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
STAGE_FAILURE_REASONS = {stage: frozenset({'no_progress', 'worker_missing', 'consumer_missing', 'upstream_stalled'})
                         for stage in PROVIDER_STAGES | {'fetch', 'judge', 'publish', 'evidence', 'agent-evidence', 'ai-level', 'uptime'}}
STAGE_FAILURE_REASONS['scheduler'] = frozenset({'scheduler_missed', 'worker_missing'})
STAGE_FAILURE_REASONS.update({'role-' + role: frozenset({'worker_missing', 'restart_loop'})
                             for role in ('scheduler', 'crawler', 'reviewer', 'publisher', 'maintenance', 'text')})


def valid_review_failures(value):
    return (isinstance(value, list) and len(value) <= len(REVIEW_STAGES) and
            all(isinstance(row, dict) and set(row) == {'stage', 'reason'} and
                isinstance(row['stage'], str) and row['stage'] in REVIEW_STAGES and
                isinstance(row['reason'], str) and row['reason'] in REVIEW_REASONS for row in value) and
            len({row['stage'] for row in value}) == len(value))


def valid_stage_failures(value):
    return (isinstance(value, list) and len(value) <= len(STAGE_FAILURE_REASONS) and
            all(isinstance(row, dict) and set(row) == {'stage', 'reason'} and
                isinstance(row['stage'], str) and row['stage'] in STAGE_FAILURE_REASONS and
                isinstance(row['reason'], str) and row['reason'] in STAGE_FAILURE_REASONS[row['stage']] for row in value) and
            len({row['stage'] for row in value}) == len(value))


# 2026-10-31 (owner decision 2026-10-30): an unknown-outcome model call never stops work. 'review' (확인 못함 · 사람 검토)
# is informational only. Only a summarized 'alarm' with an occupying dispatched row past its bound (dispatch_stuck) or an
# unreadable ledger ('unknown') is an incident. Since 2026-11-10 an alarm of review backlog/stale reasons only (over the
# monitor thresholds) is a human review notice, not an incident (capacity_review_only). A pre-2026-10-31 monitor sends the
# three-key shape, where 'alarm' only meant "review pending"; it is read as review.
CAPACITY_STATUSES = ('ok', 'review', 'alarm', 'unknown')
CAPACITY_ALARM_REASONS = ('dispatch_stuck', 'review_backlog', 'review_stale')
CAPACITY_BASE_KEYS = frozenset({'status', 'truncated', 'requests'})
CAPACITY_SUMMARY_KEYS = frozenset({'count', 'oldestAgeSeconds', 'stuckDispatched', 'alarmReasons'})
UNKNOWN_CAPACITY = {'status': 'unknown', 'truncated': False, 'requests': []}


def _capacity_total(value):
    return type(value) is int and 0 <= value <= 10 ** 9


def validate_capacity_unknowns(value):
    if (not isinstance(value, dict) or set(value) not in (CAPACITY_BASE_KEYS, CAPACITY_BASE_KEYS | CAPACITY_SUMMARY_KEYS) or
            value['status'] not in CAPACITY_STATUSES or type(value['truncated']) is not bool or
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
    if 'count' not in value:
        # Unsummarized: 'review' and the legacy 'alarm' are both "review pending"; this shape can never be an incident alarm.
        if (value['status'] in ('review', 'alarm')) != pending:
            raise ValueError('invalid_capacity_unknowns')
        return value
    count, oldest, stuck, reasons = value['count'], value['oldestAgeSeconds'], value['stuckDispatched'], value['alarmReasons']
    if (value['status'] == 'unknown' or not _capacity_total(count) or not _capacity_total(stuck) or
            not (oldest is None or _capacity_total(oldest)) or not isinstance(reasons, list) or
            any(not isinstance(reason, str) or reason not in CAPACITY_ALARM_REASONS for reason in reasons) or
            reasons != sorted(set(reasons)) or count < len(value['requests']) or (value['truncated'] and count <= 64) or
            pending != (count > 0) or (count == 0 and oldest is not None) or
            ('dispatch_stuck' in reasons) != (stuck > 0) or
            (any(reason != 'dispatch_stuck' for reason in reasons) and count == 0) or
            value['status'] != ('alarm' if reasons else 'review' if pending else 'ok')):
        raise ValueError('invalid_capacity_unknowns')
    return value


def capacity_review_only(value):
    """Owner decision 2026-11-10: a summarized alarm whose only reasons are review-list thresholds (review_backlog, review_stale,
    any review_*) with no stuck dispatched row asks for human review and blocks nothing, so it is not an incident. Same rule as
    lib/operations/model-capacity-unknowns.ts capacityReviewOnlyAlarm: the monitor pushes UP with a message, the gateway row
    follows the monitor's own overall, Oracle does not alarm. The summary itself (status/alarmReasons) is relayed unchanged."""
    reasons = value.get('alarmReasons')
    return (value['status'] == 'alarm' and isinstance(reasons, list) and bool(reasons) and value.get('stuckDispatched') == 0 and
            all(isinstance(reason, str) and reason.startswith('review_') for reason in reasons))


def capacity_alarm(value):
    """Validated capacity summary -> incident. Review-only (also legacy 'alarm', and a summarized alarm of review_* reasons only
    since 2026-11-10) is not; a summarized alarm with dispatch_stuck or a failed read is."""
    return value['status'] == 'unknown' or value['status'] == 'alarm' and 'alarmReasons' in value and not capacity_review_only(value)


def capacity_pending(value):
    return bool(value['requests']) or value['truncated']


def merge_capacity_unknowns(items, complete):
    """A fleet summary needs every replica's explicit observation. An incomplete
    read is unknown: partial review rows cannot clear a previously known alarm.
    Oracle retains the last known review/alarm separately from this failed read.
    """
    if not complete or any(item['status'] == 'unknown' for item in items):
        return dict(UNKNOWN_CAPACITY)
    requests = {}
    for item in items:
        for row in item['requests']:
            requests.setdefault(row['requestId'], row)
    truncated = len(requests) > 64 or any(item['truncated'] for item in items)
    pending = bool(requests) or truncated
    summaries = [item for item in items if 'count' in item]
    reasons = sorted({reason for item in summaries for reason in item['alarmReasons']})
    status = 'alarm' if reasons else 'review' if pending else 'ok'
    merged = {'status': status, 'truncated': truncated, 'requests': list(requests.values())[:64]}
    if reasons or (status != 'unknown' and len(summaries) == len(items)):
        count = max([len(requests), 65 if truncated else 0] + [item['count'] for item in summaries])
        ages = [item['oldestAgeSeconds'] for item in summaries if item['oldestAgeSeconds'] is not None]
        merged.update(count=count, oldestAgeSeconds=max(ages) if ages and count else None,
                      stuckDispatched=max([0] + [item['stuckDispatched'] for item in summaries]), alarmReasons=reasons)
    return validate_capacity_unknowns(merged)


MONITOR_PROBE = """try {const j=JSON.parse(require('fs').readFileSync(process.env.MONITOR_HEALTH_PATH||'/tmp/monitor-health.json','utf8'));
const allowed=['reason-translate','crawl-tagline','keywords','keyword-verify','product-translate','tagline-ko','intro-check'];
const reviews=['first','second'],reasons=['capacity_blocked','consumer_missing','worker_missing','upstream_stalled','local_stalled','review_stalled'];
const reviewKnown=Array.isArray(j.reviewFailures)&&j.reviewFailures.length<=2&&j.reviewFailures.every(v=>v&&typeof v==='object'&&!Array.isArray(v)&&
Object.keys(v).sort().join(',')==='reason,stage'&&reviews.includes(v.stage)&&reasons.includes(v.reason))&&new Set(j.reviewFailures.map(v=>v.stage)).size===j.reviewFailures.length;
const stageKeys=[...allowed,'fetch','judge','publish','evidence','agent-evidence','ai-level','uptime'],roles=['scheduler','crawler','reviewer','publisher','maintenance','text'];
const stageKnown=Array.isArray(j.stageFailures)&&j.stageFailures.length<=stageKeys.length+roles.length+1&&j.stageFailures.every(v=>v&&typeof v==='object'&&!Array.isArray(v)&&
Object.keys(v).sort().join(',')==='reason,stage'&&typeof v.stage==='string'&&typeof v.reason==='string'&&
(stageKeys.includes(v.stage)?['no_progress','worker_missing','consumer_missing','upstream_stalled'].includes(v.reason):
v.stage==='scheduler'?['scheduler_missed','worker_missing'].includes(v.reason):roles.some(role=>v.stage==='role-'+role)&&['worker_missing','restart_loop'].includes(v.reason)))
&&new Set(j.stageFailures.map(v=>v.stage)).size===j.stageFailures.length;
const capacity=v=>{const unknown={status:'unknown',truncated:false,requests:[]};
if(!v||!['ok','review','alarm','unknown'].includes(v.status)||typeof v.truncated!=='boolean'||!Array.isArray(v.requests)||v.requests.length>64)return unknown;
const ids=new Set(),rows=[];
for(const r of v.requests){if(!r||typeof r.requestId!=='string'||!(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/).test(r.requestId)||ids.has(r.requestId)
||!['routeId','groupId'].every(k=>typeof r[k]==='string'&&(/^[A-Za-z0-9_.:@+/-]{1,120}$/).test(r[k]))||typeof r.oldPolicy!=='boolean'||typeof r.localEndRecorded!=='boolean')return unknown;
ids.add(r.requestId);rows.push({requestId:r.requestId,routeId:r.routeId,groupId:r.groupId,oldPolicy:r.oldPolicy,localEndRecorded:r.localEndRecorded});}
const n=x=>Number.isSafeInteger(x)&&x>=0&&x<=1e9,base={status:v.status,truncated:v.truncated,requests:rows};
if(['count','oldestAgeSeconds','stuckDispatched','alarmReasons'].every(k=>v[k]===undefined))
return ((v.status==='review'||v.status==='alarm')===(rows.length>0||v.truncated))?base:unknown;
if(!n(v.count)||!n(v.stuckDispatched)||!(v.oldestAgeSeconds===null||n(v.oldestAgeSeconds))||!Array.isArray(v.alarmReasons)||v.alarmReasons.length>3
||!v.alarmReasons.every(k=>['dispatch_stuck','review_backlog','review_stale'].includes(k)))return unknown;
return {...base,count:v.count,oldestAgeSeconds:v.oldestAgeSeconds,stuckDispatched:v.stuckDispatched,alarmReasons:[...v.alarmReasons]};};
console.log(JSON.stringify({fresh:Number.isSafeInteger(j.checkedAt)&&Date.now()-j.checkedAt>=-1000&&Date.now()-j.checkedAt<90000,
overall:['ok','unknown','alarm'].includes(j.overall)?j.overall:'unknown',
...(j.capacityUnknowns!==undefined?{capacityUnknowns:capacity(j.capacityUnknowns)}:{}),
...(Array.isArray(j.providerFailures)?{providerFailures:allowed.filter(key=>j.providerFailures.includes(key))}:{}),
...(reviewKnown?{reviewFailures:j.reviewFailures.map(v=>({stage:v.stage,reason:v.reason}))}:{}),
...(stageKnown?{stageFailures:j.stageFailures.map(v=>({stage:v.stage,reason:v.reason}))}:{})}));}
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
                result.update(reason='pipeline_alarm' if not overall_ok else 'ok' if healthy else 'container_unhealthy',
                              ok=overall_ok and healthy)
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
                if all(valid_stage_failures(check.get('stageFailures')) for check in checks):
                    stages = {}
                    conflict = False
                    for check in checks:
                        for failure in check['stageFailures']:
                            previous = stages.get(failure['stage'])
                            conflict |= previous is not None and previous != failure['reason']
                            stages[failure['stage']] = failure['reason']
                    if not conflict:
                        result['stageFailures'] = [{'stage': stage, 'reason': stages[stage]} for stage in sorted(stages)]
                capacity = []
                for check in checks:
                    if 'capacityUnknowns' in check:
                        try:
                            capacity.append(validate_capacity_unknowns(check['capacityUnknowns']))
                        except ValueError:
                            capacity.append(dict(UNKNOWN_CAPACITY))  # contradictory summary: unread, never a clear
                if capacity:
                    merged = merge_capacity_unknowns(capacity, len(capacity) == len(checks))
                    result['capacityUnknowns'] = merged
                    # 확인 못함(review) alone, or an alarm of review_* reasons only (2026-11-10), leaves the row as the
                    # monitor's own overall reports it.
                    if capacity_alarm(merged):
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
            if not isinstance(attempts, list) or any(type(at) not in (int, float) or not math.isfinite(at) or at < 0 or at > now for at in attempts):
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
