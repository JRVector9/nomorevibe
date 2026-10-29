#!/usr/bin/env python3
"""Forced SSH command: bounded fleet observation and same-spec web/monitor recovery.

Install with a root-owned config/source, a from= restricted key and OpenSSH
restrict. No input is evaluated as shell, no env/source/image/DB is returned.
"""
import argparse
import fcntl
import http.client
import io
import json
import math
import os
import re
import signal
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def bounded_output(argv, *, payload=None, limit=2_000_000, timeout=25):
    """Bound bytes while reading, kill the whole local command group on expiry."""
    process = subprocess.Popen(argv, stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    expired = threading.Event()

    def kill():
        # The leader may exit while a descendant still owns the output pipe.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def deadline():
        expired.set()
        kill()

    timer = threading.Timer(timeout, deadline)
    timer.daemon = True
    timer.start()
    try:
        if payload is not None:
            process.stdin.write(payload)
            process.stdin.close()
        output = process.stdout.read(limit + 1)
        if len(output) > limit:
            raise ValueError('command_output_exceeded')
        process.wait()
        if process.returncode or expired.is_set():
            raise ValueError('bounded_command_failed')
        return output
    finally:
        timer.cancel()
        kill()
        process.wait()
        process.stdout.close()
        if process.stdin is not None and not process.stdin.closed:
            process.stdin.close()


def command(argv):
    return bounded_output(argv).decode('utf-8')


def save(path, value):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(value, out)
        out.flush()
        os.fsync(out.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)
    # The reservation's directory entry must survive a host power loss before
    # any recovery action is admitted, not only its temporary file contents.
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


WEB_PROBE = """Promise.all(['/api/health','/'].map(async path=>{
try {const r=await fetch('http://'+(process.env.HOSTNAME||'127.0.0.1')+':3000'+path,{signal:AbortSignal.timeout(5000),redirect:'error'});
if(path==='/api/health'){const j=await r.json();return {ready:r.ok&&j.status==='ok'&&j.db==='ok',db:j.db==='unavailable'?'unavailable':'unknown'};}
await r.body?.cancel();return {page:r.ok};}catch{return path==='/api/health'?{ready:false,db:'unknown'}:{page:false};}
})).then(rows=>console.log(JSON.stringify(Object.assign({},...rows))))"""
PROVIDER_STAGES = frozenset({'reason-translate', 'crawl-tagline', 'keywords', 'keyword-verify',
                             'product-translate', 'tagline-ko', 'intro-check'})
REVIEW_STAGES = frozenset({'first', 'second'})
REVIEW_REASONS = frozenset({'capacity_blocked', 'consumer_missing', 'worker_missing',
                          'upstream_stalled', 'local_stalled', 'review_stalled'})


def valid_review_failures(value):
    return (isinstance(value, list) and len(value) <= len(REVIEW_STAGES) and
            all(isinstance(row, dict) and set(row) == {'stage', 'reason'} and
                isinstance(row['stage'], str) and row['stage'] in REVIEW_STAGES and
                isinstance(row['reason'], str) and row['reason'] in REVIEW_REASONS for row in value) and
            len({row['stage'] for row in value}) == len(value))


def validate_capacity_unknowns(value):
    if (not isinstance(value, dict) or set(value) != {'status', 'truncated', 'requests'} or
            value['status'] not in ('ok', 'alarm', 'unknown') or type(value['truncated']) is not bool or
            not isinstance(value['requests'], list) or len(value['requests']) > 64):
        raise ValueError('invalid_capacity_unknowns')
    ids = set()
    for row in value['requests']:
        if (not isinstance(row, dict) or set(row) != {'requestId', 'routeId', 'groupId', 'oldPolicy', 'localEndRecorded'} or
                not isinstance(row['requestId'], str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', row['requestId']) or
                row['requestId'] in ids or any(type(row[k]) is not bool for k in ('oldPolicy', 'localEndRecorded')) or
                any(not isinstance(row[k], str) or not re.fullmatch(r'[A-Za-z0-9_.:@+/-]{1,120}', row[k]) for k in ('routeId', 'groupId'))):
            raise ValueError('invalid_capacity_unknowns')
        ids.add(row['requestId'])
    pending = bool(value['requests']) or value['truncated']
    if (value['status'] == 'alarm') != pending:
        raise ValueError('invalid_capacity_unknowns')
    return value


MONITOR_PROBE = """try {const j=JSON.parse(require('fs').readFileSync(process.env.MONITOR_HEALTH_PATH||'/tmp/monitor-health.json','utf8'));
const allowed=['reason-translate','crawl-tagline','keywords','keyword-verify','product-translate','tagline-ko','intro-check'];
const reviews=['first','second'],reasons=['capacity_blocked','consumer_missing','worker_missing','upstream_stalled','local_stalled','review_stalled'];
const reviewKnown=Array.isArray(j.reviewFailures)&&j.reviewFailures.length<=2&&j.reviewFailures.every(v=>v&&typeof v==='object'&&!Array.isArray(v)&&
Object.keys(v).sort().join(',')==='reason,stage'&&reviews.includes(v.stage)&&reasons.includes(v.reason))&&new Set(j.reviewFailures.map(v=>v.stage)).size===j.reviewFailures.length;
const capacity=v=>{const unknown={status:'unknown',truncated:false,requests:[]};
if(!v||!['ok','alarm','unknown'].includes(v.status)||typeof v.truncated!=='boolean'||!Array.isArray(v.requests)||v.requests.length>64)return unknown;
const ids=new Set(),rows=[];
for(const r of v.requests){if(!r||typeof r.requestId!=='string'||!(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/).test(r.requestId)||ids.has(r.requestId)
||!['routeId','groupId'].every(k=>typeof r[k]==='string'&&(/^[A-Za-z0-9_.:@+/-]{1,120}$/).test(r[k]))||typeof r.oldPolicy!=='boolean'||typeof r.localEndRecorded!=='boolean')return unknown;
ids.add(r.requestId);rows.push({requestId:r.requestId,routeId:r.routeId,groupId:r.groupId,oldPolicy:r.oldPolicy,localEndRecorded:r.localEndRecorded});}
return ((v.status==='alarm')===(rows.length>0||v.truncated))?{status:v.status,truncated:v.truncated,requests:rows}:unknown;};
console.log(JSON.stringify({fresh:Number.isSafeInteger(j.checkedAt)&&Date.now()-j.checkedAt>=-1000&&Date.now()-j.checkedAt<90000,
overall:['ok','unknown','alarm'].includes(j.overall)?j.overall:'unknown',
...(j.capacityUnknowns!==undefined?{capacityUnknowns:capacity(j.capacityUnknowns)}:{}),
...(Array.isArray(j.providerFailures)?{providerFailures:allowed.filter(key=>j.providerFailures.includes(key))}:{}),
...(reviewKnown?{reviewFailures:j.reviewFailures.map(v=>({stage:v.stage,reason:v.reason}))}:{})}));}
catch{console.log(JSON.stringify({fresh:false,overall:'unknown'}));}"""


def _age(value, now):
    from datetime import datetime
    try:
        return now - datetime.fromisoformat(re.sub(r'(\.\d{6})\d+', r'\1', value).replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError):
        return -1


def observe(key, cfg, run=command, now=None):
    now = time.time() if now is None else now
    result = {'key': key, 'version': None, 'replicas': None, 'settled': False,
              'ok': False, 'recoverable': False, 'reason': 'probe_unknown'}
    try:
        service = json.loads(run(['docker', 'service', 'inspect', cfg['service']]))[0]
        spec = service['Spec']
        replicas = spec['Mode']['Replicated']['Replicas']
        result.update(version=service['Version']['Index'], replicas=replicas)
        settled = ((service.get('UpdateStatus') or {}).get('State') in (None, 'completed') and
                   _age(service.get('UpdatedAt'), now) >= 180)
        result['settled'] = settled
        if replicas != cfg['replicas'] or replicas <= 0:
            result['reason'] = 'replica_intent_changed'
            return result
        ids = run(['docker', 'ps', '--filter', 'label=com.docker.swarm.service.id=' + service['ID'],
                   '--filter', 'status=running', '--format', '{{.ID}}']).split()
        if not ids or len(ids) != replicas or any(not re.fullmatch('[a-f0-9]{12,64}', cid) for cid in ids):
            result['reason'] = 'replicas_missing'
            return result
        containers = json.loads(run(['docker', 'inspect', *ids]))
        if (not isinstance(containers, list) or len(containers) != len(ids) or
                any(sum(isinstance(row, dict) and isinstance(row.get('Id'), str) and row['Id'].startswith(cid)
                        for row in containers) != 1 for cid in ids)):
            result['reason'] = 'probe_unknown'
            return result
        healthy = all((row['State'].get('Health') or {}).get('Status') == 'healthy' for row in containers)
        if any(_age(row['State'].get('StartedAt'), now) < 180 for row in containers):
            result['reason'] = 'warming_up'
            return result
        if cfg['kind'] == 'web':
            checks = [json.loads(run(['docker', 'exec', cid, 'node', '-e', WEB_PROBE])) for cid in ids]
            ready = all(row.get('ready') is True for row in checks)
            if any(row.get('db') == 'unavailable' for row in checks):
                result['reason'] = 'database_unavailable'
            elif ready and any(row.get('page') is not True for row in checks):
                result.update(reason='web_page_failed', recoverable=settled)
            elif ready:
                result.update(reason='ok', ok=True)
            else:
                result['reason'] = 'web_not_ready'
        elif cfg['kind'] == 'monitor':
            checks = [json.loads(run(['docker', 'exec', cid, 'node', '-e', MONITOR_PROBE])) for cid in ids]
            if any(check.get('fresh') is not True for check in checks):
                result.update(reason='monitor_stale', recoverable=settled)
            else:
                overall_ok = all(check.get('overall') == 'ok' for check in checks)
                result.update(reason='ok' if overall_ok else 'pipeline_alarm', ok=overall_ok and healthy)
                failures = sorted({stage for check in checks for stage in check.get('providerFailures', [])
                                   if isinstance(stage, str) and stage in PROVIDER_STAGES})
                if failures or all(isinstance(check.get('providerFailures'), list) for check in checks):
                    result['providerFailures'] = failures
                # Mixed/old replicas and contradictory observations are unknown,
                # never an explicit clear of an already reported review incident.
                if all(valid_review_failures(check.get('reviewFailures')) for check in checks):
                    review = {}
                    conflict = False
                    for check in checks:
                        for failure in check['reviewFailures']:
                            previous = review.get(failure['stage'])
                            conflict |= previous is not None and previous != failure['reason']
                            review[failure['stage']] = failure['reason']
                    if not conflict:
                        result['reviewFailures'] = [{'stage': stage, 'reason': review[stage]} for stage in sorted(review)]
                capacity = [validate_capacity_unknowns(check['capacityUnknowns']) for check in checks if 'capacityUnknowns' in check]
                if capacity:
                    requests = {row['requestId']: row for item in capacity for row in item['requests']}
                    truncated = len(requests) > 64 or any(item['truncated'] for item in capacity)
                    status = 'alarm' if requests or truncated else 'unknown' if len(capacity) != len(checks) or any(item['status'] == 'unknown' for item in capacity) else 'ok'
                    result['capacityUnknowns'] = {'status': status, 'truncated': truncated, 'requests': list(requests.values())[:64]}
                    if status != 'ok':
                        result.update(reason='pipeline_alarm', ok=False, recoverable=False)
        else:
            result.update(reason='ok' if healthy else 'container_unhealthy', ok=healthy)
        return result
    except Exception:
        return result


def probe(config, run=command):
    with ThreadPoolExecutor(max_workers=4) as pool:
        services = list(pool.map(lambda item: observe(*item, run=run), config['services'].items()))
    return {'services': services}


def docker_http(path, body):
    payload = json.dumps(body).encode()
    request = ('POST ' + path + ' HTTP/1.1\r\nHost: docker\r\nConnection: close\r\n'
               'Content-Type: application/json\r\nContent-Length: ' + str(len(payload)) + '\r\n\r\n').encode() + payload
    # Dial the locally configured Docker context without copying Docker credentials
    # or exposing a general socket/tunnel to the SSH client.
    output = bounded_output(['docker', 'system', 'dial-stdio'], payload=request, limit=65536)

    class ResponseSocket:
        def makefile(self, *_):
            return io.BytesIO(output)

    response = http.client.HTTPResponse(ResponseSocket())
    response.begin()
    return response.status


def force_update(cfg, version, run=command, exchange=docker_http):
    service = json.loads(run(['docker', 'service', 'inspect', cfg['service']]))[0]
    if (service['Version']['Index'] != version or service['Spec']['Name'] != cfg['service'] or
            not re.fullmatch('[a-z0-9]{25}', service['ID'])):
        return {'result': 'refused'}
    spec = service['Spec']
    task = spec['TaskTemplate']
    force = task.get('ForceUpdate', 0)
    if type(force) is not int or not 0 <= force < 2 ** 53:
        return {'result': 'refused'}
    task['ForceUpdate'] = force + 1
    # Engine CAS closes the inspect/update race. All other spec bytes, including
    # replica intent, rollout policy, release, shutdown grace and auth, stay put.
    status = exchange('/v1.45/services/' + service['ID'] + '/update?version=' + str(version) + '&registryAuthFrom=spec', spec)
    return {'result': 'requested' if status == 200 else 'refused' if status == 409 else 'unknown'}


def recover(config, key, version, *, now=None, probe_fn=probe, force_fn=force_update):
    cfg = config['services'].get(key)
    if not cfg or cfg['kind'] not in ('web', 'monitor'):
        return {'result': 'refused'}
    path = Path(config['state'])
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(str(path) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        now = time.time() if now is None else now
        try:
            state = json.loads(path.read_text()) if path.exists() else {'attempts': {}}
            attempts = state['attempts'].get(key, [])
            if not isinstance(attempts, list) or any(type(at) not in (int, float) or not math.isfinite(at) or at > now for at in attempts):
                return {'result': 'limited'}
            attempts = [at for at in attempts if now - at < 86400]
            if len(attempts) >= 2 or (attempts and now - max(attempts) < 900):
                return {'result': 'limited'}
            row = next((row for row in probe_fn(config)['services'] if row['key'] == key), {})
            if (row.get('version') != version or row.get('replicas') != cfg['replicas'] or
                    row.get('settled') is not True or row.get('recoverable') is not True):
                return {'result': 'refused'}
            # Reserve BEFORE the only mutation: an SSH/API timeout is never proof of non-execution.
            state['attempts'][key] = attempts + [now]
            save(path, state)
            return force_fn(cfg, version)
        except Exception:
            return {'result': 'unknown'}


def parse_command(value, config):
    if value == 'probe':
        return ('probe',)
    match = re.fullmatch(r'recover ([a-z0-9-]{1,60}) ([0-9]{1,16})', value)
    if not match or match[1] not in config['services']:
        raise ValueError('command_denied')
    return ('recover', match[1], int(match[2]))


def read_config(path):
    config = json.loads(Path(path).read_text())
    services = config['services']
    if not isinstance(services, dict) or not 1 <= len(services) <= 30:
        raise ValueError('invalid_config')
    for key, cfg in services.items():
        if (not re.fullmatch('[a-z0-9-]{1,60}', key) or
                not re.fullmatch('[a-z0-9-]{1,100}', cfg['service']) or
                cfg['kind'] not in ('web', 'monitor', 'worker', 'scheduler', 'connect-agent') or
                type(cfg['replicas']) is not int or not 1 <= cfg['replicas'] <= 8):
            raise ValueError('invalid_config')
    return config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    try:
        config = read_config(args.config)
        action = parse_command(os.environ.get('SSH_ORIGINAL_COMMAND', ''), config)
        result = probe(config) if action[0] == 'probe' else recover(config, *action[1:])
        print(json.dumps(result))
    except Exception:
        print(json.dumps({'error': 'gateway_denied'}))
        raise SystemExit(1)


if __name__ == '__main__':
    main()
