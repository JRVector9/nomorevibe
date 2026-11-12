#!/usr/bin/env python3
"""Private full-fleet baseline collection and final runtime proofs.

All returned API/Docker records are secret-bearing rollback material. This module
never emits them, writes a file, mutates production, or retries a deployment.
"""
import copy
import importlib.util
import re
import shlex
import subprocess
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def _load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


git_rollout = _load('release_runtime_git', 'deploy_git_apps.py')
shared = git_rollout.shared
scope = _load('release_runtime_scope', 'deployment_scope.py')
SHA = re.compile(r'[a-f0-9]{40}')
IMAGE = re.compile(r'(?:[^\s@]+@)?sha256:[a-f0-9]{64}')


def registered_apps():
    return scope.registered_apps(shared.KNOWN_APPS, shared.CONSUMER_APPS)


def _fail(short, reason):
    raise ValueError(short + '_' + reason)


def git_tree(repo, sha):
    if not SHA.fullmatch(sha or ''):
        raise ValueError('invalid_source_release')
    result = subprocess.run(['git', '--no-replace-objects', '-C', str(repo), 'rev-parse', '--verify', sha + '^{tree}'],
                            capture_output=True, text=True, timeout=30)
    if result.returncode or not SHA.fullmatch(result.stdout.strip()):
        raise ValueError('source_tree_unknown')
    return result.stdout.strip()


def _api_ready(short, app, latest):
    identity, name, host, kind = shared.app_metadata(short)
    if (not isinstance(app, dict) or
            (app.get('applicationId'), app.get('name'), app.get('serverId')) != (identity, name, host[0]) or
            not re.fullmatch(r'[a-z0-9-]+', app.get('appName') or '')):
        _fail(short, 'identity_mismatch')
    if (app.get('applicationStatus') != 'done' or app.get('autoDeploy') is not False or
            not isinstance(latest, dict) or latest.get('status') != 'done' or
            not isinstance(latest.get('deploymentId'), str) or not latest['deploymentId']):
        _fail(short, 'api_not_ready')
    replicas = app.get('replicas')
    if type(replicas) is not int or not (1 <= replicas <= shared.WEB_MAX_REPLICAS if kind == 'web' else
                                       replicas == (shared.scheduler_replicas(short) if kind == 'scheduler' else 1)):
        _fail(short, 'replicas_mismatch')
    stage = 'runner' if kind == 'web' else kind if kind in ('connect-agent', 'monitor') else 'worker'
    if app.get('dockerBuildStage') != stage:
        _fail(short, 'stage_mismatch')
    if app.get('sourceType') == 'github':
        if (short not in git_rollout.ORDER or
                (str(app.get('owner', '')).lower(), app.get('repository'), app.get('branch'),
                 app.get('buildType'), app.get('dockerfile'), app.get('buildPath')) !=
                ('jrvector9', 'nomorevibe', 'main', 'dockerfile', 'Dockerfile', '/')):
            _fail(short, 'git_source_mismatch')
    elif (app.get('sourceType') != 'docker' or kind == 'connect-agent' or
          not re.fullmatch(re.escape(shared.IMAGE_PREFIX['web' if kind == 'web' else 'worker']) +
                           r'sha256:[a-f0-9]{64}', app.get('dockerImage') or '')):
        _fail(short, 'image_source_mismatch')
    release = shared.setting(app.get('env'), 'RELEASE_TAG')
    if not SHA.fullmatch(release):
        _fail(short, 'release_invalid')
    if kind == 'web':
        if (shared.setting(app.get('env'), 'NEXT_DEPLOYMENT_ID') != release or
                shared.setting(app.get('buildArgs'), 'NEXT_DEPLOYMENT_ID') != release):
            _fail(short, 'deployment_id_mismatch')
        shared.web_key_of(short, app)
    elif shared.setting(app.get('env'), 'WORKER_ROLE') != shared.app_role(short):
        _fail(short, 'role_mismatch')
    return release


def _env(values):
    # Each list element is one Docker env value, which may itself contain newlines.
    if not isinstance(values, list):
        raise ValueError('runtime_environment_invalid')
    result = {}
    for value in values:
        if not isinstance(value, str) or '=' not in value:
            raise ValueError('runtime_environment_invalid')
        key, value = value.split('=', 1)
        if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) or key in result:
            raise ValueError('runtime_environment_invalid')
        result[key] = value
    return result


def _command_matches(short, app, config, image_config):
    entry, cmd = config.get('Entrypoint') or [], config.get('Cmd') or []
    if not all(isinstance(part, list) and all(isinstance(value, str) for value in part) for part in (entry, cmd)):
        return False
    effective = entry + cmd
    configured = app.get('command')
    if configured:
        try:
            supplied = shlex.split(configured)
        except (ValueError, TypeError):
            return False
        if supplied != effective and not (supplied == cmd and entry == (image_config.get('Entrypoint') or [])):
            return False
    elif effective != (image_config.get('Entrypoint') or []) + (image_config.get('Cmd') or []):
        return False
    argv = effective[:]
    if argv[:2] == ['/sbin/tini', '--']:
        argv = argv[2:]
    if argv[:1] == ['docker-entrypoint.sh']:
        argv = argv[1:]
    kind, role = shared.app_metadata(short)[3], shared.app_role(short)
    if kind == 'web':
        return argv in (['./scripts/entrypoint.sh'], ['node', 'server.js'])
    prefix = ['node', '--import', 'tsx']
    if kind in ('connect-agent', 'monitor'):
        script = 'connect-agent.ts' if kind == 'connect-agent' else 'watch-failover-readiness.ts'
        return argv == prefix + ['scripts/' + script]
    expected = prefix + ['scripts/worker-supervisor.ts', '--role=' + role]
    if '-consumer-' in short:
        expected += ['--consumer=' + short.rsplit('-consumer-', 1)[0]]
    role_worker = prefix + ['scripts/role-worker.ts', '--role=' + role,
                           '--kind=' + ('standby' if short.endswith('-mini') else 'primary')]
    return argv == expected or (role in ('text', 'maintenance', 'crawler', 'reviewer', 'publisher') and
                                '-consumer-' not in short and argv == role_worker)


def _mounts_match(spec_mounts, actual):
    if not isinstance(spec_mounts, list) or not isinstance(actual, list) or len(spec_mounts) != len(actual):
        return False
    for wanted in spec_mounts:
        candidates = [row for row in actual if row.get('Destination') == wanted.get('Target')]
        if len(candidates) != 1:
            return False
        row = candidates[0]
        source = row.get('Name') if wanted.get('Type') == 'volume' else row.get('Source')
        if (row.get('Type') != wanted.get('Type') or source != wanted.get('Source') or
                row.get('RW') is not (not wanted.get('ReadOnly', False))):
            return False
    return True


def _runtime_state(short, app, runtime, release, manifest, repo):
    """Validate actual bytes, roles, image provenance, rendered env and health."""
    if not isinstance(runtime, dict):
        _fail(short, 'runtime_unknown')
    spec = runtime.get('serviceSpec')
    if not isinstance(spec, dict) or runtime.get('specHash') != git_rollout.spec_hash(spec):
        _fail(short, 'runtime_spec_invalid')
    cs = (spec.get('TaskTemplate') or {}).get('ContainerSpec') or {}
    containers = runtime.get('containers')
    if (not isinstance(runtime.get('serviceId'), str) or not runtime['serviceId'] or
            type((runtime.get('version') or {}).get('Index')) is not int or
            (runtime.get('updateStatus') or {}).get('State') not in shared.SWARM_SETTLED_STATES or
            spec.get('Name') != app['appName'] or
            (spec.get('Mode') or {}).get('Replicated', {}).get('Replicas') != app['replicas'] or
            not isinstance(containers, list) or len(containers) != app['replicas']):
        _fail(short, 'runtime_not_ready')
    service_env = _env(cs.get('Env'))
    if service_env.get('RELEASE_TAG') != release:
        _fail(short, 'runtime_release_mismatch')
    if app['sourceType'] == 'docker' and cs.get('Image') != app['dockerImage']:
        _fail(short, 'runtime_image_mismatch')
    images = runtime.get('images')
    if not isinstance(images, list) or not images:
        _fail(short, 'runtime_image_unknown')
    kind, role = shared.app_metadata(short)[3], shared.app_role(short)
    ids = set()
    for container in containers:
        config = container.get('config') or {}
        state = container.get('state') or {}
        image_rows = [row for row in images if row.get('Id') == container.get('image')]
        if len(image_rows) != 1 or not IMAGE.fullmatch(container.get('image') or ''):
            _fail(short, 'container_image_unknown')
        image_config = image_rows[0].get('Config') or {}
        rendered_env = _env(image_config.get('Env') or [])
        rendered_env.update(service_env)
        actual_env = _env(config.get('Env'))
        if (actual_env != rendered_env or config.get('Image') != cs.get('Image') or
                (config.get('Labels') or {}).get('com.docker.swarm.service.name') != app['appName'] or
                state.get('Running') is not True or not _command_matches(short, app, config, image_config) or
                not _mounts_match(cs.get('Mounts') or [], container.get('mounts'))):
            _fail(short, 'container_contract_mismatch')
        if kind == 'web':
            labels = image_config.get('Labels') or {}
            health = container.get('directHealth') or {}
            body = health.get('body') or {}
            expected_health = cs.get('Healthcheck') if 'Healthcheck' in cs else image_config.get('Healthcheck')
            if (labels.get('org.opencontainers.image.revision') != release or
                    labels.get('dev.nomorevibe.tree') != git_tree(repo, release) or
                    config.get('Healthcheck') != expected_health or
                    (expected_health is not None and (state.get('Health') or {}).get('Status') != 'healthy') or
                    actual_env.get('NEXT_DEPLOYMENT_ID') != release or health.get('status') != 200 or
                    (body.get('status'), body.get('db'), body.get('release')) != ('ok', 'ok', release)):
                _fail(short, 'web_provenance_or_health_mismatch')
        else:
            health = config.get('Healthcheck') or {}
            test = ' '.join(health.get('Test') or [])
            expected_health = cs.get('Healthcheck') if 'Healthcheck' in cs else image_config.get('Healthcheck')
            if (actual_env.get('WORKER_ROLE') != role or (state.get('Health') or {}).get('Status') != 'healthy' or
                    not manifest or container.get('codeHashes') != manifest or health != expected_health):
                _fail(short, 'worker_source_or_health_mismatch')
            if kind == 'connect-agent':
                valid_health = '127.0.0.1:3020/rpc' in test and '401' in test
            else:
                valid_health = ('scripts/monitor-healthcheck.ts' if kind == 'monitor' else 'scripts/worker-healthcheck.ts') in test
            if not valid_health:
                _fail(short, 'healthcheck_contract_mismatch')
        ids.add(container['image'])
    if len(ids) != 1:
        _fail(short, 'mixed_runtime_images')
    image = cs['Image'] if app['sourceType'] == 'docker' else next(iter(ids))
    return {'release': release, 'image': image, 'specHash': git_rollout.spec_hash(spec)}


def _manifest(short, release, repo, cache):
    kind = shared.app_metadata(short)[3]
    if kind == 'web':
        return None
    stage = kind if kind in ('monitor', 'connect-agent') else 'worker'
    key = (release, stage)
    if key not in cache:
        cache[key] = git_rollout.source_manifest(release, stage=stage, repo=repo)
    return cache[key]


def _parallel(function, names):
    with ThreadPoolExecutor(max_workers=4) as pool:
        return dict(zip(names, pool.map(function, names)))


def _same_runtime_window(old, current):
    if any(old.get(key) != current.get(key) for key in ('serviceId', 'version', 'serviceSpec', 'specHash')):
        return False
    def containers(value):
        return sorted(({'id': row.get('id'), 'image': row.get('image'), 'config': row.get('config'),
                        'mounts': row.get('mounts'), 'running': (row.get('state') or {}).get('Running'),
                        'health': ((row.get('state') or {}).get('Health') or {}).get('Status')}
                       for row in value.get('containers') or []), key=lambda row: row['id'])
    return (containers(old) == containers(current) and
            (current.get('updateStatus') or {}).get('State') in shared.SWARM_SETTLED_STATES)


def collect_baseline(client, repo):
    """Read every registered app with at most four concurrent reads, then prove a stable window.

    The readback checks actual service/container identities and configuration. It
    does not hash the same remote source bytes a second time.
    """
    names = registered_apps()
    def api(short):
        app, latest = copy.deepcopy(client.app(short)), copy.deepcopy(client.latest(short))
        return app, latest, _api_ready(short, app, latest)
    originals = _parallel(api, names)
    manifests = {}
    for short in names:
        _manifest(short, originals[short][2], repo, manifests)
    def inspect(short):
        app, latest, release = originals[short]
        manifest = _manifest(short, release, repo, manifests)
        raw = git_rollout.inspect_runtime(short, app, manifest=manifest)
        return raw, _runtime_state(short, app, raw, release, manifest, repo)
    runtimes = _parallel(inspect, names)
    snapshot = {'schemaVersion': 1, 'apps': {}, 'runtime': {}, 'baseline': {}, 'latest': {}}
    web_key = None
    for short in names:
        app, latest, _ = originals[short]
        if shared.app_metadata(short)[3] == 'web':
            web_key = shared.web_key_of(short, app, web_key)
        snapshot['apps'][short], snapshot['latest'][short] = app, latest
        snapshot['runtime'][short], snapshot['baseline'][short] = copy.deepcopy(runtimes[short])
    def readback(short):
        app, latest, release = api(short)
        current = git_rollout.inspect_runtime(short, app)
        if (git_rollout.stable_config(app) != git_rollout.stable_config(snapshot['apps'][short]) or
                latest.get('deploymentId') != snapshot['latest'][short].get('deploymentId') or
                not _same_runtime_window(snapshot['runtime'][short], current)):
            _fail(short, 'changed_during_collection')
        return True
    _parallel(readback, names)
    return snapshot


def expected_api(short, original, target, retired_settings=()):
    """Exact permitted API changes; all other settings and secret text stay byte-for-byte.

    retired_settings are deleted from the saved env of Git and Docker apps alike (deploy_release --retire-setting).
    """
    kind = shared.app_metadata(short)[3]
    if kind == 'connect-agent':
        return git_rollout.expected_config(short, original, target, 'shared-worker', retired_settings)
    expected = copy.deepcopy(original)
    expected['env'] = shared.replace_setting(original['env'], 'RELEASE_TAG', target['sha'])
    if kind == 'web':
        expected['env'] = shared.replace_setting(expected['env'], 'NEXT_DEPLOYMENT_ID', target['sha'])
        expected['buildArgs'] = shared.replace_setting(original.get('buildArgs'), 'NEXT_DEPLOYMENT_ID', target['sha'])
    if retired_settings:
        expected['env'] = shared.drop_settings(expected['env'], retired_settings)
    if kind != 'connect-agent':
        expected['sourceType'] = 'docker'
        expected['dockerImage'] = target['web' if kind == 'web' else 'worker']
    return expected


def _preserves_containers(original, current, sha, kind, *, web_image=None, retired_settings=()):
    for row in current['containers']:
        actual = row.get('config') or {}
        matches = False
        for old in original['containers']:
            wanted = old.get('config') or {}
            env = _env(wanted.get('Env'))
            env['RELEASE_TAG'] = sha
            if kind == 'web':
                env['NEXT_DEPLOYMENT_ID'] = sha
            # The container renders without a retired setting; one that is still rendered is drift, not tolerance.
            for key in retired_settings:
                env.pop(key, None)
            health_matches = (actual.get('Healthcheck') == wanted.get('Healthcheck') or
                (kind == 'web' and git_rollout._inherited_web_healthcheck_matches(original, current, old, row, sha, web_image)))
            if (_env(actual.get('Env')) == env and row.get('mounts') == old.get('mounts') and health_matches and all(
                    actual.get(key) == wanted.get(key) for key in
                    ('Cmd', 'Entrypoint', 'User', 'WorkingDir', 'ExposedPorts', 'Volumes', 'StopSignal'))):
                matches = True
                break
        if not matches:
            return False
    return True


def rolled_back_to_original(snapshot, short, repo):
    """After a Swarm rollback: is the service the plan's exact original again? Read only; never raises.

    The same proof verify_fleet holds a retained app to (service identity, exact spec, release, image, rendered
    containers, health and source bytes of the original release), plus Swarm reporting the rollback settled
    (rollback_completed). Swarm restores the previous spec itself, so anything else, including an unreadable
    runtime, is False: the caller must not redeploy on an unproven state.
    """
    try:
        original, old_runtime, baseline = snapshot['apps'][short], snapshot['runtime'][short], snapshot['baseline'][short]
        release = baseline['release']
        manifest = _manifest(short, release, repo, {})
        raw = git_rollout.inspect_runtime(short, original, manifest=manifest)
        return bool((raw.get('updateStatus') or {}).get('State') == 'rollback_completed' and
                    raw.get('serviceId') == old_runtime.get('serviceId') and
                    raw.get('serviceSpec') == old_runtime.get('serviceSpec') and
                    _runtime_state(short, original, raw, release, manifest, repo) == baseline and
                    _preserves_containers(old_runtime, raw, release, shared.app_metadata(short)[3]))
    except Exception:
        return False


def verify_fleet(client, snapshot, target, selected, receipts, repo, *, output_snapshot=None, retired_settings=()):
    """Prove selected new runtimes and retained exact originals; return safe state hashes.

    With retired_settings, every selected app must have lost exactly those names from its saved env, its service
    spec and its containers; retained apps are still held to their exact originals, retired names included.
    """
    target = shared.validate_target(target['sha'], target['worker'], target['web'])
    names = registered_apps()
    apps = set(names)
    if (not isinstance(snapshot, dict) or snapshot.get('schemaVersion') != 1 or snapshot.get('target') != target or
            any(not isinstance(snapshot.get(key), dict) or set(snapshot[key]) != apps for key in
                ('apps', 'runtime', 'baseline', 'latest')) or not isinstance(selected, (tuple, list)) or
            len(selected) != len(set(selected)) or set(selected) - apps or not isinstance(receipts, dict) or
            set(receipts) != set(selected) or (output_snapshot is not None and not isinstance(output_snapshot, dict)) or
            not isinstance(retired_settings, (tuple, list)) or any(not isinstance(name, str) for name in retired_settings)):
        raise ValueError('fleet_verification_contract_invalid')
    retired = tuple(retired_settings)
    selected = set(selected)
    manifests = {}
    # Local Git archives are cached before parallel remote reads; no remote source is read twice.
    for short in names:
        _manifest(short, snapshot['baseline'][short]['release'], repo, manifests)
        if short in selected:
            _manifest(short, target['sha'], repo, manifests)
    def verify(short):
        previous, old_runtime = snapshot['apps'][short], snapshot['runtime'][short]
        old_release = _api_ready(short, previous, snapshot['latest'][short])
        old_manifest = _manifest(short, old_release, repo, manifests)
        if _runtime_state(short, previous, old_runtime, old_release, old_manifest, repo) != snapshot['baseline'][short]:
            _fail(short, 'baseline_evidence_mismatch')
        app, latest = client.app(short), client.latest(short)
        release = _api_ready(short, app, latest)
        wanted = expected_api(short, previous, target, retired) if short in selected else previous
        if git_rollout.stable_config(app) != git_rollout.stable_config(wanted):
            _fail(short, 'final_configuration_drift')
        old_deployment = snapshot['latest'][short].get('deploymentId')
        if short in selected:
            receipt = receipts[short]
            if (not isinstance(receipt, dict) or not receipt.get('deploymentId') or
                    receipt['deploymentId'] != latest.get('deploymentId') or receipt['deploymentId'] == old_deployment):
                _fail(short, 'completion_receipt_mismatch')
        elif latest.get('deploymentId') != old_deployment:
            _fail(short, 'retained_deployment_changed')
        manifest = _manifest(short, release, repo, manifests)
        raw = git_rollout.inspect_runtime(short, app, manifest=manifest)
        actual = _runtime_state(short, app, raw, release, manifest, repo)
        if raw.get('serviceId') != old_runtime.get('serviceId'):
            _fail(short, 'service_identity_changed')
        if short in selected:
            kind = shared.app_metadata(short)[3]
            if kind == 'connect-agent':
                for container in raw['containers']:
                    image = next(row for row in raw['images'] if row.get('Id') == container['image'])
                    if ((image.get('Config') or {}).get('Labels') or {}).get('org.opencontainers.image.revision') != target['sha']:
                        _fail(short, 'image_revision_mismatch')
            if ((raw.get('updateStatus') or {}).get('State') not in (None, 'completed') or
                    not git_rollout.runtime_contract_matches(old_runtime, raw, target['sha'],
                        deployment_id=target['sha'] if kind == 'web' else None,
                        web_image=target['web'] if kind == 'web' else None, retired_settings=retired) or
                    not _preserves_containers(old_runtime, raw, target['sha'], kind,
                        web_image=target['web'] if kind == 'web' else None, retired_settings=retired)):
                _fail(short, 'selected_runtime_contract_drift')
        elif (raw.get('serviceSpec') != old_runtime.get('serviceSpec') or
              actual != snapshot['baseline'][short] or
              not _preserves_containers(old_runtime, raw, snapshot['baseline'][short]['release'], shared.app_metadata(short)[3])):
            _fail(short, 'retained_runtime_drift')
        return actual, copy.deepcopy(app), copy.deepcopy(raw), copy.deepcopy(latest)
    results = _parallel(verify, names)
    observed = {short: results[short][0] for short in names}
    if output_snapshot is not None:
        output_snapshot.clear()
        output_snapshot.update({'schemaVersion': 1, 'target': copy.deepcopy(target),
            'apps': {short: results[short][1] for short in names},
            'runtime': {short: results[short][2] for short in names},
            'baseline': copy.deepcopy(observed), 'latest': {short: results[short][3] for short in names}})
    return observed
