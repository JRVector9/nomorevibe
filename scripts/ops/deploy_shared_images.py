#!/usr/bin/env python3
"""Deploy one immutable web/worker release and gate every production step.

Runs on the operator's Mac with GitHub CLI, Keychain, Docker SSH access, and curl.
No secret or raw Dokploy application response is written to stdout.
"""

import argparse
import hashlib
import json
import os
import re
import shlex
import subprocess
import time
from pathlib import Path


BASE = 'https://deploy.brut.bot/api/'
M3 = ('KenKHh2MQuS7blLN_NSem', '100.92.77.66')
MINI = ('uHWg5--LEJ2lnVcgDm-NB', '100.116.119.93')
APPS = {
    'publisher-mini': ('DWncl_MAWSx83j-qfNSyW', 'nomorevibe-publisher-standby-mini', MINI, 'worker'),
    'publisher-m3': ('AeTaWnZbZKzzv94h7c8Vw', 'nomorevibe-publisher-m3', M3, 'worker'),
    'reviewer-mini': ('Len0UIDDJlawK2jvnnPjl', 'nomorevibe-reviewer-standby-mini', MINI, 'worker'),
    'reviewer-m3': ('4RlA9EeKvtKGdR6c6AV4j', 'nomorevibe-reviewer-m3', M3, 'worker'),
    'crawler-mini': ('GfIKV_iTLs3uifo-A3ate', 'nomorevibe-crawler-standby-mini', MINI, 'worker'),
    'crawler-m3': ('AFHDBGCCY4zT9XkkcnzGd', 'nomorevibe-crawler-m3', M3, 'worker'),
    'web-mini': ('llv4rlABSJOcFauSxaHdx', 'nomorevibe-web-mini', MINI, 'web'),
    'web-m3': ('oipo2OAnIrtcnILBCRoG2', 'nomorevibe-web-m3', M3, 'web'),
}
ORDER = tuple(APPS)
IMAGE_PREFIX = {
    'worker': 'ghcr.io/jrvector9/nomorevibe-worker@',
    'web': 'ghcr.io/jrvector9/nomorevibe-runtime-web@',
}


def run(command, *, input_text=None, timeout=45):
    result = subprocess.run(command, input=input_text, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'command_failed:{command[0]}:{result.returncode}')
    return result.stdout.strip()


def validate_target(sha, worker, web):
    if not re.fullmatch(r'[0-9a-f]{40}', sha):
        raise ValueError('invalid_release_sha')
    for kind, image in (('worker', worker), ('web', web)):
        if not re.fullmatch(re.escape(IMAGE_PREFIX[kind]) + r'sha256:[0-9a-f]{64}', image):
            raise ValueError(f'invalid_{kind}_image')
    return {'sha': sha, 'worker': worker, 'web': web}


def replace_setting(value, key, replacement):
    if not isinstance(value, str):
        raise ValueError(f'missing_{key}')
    result, count = re.subn(r'(?m)^' + re.escape(key) + r'=.*$',
                            lambda _: key + '=' + replacement, value)
    if count != 1:
        raise ValueError(f'{key}_line_count_{count}')
    return result


def setting(value, key):
    rows = [line.split('=', 1)[1] for line in (value or '').splitlines()
            if line.startswith(key + '=')]
    if len(rows) != 1:
        raise ValueError(f'{key}_line_count_{len(rows)}')
    return rows[0]


class Dokploy:
    def __init__(self, key):
        self.key = key

    def request(self, path, payload=None):
        read_fd, write_fd = os.pipe()
        try:
            os.write(write_fd, ('header = ' + json.dumps('x-api-key: ' + self.key) + '\n').encode())
            os.close(write_fd)
            write_fd = -1
            command = ['curl', '-fsS', '--connect-timeout', '10', '--max-time', '30',
                       '--config', f'/dev/fd/{read_fd}']
            if payload is not None:
                command += ['-H', 'Content-Type: application/json', '--data-binary', '@-']
            command += [BASE + path]
            result = subprocess.run(command, input=json.dumps(payload) if payload is not None else None,
                                    text=True, capture_output=True, pass_fds=(read_fd,), timeout=35)
            if result.returncode:
                raise RuntimeError(f'dokploy_api_failed:{path}:{result.returncode}')
            return json.loads(result.stdout) if payload is None else None
        finally:
            os.close(read_fd)
            if write_fd >= 0:
                os.close(write_fd)

    def app(self, short):
        app_id, expected_name, (server_id, _), kind = APPS[short]
        app = self.request('application.one?applicationId=' + app_id)
        if (app.get('applicationId'), app.get('name'), app.get('serverId'),
                app.get('dockerBuildStage')) != (app_id, expected_name, server_id,
                                                 'worker' if kind == 'worker' else 'runner'):
            raise ValueError(f'{short}_identity_mismatch')
        if not re.fullmatch(r'[a-z0-9-]+', app.get('appName') or ''):
            raise ValueError(f'{short}_invalid_service_name')
        return app

    def latest(self, short):
        rows = self.request('deployment.all?applicationId=' + APPS[short][0])
        if not rows:
            raise ValueError(f'{short}_missing_deployment')
        return rows[0]


# expected: Dokploy 에 적힌 복제본 수, 또는 'any'(실행 중인 수가 원하는 수와 같기만 하면 — 배포 전 기준선).
# 웹은 여러 대가 같은 요청을 나눠 받으므로 모든 컨테이너가 새 이미지·릴리스·상태 확인을 통과해야 준비다.
REMOTE_PROBE = r'''import json,subprocess,sys
service,image,sha,kind,expected=sys.argv[1:]
def command(*args):
 r=subprocess.run(args,capture_output=True,text=True)
 return r.stdout.strip() if r.returncode==0 else ''
def container(cid):
 c={'ok':False}
 raw=command('docker','inspect',cid)
 if not raw: return c
 row=json.loads(raw)[0]
 env=dict(line.split('=',1) for line in row['Config'].get('Env',[]) if '=' in line)
 labels=row['Config'].get('Labels') or {}
 state=row.get('State') or {}
 c['containerImageMatch']=row['Config'].get('Image')==image
 c['releaseMatch']=env.get('RELEASE_TAG')==sha
 c['serviceLabelMatch']=labels.get('com.docker.swarm.service.name')==service
 c['running']=state.get('Running') is True
 c['health']=((state.get('Health') or {}).get('Status'))
 c['deploymentIdMatch']=kind!='web' or env.get('NEXT_DEPLOYMENT_ID')==sha
 if kind=='web' and all(c.get(key) for key in ('containerImageMatch','releaseMatch','running')):
  script="fetch('http://'+process.env.HOSTNAME+':3000/api/health').then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))"
  try:
   health=json.loads(command('docker','exec',cid,'node','-e',script))
   c['webHealthMatch']=(health.get('status'),health.get('db'),health.get('release'))==('ok','ok',sha)
   c['instanceId']=health.get('instanceId')
  except Exception: c['webHealthMatch']=False
 c['ok']=bool(c.get('containerImageMatch') and c.get('releaseMatch') and
  c.get('serviceLabelMatch') and c.get('running') and
  (c.get('health')=='healthy' if kind=='worker' else c.get('webHealthMatch')) and
  c.get('deploymentIdMatch'))
 return c
rows=[line.split('\t') for line in command('docker','service','ls','--format','{{.Name}}\t{{.Image}}\t{{.Replicas}}').splitlines()]
matches=[row for row in rows if len(row)==3 and row[0]==service]
result={'ready':False,'serviceFound':len(matches)==1}
if len(matches)==1:
 result['serviceImageMatch']=matches[0][1]==image
 result['replicas']=matches[0][2]
 running,_,desired=matches[0][2].partition('/')
 result['replicasMatch']=(running==desired and desired.isdigit() and int(desired)>=1 and
  (expected=='any' or desired==expected))
 ids=command('docker','ps','--filter','name='+service,'--format','{{.ID}}').splitlines()
 result['containers']=len(ids)
 if result['replicasMatch'] and len(ids)==int(desired):
  checks=[container(cid) for cid in ids]
  result['containersReady']=sum(1 for c in checks if c['ok'])
  ids_seen=sorted({c['instanceId'] for c in checks if c.get('instanceId')})
  if ids_seen: result['instanceId']=','.join(ids_seen)
  result['ready']=bool(result['serviceImageMatch'] and all(c['ok'] for c in checks))
print(json.dumps(result))
'''


def ssh_python(host, source, *args, input_text=None, timeout=40):
    command = 'python3 -c ' + shlex.quote(source) + ''.join(' ' + shlex.quote(arg) for arg in args)
    return run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
                'root@' + host, command], input_text=input_text, timeout=timeout)


WEB_MAX_REPLICAS = 8


def replicas_allowed(kind, replicas):
    """워커는 역할 lease 로 한 후보만 일하므로 한 대, 웹은 여러 대가 요청을 나눠 받는다(2026-10-06 M3 4·mini 2)."""
    if kind == 'worker':
        return replicas == 1
    return isinstance(replicas, int) and not isinstance(replicas, bool) and 1 <= replicas <= WEB_MAX_REPLICAS


def probe(short, app, target, expected='any'):
    kind = APPS[short][3]
    raw = ssh_python(APPS[short][2][1], REMOTE_PROBE, app['appName'], target[kind],
                     target['sha'], kind, str(expected))
    return json.loads(raw)


def check_app_deployed(client, short, target, previous_id, *, timeout=None, pause=5):
    if timeout is None:
        # Swarm 은 한 대씩 새로 띄우고 30초 지켜본 뒤 다음으로 넘어간다 — 복제본마다 시간을 더 준다
        timeout = 240 + 90 * (max(1, client.app(short).get('replicas') or 1) - 1)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            app = client.app(short)
            latest = client.latest(short)
        except (RuntimeError, subprocess.TimeoutExpired):
            time.sleep(pause)
            continue
        if app.get('applicationStatus') == 'error' or latest.get('status') == 'error':
            raise RuntimeError(f'{short}_deployment_error')
        if latest.get('deploymentId') != previous_id and app.get('applicationStatus') == 'done' and latest.get('status') == 'done':
            if app.get('sourceType') != 'docker' or app.get('dockerImage') != target[APPS[short][3]] or setting(app.get('env'), 'RELEASE_TAG') != target['sha']:
                raise RuntimeError(f'{short}_configuration_drift')
            try:
                evidence = probe(short, app, target, app.get('replicas'))
            except (RuntimeError, json.JSONDecodeError, subprocess.TimeoutExpired):
                evidence = {'ready': False}
            if evidence.get('ready') is True:
                return {'app': short, 'deployment': 'done', 'service': 'healthy',
                        'instanceId': evidence.get('instanceId')}
        time.sleep(pause)
    raise TimeoutError(f'{short}_verification_timeout')


REMOTE_PULL = r'''import json,os,subprocess,sys,tempfile
images=json.loads(sys.argv[1]);sha=sys.argv[2];key_hash=sys.argv[3];token=sys.stdin.read()
with tempfile.TemporaryDirectory(prefix='nmv-release-pull-') as directory:
 env={**os.environ,'DOCKER_CONFIG':directory}
 login=subprocess.run(['docker','login','ghcr.io','-u','JRVector9','--password-stdin'],
                      input=token,capture_output=True,text=True,env=env)
 if login.returncode: raise SystemExit('docker_login_failed')
 for kind,image in images.items():
  pull=subprocess.run(['docker','pull',image],capture_output=True,text=True,env=env)
  if pull.returncode: raise SystemExit(kind+'_pull_failed')
  inspect=subprocess.run(['docker','image','inspect',image],capture_output=True,text=True,env=env)
  if inspect.returncode: raise SystemExit(kind+'_inspect_failed')
  row=json.loads(inspect.stdout)[0]
  if row.get('Architecture')!='arm64' or (row.get('Config',{}).get('Labels') or {}).get('org.opencontainers.image.revision')!=sha:
   raise SystemExit(kind+'_identity_mismatch')
 script="const fs=require('node:fs');const crypto=require('node:crypto');const j=JSON.parse(fs.readFileSync('/app/.next/server/server-reference-manifest.json','utf8'));console.log(crypto.createHash('sha256').update(j.encryptionKey).digest('hex'))"
 if kind=='web':
  check=subprocess.run(['docker','run','--rm','--network','none','--read-only','--entrypoint','node',image,'-e',script],
                       capture_output=True,text=True,env=env,timeout=30)
  if check.returncode or check.stdout.strip()!=key_hash: raise SystemExit('web_build_key_mismatch')
print(json.dumps({'pulled':True,'architecture':'arm64','revision':sha}))
'''


REMOTE_MONITOR = r'''import json,subprocess,sys
service=sys.argv[1]
ids=subprocess.run(['docker','ps','--filter','name='+service,'--format','{{.ID}}'],
                   capture_output=True,text=True,check=True).stdout.strip().splitlines()
if len(ids)!=1: raise SystemExit('monitor_container_count')
reports={}
for name in ('check-failover-readiness.ts','check-worker-progress.ts'):
 result=subprocess.run(['docker','exec',ids[0],'node','--import','tsx','scripts/'+name],
                       capture_output=True,text=True,timeout=35)
 try: reports[name]=json.loads(result.stdout.strip())
 except Exception: reports[name]={'overall':'unknown'}
print(json.dumps(reports))
'''


def main_sha_and_token(target):
    if run(['gh', 'api', 'user', '--jq', '.login']) != 'JRVector9':
        raise ValueError('github_account_mismatch')
    if run(['gh', 'api', 'repos/JRVector9/nomorevibe/commits/main', '--jq', '.sha']) != target['sha']:
        raise ValueError('main_sha_mismatch')
    if run(['gh', 'api', 'user/packages/container/nomorevibe-runtime-web', '--jq', '.visibility']) != 'private':
        raise ValueError('web_package_not_private')
    return run(['gh', 'auth', 'token'])


def baseline(client, target):
    apps = {}
    release = None
    old_images = {}
    web_key = None
    for short in ORDER:
        app = client.app(short)
        latest = client.latest(short)
        kind = APPS[short][3]
        current_release = setting(app.get('env'), 'RELEASE_TAG')
        current_image = app.get('dockerImage')
        if (app.get('sourceType') != 'docker' or app.get('applicationStatus') != 'done' or
                latest.get('status') != 'done' or app.get('autoDeploy') is not False or
                not replicas_allowed(kind, app.get('replicas')) or not isinstance(current_image, str) or
                not current_image.startswith(IMAGE_PREFIX[kind])):
            raise ValueError(f'{short}_baseline_not_ready')
        if release is None:
            release = current_release
        if release != current_release or (kind in old_images and old_images[kind] != current_image):
            raise ValueError(f'{short}_baseline_release_mismatch')
        old_images[kind] = current_image
        if kind == 'web':
            runtime_key = setting(app.get('env'), 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY')
            build_key = setting(app.get('buildSecrets'), 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY')
            if not runtime_key or runtime_key != build_key or (web_key and web_key != runtime_key):
                raise ValueError(f'{short}_web_key_mismatch')
            if setting(app.get('env'), 'NEXT_DEPLOYMENT_ID') != current_release:
                raise ValueError(f'{short}_deployment_id_mismatch')
            web_key = runtime_key
        apps[short] = app
    if release == target['sha']:
        raise ValueError('target_release_already_running')
    previous = {'sha': release, **old_images}
    for short in ORDER:
        if not probe(short, apps[short], previous).get('ready'):
            raise ValueError(f'{short}_baseline_runtime_not_ready')
    return {'apps': apps, 'previous': previous}


def pre_pull(target, token, current_web_key):
    key_hash = hashlib.sha256(current_web_key.encode()).hexdigest()
    for label, (_, host) in (('mini', MINI), ('m3', M3)):
        result = json.loads(ssh_python(host, REMOTE_PULL,
                                      json.dumps({'worker': target['worker'], 'web': target['web']}),
                                      target['sha'], key_hash, input_text=token, timeout=180))
        if result.get('pulled') is not True:
            raise RuntimeError(f'{label}_prepull_failed')
        print(json.dumps({'server': label, 'imagesPulled': True}), flush=True)


def save_snapshot(path, target, state):
    destination = Path(path)
    if not destination.is_absolute() or destination.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError('snapshot_must_be_absolute_outside_repository')
    content = json.dumps({'target': target, **state}, indent=2)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as file:
        file.write(content)
    return destination


def stage_and_deploy(client, short, target, token, previous):
    app = client.app(short)
    kind = APPS[short][3]
    if (app.get('applicationStatus') != 'done' or app.get('autoDeploy') is not False or
            app.get('dockerImage') != previous[kind] or
            setting(app.get('env'), 'RELEASE_TAG') != previous['sha'] or
            client.latest(short).get('status') != 'done'):
        raise ValueError(f'{short}_changed_since_preflight')
    previous_id = client.latest(short)['deploymentId']
    env = replace_setting(app.get('env'), 'RELEASE_TAG', target['sha'])
    build_args = app.get('buildArgs')
    if kind == 'web':
        env = replace_setting(env, 'NEXT_DEPLOYMENT_ID', target['sha'])
        build_args = replace_setting(build_args, 'NEXT_DEPLOYMENT_ID', target['sha'])
    client.request('application.saveEnvironment', {
        'applicationId': APPS[short][0], 'env': env, 'buildArgs': build_args,
        'buildSecrets': app.get('buildSecrets'), 'createEnvFile': app.get('createEnvFile') is True,
    })
    client.request('application.saveDockerProvider', {
        'applicationId': APPS[short][0], 'dockerImage': target[kind],
        'username': 'JRVector9' if kind == 'web' else None,
        'password': token if kind == 'web' else None,
        'registryUrl': 'ghcr.io' if kind == 'web' else None,
    })
    configured = client.app(short)
    if (configured.get('sourceType') != 'docker' or configured.get('dockerImage') != target[kind] or
            setting(configured.get('env'), 'RELEASE_TAG') != target['sha'] or
            configured.get('command') != app.get('command') or
            configured.get('autoDeploy') is not False):
        raise RuntimeError(f'{short}_saved_configuration_mismatch')
    if kind == 'web' and (setting(configured.get('env'), 'NEXT_DEPLOYMENT_ID') != target['sha'] or
                          setting(configured.get('buildArgs'), 'NEXT_DEPLOYMENT_ID') != target['sha']):
        raise RuntimeError(f'{short}_saved_web_deployment_id_mismatch')
    client.request('application.deploy', {'applicationId': APPS[short][0]})
    return check_app_deployed(client, short, target, previous_id)


def monitor_gate(client, role, *, timeout=120, pause=5):
    deadline = time.monotonic() + timeout
    short = role + '-m3'
    app = client.app(short)
    while time.monotonic() < deadline:
        try:
            reports = json.loads(ssh_python(M3[1], REMOTE_MONITOR, app['appName'], timeout=80))
            monitor = reports['check-failover-readiness.ts']
            readiness = monitor.get('readiness') or {}
            progress = reports['check-worker-progress.ts']
            role_status = next((row for row in readiness.get('roles', []) if row.get('role') == role), None)
            if (monitor.get('overall') == 'ok' and readiness.get('overall') == 'ok' and
                    progress.get('overall') == 'ok' and
                    role_status and role_status.get('reason') == 'ready'):
                return {'role': role, 'readiness': 'ready', 'progress': 'ok'}
        except (RuntimeError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
            pass
        time.sleep(pause)
    raise TimeoutError(f'{role}_monitor_gate_timeout')


def public_gate(sha, *, attempts=24):
    seen = set()
    for _ in range(attempts):
        try:
            health = json.loads(run(['curl', '-fsS', '--max-time', '10',
                                     'https://nomorevibe.brut.bot/api/health'], timeout=12))
            if (health.get('status'), health.get('db'), health.get('release')) == ('ok', 'ok', sha):
                seen.add(health.get('instanceId'))
                if seen == {'mini-web', 'm3-web'}:
                    return {'publicHealth': 'ok', 'instances': sorted(seen)}
        except (RuntimeError, ValueError):
            pass
    raise TimeoutError('public_health_gate_timeout')


def deploy(client, target, token, state, snapshot):
    save_snapshot(snapshot, target, state)
    print(json.dumps({'snapshot': snapshot, 'preflight': 'passed'}), flush=True)
    try:
        for role in ('publisher', 'reviewer', 'crawler'):
            for short in (role + '-mini', role + '-m3'):
                print(json.dumps(stage_and_deploy(client, short, target, token,
                                                  state['previous'])), flush=True)
            print(json.dumps(monitor_gate(client, role)), flush=True)
        for short in ('web-mini', 'web-m3'):
            print(json.dumps(stage_and_deploy(client, short, target, token,
                                              state['previous'])), flush=True)
        print(json.dumps(public_gate(target['sha'])), flush=True)
    except Exception:
        print(json.dumps({'stopped': True, 'snapshot': snapshot,
                          'nextStep': 'restore affected app or pair before retrying'}), flush=True)
        raise


def restore(client, snapshot_path, short, token):
    path = Path(snapshot_path)
    if not path.is_absolute() or path.stat().st_mode & 0o077:
        raise ValueError('snapshot_permissions_or_path_invalid')
    snapshot = json.loads(path.read_text())
    if short not in APPS or short not in snapshot.get('apps', {}):
        raise ValueError('app_missing_from_snapshot')
    original = snapshot['apps'][short]
    current = client.app(short)
    kind = APPS[short][3]
    previous = snapshot['previous']
    if (current['appName'] != original['appName'] or current.get('sourceType') != 'docker' or
            current.get('dockerImage') not in (previous[kind], snapshot['target'][kind]) or
            current.get('autoDeploy') is not False):
        raise ValueError(f'{short}_restore_preflight_mismatch')
    previous_id = client.latest(short)['deploymentId']
    client.request('application.saveEnvironment', {
        'applicationId': APPS[short][0], 'env': original['env'],
        'buildArgs': original.get('buildArgs'), 'buildSecrets': original.get('buildSecrets'),
        'createEnvFile': original.get('createEnvFile') is True,
    })
    client.request('application.saveDockerProvider', {
        'applicationId': APPS[short][0], 'dockerImage': previous[kind],
        'username': 'JRVector9' if kind == 'web' else None,
        'password': token if kind == 'web' else None,
        'registryUrl': 'ghcr.io' if kind == 'web' else None,
    })
    configured = client.app(short)
    if (configured.get('dockerImage') != previous[kind] or
            setting(configured.get('env'), 'RELEASE_TAG') != previous['sha']):
        raise RuntimeError(f'{short}_restore_configuration_mismatch')
    client.request('application.deploy', {'applicationId': APPS[short][0]})
    return check_app_deployed(client, short, previous, previous_id)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'run', 'restore'))
    parser.add_argument('--sha')
    parser.add_argument('--worker-image')
    parser.add_argument('--web-image')
    parser.add_argument('--snapshot', help='required for run/restore; absolute path outside Git checkout')
    parser.add_argument('--app', choices=ORDER, help='app to restore from the snapshot')
    parser.add_argument('--migration-verified', action='store_true',
                        help='assert any DB migration/schema change was applied before rollout')
    args = parser.parse_args(argv)
    if args.action in ('run', 'restore') and not args.snapshot:
        parser.error('--snapshot is required for run/restore')
    if args.action == 'restore' and not args.app:
        parser.error('--app is required for restore')
    if args.action != 'restore' and not all((args.sha, args.worker_image, args.web_image)):
        parser.error('--sha, --worker-image, and --web-image are required for plan/run')
    key = run(['security', 'find-generic-password', '-a', 'deploy.brut.bot',
               '-s', 'dokploy-api-key', '-w'])
    client = Dokploy(key)
    if args.action == 'restore':
        print(json.dumps(restore(client, args.snapshot, args.app, run(['gh', 'auth', 'token']))))
        return
    target = validate_target(args.sha, args.worker_image, args.web_image)
    token = main_sha_and_token(target)
    if run(['git', 'rev-parse', 'HEAD']) != target['sha']:
        raise ValueError('local_checkout_not_target_main')
    state = baseline(client, target)
    changed = run(['git', 'diff', '--name-only', state['previous']['sha'], target['sha'],
                   '--', 'drizzle', 'lib/db/schema.ts', 'scripts/migrate.mjs'])
    if changed and not args.migration_verified:
        raise ValueError('database_changes_require_migration_verified')
    monitor_gate(client, 'crawler')
    pre_pull(target, token, setting(state['apps']['web-m3']['env'],
                                    'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY'))
    print(json.dumps({'plan': list(ORDER), 'currentRelease': state['previous']['sha'],
                      'targetRelease': target['sha']}), flush=True)
    if args.action == 'run':
        deploy(client, target, token, state, args.snapshot)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'detail': str(error)
                          if isinstance(error, (ValueError, TimeoutError)) else None}), flush=True)
        raise SystemExit(1)
