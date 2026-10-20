#!/usr/bin/env python3
"""Deploy one immutable web/worker release and gate every production step.

Runs on the operator's Mac with GitHub CLI, Keychain, Docker SSH access, and curl.
No secret or raw Dokploy application response is written to stdout.
"""

import argparse
import hashlib
import importlib
import json
import os
import re
import shlex
import subprocess
import sys
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
READ_ONLY_MAINTENANCE = {
    'maintenance-mini': ('T6ATm-paaE03hfSsQX8-S', 'nomorevibe-maintenance-standby-mini', MINI, 'worker'),
    'maintenance-m3': ('7OlFqQdacbyQseQM72E7b', 'nomorevibe-maintenance-m3', M3, 'worker'),
}
# The other production Dokploy apps (AGENTS.md: 13 apps, plus connect-agent). They are git-build apps released one by
# one (RELEASE_TAG + application.deploy, standby first); `run` never deploys them and `inventory` only reads them.
# The versioned split roles (translation, product-health, site-evidence, official-news) have no M3/mini Dokploy app and
# the Oracle runtime is outside Dokploy (oracle-* actions); an unregistered app is never guessed.
GIT_BUILD_APPS = {
    'text-mini': ('YwCZROZf_V0qgI1coMugP', 'nomorevibe-text-standby-mini', MINI, 'worker'),
    'text-m3': ('Pi0loosJrKsse_UQ0mln9', 'nomorevibe-text-m3', M3, 'worker'),
    **READ_ONLY_MAINTENANCE,
    'scheduler-m3': ('uAjLU7MslLIGpORD9h6LQ', 'nomorevibe-scheduler-m3', M3, 'scheduler'),
    'connect-agent-m3': ('xJK6CoRUOs_bpVVNmJDBF', 'nomorevibe-connect-agent-m3', M3, 'connect-agent'),
}
KNOWN_APPS = APPS | GIT_BUILD_APPS
# AI1/AI2 independent consumer apps (PR06e): the shared worker image running `worker-supervisor.ts --role=reviewer --consumer=ai1|ai2`,
# one replica each. The Dokploy apps do not exist yet, so ID and name are empty; an empty target is refused before any action, never guessed.
# `plan`/`run` release only the apps chosen with --consumer, right after their parent role's pair; without it the 8-app release is unchanged.
# agent-scan (E5) runs `--role=crawler --consumer=agent-scan` on M3 only (its other host is Oracle, outside Dokploy).
CONSUMER_APPS = {
    'ai1-consumer-mini': ('', '', MINI, 'worker'),
    'ai1-consumer-m3': ('', '', M3, 'worker'),
    'ai2-consumer-mini': ('', '', MINI, 'worker'),
    'ai2-consumer-m3': ('', '', M3, 'worker'),
    'agent-scan-consumer-m3': ('', '', M3, 'worker'),
}
# Consumer name -> parent role (lib/runtime/consumer-registry.ts). Its apps run that role's code, so they follow the role's pair and precede its gate.
CONSUMER_ROLES = {'ai1': 'reviewer', 'ai2': 'reviewer', 'agent-scan': 'crawler'}


def app_metadata(short):
    metadata = KNOWN_APPS.get(short) or CONSUMER_APPS.get(short)
    if metadata is None:
        raise ValueError(f'{short}_unknown_app')
    if not metadata[0] or not metadata[1]:
        raise ValueError(f'{short}_app_unregistered')
    return metadata


def consumer_apps(consumers):
    """Apps of the chosen consumers on their listed hosts, standby host first; any unregistered app is refused before Keychain or Dokploy."""
    selected = tuple(f'{consumer}-consumer-{host}' for consumer in consumers for host in ('mini', 'm3')
                     if f'{consumer}-consumer-{host}' in CONSUMER_APPS)
    for short in selected:
        app_metadata(short)
    return selected


def consumer_role(short):
    return CONSUMER_ROLES[short.rsplit('-consumer-', 1)[0]]


def release_order(consumers=()):
    """Image release order: chosen consumer apps follow their parent role's pair; with none it is exactly ORDER."""
    order = []
    for short in ORDER:
        order.append(short)
        role, _, host = short.rpartition('-')
        if host == 'm3':
            order += [consumer for consumer in consumers if consumer_role(consumer) == role]
    return tuple(order)


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


def dotenv_settings(value):
    """Parse literal dotenv values without interpolation or secret-bearing errors."""
    rows = (value or '').splitlines()
    result = {}
    index = 0
    while index < len(rows):
        line = rows[index].strip()
        index += 1
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)', line)
        if not match:
            raise ValueError(f'dotenv_invalid_line_{index}')
        key, raw = match.groups()
        if key in result:
            raise ValueError(f'{key}_line_count_2')
        if raw.startswith(('"', "'")):
            quote = raw[0]
            raw = raw[1:]
            end = None
            while end is None:
                for position, char in enumerate(raw):
                    if char != quote:
                        continue
                    escapes = len(raw[:position]) - len(raw[:position].rstrip('\\'))
                    if quote == "'" or escapes % 2 == 0:
                        end = position
                        break
                if end is None:
                    if index == len(rows):
                        raise ValueError(f'{key}_unterminated')
                    raw += '\n' + rows[index]
                    index += 1
            suffix = raw[end + 1:].strip()
            if suffix and not suffix.startswith('#'):
                raise ValueError(f'{key}_invalid_quoted_suffix')
            parsed = raw[:end]
            if quote == '"':
                escapes = {'n': '\n', 'r': '\r', 't': '\t', '"': '"', '\\': '\\'}
                parsed = re.sub(r'\\([nrt"\\])', lambda item: escapes[item[1]], parsed)
        else:
            parsed = re.split(r'\s+#', raw, maxsplit=1)[0].rstrip()
        result[key] = parsed
    return result


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
        app_id, expected_name, (server_id, _), kind = app_metadata(short)
        app = self.request('application.one?applicationId=' + app_id)
        if (app.get('applicationId'), app.get('name'), app.get('serverId')) != (app_id, expected_name, server_id):
            raise ValueError(f'{short}_identity_mismatch')
        if (short in APPS or short in CONSUMER_APPS) and app.get('dockerBuildStage') != ('worker' if kind == 'worker' else 'runner'):
            raise ValueError(f'{short}_identity_mismatch')
        if not re.fullmatch(r'[a-z0-9-]+', app.get('appName') or ''):
            raise ValueError(f'{short}_invalid_service_name')
        return app

    def latest(self, short):
        rows = self.request('deployment.all?applicationId=' + app_metadata(short)[0])
        if not rows:
            raise ValueError(f'{short}_missing_deployment')
        return rows[0]


INTEGRATION_FLAGS = ('PUBLIC_USER_AUTH_ENABLED', 'GITHUB_STAR_ENABLED',
                     'PRODUCT_FEEDBACK_ENABLED', 'GITHUB_FEEDBACK_DELIVERY_ENABLED')


def github_integration_preflight(client, apps):
    """Read only configuration checks; exceptions and evidence contain names, never secret values."""
    surfaces = {short: apps[short] for short in ('web-mini', 'web-m3', 'publisher-mini', 'publisher-m3')}
    for short in READ_ONLY_MAINTENANCE:
        surfaces[short] = client.app(short)
    envs = {short: dotenv_settings(app.get('env')) for short, app in surfaces.items()}

    def value(short, key):
        if key in envs[short]:
            return envs[short][key]
        if key in INTEGRATION_FLAGS:
            return 'false'
        raise ValueError(f'{key}_line_count_0')

    def matched(key, names, required=False):
        values = [value(short, key) for short in names]
        if required and any(not item.strip() for item in values):
            raise ValueError(f'{key}_missing')
        if len(set(values)) != 1:
            raise ValueError(f'{key}_mismatch')
        return values[0]

    web = ('web-mini', 'web-m3')
    flags = {}
    for key in INTEGRATION_FLAGS:
        for short in web:
            if value(short, key) not in ('true', 'false'):
                raise ValueError(f'{short}_{key}_invalid')
        flags[key] = matched(key, web) == 'true'
    for key, names in (('GITHUB_FEEDBACK_DELIVERY_ENABLED', tuple(surfaces)),):
        for short in names:
            if value(short, key) not in ('true', 'false'):
                raise ValueError(f'{short}_{key}_invalid')
        matched(key, names)
    if ((flags['GITHUB_STAR_ENABLED'] or flags['PRODUCT_FEEDBACK_ENABLED']) and not flags['PUBLIC_USER_AUTH_ENABLED']
            or flags['GITHUB_FEEDBACK_DELIVERY_ENABLED'] and not flags['PRODUCT_FEEDBACK_ENABLED']):
        raise ValueError('github_integration_flag_dependency')
    if flags['PUBLIC_USER_AUTH_ENABLED']:
        public_secret = matched('PUBLIC_AUTH_SECRET', web, True)
        if len(public_secret) < 32 or any(public_secret == value(short, 'AUTH_SECRET') for short in web):
            raise ValueError('PUBLIC_AUTH_SECRET_invalid_or_reused')
        mail_keys = ('LOGIN_EMAIL_API_KEY', 'LOGIN_EMAIL_FROM')
        if any(envs[short].get(key, '').strip() for short in web for key in mail_keys):
            for key in mail_keys:
                matched(key, web, True)
        elif not flags['GITHUB_STAR_ENABLED']:
            raise ValueError('public_auth_login_method_missing')
    if any(flags.values()):
        site_roles = tuple(surfaces) if flags['GITHUB_FEEDBACK_DELIVERY_ENABLED'] else web
        matched('NEXT_PUBLIC_SITE_URL', site_roles, True)
    if flags['GITHUB_STAR_ENABLED'] or flags['GITHUB_FEEDBACK_DELIVERY_ENABLED']:
        integration_secret = matched('GITHUB_INTEGRATION_SECRET', web, True)
        if len(integration_secret) < 32 or any(integration_secret == value(short, 'AUTH_SECRET')
                                             or integration_secret == value(short, 'PUBLIC_AUTH_SECRET') for short in web):
            raise ValueError('GITHUB_INTEGRATION_SECRET_invalid_or_reused')
    if flags['GITHUB_STAR_ENABLED']:
        for key in ('GITHUB_STAR_APP_ID', 'GITHUB_STAR_APP_WEBHOOK_SECRET'):
            matched(key, web, True)
        for key in ('GITHUB_STAR_APP_CLIENT_ID', 'GITHUB_STAR_APP_CLIENT_SECRET'):
            matched(key, web, True)
    if flags['GITHUB_FEEDBACK_DELIVERY_ENABLED']:
        for key in ('GITHUB_FEEDBACK_APP_SLUG', 'GITHUB_FEEDBACK_APP_CLIENT_ID', 'GITHUB_FEEDBACK_APP_CLIENT_SECRET', 'GITHUB_FEEDBACK_APP_WEBHOOK_SECRET'):
            matched(key, web, True)
        for key in ('GITHUB_FEEDBACK_APP_ID', 'GITHUB_FEEDBACK_APP_PRIVATE_KEY'):
            matched(key, tuple(surfaces), True)
    if flags['GITHUB_STAR_ENABLED'] and flags['GITHUB_FEEDBACK_DELIVERY_ENABLED']:
        if value('web-mini', 'GITHUB_STAR_APP_ID') == value('web-mini', 'GITHUB_FEEDBACK_APP_ID'):
            raise ValueError('github_app_identity_reused')
        for suffix in ('CLIENT_ID', 'CLIENT_SECRET', 'WEBHOOK_SECRET'):
            if value('web-mini', 'GITHUB_STAR_APP_' + suffix) == value('web-mini', 'GITHUB_FEEDBACK_APP_' + suffix):
                raise ValueError('github_app_' + suffix + '_reused')
    maintenance = {}
    for short in READ_ONLY_MAINTENANCE:
        app = surfaces[short]
        if (app.get('applicationStatus') != 'done' or client.latest(short).get('status') != 'done'
                or not replicas_allowed('worker', app.get('replicas')) or value(short, 'WORKER_ROLE') != 'maintenance'):
            raise ValueError(f'{short}_maintenance_not_ready')
        maintenance[short] = {'sourceType': app.get('sourceType'), 'autoDeploy': app.get('autoDeploy'), 'manualReleaseRequired': True}
    matched('RELEASE_TAG', tuple(READ_ONLY_MAINTENANCE), True)
    return {'configurationMatched': True, 'flags': flags, 'maintenance': maintenance}


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
    _, _, (_, host), kind = app_metadata(short)
    raw = ssh_python(host, REMOTE_PROBE, app['appName'], target[kind],
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
            if app.get('sourceType') != 'docker' or app.get('dockerImage') != target[app_metadata(short)[3]] or setting(app.get('env'), 'RELEASE_TAG') != target['sha']:
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


# Production migration state, read-only. It runs inside the running crawler-m3 container (the container monitor_gate already execs
# into) with that container's own DATABASE_URL, so no database secret reaches this Mac. READ ONLY transaction, 5s statement limit,
# no write. The probed `when` is a bound parameter. drizzle's migrator applies a journal entry only when its `when` is above the
# newest applied created_at, so the applied count and the latest entry's hash are checked too (a lower `when` is skipped silently).
MIGRATION_STATE_SCRIPT = (
    "import postgres from 'postgres';"
    "const sql=postgres(process.env.DATABASE_URL,{max:1,prepare:false,connect_timeout:10,onnotice:()=>{}});"
    "try{const [row]=await sql.begin('read only',async tx=>{await tx`SET LOCAL statement_timeout='5s'`;"
    "return tx`SELECT count(*)::int AS applied,max(created_at)::text AS latest,(SELECT hash FROM drizzle.__drizzle_migrations "
    "WHERE created_at=${process.argv[1]}::bigint ORDER BY id DESC LIMIT 1) AS hash FROM drizzle.__drizzle_migrations`;});"
    "console.log(JSON.stringify(row));}finally{await sql.end({timeout:5});}")
REMOTE_MIGRATIONS = r'''import subprocess,sys
service,when,script=sys.argv[1:]
ids=subprocess.run(['docker','ps','--filter','name='+service,'--format','{{.ID}}'],
                   capture_output=True,text=True,check=True).stdout.strip().splitlines()
if len(ids)!=1: raise SystemExit('migration_check_container_count')
result=subprocess.run(['docker','exec',ids[0],'node','--input-type=module','-e',script,when],capture_output=True,text=True,timeout=40)
if result.returncode: raise SystemExit('migration_check_failed')
print(result.stdout.strip().splitlines()[-1])
'''


def git_blob(sha, path):
    """Exact committed bytes (no strip): drizzle hashes the whole migration file."""
    result = subprocess.run(['git', 'show', f'{sha}:{path}'], capture_output=True, timeout=45)
    if result.returncode:
        raise RuntimeError(f'command_failed:git:{result.returncode}')
    return result.stdout


def migration_journal(sha):
    journal = json.loads(git_blob(sha, 'drizzle/meta/_journal.json'))
    entries = journal.get('entries') if isinstance(journal, dict) else None
    if not isinstance(entries, list) or not entries:
        raise ValueError('migration_journal_invalid')
    whens = [entry.get('when') if isinstance(entry, dict) else None for entry in entries]
    if any(type(when) is not int for when in whens) or any(later <= earlier for earlier, later in zip(whens, whens[1:])):
        raise ValueError('migration_journal_not_increasing')
    latest = entries[-1]
    if not isinstance(latest.get('tag'), str) or not re.fullmatch(r'[0-9]{4}_[a-z0-9_]+', latest['tag']):
        raise ValueError('migration_journal_invalid')
    return {'count': len(entries), 'when': latest['when'], 'tag': latest['tag'],
            'hash': hashlib.sha256(git_blob(sha, f"drizzle/{latest['tag']}.sql")).hexdigest()}


def migration_gate(client, sha):
    """Refuse a release whose journal is not applied in production. An unreadable state is a refusal, never a pass."""
    journal = migration_journal(sha)
    try:
        app = client.app('crawler-m3')
        state = json.loads(ssh_python(M3[1], REMOTE_MIGRATIONS, app['appName'], str(journal['when']), MIGRATION_STATE_SCRIPT, timeout=60))
    except (RuntimeError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        raise ValueError('database_migration_state_unknown') from error
    latest, applied = state.get('latest') if isinstance(state, dict) else None, state.get('applied') if isinstance(state, dict) else None
    if not isinstance(latest, str) or not re.fullmatch(r'[0-9]{1,19}', latest) or type(applied) is not int:
        raise ValueError('database_migration_state_unknown')
    if int(latest) < journal['when'] or applied < journal['count']:
        raise ValueError('database_migrations_not_applied')
    if state.get('hash') != journal['hash']:
        raise ValueError('database_migration_hash_mismatch')
    return {'migrations': 'applied', 'latestTag': journal['tag'], 'applied': applied}


# Agent-scan legacy write gate (migration 0105, lib/domain/evidence/agents/claim-control.ts). A crawler release without it keeps writing
# legacy scans while agent_scan_control is items/draining, so it overlaps the claim consumers on the same repository (review P2-7).
AGENT_SCAN_GATE = ('lib/domain/evidence/agents/repository.ts', b'assertLegacyAgentScanWrite')
# Production agent_scan_control mode, read-only like MIGRATION_STATE_SCRIPT (READ ONLY transaction, 5s limit). 'absent' = before 0105.
AGENT_SCAN_MODE_SCRIPT = (
    "import postgres from 'postgres';"
    "const sql=postgres(process.env.DATABASE_URL,{max:1,prepare:false,connect_timeout:10,onnotice:()=>{}});"
    "try{const row=await sql.begin('read only',async tx=>{await tx`SET LOCAL statement_timeout='5s'`;"
    "const [table]=await tx`SELECT to_regclass('public.agent_scan_control') IS NOT NULL AS present`;"
    "if(!table.present)return {mode:'absent'};"
    "const [control]=await tx`SELECT mode FROM agent_scan_control WHERE id=1`;return {mode:control?control.mode:null};});"
    "console.log(JSON.stringify(row));}finally{await sql.end({timeout:5});}")
# Any worker container can read it; a crawler restore must not depend on the crawler container it is about to replace.
AGENT_SCAN_PROBE_APPS = ('reviewer-m3', 'publisher-m3', 'crawler-m3')


def app_role(short):
    return consumer_role(short) if short in CONSUMER_APPS else short.rpartition('-')[0]


def agent_scan_gated(sha):
    """True only when that release's code carries the legacy write gate. A missing file or unreadable SHA is not proof."""
    try:
        return AGENT_SCAN_GATE[1] in git_blob(sha, AGENT_SCAN_GATE[0])
    except RuntimeError:
        return False


def agent_scan_mode(client):
    for short in AGENT_SCAN_PROBE_APPS:
        try:
            state = json.loads(ssh_python(M3[1], REMOTE_MIGRATIONS, client.app(short)['appName'], '0', AGENT_SCAN_MODE_SCRIPT, timeout=60))
        except (RuntimeError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired):
            continue
        mode = state.get('mode') if isinstance(state, dict) else None
        if mode in ('absent', 'legacy', 'draining', 'items'):
            return mode
    raise ValueError('agent_scan_mode_unknown')


def agent_scan_release_gate(client, sha):
    """Refuse crawler code without the agent-scan gate unless production agent_scan_control is legacy (or not yet migrated).
    Return the control to legacy first (pipeline-control runbook 11-6); an unreadable mode is a refusal, never a pass."""
    if agent_scan_gated(sha):
        return {'agentScanGate': 'release_gated'}
    mode = agent_scan_mode(client)
    if mode not in ('absent', 'legacy'):
        raise ValueError(f'agent_scan_ungated_release_while_{mode}')
    return {'agentScanGate': 'ungated_release_allowed', 'agentScanMode': mode}


def main_sha_and_token(target):
    if run(['gh', 'api', 'user', '--jq', '.login']) != 'JRVector9':
        raise ValueError('github_account_mismatch')
    if run(['gh', 'api', 'repos/JRVector9/nomorevibe/commits/main', '--jq', '.sha']) != target['sha']:
        raise ValueError('main_sha_mismatch')
    if run(['gh', 'api', 'user/packages/container/nomorevibe-runtime-web', '--jq', '.visibility']) != 'private':
        raise ValueError('web_package_not_private')
    return run(['gh', 'auth', 'token'])


def baseline(client, target, consumers=()):
    apps = {}
    release = None
    old_images = {}
    web_key = None
    for short in release_order(consumers):
        app = client.app(short)
        latest = client.latest(short)
        kind = app_metadata(short)[3]
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
    for short in release_order(consumers):
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
    app_id, _, _, kind = app_metadata(short)
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
        'applicationId': app_id, 'env': env, 'buildArgs': build_args,
        'buildSecrets': app.get('buildSecrets'), 'createEnvFile': app.get('createEnvFile') is True,
    })
    client.request('application.saveDockerProvider', {
        'applicationId': app_id, 'dockerImage': target[kind],
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
    client.request('application.deploy', {'applicationId': app_id})
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
                                     'https://nomorevibe.com/api/health'], timeout=12))
            if (health.get('status'), health.get('db'), health.get('release')) == ('ok', 'ok', sha):
                seen.add(health.get('instanceId'))
                if seen == {'mini-web', 'm3-web'}:
                    return {'publicHealth': 'ok', 'instances': sorted(seen)}
        except (RuntimeError, ValueError):
            pass
    raise TimeoutError('public_health_gate_timeout')


CLOUDFLARE_ZONE_ID = '9fc499cc4b48354cf9738ac039c9fd70'  # nomorevibe.com — 비밀이 아니다
PURGE_TOKEN_ITEM = 'nomorevibe-cloudflare-purge-token'


def purge_html():
    """웹이 모두 새 릴리스가 된 뒤 Cloudflare 의 옛 화면(html 태그)을 지운다.

    지우지 않으면 캐시된 옛 HTML 이 새 이미지에 없는 옛 JS 조각을 최대 5분 가리킨다. 릴리스는 이미 끝났으므로
    실패해도 멈추지 않고 결과만 알린다. 토큰은 지우기 권한 하나만 가진 키체인 항목이다."""
    try:
        token = run(['security', 'find-generic-password', '-s', PURGE_TOKEN_ITEM, '-w'])
    except RuntimeError:
        return {'htmlPurge': 'skipped', 'reason': 'no_purge_token'}
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, ('header = ' + json.dumps('Authorization: Bearer ' + token) + '\n').encode())
        os.close(write_fd)
        write_fd = -1
        result = subprocess.run(['curl', '-sS', '--max-time', '20', '--config', f'/dev/fd/{read_fd}',
                                 '-H', 'Content-Type: application/json', '--data-binary', '{"tags":["html"]}',
                                 f'https://api.cloudflare.com/client/v4/zones/{CLOUDFLARE_ZONE_ID}/purge_cache'],
                                text=True, capture_output=True, pass_fds=(read_fd,), timeout=25)
        body = json.loads(result.stdout or '{}')
        return {'htmlPurge': 'ok' if body.get('success') else 'failed',
                'errors': [error.get('message') for error in body.get('errors') or []]}
    except (subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        return {'htmlPurge': 'failed', 'errors': [type(error).__name__]}
    finally:
        os.close(read_fd)
        if write_fd >= 0:
            os.close(write_fd)


def purge_cloudfront_html(distribution_id=None):
    """CloudFront 의 옛 화면(#html 태그)을 무효화한다 — 운영자 프로필(nomorevibe, 키는 키체인)로. 배포 ID 가 없으면 건너뛴다."""
    distribution_id = distribution_id or os.environ.get('NMV_CLOUDFRONT_DISTRIBUTION_ID')
    if not distribution_id:
        return {'cloudfrontHtml': 'skipped', 'reason': 'no_distribution_id'}
    try:
        out = run(['aws', 'cloudfront', 'create-invalidation', '--profile', 'nomorevibe',
                   '--distribution-id', distribution_id, '--paths', '#html',
                   '--query', 'Invalidation.Status', '--output', 'text'], timeout=40)
        return {'cloudfrontHtml': 'ok', 'status': out}
    except (RuntimeError, subprocess.TimeoutExpired) as error:
        return {'cloudfrontHtml': 'failed', 'errors': [str(error)[:120]]}


def deploy(client, target, token, state, snapshot, consumers=()):
    save_snapshot(snapshot, target, state)
    print(json.dumps({'snapshot': snapshot, 'preflight': 'passed'}), flush=True)
    try:
        for role in ('publisher', 'reviewer', 'crawler'):
            # Chosen consumer apps run their parent role's code, so they follow that pair and precede its gate.
            for short in (role + '-mini', role + '-m3') + tuple(app for app in consumers if consumer_role(app) == role):
                print(json.dumps(stage_and_deploy(client, short, target, token,
                                                  state['previous'])), flush=True)
            print(json.dumps(monitor_gate(client, role)), flush=True)
        for short in ('web-mini', 'web-m3'):
            print(json.dumps(stage_and_deploy(client, short, target, token,
                                              state['previous'])), flush=True)
        print(json.dumps(public_gate(target['sha'])), flush=True)
        print(json.dumps(purge_html()), flush=True)
        print(json.dumps(purge_cloudfront_html()), flush=True)
    except Exception:
        print(json.dumps({'stopped': True, 'snapshot': snapshot,
                          'nextStep': 'restore affected app or pair before retrying'}), flush=True)
        raise


def restore(client, snapshot_path, short, token):
    path = Path(snapshot_path)
    if not path.is_absolute() or path.stat().st_mode & 0o077:
        raise ValueError('snapshot_permissions_or_path_invalid')
    snapshot = json.loads(path.read_text())
    if short not in APPS and short not in CONSUMER_APPS or short not in snapshot.get('apps', {}):
        raise ValueError('app_missing_from_snapshot')
    original = snapshot['apps'][short]
    current = client.app(short)
    app_id, _, _, kind = app_metadata(short)
    previous = snapshot['previous']
    if (current['appName'] != original['appName'] or current.get('sourceType') != 'docker' or
            current.get('dockerImage') not in (previous[kind], snapshot['target'][kind]) or
            current.get('autoDeploy') is not False):
        raise ValueError(f'{short}_restore_preflight_mismatch')
    # Crawler code (role pair and agent-scan consumer apps) writes agent scans; check before any Dokploy write.
    agent_scan = agent_scan_release_gate(client, previous['sha']) if app_role(short) == 'crawler' else None
    previous_id = client.latest(short)['deploymentId']
    client.request('application.saveEnvironment', {
        'applicationId': app_id, 'env': original['env'],
        'buildArgs': original.get('buildArgs'), 'buildSecrets': original.get('buildSecrets'),
        'createEnvFile': original.get('createEnvFile') is True,
    })
    client.request('application.saveDockerProvider', {
        'applicationId': app_id, 'dockerImage': previous[kind],
        'username': 'JRVector9' if kind == 'web' else None,
        'password': token if kind == 'web' else None,
        'registryUrl': 'ghcr.io' if kind == 'web' else None,
    })
    configured = client.app(short)
    if (configured.get('dockerImage') != previous[kind] or
            setting(configured.get('env'), 'RELEASE_TAG') != previous['sha']):
        raise RuntimeError(f'{short}_restore_configuration_mismatch')
    client.request('application.deploy', {'applicationId': app_id})
    result = check_app_deployed(client, short, previous, previous_id)
    return {**result, **agent_scan} if agent_scan else result


def inventory(client, sha):
    """Read-only release coverage of every known production Dokploy app. No write, deploy, SSH or secret output."""
    if not re.fullmatch(r'[0-9a-f]{40}', sha or ''):
        raise ValueError('invalid_release_sha')
    apps = {}
    # Unregistered consumer apps are listed, not counted: they may not exist in Dokploy yet.
    registered = tuple(short for short, metadata in CONSUMER_APPS.items() if metadata[0] and metadata[1])
    for short in ORDER + tuple(GIT_BUILD_APPS) + registered:
        app, latest = client.app(short), client.latest(short)
        try:
            current = setting(app.get('env'), 'RELEASE_TAG')
        except ValueError:
            current = None
        apps[short] = {'deployedBy': 'run' if short in APPS or short in CONSUMER_APPS else 'manual-git-build', 'sourceType': app.get('sourceType'),
                       'applicationStatus': app.get('applicationStatus'), 'latestDeployment': latest.get('status'),
                       'replicas': app.get('replicas'), 'releaseMatches': current == sha}
    complete = all(row['releaseMatches'] and row['applicationStatus'] == 'done' and row['latestDeployment'] == 'done'
                   for row in apps.values())
    return {'targetRelease': sha, 'apps': apps, 'appCount': len(apps), 'complete': complete,
            'pending': sorted(short for short, row in apps.items() if not row['releaseMatches']),
            'consumerApps': {short: 'registered' if short in registered else 'unregistered' for short in CONSUMER_APPS},
            'splitRoleApps': 'none_registered', 'oracle': 'outside_dokploy'}


ORACLE_ACTIONS = ('oracle-plan', 'oracle-install', 'oracle-rollback')


def oracle_modules():
    directory = Path(__file__).resolve().parents[2] / 'deploy/oracle'
    previous = sys.path[:]
    try:
        sys.path.insert(0, str(directory))
        modules = []
        for name in ('release_contract', 'manage_release'):
            module = importlib.import_module(name)
            if Path(module.__file__).resolve() != (directory / (name + '.py')).resolve():
                raise RuntimeError('oracle_module_path_mismatch')
            modules.append(module)
        return tuple(modules)
    finally:
        sys.path[:] = previous


def oracle_main(argv):
    parser = argparse.ArgumentParser(description='Verify or switch an inactive caller-owned offline Oracle release.', allow_abbrev=False)
    parser.add_argument('action', choices=ORACLE_ACTIONS)
    parser.add_argument('--sha', required=True)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--expected-host', required=True, type=Path)
    parser.add_argument('--observed-host', required=True, type=Path)
    parser.add_argument('--staging-root', type=Path)
    parser.add_argument('--expected-current')
    args = parser.parse_args(argv)
    if args.action == 'oracle-plan' and (args.staging_root is not None or args.expected_current is not None):
        parser.error('oracle-plan does not accept --staging-root or --expected-current')
    if args.action != 'oracle-plan' and args.staging_root is None:
        parser.error('--staging-root is required for oracle-install/oracle-rollback')
    if args.action == 'oracle-rollback' and args.expected_current is None:
        parser.error('--expected-current is required for oracle-rollback')
    contract, manager = oracle_modules()
    contract.sha(args.sha, 40)
    if args.expected_current is not None:
        contract.sha(args.expected_current, 40)
    hosts = (contract.load_json(args.expected_host.read_bytes()), contract.load_json(args.observed_host.read_bytes()))
    contract.validate_host(*hosts)
    manifest = manager.inspect_archive(args.archive, args.archive_sha256)
    if manifest['releaseSha'] != args.sha:
        raise ValueError('oracle_release_sha_mismatch')
    result = {'action': args.action, 'releaseSha': args.sha, 'readiness': 'unverified', 'activationAllowed': False}
    if args.action == 'oracle-plan':
        result['files'] = len(manifest['files'])
    else:
        manager.stage_release(args.staging_root, args.archive, args.archive_sha256, *hosts)
        result.update(manager.switch_release(args.staging_root, args.sha, args.expected_current, *hosts))
    print(json.dumps(result))


def main(argv=None):
    actual = sys.argv[1:] if argv is None else argv
    if actual and actual[0] in ORACLE_ACTIONS:
        if argv is None:
            try:
                return oracle_main(actual)
            except Exception as error:
                print(json.dumps({'error': type(error).__name__, 'code': 'oracle_offline_release_failed',
                                  'readiness': 'unverified', 'activationAllowed': False}))
                raise SystemExit(1) from error
        return oracle_main(actual)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'run', 'restore', 'inventory'))
    parser.add_argument('--sha')
    parser.add_argument('--worker-image')
    parser.add_argument('--web-image')
    parser.add_argument('--snapshot', help='required for run/restore; absolute path outside Git checkout')
    parser.add_argument('--app', choices=ORDER + tuple(CONSUMER_APPS), help='app to restore from the snapshot')
    parser.add_argument('--consumer', action='append', choices=tuple(CONSUMER_ROLES), default=[],
                        help="plan/run: also release this registered consumer's apps right after its parent role's pair")
    parser.add_argument('--migration-verified', action='store_true',
                        help='assert any DB migration/schema change was applied before rollout; the helper then also '
                             'reads the production migration journal (read-only) and refuses if it is behind or unreadable')
    args = parser.parse_args(argv)
    if args.action in ('run', 'restore') and not args.snapshot:
        parser.error('--snapshot is required for run/restore')
    if args.action == 'restore' and not args.app:
        parser.error('--app is required for restore')
    if args.action == 'inventory' and (not args.sha or args.worker_image or args.web_image or args.snapshot or args.app
                                       or args.migration_verified):
        parser.error('inventory accepts only --sha')
    if args.action not in ('restore', 'inventory') and not all((args.sha, args.worker_image, args.web_image)):
        parser.error('--sha, --worker-image, and --web-image are required for plan/run')
    if args.consumer and (args.action not in ('plan', 'run') or len(set(args.consumer)) != len(args.consumer)):
        parser.error('--consumer is only for plan/run and may not repeat')
    # An unregistered consumer target is refused before Keychain or Dokploy.
    consumers = consumer_apps(args.consumer)
    if args.action == 'restore' and args.app in CONSUMER_APPS:
        app_metadata(args.app)
    key = run(['security', 'find-generic-password', '-a', 'deploy.brut.bot',
               '-s', 'dokploy-api-key', '-w'])
    client = Dokploy(key)
    if args.action == 'inventory':
        result = inventory(client, args.sha)
        print(json.dumps(result), flush=True)
        if not result['complete']:
            raise SystemExit(2)
        return
    if args.action == 'restore':
        print(json.dumps(restore(client, args.snapshot, args.app, run(['gh', 'auth', 'token']))))
        return
    target = validate_target(args.sha, args.worker_image, args.web_image)
    token = main_sha_and_token(target)
    if run(['git', 'rev-parse', 'HEAD']) != target['sha']:
        raise ValueError('local_checkout_not_target_main')
    state = baseline(client, target, consumers)
    integration = github_integration_preflight(client, state['apps'])
    changed = run(['git', 'diff', '--name-only', state['previous']['sha'], target['sha'],
                   '--', 'drizzle', 'lib/db/schema.ts', 'scripts/migrate.mjs'])
    if changed and not args.migration_verified:
        raise ValueError('database_changes_require_migration_verified')
    # The operator assertion alone is not proof: a release with DB changes also needs the applied production journal.
    migrations = migration_gate(client, target['sha']) if changed else None
    # The crawler pair is always released; refuse code without the agent-scan gate while the control is not legacy.
    agent_scan = agent_scan_release_gate(client, target['sha'])
    monitor_gate(client, 'crawler')
    pre_pull(target, token, setting(state['apps']['web-m3']['env'],
                                    'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY'))
    print(json.dumps({'plan': list(release_order(consumers)), 'currentRelease': state['previous']['sha'],
                      'targetRelease': target['sha'], 'githubIntegration': integration, **agent_scan,
                      **({'databaseMigrations': migrations} if migrations else {})}), flush=True)
    if args.action == 'run':
        deploy(client, target, token, state, args.snapshot, consumers)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'detail': str(error)
                          if isinstance(error, (ValueError, TimeoutError)) else None}), flush=True)
        raise SystemExit(1)
