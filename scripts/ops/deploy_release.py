#!/usr/bin/env python3
"""Plan, deploy affected apps, and verify the exact production fleet.

Plans and rollback originals are private files outside the checkout. A run is
once-only; failed or ambiguous mutations require readback and a new reviewed plan.
This tool never migrates a database, changes capacity, or requeues model work.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
import re
import stat
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


shared = load('release_shared', 'deploy_shared_images.py')
git = load('release_git', 'deploy_git_apps.py')
scope = load('release_scope', 'deployment_scope.py')
fleet = load('release_fleet', 'release_runtime.py')
readiness = load('release_ready', 'release_readiness.py')
catalog = load('release_catalog', 'release_catalog.py')
SCHEMA_VERSION = 1
ALL_ROLES = ('publisher', 'reviewer', 'crawler', 'text', 'maintenance')
TOOL_FILES = ('deploy_release.py', 'deploy_shared_images.py', 'deploy_git_apps.py',
              'deployment_scope.py', 'release_runtime.py', 'release_readiness.py',
              'release_observer.py', 'release_monitor.py', 'release_catalog.py')


def now():
    return datetime.now(timezone.utc).isoformat()


def execution_source_hashes():
    return {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
            for name in TOOL_FILES}


def validate_tool_sources(plan):
    if (not isinstance(plan.get('toolSources'), dict) or set(plan['toolSources']) != set(TOOL_FILES)
            or plan['toolSources'] != execution_source_hashes()):
        raise ValueError('execution_sources_changed_new_plan_required')


def private_location(path):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or path.resolve().is_relative_to(ROOT):
        raise ValueError('private_path_must_be_absolute_outside_checkout')
    return path


def write_private(path, value):
    path = private_location(path)
    content = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return hashlib.sha256(content).hexdigest()


def read_private(path, digest):
    path = private_location(path)
    status = path.lstat()
    if (not stat.S_ISREG(status.st_mode) or status.st_uid != os.getuid() or status.st_mode & 0o077
            or status.st_size > 128 * 1024 * 1024):
        raise ValueError('private_file_required')
    data = path.read_bytes()
    if not re.fullmatch('[a-f0-9]{64}', digest or '') or hashlib.sha256(data).hexdigest() != digest:
        raise ValueError('private_file_digest_mismatch')
    return json.loads(data)


def fresh_directory(path):
    path = private_location(path)
    if path.exists():
        raise ValueError('release_already_attempted_review_existing_receipts')
    path.mkdir(mode=0o700, parents=False)
    return path


def execution_steps(selected, skipped=()):
    """Existing shared-role parallelism, serial web pair, and monitor last."""
    selected = set(selected)
    if selected - set(fleet.registered_apps()):
        raise ValueError('unknown_selected_app')
    steps = []
    roles = tuple(role for role in shared.ROLES if role + '-m3' in selected)
    for role in shared.ROLES:
        if (role + '-mini' in selected) != (role + '-m3' in selected):
            raise ValueError('role_pair_required')
    for host in ('mini', 'm3'):
        batch = tuple(role + '-' + host for role in roles)
        if batch:
            steps.append(('deploy', batch))
    consumers = tuple(name for name in fleet.registered_apps() if '-consumer-' in name and name in selected)
    for name in consumers:
        parent = shared.consumer_role(name)
        if parent not in roles:
            raise ValueError('consumer_parent_pair_required')
    for host in ('mini', 'm3'):
        batch = tuple(name for name in consumers if name.endswith('-' + host))
        if batch:
            steps.append(('deploy', batch))
    if roles:
        steps.append(('gate', roles))
    for name in ('web-mini', 'web-m3'):
        if name in selected:
            steps.append(('deploy', (name,)))
    if any(name.startswith('web-') for name in selected):
        if not {'web-mini', 'web-m3'}.issubset(selected):
            raise ValueError('web_pair_required')
        steps.append(('public', ()))
    if 'monitor-m3' in selected:
        steps.append(('deploy', ('monitor-m3',)))
    skipped = set(skipped)
    if skipped - selected:
        raise ValueError('skip_outside_scope')
    return [(kind, tuple(name for name in names if name not in skipped))
            for kind, names in steps if kind != 'deploy' or set(names) - skipped]


def already_target(snapshot, target, selected):
    """A proven baseline already at the desired config needs no new deployment."""
    return [short for short in selected if git.stable_config(snapshot['apps'][short]) ==
            git.stable_config(fleet.expected_api(short, snapshot['apps'][short], target))]


def required_kinds(selected):
    kinds = []
    if any(not name.startswith('web-') for name in selected):
        kinds.append('worker')
    if any(name.startswith('web-') for name in selected):
        kinds.append('web')
    return tuple(kinds)


def validate_catalog_scope(additions, selected, snapshot, sha):
    """New catalog jobs need the new scheduler first: in this scope, or both schedulers already proven at the target
    release (a stopped release continued by a fresh plan; run_release still waits for the rows to be registered)."""
    schedulers = ('scheduler-mini', 'scheduler-m3')
    at_target = all((snapshot['baseline'].get(name) or {}).get('release') == sha for name in schedulers)
    if additions and not set(schedulers).issubset(selected) and not at_target:
        raise ValueError('new_catalog_requires_scheduler_deployment_scope')


def new_client():
    return shared.Dokploy(shared.dokploy_api_key())


def impact(snapshot, sha):
    return scope.plan_for_baselines(ROOT, sha, snapshot['baseline'],
                                    known_apps=shared.KNOWN_APPS, consumer_apps=shared.CONSUMER_APPS)


def merged_target(snapshot, proof):
    target = dict(proof['target'])
    for kind, short in (('worker', 'publisher-m3'), ('web', 'web-m3')):
        if kind not in target:
            target[kind] = snapshot['apps'][short]['dockerImage']
    return shared.validate_target(target['sha'], target['worker'], target['web'])


def migration_changes(snapshot, sha):
    previous = sorted({row['release'] for row in snapshot['baseline'].values()})
    for old in previous:
        paths = shared.run(['git', '--no-replace-objects', 'diff', '--no-ext-diff', '--no-textconv',
                            '--name-only', old, sha, '--', 'drizzle', 'lib/db/schema.ts', 'scripts/migrate.mjs'])
        if paths:
            return True
    return False


def prepull(snapshot, target, selected):
    """Verify only needed images on affected hosts, using preserved registry credentials."""
    verified_token = shared.main_sha_and_token(target)
    kinds = required_kinds(selected)
    web = snapshot['apps']['web-m3']
    if 'web' in kinds:
        key = shared.web_key_of('web-m3', web)
        shared.web_key_of('web-mini', snapshot['apps']['web-mini'], key)
        key_hash = hashlib.sha256(key.encode()).hexdigest()
    else:
        key_hash = ''
    # The same stored web credential will be passed back unchanged to Dokploy.
    token = web.get('password') or verified_token
    hosts = sorted({shared.app_metadata(short)[2][1] for short in selected})
    def one(host):
        images = {kind: target[kind] for kind in kinds}
        raw = shared.ssh_python(host, shared.REMOTE_PULL, json.dumps(images), target['sha'], key_hash,
                                input_text=token, timeout=180)
        result = json.loads(raw)
        if result.get('pulled') is not True or result.get('revision') != target['sha']:
            raise ValueError('prepull_provenance_not_verified')
        return host
    with ThreadPoolExecutor(max_workers=2) as pool:
        return {'hosts': sorted(pool.map(one, hosts)), 'kinds': kinds, 'verifiedAt': now()}


def create_plan(sha, output, *, baseline_path=None, baseline_sha=None, migration_verified=False):
    if not re.fullmatch('[a-f0-9]{40}', sha or ''):
        raise ValueError('exact_release_sha_required')
    if shared.run(['git', '--no-replace-objects', 'rev-parse', 'HEAD']) != sha:
        raise ValueError('checkout_must_be_target_release')
    if shared.run(['git', 'status', '--porcelain', '--untracked-files=no']):
        raise ValueError('clean_target_checkout_required')
    snapshot = read_private(baseline_path, baseline_sha) if baseline_path else fleet.collect_baseline(new_client(), ROOT)
    decision = impact(snapshot, sha)
    selected = decision['selectedApps']
    plan = {'schemaVersion': SCHEMA_VERSION, 'createdAt': now(), 'scope': decision,
            'snapshot': snapshot, 'target': {'sha': sha}, 'steps': [], 'migrationVerified': migration_verified,
            'toolSources': execution_source_hashes()}
    if selected:
        client = new_client()
        proof = readiness.resolve_readiness(sha, required_kinds=required_kinds(selected))
        target = merged_target(snapshot, proof)
        proof['target'] = target
        snapshot['target'] = target
        # A supplied prior receipt may be old. Reprove it before planning any mutation.
        fleet.verify_fleet(client, snapshot, target, [], {}, ROOT)
        changed = migration_changes(snapshot, sha)
        if changed and not migration_verified:
            raise ValueError('database_changes_require_migration_verified')
        migrations = shared.migration_gate(client, sha) if changed else None
        integration = shared.github_integration_preflight(client, snapshot['apps'])
        guard = shared.monitor_gate(client, 'crawler', roles=ALL_ROLES, strict=())
        scan = shared.agent_scan_release_gate(client, sha) if any(name.startswith('crawler-') for name in selected) else None
        images = prepull(snapshot, target, selected)
        additions = catalog.catalog_additions(snapshot, sha, ROOT)
        validate_catalog_scope(additions, selected, snapshot, sha)
        plan.update(target=target, readiness=proof, steps=execution_steps(selected), migrations=migrations,
                    integration=integration, existingGuard=guard, agentScan=scan, prePull=images,
                    catalogAdditions=additions)
        git_selected = [name for name in git.ORDER if name in selected]
        plan['gitPrepared'] = git.prepare(client, target, git_selected, snapshot, proof)
    directory = fresh_directory(output)
    path = directory / 'plan.private.json'
    digest = write_private(path, plan)
    return {'status': 'planned', 'plan': str(path), 'planSha256': digest, 'selectedApps': selected,
            'retainedApps': decision['retainedApps'], 'mode': decision['mode'], 'serviceMutations': 0}


def action(client, directory, short, label, endpoint, payload):
    write_private(directory / (short + '.' + label + '.attempted.json'), {'app': short, 'action': endpoint, 'at': now()})
    client.request(endpoint, payload)
    write_private(directory / (short + '.' + label + '.completed.json'), {'app': short, 'action': endpoint, 'at': now()})


REMOTE_RETAIN_IMAGE = r'''import json,subprocess,sys
image,tag=sys.argv[1:]
def inspect(value):
 p=subprocess.run(['docker','image','inspect',value,'--format','{{.Id}}'],capture_output=True,text=True)
 return p.stdout.strip() if p.returncode==0 else None
if inspect(image)!=image:raise SystemExit('rollback_image_missing')
existing=inspect(tag)
if existing is not None and existing!=image:raise SystemExit('rollback_tag_conflict')
if existing is None:
 subprocess.run(['docker','image','tag',image,tag],capture_output=True,check=True)
if inspect(tag)!=image:raise SystemExit('rollback_tag_readback_failed')
print(json.dumps({'image':image,'retained':True}))
'''


def preserve_git_images(snapshot, selected, directory):
    """Keep old local Git build images addressable after provider conversion."""
    for short in selected:
        if snapshot['apps'][short].get('sourceType') != 'github':
            continue
        images = {item['image'] for item in snapshot['runtime'][short]['containers']}
        if len(images) != 1 or not re.fullmatch('sha256:[a-f0-9]{64}', next(iter(images))):
            raise ValueError('rollback_image_identity_ambiguous')
        image = next(iter(images))
        tag = 'nomorevibe-rollback/' + short + ':' + snapshot['baseline'][short]['release']
        write_private(directory / (short + '.rollback-image.attempted.json'), {'image': image, 'tag': tag, 'at': now()})
        host = shared.app_metadata(short)[2][1]
        receipt = json.loads(shared.ssh_python(host, REMOTE_RETAIN_IMAGE, image, tag))
        if receipt != {'image': image, 'retained': True}:
            raise ValueError('rollback_image_not_retained')
        write_private(directory / (short + '.rollback-image.completed.json'), {**receipt, 'tag': tag, 'at': now()})


def unchanged(client, snapshot, short):
    app, latest = client.app(short), client.latest(short)
    if (git.stable_config(app) != git.stable_config(snapshot['apps'][short]) or
            app.get('applicationStatus') != 'done' or latest.get('status') != 'done' or
            latest.get('deploymentId') != snapshot['latest'][short].get('deploymentId')):
        raise ValueError(short + '_changed_since_plan')
    return app


MODEL_OWNER_ROLES = frozenset({'reviewer', 'publisher', 'text', 'maintenance'})
MODEL_REPLACEMENT_SCRIPT = r'''import postgres from 'postgres';
const db=postgres(process.env.DATABASE_URL,{max:1,prepare:false,connect_timeout:5,onnotice:()=>{}});
try {
 const result=await db.begin('read only',async tx=>{
  await tx`SET LOCAL statement_timeout='5s'`;
  const [identity]=await tx`SELECT pg_is_in_recovery() AS replica`;
  const [control]=await tx`SELECT mode FROM model_capacity_control WHERE id=1`;
  const [active]=await tx`SELECT count(*)::int AS active FROM model_capacity_requests
    WHERE state IN ('dispatched','indeterminate') OR (state='reserved' AND reserved_until>clock_timestamp())`;
  return {replica:identity.replica,mode:control?.mode,active:active.active};
 });
 console.log(JSON.stringify(result));
} finally {await db.end({timeout:5});}
'''
REMOTE_MODEL_REPLACEMENT = r'''import json,subprocess,sys
service=sys.argv[1]
ids=subprocess.check_output(['docker','ps','--filter','label=com.docker.swarm.service.name='+service,
                             '--format','{{.ID}}'],text=True).split()
if len(ids)!=1:raise SystemExit('model_replacement_probe_container_count')
r=subprocess.run(['docker','exec','-i',ids[0],'node','--input-type=module'],
                 input=sys.stdin.read(),capture_output=True,text=True,timeout=20)
if r.returncode or r.stderr:raise SystemExit('model_replacement_probe_failed')
print(json.dumps(json.loads(r.stdout)))
'''


def model_replacement_gate(client, selected):
    """Observe an explicit operator drain before replacing a model request owner.

    Never change capacity or infer remote completion from a client exit. A
    running/unknown call blocks replacement, including recovery releases.
    """
    owners = [short for short in selected if short.startswith('web-') or
              shared.app_role(short) in MODEL_OWNER_ROLES]
    if not owners:
        return {'required': False}
    app = client.app('crawler-m3')
    observation = json.loads(shared.ssh_python(shared.M3[1], REMOTE_MODEL_REPLACEMENT, app['appName'],
                                              input_text=MODEL_REPLACEMENT_SCRIPT, timeout=30))
    if (not isinstance(observation, dict) or observation.get('replica') is not False or
            observation.get('mode') != 'draining' or type(observation.get('active')) is not int or
            observation['active'] != 0):
        raise ValueError('model_replacement_requires_explicit_drain_and_zero_active_calls')
    return {'required': True, 'mode': 'draining', 'active': 0, 'owners': sorted(owners), 'observedAt': now()}


def deploy_one(client, plan, short, directory):
    snapshot, target = plan['snapshot'], plan['target']
    original = unchanged(client, snapshot, short)
    expected = fleet.expected_api(short, original, target)
    app_id = shared.app_metadata(short)[0]
    action(client, directory, short, 'environment', 'application.saveEnvironment', {
        'applicationId': app_id, 'env': expected['env'], 'buildArgs': expected.get('buildArgs'),
        'buildSecrets': original.get('buildSecrets'), 'createEnvFile': original.get('createEnvFile') is True})
    intermediate = copy.deepcopy(original)
    intermediate.update(env=expected['env'], buildArgs=expected.get('buildArgs'))
    if git.stable_config(client.app(short)) != git.stable_config(intermediate):
        raise ValueError(short + '_saved_environment_drift')
    action(client, directory, short, 'provider', 'application.saveDockerProvider', {
        'applicationId': app_id, 'dockerImage': expected['dockerImage'], 'username': original.get('username'),
        'password': original.get('password'), 'registryUrl': original.get('registryUrl')})
    if git.stable_config(client.app(short)) != git.stable_config(expected):
        raise ValueError(short + '_saved_provider_drift')
    old_id = snapshot['latest'][short]['deploymentId']
    action(client, directory, short, 'deploy', 'application.deploy', {'applicationId': app_id})
    evidence = {}
    if short in shared.APPS or short in shared.CONSUMER_APPS:
        shared.check_app_deployed(client, short, target, old_id)
    else:
        monitor = load('release_monitor', 'release_monitor.py')
        evidence = monitor.check_monitor_deployed(client, short, target, original, old_id,
                           git.source_manifest(target['sha'], stage='monitor', repo=ROOT),
                           expected_runtime=snapshot['runtime'][short])
    latest = client.latest(short)
    if latest.get('status') != 'done' or latest.get('deploymentId') == old_id:
        raise ValueError(short + '_new_deployment_receipt_missing')
    return {**evidence, 'app': short, 'deploymentId': latest['deploymentId'], 'at': now()}


def run_batch(names, one, directory):
    results, errors = {}, []
    with ThreadPoolExecutor(max_workers=min(3, len(names))) as pool:
        futures = {pool.submit(one, name): name for name in names}
        for future in as_completed(futures):
            short = futures[future]
            try:
                results[short] = future.result()
                write_private(directory / (short + '.verified.json'), results[short])
            except Exception as error:
                errors.append(error)
                write_private(directory / (short + '.failed.json'), {'app': short, 'errorClass': type(error).__name__, 'at': now()})
    if errors:
        raise RuntimeError('batch_failed_review_all_started_app_receipts') from errors[0]
    return results


def run_release(plan, execution_dir, *, observe=True):
    if plan.get('schemaVersion') != SCHEMA_VERSION:
        raise ValueError('invalid_release_plan')
    selected = plan['scope']['selectedApps']
    directory = fresh_directory(execution_dir)
    write_private(directory / 'once.json', {'startedAt': now(), 'target': plan['target'], 'selectedApps': selected})
    if not selected:
        result = {'status': 'no-runtime-changes', 'productionMutations': 0,
                  'scope': 'local change proof; no new fleet health observation'}
        write_private(directory / 'result.safe.json', result)
        return result
    receipts = {}
    try:
        validate_tool_sources(plan)
        client, target = new_client(), plan['target']
        proof = readiness.resolve_readiness(target['sha'], required_kinds=required_kinds(selected))
        if merged_target(plan['snapshot'], proof) != target or any(
                proof.get(key) != plan['readiness'].get(key) for key in ('runId', 'runAttempt', 'profile', 'rulesVersion')):
            raise ValueError('readiness_changed_new_plan_required')
        proof['target'] = target
        plan['readiness'] = proof
        git.verify_main(target)
        # Preserve the original GitHub account/private-web registry guard.
        shared.main_sha_and_token(target)
        # Every app must still be its exact original before the first service mutation.
        fleet.verify_fleet(client, plan['snapshot'], target, [], {}, ROOT)
        current_impact = impact(plan['snapshot'], target['sha'])
        if current_impact['selectedApps'] != selected or current_impact['rulesVersion'] != plan['scope']['rulesVersion']:
            raise ValueError('deployment_scope_changed')
        additions = catalog.catalog_additions(plan['snapshot'], target['sha'], ROOT)
        if additions != plan.get('catalogAdditions', []):
            raise ValueError('catalog_changed_new_plan_required')
        validate_catalog_scope(additions, selected, plan['snapshot'], target['sha'])
        if migration_changes(plan['snapshot'], target['sha']):
            if not plan.get('migrationVerified'):
                raise ValueError('database_changes_require_migration_verified')
            shared.migration_gate(client, target['sha'])
        shared.github_integration_preflight(client, plan['snapshot']['apps'])
        shared.monitor_gate(client, 'crawler', roles=ALL_ROLES, strict=())
        if any(name.startswith('crawler-') for name in selected):
            shared.agent_scan_release_gate(client, target['sha'])
        skipped = already_target(plan['snapshot'], target, selected)
        deployed = [short for short in selected if short not in skipped]
        write_private(directory / 'model-drain.safe.json', model_replacement_gate(client, deployed))
        preserve_git_images(plan['snapshot'], deployed, directory)
        git_selected = [name for name in git.ORDER if name in selected]
        if git_selected:
            validate_tool_sources(plan)
            prepared = git.prepare(client, target, git_selected, plan['snapshot'], proof)
            result = git.deploy(client, target, prepared, directory / 'git')
            write_private(directory / 'git.summary.safe.json', result)
            if set(result['skipped']) != set(skipped) & set(git_selected):
                raise ValueError('git_skip_contract_changed')
            if set(result['deployed']) != set(deployed) & set(git_selected):
                raise ValueError('git_deployment_receipts_mismatch')
            for short in result['deployed']:
                receipts[short] = json.loads((directory / 'git' / (short + '.verified.json')).read_text())
        if additions:
            write_private(directory / 'catalog.safe.json', catalog.verify_registered(client, additions))
        for kind, names in execution_steps(selected, skipped):
            validate_tool_sources(plan)
            git.verify_main(target)
            if kind == 'deploy':
                # Re-read before every replacement batch. Do not reuse a prior
                # drain if another operator has reopened model admission.
                write_private(directory / ('model-drain-' + '-'.join(names) + '.safe.json'),
                              model_replacement_gate(client, names))
                for short in names:
                    unchanged(client, plan['snapshot'], short)
                receipts.update(run_batch(names, lambda short: deploy_one(client, plan, short, directory), directory))
            elif kind == 'gate':
                result = shared.monitor_gate(client, 'crawler', roles=names, timeout=shared.PARALLEL_GATE_TIMEOUT)
                write_private(directory / ('gate-' + '-'.join(names) + '.safe.json'), result)
            else:
                write_private(directory / 'public.safe.json', shared.public_gate(target['sha']))
                write_private(directory / 'purge.safe.json', shared.purge_html())
        final_snapshot = {}
        validate_tool_sources(plan)
        states = fleet.verify_fleet(client, plan['snapshot'], target, deployed, receipts, ROOT, output_snapshot=final_snapshot)
        guard = shared.monitor_gate(client, 'crawler', roles=ALL_ROLES,
                                     strict=tuple(role for role in ALL_ROLES if role + '-m3' in deployed))
        final_path = directory / 'final.private.json'
        digest = write_private(final_path, final_snapshot)
        result = {'status': 'deployed-and-verified', 'target': target, 'selectedApps': selected,
                  'deployedApps': deployed, 'skippedApps': skipped,
                  'retainedApps': sorted(set(fleet.registered_apps()) - set(deployed)),
                  'states': states, 'existingGuard': guard,
                  'finalSnapshot': str(final_path), 'finalSnapshotSha256': digest, 'completedAt': now()}
        # Deployment completion is durable before the independent scheduler starts.
        write_private(directory / 'result.safe.json', result)
        if observe:
            try:
                observer = load('release_observe', 'release_observer.py')
                result['observation'] = observer.launch_observer(final_path, digest, directory / 'observation')
            except Exception as error:
                result['observation'] = {'status': 'schedule-failed', 'errorClass': type(error).__name__,
                                         'scope': 'deployment verified; observation has not been scheduled'}
            write_private(directory / 'observation.safe.json', result['observation'])
        return result
    except Exception as error:
        write_private(directory / 'failure.private.json', {'errorClass': type(error).__name__,
                      'message': str(error), 'traceback': traceback.format_exc(), 'at': now()})
        write_private(directory / 'stopped.safe.json', {'status': 'stopped-readback-required', 'at': now(),
            'errorClass': type(error).__name__, 'completedApps': sorted(receipts),
            'scope': 'do not rerun markers or resubmit ambiguous actions; inspect private originals and receipts'})
        raise


def main(argv=None):
    os.chdir(ROOT)
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    preview = sub.add_parser('scope', help='local impact preview only; no production or credentials')
    preview.add_argument('--base', required=True)
    preview.add_argument('--sha', required=True)
    prepare = sub.add_parser('plan', help='read-only service preflight, image preparation, and private rollback plan')
    prepare.add_argument('--sha', required=True)
    prepare.add_argument('--out', type=Path, required=True)
    prepare.add_argument('--baseline', type=Path)
    prepare.add_argument('--baseline-sha')
    prepare.add_argument('--migration-verified', action='store_true')
    execute = sub.add_parser('run', help='execute a fresh reviewed private plan exactly once')
    execute.add_argument('--plan', type=Path, required=True)
    execute.add_argument('--plan-sha', required=True)
    args = parser.parse_args(argv)
    if args.action == 'scope':
        result = scope.plan_deployment(ROOT, args.base, args.sha, known_apps=shared.KNOWN_APPS,
                                       consumer_apps=shared.CONSUMER_APPS)
    elif args.action == 'plan':
        if bool(args.baseline) != bool(args.baseline_sha):
            parser.error('--baseline and --baseline-sha must be provided together')
        result = create_plan(args.sha, args.out, baseline_path=args.baseline,
                             baseline_sha=args.baseline_sha, migration_verified=args.migration_verified)
    else:
        plan = read_private(args.plan, args.plan_sha)
        result = run_release(plan, args.plan.parent / 'execution')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'release-not-complete', 'errorClass': type(error).__name__,
                          'reason': getattr(error, 'code', 'inspect-private-receipts'), 'automaticRetry': False}))
        sys.exit(1)
