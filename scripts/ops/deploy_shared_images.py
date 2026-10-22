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
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timezone
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
# Docker auxiliary services have their own command/healthcheck and release procedure.
# Inventory reads them, while plan/run/restore keep the existing shared-image scope.
AUXILIARY_APPS = {
    'monitor-m3': ('WbGj-YxQGHNEoGElyTLBq', 'nomorevibe-monitor-m3', M3, 'monitor'),
}
KNOWN_APPS = APPS | GIT_BUILD_APPS | AUXILIARY_APPS
# AI1/AI2 independent consumer apps (PR06e): the shared worker image running `worker-supervisor.ts --role=reviewer --consumer=ai1|ai2`,
# one replica each. The Dokploy apps do not exist yet, so ID and name are empty; an empty target is refused before any action, never guessed.
# `plan`/`run` release only the apps chosen with --consumer, right after their parent role's pair; without it the 8-app release is unchanged.
# agent-scan (E5) runs `--role=crawler --consumer=agent-scan` on M3 only (its other host is Oracle, outside Dokploy).
# 2026-10-20: agent-scan-consumer-m3 was created as a copy of crawler-m3 (same image, env + SERVICE_INSTANCE_ID=agent-scan-consumer-m3,
# AGENT_SCAN_CONSUMER_VERSION=1, AGENT_SCAN_CONCURRENCY=1). Release it with `--consumer agent-scan`; the AI1/AI2 apps still do not exist.
CONSUMER_APPS = {
    'ai1-consumer-mini': ('', '', MINI, 'worker'),
    'ai1-consumer-m3': ('', '', M3, 'worker'),
    'ai2-consumer-mini': ('', '', MINI, 'worker'),
    'ai2-consumer-m3': ('', '', M3, 'worker'),
    'agent-scan-consumer-m3': ('LIRNQFq9mWGBOWRshJ-19', 'nomorevibe-agent-scan-consumer-m3', M3, 'worker'),
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


# 확인 간격(초). 앱 확인은 Dokploy 읽기 두 번이고 SSH 확인은 Dokploy 가 done 을 낸 뒤에만 한다.
# 감시 관문은 한 번에 컨테이너 안에서 tsx 를 두 번 띄우므로 조금 길게 둔다(예전에는 둘 다 5초).
APP_POLL_SECONDS = 2
MONITOR_POLL_SECONDS = 3
_EMIT_LOCK = threading.Lock()


def emit(record):
    """진행 한 줄을 JSON 으로 낸다. 맨 앞에 UTC 시각(at)을 붙이고, 동시 배포의 여러 스레드가 써도 줄이 섞이지 않는다."""
    line = json.dumps({'at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), **record})
    with _EMIT_LOCK:
        print(line, flush=True)


class Timeline:
    """단계별 걸린 시간(초)을 모은다. 마지막 요약 줄은 실패해도 그때까지 끝난 단계의 시간을 남긴다."""

    def __init__(self):
        self.started = time.monotonic()
        self.seconds = {}
        self._lock = threading.Lock()

    @contextmanager
    def step(self, name):
        started = time.monotonic()
        try:
            yield
        finally:
            with self._lock:
                self.seconds[name] = round(time.monotonic() - started, 1)

    def summary(self, **extra):
        with self._lock:
            return {'durations': dict(self.seconds), 'totalSeconds': round(time.monotonic() - self.started, 1), **extra}


class ReleaseStopped(RuntimeError):
    """도구가 스스로 멈춘 까닭. 글에는 앱 이름·Swarm 상태·(걸러 낸) Docker 태스크 오류만 있다 — env·비밀값은 없다."""


class SwarmRollback(ReleaseStopped):
    """Dokploy 는 done 인데 Swarm 이 새 태스크를 되돌렸다(rollback_*) 또는 멈췄다(paused)."""

    def __init__(self, short, evidence):
        self.state = evidence.get('updateState')
        self.task_errors = list(evidence.get('taskErrors') or [])
        self.evidence = evidence
        super().__init__(swarm_detail(f'{short}_swarm_{self.state}', evidence))


def swarm_detail(code, evidence):
    """멈춤 코드 뒤에 가장 최근 태스크 오류(없으면 Swarm 메시지)를 붙인다. 원격 확인이 이미 글자를 걸러 160자로 자른 값이다."""
    if not evidence:
        return code
    if evidence.get('taskErrors'):
        return code + ':task_error=' + evidence['taskErrors'][0]
    if evidence.get('updateMessage'):
        return code + ':message=' + evidence['updateMessage']
    return code


def error_fields(error):
    """실패 줄에 넣을 이름과 코드. 값이 섞일 수 있는 다른 예외는 이름만 낸다(맨 끝 오류 줄과 같은 규칙)."""
    return {'error': type(error).__name__,
            'detail': str(error) if isinstance(error, (ValueError, TimeoutError, ReleaseStopped)) else None}


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
        if short in AUXILIARY_APPS and (app.get('sourceType') != 'docker' or app.get('dockerBuildStage') != 'monitor'):
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
    mail_keys = ('LOGIN_EMAIL_API_KEY', 'LOGIN_EMAIL_FROM')
    web_mail = any(envs[short].get(key, '').strip() for short in web for key in mail_keys)
    if not web_mail and any(envs[short].get(key, '').strip() for short in READ_ONLY_MAINTENANCE for key in mail_keys):
        # 웹이 메일 칸을 숨기는데 maintenance 만 보내면 화면과 메일이 어긋난다
        raise ValueError('LOGIN_EMAIL_maintenance_only')
    if ((flags['GITHUB_STAR_ENABLED'] or flags['PRODUCT_FEEDBACK_ENABLED']) and not flags['PUBLIC_USER_AUTH_ENABLED']
            or flags['GITHUB_FEEDBACK_DELIVERY_ENABLED'] and not flags['PRODUCT_FEEDBACK_ENABLED']):
        raise ValueError('github_integration_flag_dependency')
    if flags['PUBLIC_USER_AUTH_ENABLED']:
        public_secret = matched('PUBLIC_AUTH_SECRET', web, True)
        if len(public_secret) < 32 or any(public_secret == value(short, 'AUTH_SECRET') for short in web):
            raise ValueError('PUBLIC_AUTH_SECRET_invalid_or_reused')
        if web_mail:
            for key in mail_keys:
                matched(key, web, True)
            # 알림 메일은 maintenance 의 email-outbox-send 가 보낸다 — 두 maintenance 도 같은 발신 키와 끄기 링크 서명 비밀을 가져야 한다
            for key in mail_keys + ('PUBLIC_AUTH_SECRET',):
                matched(key, web + tuple(READ_ONLY_MAINTENANCE), True)
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
# 준비가 아니면 Swarm 의 UpdateStatus(updating·completed·paused·rollback_*)와 최근 태스크 오류(예: "No such container")를
# 걸러 160자로 자른 글로 더한다 — Dokploy 가 done 을 내도 Swarm 이 새 태스크를 옛 spec 으로 되돌린 것을 시간 초과 전에 알아챈다.
REMOTE_PROBE = r'''import json,subprocess,sys
service,image,sha,kind,expected=sys.argv[1:6]
detail=sys.argv[6:]==['detail']
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
if len(matches)==1 and (detail or not result['ready']):
 import re
 clean=lambda v:re.sub(r'[^A-Za-z0-9 :._/@()=,+-]','?',str(v or ''))[:160]
 try: status=json.loads(command('docker','service','inspect',service,'--format','{{json .UpdateStatus}}') or 'null')
 except Exception: status=None
 if isinstance(status,dict):
  result['updateState']=clean(status.get('State'))
  if status.get('Message'): result['updateMessage']=clean(status.get('Message'))
 errors=[]
 for line in command('docker','service','ps',service,'--no-trunc','--format','{{json .}}').splitlines()[:8]:
  try: task=json.loads(line)
  except Exception: continue
  if isinstance(task,dict) and task.get('Error'): errors.append(clean(task['Error']))
 if errors: result['taskErrors']=errors[:3]
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


def probe(short, app, target, expected='any', *, detail=False):
    """detail=True 면 준비여도 Swarm UpdateStatus·태스크 오류를 함께 읽는다(설정만 되돌릴 때 진행 중인 update 가 없는지 본다)."""
    _, _, (_, host), kind = app_metadata(short)
    raw = ssh_python(host, REMOTE_PROBE, app['appName'], target[kind],
                     target['sha'], kind, str(expected), *(('detail',) if detail else ()))
    return json.loads(raw)


# Dokploy 의 done 은 `docker service update` 요청이 끝났다는 뜻일 뿐이다. 새 태스크가 실패하면(2026-10-17 maintenance·scheduler,
# 2026-10-22 crawler-m3 의 "No such container") Swarm 이 옛 spec 으로 되돌리고 서비스는 옛 이미지로 healthy 다.
SWARM_ROLLBACK_STATES = ('rollback_started', 'rollback_completed')
SWARM_STOP_STATES = ('paused', 'rollback_paused')
# 되돌리기가 끝나기를 기다리는 한도. Swarm 은 되돌린 태스크도 healthcheck 를 거쳐 띄운다.
SWARM_ROLLBACK_SETTLE_SECONDS = 180


def check_app_deployed(client, short, target, previous_id, *, timeout=None, pause=APP_POLL_SECONDS):
    if timeout is None:
        # Swarm 은 한 대씩 새로 띄우고 30초 지켜본 뒤 다음으로 넘어간다 — 복제본마다 시간을 더 준다
        timeout = 240 + 90 * (max(1, client.app(short).get('replicas') or 1) - 1)
    deadline = time.monotonic() + timeout
    last = None
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
            # swarmkit 은 spec 을 바꾸는 update 마다 UpdateStatus 를 비우므로, done 뒤에 보이는 rollback 은 이번 배포의 것이다
            if evidence.get('updateState') in SWARM_ROLLBACK_STATES + SWARM_STOP_STATES:
                raise SwarmRollback(short, evidence)
            last = evidence
        time.sleep(pause)
    raise TimeoutError(swarm_detail(f'{short}_verification_timeout', last))


def await_rollback_settled(client, short, expected, *, timeout=SWARM_ROLLBACK_SETTLE_SECONDS, pause=APP_POLL_SECONDS):
    """Swarm 이 되돌리기를 끝낼 때까지(rollback_completed) 기다린다. 되돌리는 중에 다시 배포하면 두 update 가 겹친다."""
    deadline = time.monotonic() + timeout
    evidence = None
    while time.monotonic() < deadline:
        try:
            evidence = probe(short, client.app(short), expected, 'any')
        except (RuntimeError, json.JSONDecodeError, subprocess.TimeoutExpired):
            evidence = None
        state = (evidence or {}).get('updateState')
        if state == 'rollback_completed':
            return evidence
        if state in SWARM_STOP_STATES:
            raise ReleaseStopped(swarm_detail(f'{short}_swarm_{state}', evidence))
        time.sleep(pause)
    raise ReleaseStopped(swarm_detail(f'{short}_swarm_rollback_unsettled', evidence))


def deploy_app(client, short, expected, *, redeploys=1):
    """저장된 설정 그대로 application.deploy 를 요청하고 실제 실행을 확인한다.

    Swarm 이 새 태스크를 되돌리면(rollback) 끝나기를 기다렸다가 **같은 설정으로 한 번만** 다시 배포한다
    ("No such container" 같은 Swarm 시작 경합은 같은 SHA 재배포로 풀렸다). 다시 되돌리면 실패한 태스크 오류를 담아 멈춘다.
    paused·rollback_paused 는 사람이 봐야 하므로 다시 배포하지 않고 바로 멈춘다."""
    app_id = app_metadata(short)[0]
    for attempt in range(redeploys + 1):
        previous_id = client.latest(short)['deploymentId']
        client.request('application.deploy', {'applicationId': app_id})
        try:
            result = check_app_deployed(client, short, expected, previous_id)
        except SwarmRollback as rollback:
            retry = attempt < redeploys and rollback.state in SWARM_ROLLBACK_STATES
            emit({'app': short, 'swarmRollback': rollback.state, 'taskErrors': rollback.task_errors,
                  'action': 'redeploy_once' if retry else 'stop'})
            if not retry:
                if rollback.state in SWARM_STOP_STATES:
                    raise
                raise ReleaseStopped(swarm_detail(f'{short}_swarm_rollback_repeated', rollback.evidence)) from rollback
            await_rollback_settled(client, short, expected)
            continue
        return {**result, 'swarmRedeploys': attempt} if attempt else result
    raise AssertionError('unreachable')


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


def web_key_of(short, app, expected=None):
    """웹의 서버 액션 키: 실행 env 와 빌드 비밀이 같고, 앞서 본 웹과도 같아야 한다. 값은 오류에 넣지 않는다."""
    runtime_key = setting(app.get('env'), 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY')
    build_key = setting(app.get('buildSecrets'), 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY')
    if not runtime_key or runtime_key != build_key or (expected and expected != runtime_key):
        raise ValueError(f'{short}_web_key_mismatch')
    return runtime_key


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
            runtime_key = web_key_of(short, app, web_key)
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


def _lines(value):
    """설정 비교용: 줄 끝 공백과 앞뒤 빈 줄만 무시한다(값·순서·나머지 줄은 그대로 비교)."""
    return [line.rstrip() for line in (value or '').strip('\n').splitlines()]


def read_snapshot(snapshot_path):
    path = Path(snapshot_path)
    if not path.is_absolute() or path.stat().st_mode & 0o077:
        raise ValueError('snapshot_permissions_or_path_invalid')
    return json.loads(path.read_text())


# --resume·restore 가 실행이 이전 릴리스인 앱을 그대로 두거나 다시 배포해도 되는 Swarm 상태(진행 중인 update·되돌리기가 없다)
SWARM_SETTLED_STATES = (None, 'completed', 'rollback_completed')


def resume_baseline(client, target, snapshot, consumers=()):
    """`run --resume`: 같은 목표로 멈춘 run 의 스냅샷에서 이어 간다(릴리스가 섞인 상태를 손으로 되돌리지 않는다).

    앱마다 Dokploy 설정이 스냅샷의 이전 설정 그대로(previous)이거나, 그 설정에서 run 이 바꾸는 것(RELEASE_TAG·웹의
    NEXT_DEPLOYMENT_ID 줄과 이미지)만 이번 목표로 바뀐 설정(target)이어야 한다. 그 밖의 차이는 설명되지 않은 drift 로 보고
    어느 앱에도 쓰지 않는다. target 앱은 실제 실행으로 다시 나눈다: done(새 릴리스로 healthy — 건너뜀),
    redeploy(설정만 새 릴리스이고 실행은 이전 릴리스 — Swarm 이 되돌렸다. 같은 설정으로 다시 배포). 셋 다 아니면 멈춘다."""
    previous = snapshot.get('previous') or {}
    originals = snapshot.get('apps') or {}
    if snapshot.get('target') != target:
        raise ValueError('resume_snapshot_target_mismatch')
    if (not re.fullmatch(r'[0-9a-f]{40}', str(previous.get('sha'))) or previous['sha'] == target['sha'] or
            any(not isinstance(previous.get(kind), str) for kind in IMAGE_PREFIX)):
        raise ValueError('resume_snapshot_previous_invalid')
    order = release_order(consumers)
    apps, status, web_key = {}, {}, None
    for short in order:
        if short not in originals:
            raise ValueError(f'{short}_missing_from_snapshot')
        kind = app_metadata(short)[3]
        original, app, latest = originals[short], client.app(short), client.latest(short)
        if (app.get('sourceType') != 'docker' or app.get('applicationStatus') != 'done' or latest.get('status') != 'done' or
                app.get('autoDeploy') is not False or not replicas_allowed(kind, app.get('replicas'))):
            raise ValueError(f'{short}_baseline_not_ready')
        if original.get('dockerImage') != previous[kind] or setting(original.get('env'), 'RELEASE_TAG') != previous['sha']:
            raise ValueError(f'{short}_resume_snapshot_not_previous')
        same = (all(app.get(key) == original.get(key) for key in ('appName', 'replicas', 'command', 'sourceType')) and
                _lines(app.get('buildSecrets')) == _lines(original.get('buildSecrets')))
        staged_env, staged_args = staged_settings(original, kind, target['sha'])
        if (same and app.get('dockerImage') == previous[kind] and _lines(app.get('env')) == _lines(original.get('env')) and
                _lines(app.get('buildArgs')) == _lines(original.get('buildArgs'))):
            status[short] = 'previous'
        elif (same and app.get('dockerImage') == target[kind] and _lines(app.get('env')) == _lines(staged_env) and
                _lines(app.get('buildArgs')) == _lines(staged_args)):
            status[short] = 'target'
        else:
            raise ValueError(f'{short}_unexplained_drift')
        if kind == 'web':
            web_key = web_key_of(short, app, web_key)
        apps[short] = app
    for short in order:
        if status[short] == 'previous':
            if not probe(short, apps[short], previous).get('ready'):
                raise ValueError(f'{short}_baseline_runtime_not_ready')
            continue
        if probe(short, apps[short], target, apps[short].get('replicas')).get('ready'):
            status[short] = 'done'
            continue
        evidence = probe(short, apps[short], previous, detail=True)
        if not evidence.get('ready'):
            raise ValueError(swarm_detail(f'{short}_resume_runtime_unknown', evidence))
        if evidence.get('updateState') not in SWARM_SETTLED_STATES:
            raise ValueError(f"{short}_resume_swarm_{evidence.get('updateState')}")
        status[short] = 'redeploy'
    runtime = {short: target['sha'] if value == 'done' else previous['sha'] for short, value in status.items()}
    # 쌍의 한쪽만 새 릴리스로 실행 중인 역할은 사전 관문에서 release_mismatch 를 받는다(이어서 그 쌍부터 마저 올린다)
    mixed = {role: ('release_mismatch',) for role in ROLES if runtime[role + '-mini'] != runtime[role + '-m3']}
    return {'apps': apps, 'previous': previous, 'resume': status, 'mixedRoles': mixed}


def pull_on_host(label, host, target, token, key_hash):
    started = time.monotonic()
    result = json.loads(ssh_python(host, REMOTE_PULL,
                                  json.dumps({'worker': target['worker'], 'web': target['web']}),
                                  target['sha'], key_hash, input_text=token, timeout=180))
    if result.get('pulled') is not True:
        raise RuntimeError(f'{label}_prepull_failed')
    return {'server': label, 'imagesPulled': True, 'seconds': round(time.monotonic() - started, 1)}


def pre_pull(target, token, current_web_key):
    """두 서버가 동시에 받는다(예전에는 mini 다음 M3). 서로 다른 서버라 순서가 필요 없다.
    한 서버가 실패해도 다른 서버의 받기는 끝까지 기다려 결과를 남긴 뒤, 처음 실패를 그대로 올린다."""
    key_hash = hashlib.sha256(current_web_key.encode()).hexdigest()
    hosts = (('mini', MINI), ('m3', M3))
    errors = []
    with ThreadPoolExecutor(max_workers=len(hosts)) as pool:
        futures = {pool.submit(pull_on_host, label, host, target, token, key_hash): label for label, (_, host) in hosts}
        for future in as_completed(futures):
            try:
                emit(future.result())
            except Exception as error:
                errors.append(error)
                emit({'server': futures[future], 'imagesPulled': False, **error_fields(error)})
    if errors:
        raise errors[0]


def prepull(client, target):
    """이미지가 나오자마자 두 서버에 미리 받아 둔다. Dokploy 는 두 웹의 빌드 키만 읽고 앱 설정·배포는 바꾸지 않는다.
    run 도 같은 받기·검사(arm64·revision·웹 빌드 키)를 다시 하므로, 이 명령은 시간을 당길 뿐 관문을 대신하지 않는다."""
    token = main_sha_and_token(target)
    key = None
    for short in ('web-mini', 'web-m3'):
        key = web_key_of(short, client.app(short), key)
    pre_pull(target, token, key)
    return {'prepull': 'done', 'targetRelease': target['sha']}


def save_snapshot(path, target, state):
    destination = Path(path)
    if not destination.is_absolute() or destination.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise ValueError('snapshot_must_be_absolute_outside_repository')
    content = json.dumps({'target': target, **state}, indent=2)
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as file:
        file.write(content)
    return destination


def unchanged_since_preflight(client, short, previous):
    """읽기만 한다: 사전 검사 뒤 앱이 그대로(이전 이미지·릴리스, 자동 배포 꺼짐, 마지막 배포 done)인지."""
    app = client.app(short)
    kind = app_metadata(short)[3]
    if (app.get('applicationStatus') != 'done' or app.get('autoDeploy') is not False or
            app.get('dockerImage') != previous[kind] or
            setting(app.get('env'), 'RELEASE_TAG') != previous['sha'] or
            client.latest(short).get('status') != 'done'):
        raise ValueError(f'{short}_changed_since_preflight')
    return app


def staged_settings(app, kind, sha):
    """새 릴리스로 바꿀 때 저장하는 env·buildArgs: RELEASE_TAG(웹은 NEXT_DEPLOYMENT_ID 도) 한 줄씩만 바꾼다."""
    env = replace_setting(app.get('env'), 'RELEASE_TAG', sha)
    build_args = app.get('buildArgs')
    if kind == 'web':
        env = replace_setting(env, 'NEXT_DEPLOYMENT_ID', sha)
        build_args = replace_setting(build_args, 'NEXT_DEPLOYMENT_ID', sha)
    return env, build_args


def stage_and_deploy(client, short, target, token, previous):
    app = unchanged_since_preflight(client, short, previous)
    app_id, _, _, kind = app_metadata(short)
    env, build_args = staged_settings(app, kind, target['sha'])
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
    return deploy_app(client, short, target)


# 역할 lease 를 쥘 수 있는 정상 상태. standby_active 는 주·예비가 모두 살아 있고 같은 릴리스이며 lease 도 유효한데
# 예비가 일하는 상태다(lib/operations/failover-readiness.ts). 역할은 돌고 있으므로 이번에 배포하지 않은 역할의 이 상태로
# 배포를 멈추지 않는다. 예비가 다시 시작되면(예비를 먼저 올리는 배포) 주가 되찾고, 예비 넘겨주기가 든 릴리스부터는 예비가 스스로 놓는다.
VALID_HOLDER_REASONS = frozenset({'ready', 'standby_active'})
# 방금 주·예비를 새 릴리스로 올린 역할을 예비가 쥐고 있으면 주가 되찾을 때까지 관문을 이만큼 더 기다린다
# (예비 넘겨주기: 주가 같은 boot 로 60초 이상 대기 → 예비 drain → 주 선출. role-worker.ts ROLE_HANDOFF_*).
HANDOFF_GATE_EXTRA_SECONDS = 180


def gate_verdict(reports, names, *, strict=None, allow=None):
    """감시 보고 하나를 판정한다. 돌려주는 값: passed·handoff(고른 역할을 예비가 쥠)·standbyActive·blocking(받지 못한 사유).

    - strict(기본은 names): 방금 배포한 역할은 주가 lease 를 쥔 `ready` 여야 한다 — 새 릴리스의 M3 주가 역할을 실제로 쥘 수 있음을
      보여야 하기 때문이다. 예비가 쥐고 있으면(standby_active) 넘겨주기를 기다린다.
    - 다른 역할은 유효한 소유자(ready·standby_active) 어느 쪽이든 된다. allow 로 역할별 사유를 더 받는다(--resume 의 반쯤 올린 쌍).
    - scheduler 두 복제본(ready)과 worker progress 전체 ok 는 그대로 필요하다."""
    strict = tuple(names if strict is None else strict)
    allow = allow or {}
    readiness = reports['check-failover-readiness.ts'].get('readiness') or {}
    progress = reports['check-worker-progress.ts'].get('overall')
    reasons = {row.get('role'): row.get('reason') for row in readiness.get('roles') or [] if isinstance(row, dict)}
    scheduler = (readiness.get('scheduler') or {}).get('reason')
    blocking = [f'{name}=missing' for name in names if name not in reasons]
    for name, reason in sorted(reasons.items()):
        accepted = ({'ready'} if name in strict else set(VALID_HOLDER_REASONS)) | set(allow.get(name, ()))
        if reason not in accepted:
            blocking.append(f'{name}={reason}')
    if scheduler != 'ready':
        blocking.append(f'scheduler={scheduler}')
    if progress != 'ok':
        blocking.append(f'progress={progress}')
    return {'passed': not blocking, 'blocking': blocking,
            'handoff': any(reasons.get(name) == 'standby_active' for name in strict),
            'standbyActive': sorted(name for name, reason in reasons.items() if reason == 'standby_active')}


def monitor_gate(client, role, *, roles=None, timeout=120, pause=MONITOR_POLL_SECONDS, strict=None, allow=None):
    """role 의 M3 컨테이너에서 failover readiness·worker progress 를 본다(판정은 gate_verdict).

    고른 역할(기본은 role 하나, --parallel-roles 의 한 번 관문은 세 역할 모두)은 주가 쥔 ready 여야 하고, 다른 역할은 유효한
    소유자면 된다. 사전 검사는 strict=() 로 모든 역할에서 유효한 소유자를 받는다. 고른 역할을 예비가 쥐고 있으면 한 번
    HANDOFF_GATE_EXTRA_SECONDS 만큼 더 기다린다. 시간이 넘으면 마지막으로 본 받지 못한 사유를 오류에 붙인다."""
    names = tuple(roles or (role,))
    started = time.monotonic()
    deadline = started + timeout
    extended = False
    short = role + '-m3'
    app = client.app(short)
    blocking = None
    while time.monotonic() < deadline:
        try:
            reports = json.loads(ssh_python(M3[1], REMOTE_MONITOR, app['appName'], timeout=80))
            verdict = gate_verdict(reports, names, strict=strict, allow=allow)
            blocking = verdict['blocking']
            if verdict['passed']:
                result = {'role': role} if roles is None else {'roles': list(names)}
                standby = verdict['standbyActive']
                return {**result, 'readiness': 'ready', 'progress': 'ok', **({'standbyActive': standby} if standby else {})}
            if verdict['handoff'] and not extended:
                extended = True
                deadline = started + timeout + HANDOFF_GATE_EXTRA_SECONDS
                emit({'gate': ','.join(names), 'handoff': 'waiting_for_primary', 'standbyActive': verdict['standbyActive']})
        except (RuntimeError, ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired):
            pass
        time.sleep(pause)
    detail = ('_'.join(names) if roles is not None else role) + '_monitor_gate_timeout'
    raise TimeoutError(detail + (':' + ','.join(blocking) if blocking else ''))


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


ROLES = ('publisher', 'reviewer', 'crawler')
# --parallel-roles 의 한 번 관문: 세 역할의 주가 함께 다시 떴으므로 역할 하나의 관문(120초)보다 넉넉히 준다.
# 통과하면 바로 끝나므로 시간 한도는 실패를 알아차리는 데만 쓰인다.
PARALLEL_GATE_TIMEOUT = 180


def rollout_steps(consumers=(), parallel_roles=False):
    """배포 단계 목록. ('deploy', 앱들)은 한 묶음(둘 이상이면 동시에), ('gate', 역할들)은 감시 관문, ('public', ())은 공개 health.

    기본(순차): 역할마다 mini 예비 → M3 주 → 고른 소비자 앱 → 그 역할의 관문. 실패하면 뒤 역할은 옛 릴리스 그대로다.
    --parallel-roles: 세 역할의 mini 예비를 함께 → 세 역할의 M3 주를 함께 → 고른 소비자 앱(mini 들 → M3 들) → 관문 한 번(세 역할 모두 ready).
    어느 쪽이든 예비가 주보다 먼저, 소비자 앱은 부모 역할의 주 뒤·관문 앞이고, 웹은 mini → M3 한 대씩 올린 뒤 공개 관문이다."""
    steps = []
    if parallel_roles:
        for host in ('mini', 'm3'):
            steps.append(('deploy', tuple(role + '-' + host for role in ROLES)))
        for host in ('mini', 'm3'):
            chosen = tuple(app for app in consumers if app.endswith('-consumer-' + host))
            if chosen:
                steps.append(('deploy', chosen))
        steps.append(('gate', ROLES))
    else:
        for role in ROLES:
            # Chosen consumer apps run their parent role's code, so they follow that pair and precede its gate.
            for short in (role + '-mini', role + '-m3') + tuple(app for app in consumers if consumer_role(app) == role):
                steps.append(('deploy', (short,)))
            steps.append(('gate', (role,)))
    return steps + [('deploy', ('web-mini',)), ('deploy', ('web-m3',)), ('public', ())]


def describe_steps(steps):
    return [kind + (':' + ','.join(names) if names else '') for kind, names in steps]


def resume_app(client, short, target, token, previous, status):
    """--resume 의 앱 하나. previous 는 보통 배포, done 은 건너뛰고, redeploy 는 저장된 새 설정 그대로 다시 배포한다."""
    if status == 'previous':
        return stage_and_deploy(client, short, target, token, previous)
    app = client.app(short)
    kind = app_metadata(short)[3]
    if (app.get('dockerImage') != target[kind] or setting(app.get('env'), 'RELEASE_TAG') != target['sha'] or
            app.get('autoDeploy') is not False or app.get('applicationStatus') != 'done'):
        raise ValueError(f'{short}_changed_since_preflight')
    if status == 'done':
        return {'app': short, 'deployment': 'skipped', 'resume': 'already_target'}
    return {**deploy_app(client, short, target), 'resume': 'redeployed'}


def deploy_batch(client, names, target, token, previous, timeline, touched, resume=None):
    """한 묶음을 올린다. 둘 이상이면 먼저 전부 읽기만 해서 바뀐 앱이 없는지 본 뒤(하나라도 바뀌었으면 아무것도 쓰지 않는다) 동시에 올린다.
    하나가 실패해도 이미 요청한 다른 앱은 끝까지 기다려 결과를 남긴다 — Dokploy 배포는 중간에 거둘 수 없다. 그 뒤 처음 실패를 올린다.
    touched 에는 설정을 바꿨을 수 있는 앱을 쌓는다(멈췄을 때 되돌릴 후보). resume 은 --resume 의 앱별 상태다."""
    def one(short):
        with timeline.step(short):
            if resume is None:
                return stage_and_deploy(client, short, target, token, previous)
            return resume_app(client, short, target, token, previous, resume[short])

    def mark(shorts):
        touched.extend(short for short in shorts if short not in touched)

    if len(names) == 1:
        mark(names)
        emit({**one(names[0]), 'seconds': timeline.seconds[names[0]]})
        return
    for short in names:
        if resume is None or resume[short] == 'previous':
            unchanged_since_preflight(client, short, previous)
    mark(names)
    errors = []
    with ThreadPoolExecutor(max_workers=len(names)) as pool:
        futures = {pool.submit(one, short): short for short in names}
        for future in as_completed(futures):
            short = futures[future]
            try:
                emit({**future.result(), 'seconds': timeline.seconds[short]})
            except Exception as error:
                errors.append(error)
                emit({'app': short, 'failed': True, 'seconds': timeline.seconds.get(short), **error_fields(error)})
    if errors:
        raise errors[0]


def deploy(client, target, token, state, snapshot, consumers=(), *, parallel_roles=False):
    """state['resume'] 가 있으면(--resume) 새 스냅샷을 쓰지 않고 멈춘 run 의 스냅샷을 그대로 쓴다 — 되돌릴 이전 설정이 그 안에 있다."""
    timeline = Timeline()
    resume = state.get('resume')
    # 이어 가기면 앞선 run 이 이미 바꾼 앱부터 되돌릴 후보다
    touched = [short for short in release_order(consumers) if (resume or {}).get(short, 'previous') != 'previous']
    mode = 'parallel-roles' if parallel_roles else 'sequential'
    if resume is None:
        save_snapshot(snapshot, target, state)
    emit({'snapshot': snapshot, 'preflight': 'passed', 'mode': mode, **({'resumed': list(touched)} if resume is not None else {})})
    try:
        for kind, names in rollout_steps(consumers, parallel_roles):
            if kind == 'deploy':
                deploy_batch(client, names, target, token, state['previous'], timeline, touched, resume)
                continue
            label = describe_steps([(kind, names)])[0]
            with timeline.step(label):
                if kind == 'public':
                    result = public_gate(target['sha'])
                elif len(names) == 1:
                    result = monitor_gate(client, names[0])
                else:
                    result = monitor_gate(client, 'crawler', roles=names, timeout=PARALLEL_GATE_TIMEOUT)
            emit({**result, 'seconds': timeline.seconds[label]})
        emit(purge_html())
    except Exception:
        emit({'stopped': True, 'snapshot': snapshot, 'touched': touched,
              'nextStep': 'same run with --resume and this snapshot once the cause is fixed, or restore touched apps from it'})
        raise
    finally:
        # 앱·관문마다 걸린 시간 — 다음 속도 개선의 근거로 남긴다
        emit({'summary': timeline.summary(mode=mode)})


def restore(client, snapshot_path, short, token):
    """스냅샷의 이전 설정으로 앱 하나를 되돌린다.

    실제 실행이 이미 이전 릴리스이고 Swarm update 가 진행 중이 아니면(예: Swarm 이 새 태스크를 되돌렸다) 설정만 되돌리고
    다시 배포하지 않는다. 같은 릴리스로 주를 재시작하면 같은 릴리스의 예비가 lease 를 가져갈 수 있다(2026-10-22 #597 crawler).
    Swarm 이 되돌리기를 하면(새 태스크 실패) deploy_app 이 끝나기를 기다려 한 번 더 배포한다."""
    snapshot = read_snapshot(snapshot_path)
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
    try:
        evidence = probe(short, current, previous, detail=True)
    except (RuntimeError, json.JSONDecodeError, subprocess.TimeoutExpired):
        evidence = {}
    runtime_previous = evidence.get('ready') is True and evidence.get('updateState') in SWARM_SETTLED_STATES
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
    if runtime_previous:
        result = {'app': short, 'deployment': 'skipped', 'restored': 'configuration_only', 'runtime': 'already_previous',
                  'instanceId': evidence.get('instanceId')}
    else:
        result = deploy_app(client, short, previous)
    return {**result, **agent_scan} if agent_scan else result


def inventory(client, sha):
    """Read-only release coverage of every known production Dokploy app. No write, deploy, SSH or secret output."""
    if not re.fullmatch(r'[0-9a-f]{40}', sha or ''):
        raise ValueError('invalid_release_sha')
    apps = {}
    # Unregistered consumer apps are listed, not counted: they may not exist in Dokploy yet.
    registered = tuple(short for short, metadata in CONSUMER_APPS.items() if metadata[0] and metadata[1])
    for short in ORDER + tuple(GIT_BUILD_APPS) + registered + tuple(AUXILIARY_APPS):
        app, latest = client.app(short), client.latest(short)
        try:
            current = setting(app.get('env'), 'RELEASE_TAG')
        except ValueError:
            current = None
        deployed_by = 'manual-docker' if short in AUXILIARY_APPS else 'run' if short in APPS or short in CONSUMER_APPS else 'manual-git-build'
        apps[short] = {'deployedBy': deployed_by, 'sourceType': app.get('sourceType'),
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
    parser.add_argument('action', choices=('plan', 'run', 'prepull', 'restore', 'inventory'))
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
    parser.add_argument('--parallel-roles', action='store_true',
                        help='plan/run: release the three role standbys together, then the three primaries together, '
                             'then one monitor gate for all roles (default: one role pair and gate at a time)')
    parser.add_argument('--resume', action='store_true',
                        help='plan/run: continue a stopped run of the same target from its --snapshot (no new snapshot). '
                             'Every app must be at the snapshot configuration or exactly the staged target configuration')
    args = parser.parse_args(argv)
    if args.action in ('run', 'restore') and not args.snapshot:
        parser.error('--snapshot is required for run/restore')
    if args.resume and (args.action not in ('plan', 'run') or not args.snapshot):
        parser.error('--resume is only for plan/run and needs the stopped run\'s --snapshot')
    if args.action == 'restore' and not args.app:
        parser.error('--app is required for restore')
    if args.action == 'inventory' and (not args.sha or args.worker_image or args.web_image or args.snapshot or args.app
                                       or args.migration_verified):
        parser.error('inventory accepts only --sha')
    if args.action not in ('restore', 'inventory') and not all((args.sha, args.worker_image, args.web_image)):
        parser.error('--sha, --worker-image, and --web-image are required for plan/run/prepull')
    if args.action == 'prepull' and (args.snapshot or args.app or args.migration_verified):
        parser.error('prepull accepts only --sha, --worker-image and --web-image')
    if args.parallel_roles and args.action not in ('plan', 'run'):
        parser.error('--parallel-roles is only for plan/run')
    if args.consumer and (args.action not in ('plan', 'run') or len(set(args.consumer)) != len(args.consumer)):
        parser.error('--consumer is only for plan/run and may not repeat')
    # An unregistered consumer target is refused before Keychain or Dokploy.
    consumers = consumer_apps(args.consumer)
    if args.action == 'restore' and args.app in CONSUMER_APPS:
        app_metadata(args.app)
    # prepull refuses an invalid release target before Keychain (plan/run keep their check below, unchanged).
    target = validate_target(args.sha, args.worker_image, args.web_image) if args.action == 'prepull' else None
    # --resume reads the stopped run's private snapshot before Keychain; a missing or shared file is refused here.
    snapshot = read_snapshot(args.snapshot) if args.resume else None
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
        emit(restore(client, args.snapshot, args.app, run(['gh', 'auth', 'token'])))
        return
    timeline = Timeline()
    if args.action == 'prepull':
        emit({**prepull(client, target), 'summary': timeline.summary()})
        return
    target = validate_target(args.sha, args.worker_image, args.web_image)
    token = main_sha_and_token(target)
    if run(['git', 'rev-parse', 'HEAD']) != target['sha']:
        raise ValueError('local_checkout_not_target_main')
    with timeline.step('baseline'):
        state = resume_baseline(client, target, snapshot, consumers) if args.resume else baseline(client, target, consumers)
    integration = github_integration_preflight(client, state['apps'])
    changed = run(['git', 'diff', '--name-only', state['previous']['sha'], target['sha'],
                   '--', 'drizzle', 'lib/db/schema.ts', 'scripts/migrate.mjs'])
    if changed and not args.migration_verified:
        raise ValueError('database_changes_require_migration_verified')
    # The operator assertion alone is not proof: a release with DB changes also needs the applied production journal.
    migrations = migration_gate(client, target['sha']) if changed else None
    # The crawler pair is always released; refuse code without the agent-scan gate while the control is not legacy.
    agent_scan = agent_scan_release_gate(client, target['sha'])
    # 배포 전 상태: 모든 역할이 유효한 소유자면 된다(예비가 쥔 역할은 예비를 먼저 올릴 때 주가 되찾는다).
    # --resume 은 반쯤 올린 쌍의 release_mismatch 도 받는다.
    with timeline.step('gate:crawler'):
        gate = monitor_gate(client, 'crawler', strict=(), allow=state.get('mixedRoles'))
    with timeline.step('prePull'):
        pre_pull(target, token, setting(state['apps']['web-m3']['env'],
                                        'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY'))
    standby = gate.get('standbyActive') if isinstance(gate, dict) else None
    emit({'plan': list(release_order(consumers)), 'currentRelease': state['previous']['sha'],
          'targetRelease': target['sha'], 'mode': 'parallel-roles' if args.parallel_roles else 'sequential',
          'rollout': describe_steps(rollout_steps(consumers, args.parallel_roles)),
          **({'resume': state['resume']} if args.resume else {}), **({'standbyActive': standby} if standby else {}),
          'githubIntegration': integration, **agent_scan,
          **({'databaseMigrations': migrations} if migrations else {}), 'preflight': timeline.summary()})
    if args.action == 'run':
        deploy(client, target, token, state, args.snapshot, consumers, parallel_roles=args.parallel_roles)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit(error_fields(error))
        raise SystemExit(1)
