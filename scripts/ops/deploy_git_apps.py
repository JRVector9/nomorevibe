#!/usr/bin/env python3
"""Bounded, once-only rollout for text, maintenance, scheduler and connect.

The caller supplies the durable full-fleet rollback snapshot and freshly verified
main CI/image receipt. Worker apps use the immutable shared worker image by
default; connect keeps its Git source and separate healthcheck. No automatic
retry, resume, rollback, or production discovery is performed by this module.
"""

import copy
import hashlib
import importlib.util
import io
import json
import os
import re
import shlex
import subprocess
import tarfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path


_SPEC = importlib.util.spec_from_file_location('git_rollout_shared', Path(__file__).with_name('deploy_shared_images.py'))
shared = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(shared)

WAVES = (('text-mini', 'maintenance-mini'), ('text-m3', 'maintenance-m3'),
         ('scheduler-m3', 'connect-agent-m3'))
ORDER = tuple(short for wave in WAVES for short in wave)
READINESS_MAX_AGE_SECONDS = 900
BASELINE_SETTLED_STATES = (None, 'completed', 'rollback_completed')
DEPLOYED_SETTLED_STATES = (None, 'completed')
VOLATILE_FIELDS = frozenset(('applicationStatus', 'updatedAt', 'createdAt', 'deployments', 'deployment',
                             'deploymentStatus', 'lastDeployment', 'lastDeploymentAt'))


class GitRolloutStopped(shared.ReleaseStopped):
    def __init__(self, summary):
        self.summary = summary
        super().__init__('git_rollout_stopped_review_receipts_before_recovery')


def waves(selected):
    selected = tuple(selected)
    if len(set(selected)) != len(selected) or any(short not in ORDER for short in selected):
        raise ValueError('invalid_git_apps')
    for role in ('text', 'maintenance'):
        if role + '-m3' in selected and role + '-mini' not in selected:
            raise ValueError(role + '_standby_required')
        if role + '-mini' in selected and role + '-m3' not in selected:
            raise ValueError(role + '_primary_required')
    return tuple(tuple(short for short in wave if short in selected) for wave in WAVES
                 if any(short in selected for short in wave))


def validate_readiness(target, receipt):
    try:
        verified = datetime.fromisoformat(receipt['verifiedAt'].replace('Z', '+00:00'))
        age = (datetime.now(timezone.utc) - verified).total_seconds()
        valid = (receipt.get('schemaVersion') == 1 and receipt.get('target') == target and
                 receipt.get('checkPassed') is True and receipt.get('imagesReady') is True and
                 type(receipt.get('runId')) is int and receipt['runId'] > 0 and
                 receipt.get('profile') in ('full', 'ui') and receipt.get('rulesVersion') == 'v2' and
                 -30 <= age <= READINESS_MAX_AGE_SECONDS)
    except (KeyError, TypeError, ValueError, AttributeError):
        valid = False
    if not valid:
        raise ValueError('git_readiness_invalid_or_stale')


def verify_main(target):
    if shared.run(['gh', 'api', 'repos/JRVector9/nomorevibe/commits/main', '--jq', '.sha']) != target['sha']:
        raise ValueError('main_sha_mismatch')
    if shared.run(['git', '--no-replace-objects', 'rev-parse', 'HEAD']) != target['sha']:
        raise ValueError('local_checkout_not_target_main')
    if shared.run(['git', '--no-replace-objects', 'status', '--porcelain', '--untracked-files=no']):
        raise ValueError('clean_target_checkout_required')


def stable_config(app):
    """Compare all API configuration, including mounts/resources/health, not a small allowlist."""
    return {key: value for key, value in app.items() if key not in VOLATILE_FIELDS}


def provenance_build_args(value, sha):
    if not isinstance(sha, str) or not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ValueError('NMV_SOURCE_SHA_invalid_target')
    value = value or ''
    if not isinstance(value, str):
        raise ValueError('NMV_SOURCE_SHA_invalid_build_args')
    rows = [line for line in value.splitlines() if re.match(r'\s*(?:export\s+)?NMV_SOURCE_SHA\s*=', line)]
    if len(rows) > 1 or (rows and not re.fullmatch(r'NMV_SOURCE_SHA=[a-f0-9]{40}', rows[0])):
        raise ValueError('NMV_SOURCE_SHA_invalid_or_duplicate')
    if rows:
        return shared.replace_setting(value, 'NMV_SOURCE_SHA', sha)
    return value + ('\n' if value and not value.endswith('\n') else '') + 'NMV_SOURCE_SHA=' + sha + '\n'


def validate_git_source_build(sha, stage):
    dockerfile = shared.git_blob(sha, 'Dockerfile').decode()
    match = re.search(r'(?ms)^FROM [^\n]+ AS ' + re.escape(stage) + r'\n(.*?)(?=^FROM |\Z)', dockerfile)
    if (not match or not re.search(r'(?m)^ARG NMV_SOURCE_SHA\s*$', match[1]) or not re.search(
            r'(?m)^LABEL org\.opencontainers\.image\.revision="?\$\{NMV_SOURCE_SHA\}"?\s*$', match[1])):
        raise ValueError('git_source_revision_build_contract_unsupported_' + stage)


def validate_contract(short, app, *, mode):
    app_id, name, (server, _), kind = shared.app_metadata(short)
    if (app.get('applicationId'), app.get('name'), app.get('serverId')) != (app_id, name, server):
        raise ValueError(short + '_identity_mismatch')
    if not re.fullmatch(r'[a-z0-9-]+', app.get('appName') or ''):
        raise ValueError(short + '_invalid_service_name')
    if app.get('autoDeploy') is not False:
        raise ValueError(short + '_auto_deploy_must_be_disabled')
    expected_replicas = 2 if kind == 'scheduler' else 1
    if type(app.get('replicas')) is not int or app['replicas'] != expected_replicas:
        raise ValueError(short + '_replicas_mismatch')
    if app.get('dockerBuildStage') != ('connect-agent' if kind == 'connect-agent' else 'worker'):
        raise ValueError(short + '_stage_mismatch')
    source = app.get('sourceType')
    if source == 'github':
        if (str(app.get('owner', '')).lower(), app.get('repository'), app.get('branch'),
                app.get('buildType'), app.get('dockerfile'), app.get('buildPath')) != (
                'jrvector9', 'nomorevibe', 'main', 'dockerfile', 'Dockerfile', '/'):
            raise ValueError(short + '_git_source_mismatch')
    elif (source != 'docker' or mode != 'shared-worker' or kind == 'connect-agent' or
          not re.fullmatch(re.escape(shared.IMAGE_PREFIX['worker']) + r'sha256:[a-f0-9]{64}', app.get('dockerImage') or '')):
        raise ValueError(short + '_source_mismatch')
    role = short.rpartition('-')[0]
    argv = shlex.split(app.get('command') or '')
    if argv[:2] == ['/sbin/tini', '--']:
        argv = argv[2:]
    expected = ['node', '--import', 'tsx', 'scripts/connect-agent.ts'] if kind == 'connect-agent' else [
        'node', '--import', 'tsx', 'scripts/worker-supervisor.ts', '--role=' + role]
    candidate = ['node', '--import', 'tsx', 'scripts/role-worker.ts', '--role=' + role,
                 '--kind=' + ('standby' if short.endswith('-mini') else 'primary')]
    if not (argv == expected or (kind == 'connect-agent' and not argv) or
            (role in ('text', 'maintenance') and argv == candidate)):
        raise ValueError(short + '_command_mismatch')
    if kind != 'connect-agent' and shared.setting(app.get('env'), 'WORKER_ROLE') != role:
        raise ValueError(short + '_role_mismatch')
    if not re.fullmatch(r'[a-f0-9]{40}', shared.setting(app.get('env'), 'RELEASE_TAG')):
        raise ValueError(short + '_release_invalid')


def source_manifest(sha, *, stage='worker', kind=None, repo=None):
    """SHA256 of committed bytes COPYed into the supported worker/monitor stages.

    Refuse unknown COPY/ignore rules rather than claiming source provenance for
    files that the Docker build excludes or obtains from an unverified stage.
    """
    if not re.fullmatch(r'[a-f0-9]{40}', sha):
        raise ValueError('invalid_release_sha')
    stage = kind or stage
    if stage not in ('worker', 'connect-agent', 'monitor'):
        raise ValueError('source_manifest_unsupported_stage')
    actual_stage = 'worker' if stage == 'connect-agent' else stage
    git = ['git', '--no-replace-objects'] + (['-C', str(repo)] if repo is not None else [])
    def git_bytes(path):
        result = subprocess.run([*git, 'show', sha + ':' + path], capture_output=True, timeout=45)
        if result.returncode:
            raise RuntimeError('git_source_read_failed')
        return result.stdout
    dockerfile = git_bytes('Dockerfile').decode()
    match = re.search(r'(?ms)^FROM [^\n]+ AS ' + actual_stage + r'\n(.*?)(?=^FROM |\Z)', dockerfile)
    if not match:
        raise ValueError('source_manifest_unsupported_dockerfile')
    expected_copies = ['package.json package-lock.json tsconfig.json ./', 'lib ./lib', 'scripts ./scripts']
    if actual_stage == 'worker':
        expected_copies += ['drizzle ./drizzle', 'messages ./messages']
    copies = []
    for line in match[1].splitlines():
        if not line.startswith('COPY '):
            continue
        value = re.sub(r'--chown=[^ ]+ ', '', line[5:])
        if value == '--from=worker-deps /app/node_modules ./node_modules':
            continue
        copies.append(value)
    if copies != expected_copies:
        raise ValueError('source_manifest_unsupported_copy_rules')
    ignores = [line.strip() for line in git_bytes('.dockerignore').decode().splitlines()
               if line.strip() and not line.lstrip().startswith('#')]
    known = {'node_modules', '.next', '.git', '.env*', '!.env.example', 'tests', 'scripts/ops',
             '**/__pycache__', '**/*.pyc', 'drizzle.config.ts', 'vitest*.config.ts', '.github', 'README.md'}
    if any(line not in known for line in ignores):
        raise ValueError('source_manifest_unsupported_ignore_rules')
    paths = ['lib', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json']
    if actual_stage == 'worker':
        paths += ['drizzle', 'messages']
    archive = subprocess.run([*git, 'archive', '--format=tar', sha, '--', *paths], capture_output=True, timeout=45)
    if archive.returncode:
        raise RuntimeError('git_source_archive_failed')
    result = {}
    with tarfile.open(fileobj=io.BytesIO(archive.stdout)) as entries:
        for entry in entries:
            path = entry.name
            if entry.isdir():
                continue
            if not entry.isfile() or path.startswith('/') or '..' in path.split('/'):
                raise ValueError('git_source_manifest_unsupported_entry')
            if (('scripts/ops' in ignores and path.startswith('scripts/ops/')) or
                    ('**/__pycache__' in ignores and '__pycache__' in path.split('/')) or
                    ('**/*.pyc' in ignores and path.endswith('.pyc'))):
                continue
            result[path] = hashlib.sha256(entries.extractfile(entry).read()).hexdigest()
    if not all(path in result for path in ('package.json', 'package-lock.json', 'tsconfig.json',
                                          'scripts/worker-supervisor.ts', 'scripts/worker-healthcheck.ts',
                                          'scripts/connect-agent.ts')):
        raise ValueError('git_source_manifest_incomplete')
    return result


# This raw data is private rollback material. Callers must never emit it.
REMOTE_INSPECT = r'''import hashlib,json,subprocess,sys
service=sys.argv[1];kind=sys.argv[2];manifest=json.loads(sys.stdin.read() or '{}')
def cmd(*args,input=None):
 r=subprocess.run(args,capture_output=True,text=True,input=input,timeout=45)
 if r.returncode: raise RuntimeError('runtime_probe_command_failed')
 return r.stdout.strip()
rows=json.loads(cmd('docker','service','inspect',service))
if len(rows)!=1: raise SystemExit('runtime_service_not_unique')
s=rows[0];spec=s['Spec'];ids=cmd('docker','ps','--filter','label=com.docker.swarm.service.name='+service,'--format','{{.ID}}').splitlines()
result={'serviceId':s.get('ID'),'version':s.get('Version'),'updateStatus':s.get('UpdateStatus'),
        'serviceSpec':spec,'specHash':hashlib.sha256(json.dumps(spec,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
        'containers':[],'images':[]}
image_ids=set()
for cid in ids:
 c=json.loads(cmd('docker','inspect',cid))[0]
 record={'id':cid,'image':c.get('Image'),'config':c.get('Config') or {},'mounts':c.get('Mounts') or [],'state':c.get('State') or {}}
 if kind=='web':
  script="fetch('http://'+process.env.HOSTNAME+':3000/api/health').then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()}))).catch(()=>console.log(JSON.stringify({status:0})));"
  record['directHealth']=json.loads(cmd('docker','exec',cid,'node','-e',script))
 if manifest:
  script="const fs=require('fs'),c=require('crypto');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const out={};for(const p of Object.keys(JSON.parse(s))){try{out[p]=c.createHash('sha256').update(fs.readFileSync('/app/'+p)).digest('hex');}catch{out[p]=null;}}console.log(JSON.stringify(out));});"
  record['codeHashes']=json.loads(cmd('docker','exec','-i',cid,'node','-e',script,input=json.dumps(manifest)))
 result['containers'].append(record)
 if c.get('Image') not in image_ids:
  result['images']+=json.loads(cmd('docker','image','inspect',c['Image']));image_ids.add(c['Image'])
print(json.dumps(result))
'''


def spec_hash(spec):
    return hashlib.sha256(json.dumps(spec, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def inspect_runtime(short, app, *, manifest=None):
    """Read private runtime evidence for any registered app; no mutation or emission."""
    metadata = shared.app_metadata(short)
    raw = shared.ssh_python(metadata[2][1], REMOTE_INSPECT, app['appName'], metadata[3],
                            input_text=json.dumps(manifest or {}), timeout=90)
    result = json.loads(raw)
    if not isinstance(result, dict) or not isinstance(result.get('serviceSpec'), dict):
        raise ValueError(short + '_runtime_unknown')
    return result


def runtime_contract_matches(original, current, sha, *, deployment_id=None):
    """Only the image, exact release env lines, and ForceUpdate may change."""
    try:
        old, new = copy.deepcopy(original['serviceSpec']), copy.deepcopy(current['serviceSpec'])
        old_task, new_task = old['TaskTemplate'], new['TaskTemplate']
        old_container, new_container = old_task['ContainerSpec'], new_task['ContainerSpec']
        old_container['Image'] = new_container['Image']
        old_env = list(old_container.get('Env') or [])
        for key, value in (('RELEASE_TAG', sha), ('NEXT_DEPLOYMENT_ID', deployment_id)):
            if value is None:
                continue
            indexes = [index for index, line in enumerate(old_env) if line.startswith(key + '=')]
            if len(indexes) != 1:
                return False
            old_env[indexes[0]] = key + '=' + value
        old_container['Env'] = old_env
        force = new_task.get('ForceUpdate', 0)
        if type(force) is not int or force < old_task.get('ForceUpdate', 0):
            return False
        if 'ForceUpdate' in new_task:
            old_task['ForceUpdate'] = force
        if old != new:
            return False
        contracts = [{key: row['config'].get(key) for key in ('Cmd', 'Entrypoint', 'Healthcheck', 'User', 'WorkingDir')}
                     for row in original['containers']]
        return bool(contracts and current['containers'] and all(
            {key: row['config'].get(key) for key in ('Cmd', 'Entrypoint', 'Healthcheck', 'User', 'WorkingDir')} in contracts
            for row in current['containers']))
    except (KeyError, TypeError, ValueError):
        return False


def runtime_health(short, app, runtime, sha, *, image=None, manifest=None, expected_runtime=None, require_revision=False):
    """Pure runtime checks, also exported for fleet collection and offline fixtures."""
    role = shared.app_role(short)
    spec = runtime.get('serviceSpec') or {}
    container_spec = (spec.get('TaskTemplate') or {}).get('ContainerSpec') or {}
    containers = runtime.get('containers') or []
    state = (runtime.get('updateStatus') or {}).get('State')
    images = {row.get('image') for row in containers}
    image_details = {row.get('Id'): row for row in runtime.get('images') or []}
    configured_image = container_spec.get('Image') or ''
    expected_argv = shlex.split(app.get('command') or '')
    if not expected_argv and role == 'connect-agent':
        expected_argv = ['node', '--import', 'tsx', 'scripts/connect-agent.ts']
    if expected_argv[:2] != ['/sbin/tini', '--']:
        expected_argv = ['/sbin/tini', '--'] + expected_argv
    actual_image = configured_image if '@sha256:' in configured_image else next(iter(images)) if len(images) == 1 else None
    ready = (spec.get('Name') == app['appName'] and len(containers) == app['replicas'] and
             (spec.get('Mode') or {}).get('Replicated', {}).get('Replicas') == app['replicas'])
    for row in containers:
        config = row.get('config') or {}
        env_rows = config.get('Env') or []
        env = dict(line.split('=', 1) for line in env_rows if '=' in line)
        health = ' '.join((config.get('Healthcheck') or {}).get('Test') or [])
        ready = ready and (row.get('state') or {}).get('Running') is True and (
            (row.get('state') or {}).get('Health') or {}).get('Status') == 'healthy'
        ready = ready and (env.get('RELEASE_TAG') == sha and
                          sum(line.startswith('RELEASE_TAG=') for line in env_rows) == 1 and
                          (config.get('Entrypoint') or []) + (config.get('Cmd') or []) == expected_argv and
                          (config.get('Labels') or {}).get('com.docker.swarm.service.name') == app['appName'])
        if role == 'connect-agent':
            ready = ready and '127.0.0.1:3020/rpc' in health and '401' in health
        else:
            ready = ready and env.get('WORKER_ROLE') == role and 'scripts/worker-healthcheck.ts' in health
        if image:
            ready = ready and configured_image == image and config.get('Image') == image
        if manifest:
            ready = ready and row.get('codeHashes') == manifest
        if require_revision:
            labels = ((image_details.get(row.get('image')) or {}).get('Config') or {}).get('Labels') or {}
            ready = ready and labels.get('org.opencontainers.image.revision') == sha
    if expected_runtime is not None:
        ready = ready and runtime_contract_matches(expected_runtime, runtime, sha)
    return {'ready': bool(ready), 'image': actual_image, 'specHash': spec_hash(spec), 'updateState': state}


def probe(short, app, expected_sha, *, image=None, manifest=None, expected_runtime=None, require_revision=False):
    runtime = inspect_runtime(short, app, manifest=manifest)
    return runtime_health(short, app, runtime, expected_sha, image=image, manifest=manifest,
                          expected_runtime=expected_runtime, require_revision=require_revision)


def prepare(client, target, selected, root_snapshot, readiness, *, mode='shared-worker'):
    target = shared.validate_target(target['sha'], target['worker'], target['web'])
    selected_waves = waves(selected)
    if mode not in ('shared-worker', 'git-build'):
        raise ValueError('invalid_git_rollout_mode')
    if not selected_waves:
        return {'target': target, 'mode': mode, 'waves': (), 'apps': {}, 'baseline': {},
                'manifests': {}, 'conversions': [], 'buildArgUpdates': [], 'skipped': [], 'readiness': readiness}
    validate_readiness(target, readiness)
    if root_snapshot.get('schemaVersion') != 1 or root_snapshot.get('target') != target:
        raise ValueError('git_root_baseline_target_mismatch')
    verify_main(target)
    for short in (short for wave in selected_waves for short in wave):
        if mode == 'git-build' or short == 'connect-agent-m3':
            validate_git_source_build(target['sha'], 'connect-agent' if short == 'connect-agent-m3' else 'worker')
    originals, baselines, manifests, runtimes = {}, {}, {}, {}
    # Read and verify every original before any mutation; the root snapshot is the rollback authority.
    for short in ORDER:
        app = client.app(short)
        original = root_snapshot.get('apps', {}).get(short)
        baseline = root_snapshot.get('baseline', {}).get(short)
        runtime = root_snapshot.get('runtime', {}).get(short)
        if not original or stable_config(app) != stable_config(original) or not baseline:
            raise ValueError(short + '_root_baseline_mismatch')
        validate_contract(short, app, mode=mode)
        latest = client.latest(short)
        if app.get('applicationStatus') != 'done' or latest.get('status') != 'done' or not latest.get('deploymentId'):
            raise ValueError(short + '_baseline_not_ready')
        sha = shared.setting(app['env'], 'RELEASE_TAG')
        if (baseline.get('release') != sha or not re.fullmatch(r'[a-f0-9]{64}', baseline.get('specHash') or '') or
                not re.fullmatch(r'(?:sha256:[a-f0-9]{64}|[^\s]+@sha256:[a-f0-9]{64})', baseline.get('image') or '')):
            raise ValueError(short + '_root_baseline_invalid')
        if (not isinstance(runtime, dict) or not runtime.get('containers') or
                not isinstance(runtime.get('serviceSpec'), dict) or spec_hash(runtime['serviceSpec']) != baseline['specHash']):
            raise ValueError(short + '_runtime_baseline_invalid')
        if sha not in manifests:
            manifests[sha] = source_manifest(sha)
        manifest = manifests[sha]
        evidence = probe(short, app, sha, image=app.get('dockerImage') if app['sourceType'] == 'docker' else None,
                         manifest=manifest, expected_runtime=runtime)
        if (evidence.get('ready') is not True or evidence.get('image') != baseline['image'] or
                evidence.get('specHash') != baseline['specHash'] or
                evidence.get('updateState') not in BASELINE_SETTLED_STATES):
            raise ValueError(short + '_baseline_runtime_not_ready')
        originals[short] = copy.deepcopy(app)
        baselines[short] = {**baseline, 'deploymentId': latest['deploymentId']}
        runtimes[short] = copy.deepcopy(runtime)
    target_manifest = source_manifest(target['sha'])
    shared.monitor_gate(client, 'crawler', roles=('text', 'maintenance'), strict=())
    requested = tuple(short for wave in selected_waves for short in wave)
    skipped = [short for short in requested if stable_config(originals[short]) == stable_config(
        expected_config(short, originals[short], target, mode))]
    selected_waves = tuple(tuple(short for short in wave if short not in skipped) for wave in selected_waves)
    selected_waves = tuple(wave for wave in selected_waves if wave)
    chosen = tuple(short for wave in selected_waves for short in wave)
    return {'target': target, 'mode': mode, 'waves': selected_waves, 'apps': originals,
            'baseline': baselines, 'runtime': runtimes, 'manifests': manifests, 'targetManifest': target_manifest,
            'readiness': copy.deepcopy(readiness), 'skipped': skipped,
            'buildArgUpdates': [short for short in chosen if mode == 'git-build' or short == 'connect-agent-m3'],
            'conversions': [short for short in chosen if mode == 'shared-worker' and short != 'connect-agent-m3'
                            and originals[short]['sourceType'] == 'github']}


def expected_config(short, original, target, mode):
    expected = copy.deepcopy(original)
    expected['env'] = shared.replace_setting(original['env'], 'RELEASE_TAG', target['sha'])
    if mode == 'shared-worker' and short != 'connect-agent-m3':
        expected.update(sourceType='docker', dockerImage=target['worker'])
    else:
        expected['buildArgs'] = provenance_build_args(original.get('buildArgs'), target['sha'])
    return expected


def unchanged(client, short, original, baseline):
    app, latest = client.app(short), client.latest(short)
    if (stable_config(app) != stable_config(original) or app.get('applicationStatus') != 'done' or
            latest.get('status') != 'done' or latest.get('deploymentId') != baseline['deploymentId']):
        raise ValueError(short + '_changed_since_preflight')
    return app


def check_deployed(client, short, target, original, previous_id, manifest, *, mode='git-build', expected_runtime=None,
                   timeout=480, pause=2):
    expected = expected_config(short, original, target, mode)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        app, latest = client.app(short), client.latest(short)
        if app.get('applicationStatus') == 'error' or latest.get('status') == 'error':
            raise shared.ReleaseStopped(short + '_deployment_error')
        if (latest.get('deploymentId') != previous_id and latest.get('deploymentId') and
                app.get('applicationStatus') == 'done' and latest.get('status') == 'done'):
            if stable_config(app) != stable_config(expected):
                raise shared.ReleaseStopped(short + '_saved_configuration_mismatch')
            docker = expected['sourceType'] == 'docker'
            evidence = probe(short, app, target['sha'], image=target['worker'] if docker else None,
                             manifest=manifest, expected_runtime=expected_runtime, require_revision=not docker)
            if evidence.get('updateState') in shared.SWARM_ROLLBACK_STATES + shared.SWARM_STOP_STATES:
                raise shared.SwarmRollback(short, evidence)
            if evidence.get('ready') is True and evidence.get('updateState') in DEPLOYED_SETTLED_STATES:
                return {'app': short, 'deployment': 'done', 'service': 'healthy',
                        'deploymentId': latest['deploymentId'], 'image': evidence.get('image'),
                        'specHash': evidence.get('specHash'),
                        'source': 'immutable-worker+sha256-manifest' if docker else 'sha256-manifest'}
        time.sleep(pause)
    raise TimeoutError(short + '_verification_timeout')


def durable_json(path, data):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        stream.write(json.dumps({'at': datetime.now(timezone.utc).isoformat(), **data}, sort_keys=True, indent=2) + '\n')
        stream.flush()
        os.fsync(stream.fileno())
    descriptor = os.open(Path(path).parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def deploy(client, target, state, receipt_dir):
    if state.get('target') != target:
        raise ValueError('git_prepared_target_mismatch')
    if not state['waves']:
        return {'deployed': [], 'failed': [], 'touched': [], 'waves': [], 'mode': state['mode'],
                'skipped': state.get('skipped', [])}
    validate_readiness(target, state['readiness'])
    destination = Path(receipt_dir)
    if not destination.is_absolute() or destination.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError('git_receipts_must_be_absolute_outside_repository')
    try:
        destination.mkdir(mode=0o700)
    except FileExistsError as error:
        raise ValueError('git_rollout_already_attempted_no_automatic_resume') from error
    durable_json(destination / 'once.json', {'target': target, 'mode': state['mode'], 'status': 'attempted',
                                            'waves': state['waves'], 'conversions': state['conversions'],
                                            'buildArgUpdates': state['buildArgUpdates']})
    deployed, failed, touched, completed_waves = [], [], [], []

    def action(short, label, path, payload):
        durable_json(destination / (short + '.' + label + '.attempted.json'), {'app': short, 'action': path, 'status': 'attempted'})
        client.request(path, payload)
        durable_json(destination / (short + '.' + label + '.completed.json'), {'app': short, 'action': path, 'status': 'completed'})

    def one(short):
        original, baseline = state['apps'][short], state['baseline'][short]
        unchanged(client, short, original, baseline)
        expected = expected_config(short, original, target, state['mode'])
        app_id = shared.app_metadata(short)[0]
        action(short, 'environment', 'application.saveEnvironment', {
            'applicationId': app_id, 'env': expected['env'], 'buildArgs': expected.get('buildArgs'),
            'buildSecrets': original.get('buildSecrets'), 'createEnvFile': original.get('createEnvFile') is True})
        intermediate = copy.deepcopy(original)
        intermediate['env'] = expected['env']
        intermediate['buildArgs'] = expected.get('buildArgs')
        if stable_config(client.app(short)) != stable_config(intermediate):
            raise shared.ReleaseStopped(short + '_saved_configuration_mismatch')
        if expected['sourceType'] == 'docker':
            action(short, 'provider', 'application.saveDockerProvider', {
                'applicationId': app_id, 'dockerImage': target['worker'],
                'username': original.get('username'), 'password': original.get('password'),
                'registryUrl': original.get('registryUrl')})
        if stable_config(client.app(short)) != stable_config(expected):
            raise shared.ReleaseStopped(short + '_saved_configuration_mismatch')
        action(short, 'deploy', 'application.deploy', {'applicationId': app_id})
        result = check_deployed(client, short, target, original, baseline['deploymentId'],
                                state['targetManifest'], mode=state['mode'], expected_runtime=state['runtime'][short])
        durable_json(destination / (short + '.verified.json'), result)
        return result

    try:
        for index, names in enumerate(state['waves'], 1):
            validate_readiness(target, state['readiness'])
            verify_main(target)
            # The whole wave passes CAS before either peer is allowed to write.
            for short in names:
                unchanged(client, short, state['apps'][short], state['baseline'][short])
            touched.extend(names)
            errors = []
            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = {pool.submit(one, short): short for short in names}
                for future in as_completed(futures):
                    short = futures[future]
                    try:
                        future.result()
                        deployed.append(short)
                    except Exception as error:
                        failed.append(short)
                        errors.append(error)
                        # Raw transport/API exceptions may contain credentials; record type only.
                        durable_json(destination / (short + '.failed.json'), {'app': short, 'failed': True,
                                                                              **shared.error_fields(error)})
            durable_json(destination / ('wave-' + str(index) + '.json'), {
                'apps': names, 'completed': [short for short in names if short in deployed],
                'failed': [short for short in names if short in failed]})
            if errors:
                raise errors[0]
            completed_waves.append(list(names))
            if any(short in names for short in ('text-m3', 'maintenance-m3')):
                roles = tuple(role for role in ('text', 'maintenance') if role + '-m3' in names)
                result = shared.monitor_gate(client, 'crawler', roles=roles)
                durable_json(destination / ('wave-' + str(index) + '.gate.json'), result)
        # Expected release is per app: skipped apps retain their original release and configuration.
        selected = {short for wave in state['waves'] for short in wave}
        for short in ORDER:
            app = client.app(short)
            expected = expected_config(short, state['apps'][short], target, state['mode']) if short in selected else state['apps'][short]
            if stable_config(app) != stable_config(expected):
                raise shared.ReleaseStopped(short + '_final_configuration_drift')
            sha = target['sha'] if short in selected else state['baseline'][short]['release']
            docker = expected['sourceType'] == 'docker'
            image = target['worker'] if short in selected and docker else expected.get('dockerImage') if docker else None
            manifest = state['targetManifest'] if short in selected else state['manifests'][sha]
            evidence = probe(short, app, sha, image=image, manifest=manifest, expected_runtime=state['runtime'][short],
                             require_revision=short in selected and not docker)
            settled = DEPLOYED_SETTLED_STATES if short in selected else BASELINE_SETTLED_STATES
            if evidence.get('ready') is not True or evidence.get('updateState') not in settled:
                raise shared.ReleaseStopped(short + '_final_runtime_not_ready')
            if short not in selected and (evidence.get('image') != state['baseline'][short]['image'] or
                                         evidence.get('specHash') != state['baseline'][short]['specHash']):
                raise shared.ReleaseStopped(short + '_unselected_runtime_changed')
        shared.monitor_gate(client, 'crawler', roles=('text', 'maintenance'), strict=tuple(
            role for role in ('text', 'maintenance') if role + '-m3' in selected))
    except Exception as error:
        summary = {'target': target, 'mode': state['mode'], 'deployed': sorted(deployed, key=ORDER.index),
                   'failed': sorted(failed, key=ORDER.index), 'touched': touched, 'waves': completed_waves,
                   'stopped': True, **shared.error_fields(error)}
        durable_json(destination / 'summary.json', summary)
        if not touched:
            raise
        raise GitRolloutStopped(summary) from error
    summary = {'target': target, 'mode': state['mode'], 'deployed': sorted(deployed, key=ORDER.index),
               'failed': [], 'touched': touched, 'waves': completed_waves, 'stopped': False,
               'skipped': state.get('skipped', [])}
    durable_json(destination / 'summary.json', summary)
    return summary
