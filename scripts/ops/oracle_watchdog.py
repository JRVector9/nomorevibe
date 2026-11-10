#!/usr/bin/env python3
"""Independent Oracle loop; uses only forced SSH commands and private Kuma URLs."""
import argparse
import fcntl
import http.client
import json
import math
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlencode, urlsplit

from recovery_gateway import (PROVIDER_STAGES, UNKNOWN_CAPACITY, bounded_output, capacity_alarm, capacity_pending, save,
                              valid_review_failures, valid_stage_failures, validate_capacity_unknowns)
from incident_notifications import notify, validate_destination


REASONS = {'probe_unknown', 'replica_intent_changed', 'replicas_missing', 'warming_up',
           'database_unavailable', 'web_page_failed', 'ok', 'web_not_ready', 'monitor_stale',
           'pipeline_alarm', 'container_unhealthy', 'native_unit_failed', 'native_unit_inactive', 'native_unit_unknown'}
# 2026-10-31: unknown-outcome model calls (확인 못함) are a human review list (/admin/models), never an incident by
# themselves. The monitor decides the review thresholds; Oracle only relays its summarized alarm reasons
# (review_backlog/review_stale/dispatch_stuck) and keeps no per-request clock or per-request incident.
# 2026-11-10: an alarm of review_* reasons only with no stuck dispatched row (recovery_gateway.capacity_review_only) is not
# an Oracle alarm or DOWN; the monitor's UP push carries the review message. Its one Telegram notice per reason is kept.


def validate_report(report):
    if not isinstance(report, dict) or set(report) != {'services'} or not isinstance(report['services'], list) or not 1 <= len(report['services']) <= 30:
        raise ValueError('invalid_report')
    keys = set()
    for row in report['services']:
        if (not isinstance(row, dict) or set(row) - {'providerFailures', 'reviewFailures', 'stageFailures', 'capacityUnknowns'} != {'key', 'version', 'replicas', 'settled', 'ok', 'recoverable', 'reason'} or
                not isinstance(row['key'], str) or not re.fullmatch('[a-z0-9-]{1,60}', row['key']) or row['key'] in keys or
                row['reason'] not in REASONS or any(type(row[key]) is not bool for key in ('ok', 'recoverable', 'settled')) or
                not (row['version'] is None or type(row['version']) is int and 0 < row['version'] < 10 ** 16) or
                not (row['replicas'] is None or type(row['replicas']) is int and 0 <= row['replicas'] <= 8)):
            raise ValueError('invalid_report')
        failures = row.get('providerFailures', [])
        if (not isinstance(failures, list) or len(failures) > len(PROVIDER_STAGES) or
                any(not isinstance(stage, str) or stage not in PROVIDER_STAGES for stage in failures) or
                len(set(failures)) != len(failures)):
            raise ValueError('invalid_provider_failures')
        if 'reviewFailures' in row and not valid_review_failures(row['reviewFailures']):
            raise ValueError('invalid_review_failures')
        if 'stageFailures' in row and not valid_stage_failures(row['stageFailures']):
            raise ValueError('invalid_stage_failures')

        if 'capacityUnknowns' in row:
            capacity = validate_capacity_unknowns(row['capacityUnknowns'])
            if capacity_alarm(capacity) and (row['ok'] or row['recoverable']):
                raise ValueError('invalid_capacity_recovery_claim')
        if row['recoverable'] and (row['reason'] not in ('web_page_failed', 'monitor_stale', 'native_unit_failed') or not row['settled'] or row['ok']):
            raise ValueError('invalid_recovery_claim')
        keys.add(row['key'])
    return report


def stored_capacity_alarm(target):
    capacity = target.get('capacityUnknowns') if isinstance(target, dict) else None
    if capacity is None:
        return False
    try:
        return capacity_alarm(validate_capacity_unknowns(capacity))
    except ValueError:
        return True  # corrupt stored observation is unknown, never a clear


def ssh(host, action):
    argv = ['ssh', '-F', '/dev/null', '-p', '22222', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=8',
            '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
            '-o', 'UserKnownHostsFile=' + host['knownHosts'], '-i', host['key'], host['target'], action]
    return json.loads(bounded_output(argv, limit=32768, timeout=100))


def collect(config):
    def read(item):
        name, host = item
        try:
            report = validate_report(ssh(host, 'probe'))
            if {row['key'] for row in report['services']} != set(host['services']):
                raise ValueError('inventory_changed')
            return name, report
        except Exception:
            return name, None
    with ThreadPoolExecutor(max_workers=3) as pool:
        return dict(pool.map(read, config['hosts'].items()))


def cycle(config, state, reports, *, now=None, recover=None):
    now = time.time() if now is None else now
    events = []
    alarm = False
    for host in config['hosts']:
        report = reports.get(host)
        if report is None:
            alarm = alarm or any(key.startswith(host + '/') and (value.get('bad', 0) >= 2 or stored_capacity_alarm(value))
                                 for key, value in state['targets'].items())
            # An unavailable host supplies no fresh generic-stage sample. Keep
            # notification receipts, but require two observations after it returns.
            for key, value in state['targets'].items():
                if key.startswith(host + '/'):
                    value.pop('stageFailures', None)
            rows = [{'key': 'host', 'ok': False, 'version': None, 'recoverable': False, 'reason': 'probe_unknown'}]
        else:
            rows = validate_report(report)['services']
        for row in rows:
            key = host + '/' + row['key']
            old = state['targets'].get(key, {})
            consecutive = 0 <= now - old.get('at', 0) <= 150 and old.get('version') == row['version']
            bad = min(3, old.get('bad', 0) + 1) if consecutive and not row['ok'] else (0 if row['ok'] else 1)
            actionable = (min(3, old.get('actionable', 0) + 1) if consecutive and old.get('reason') == row['reason']
                          else 1) if row['recoverable'] else 0
            attempts = old.get('attempts', [])
            if (not isinstance(attempts, list) or any(type(at) not in (int, float) or not math.isfinite(at) or at < 0 or at > now for at in attempts)):
                # A clock rollback or corrupt recovery history cannot open a fresh mutation budget.
                attempts = [now, now]
            attempts = [at for at in attempts if now - at < 86400]
            target = {'at': now, 'bad': bad, 'actionable': actionable, 'reason': row['reason'],
                      'version': row['version'], 'attempts': attempts}
            # Provider retries refresh database timestamps. The independent,
            # durable observer measures uninterrupted failure instead of the
            # age of the last retry. Releases alone do not reset this clock.
            observations = {}
            previous = old.get('providerFailures', {})
            for stage in row.get('providerFailures', []):
                history = previous.get(stage, {}) if isinstance(previous, dict) else {}
                if not isinstance(history, dict):
                    history = {}
                first, last = history.get('first'), history.get('last')
                valid = (type(first) in (int, float) and type(last) in (int, float) and
                         math.isfinite(first) and math.isfinite(last) and 0 <= first <= last <= now and now - last <= 150)
                first = first if valid else now
                observations[stage] = {'first': first, 'last': now}
                if now - first >= 1800:
                    alarm = True
                    events.append({'target': key, 'stage': stage, 'reason': 'upstream_stalled'})
            if observations:
                target['providerFailures'] = observations
            review_observations = {}
            previous_reviews = old.get('reviewFailures', {})
            for failure in row.get('reviewFailures', []):
                stage, reason = failure['stage'], failure['reason']
                history = previous_reviews.get(stage, {}) if isinstance(previous_reviews, dict) else {}
                previous_at = history.get('at') if isinstance(history, dict) else None
                continuous = (type(previous_at) in (int, float) and math.isfinite(previous_at) and
                              0 <= now - previous_at <= 150 and history.get('reason') == reason and
                              type(history.get('bad')) is int and 0 <= history['bad'] <= 3)
                samples = min(3, history['bad'] + 1) if continuous else 1
                review_observations[stage] = {'at': now, 'reason': reason, 'bad': samples}
                if samples >= 2:
                    alarm = True
                    events.append({'target': key, 'stage': stage, 'reason': reason, 'bad': samples})
            if review_observations:
                target['reviewFailures'] = review_observations

            stage_observations = {}
            previous_stages = old.get('stageFailures', {})
            for failure in row.get('stageFailures', []):
                stage, reason = failure['stage'], failure['reason']
                history = previous_stages.get(stage, {}) if isinstance(previous_stages, dict) else {}
                previous_at = history.get('at') if isinstance(history, dict) else None
                continuous = (type(previous_at) in (int, float) and math.isfinite(previous_at) and
                              0 <= now - previous_at <= 150 and history.get('reason') == reason and
                              type(history.get('bad')) is int and 0 <= history['bad'] <= 3)
                samples = min(3, history['bad'] + 1) if continuous else 1
                stage_observations[stage] = {'at': now, 'reason': reason, 'bad': samples}
                if samples >= 2:
                    alarm = True
                    events.append({'target': key, 'stage': 'progress-' + stage, 'reason': reason, 'bad': samples})
            if stage_observations:
                target['stageFailures'] = stage_observations

            capacity = row.get('capacityUnknowns')
            observed_unknown = capacity is not None and capacity['status'] == 'unknown'
            # A missing/failed read cannot clear a known review queue or alarm. Only a fresh, explicit observation can.
            if capacity is None or observed_unknown:
                previous_capacity = old.get('capacityUnknowns')
                if previous_capacity is not None:
                    try:
                        previous_capacity = validate_capacity_unknowns(previous_capacity)
                    except ValueError:
                        previous_capacity = dict(UNKNOWN_CAPACITY)
                    if capacity is None or capacity_pending(previous_capacity) or capacity_alarm(previous_capacity):
                        capacity = previous_capacity
            if capacity is not None:
                capacity = validate_capacity_unknowns(capacity)
                target['capacityUnknowns'] = capacity
                if observed_unknown or capacity_alarm(capacity):
                    alarm = True
                for reason in capacity.get('alarmReasons', []) if capacity['status'] == 'alarm' else []:
                    events.append({'target': key, 'stage': 'capacity', 'reason': reason, 'count': capacity['count'],
                                   'oldestAgeSeconds': capacity['oldestAgeSeconds'], 'stuckDispatched': capacity['stuckDispatched']})
                if capacity_pending(capacity):
                    # Informational log line only: no incident, no DOWN, no Oracle model/DB authority.
                    events.append({'target': key, 'reason': 'model_review_pending', 'truncated': capacity['truncated'],
                                   'count': capacity.get('count', len(capacity['requests'])),
                                   'oldestAgeSeconds': capacity.get('oldestAgeSeconds')})
            state['targets'][key] = target
            if bad >= 2:
                alarm = True
            if (config.get('recover') is True and actionable >= 3 and row['recoverable'] and row['version'] is not None and
                    len(attempts) < 2 and (not attempts or now - max(attempts) >= 900)):
                target['attempts'].append(now)
                save(config['state'], state)
                try:
                    result = recover(host, row['key'], row['version'])
                    outcome = result.get('result') if isinstance(result, dict) else None
                except Exception:
                    outcome = None
                events.append({'target': key, 'recovery': outcome if outcome in ('requested', 'refused', 'limited') else 'unknown'})
            events.append({'target': key, 'reason': row['reason'], 'bad': bad})
        if report is not None:
            state['targets'].pop(host + '/host', None)
    save(config['state'], state)
    return {'ok': not alarm, 'events': events}


def push(url, ok, *, deadline_seconds=5):
    # No redirect handling, proxies, response bodies, URL or exception logging.
    target = urlsplit(url)
    if target.scheme != 'https' or target.username or target.password or target.fragment:
        raise ValueError('push_configuration_invalid')
    query = target.query + ('&' if target.query else '') + urlencode({'status': 'up' if ok else 'down',
                                                                    'msg': 'Oracle watchdog healthy' if ok else 'Oracle watchdog incident'})
    connection = http.client.HTTPSConnection(target.hostname, target.port, timeout=5)
    timer = None
    try:
        connection.connect()
        transport = connection.sock

        def deadline():
            try:
                transport.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        # Socket idle timeouts alone allow a slow-drip header/body to stop the
        # monitoring loop indefinitely. Shutdown wakes blocked SSL reads too.
        timer = threading.Timer(deadline_seconds, deadline)
        timer.daemon = True
        timer.start()
        connection.request('POST', target.path + '?' + query, body=b'')
        response = connection.getresponse()
        body = response.read(8193)
        if response.status != 200 or len(body) > 8192 or json.loads(body).get('ok') is not True:
            raise ValueError('push_failed')
    finally:
        if timer:
            timer.cancel()
        connection.close()


def deliver(config, ok):
    targets = [(url, ok) for url in config['pushUrls']] + [(url, True) for url in config.get('heartbeatUrls', [])]
    with ThreadPoolExecutor(max_workers=4) as pool:
        receipts = list(pool.map(lambda target: safe_push(*target), targets))
    boundary = len(config['pushUrls'])
    return {'receipts': receipts[:boundary], 'heartbeatReceipts': receipts[boundary:]}


def read_config(path):
    path = Path(path)
    if path.stat().st_mode & 0o077:
        raise ValueError('private_configuration_required')
    config = json.loads(path.read_text())
    if type(config.get('recover')) is not bool or not isinstance(config.get('hosts'), dict) or not 1 <= len(config['hosts']) <= 3:
        raise ValueError('invalid_configuration')
    for name, host in config['hosts'].items():
        if (not re.fullmatch('[a-z0-9-]{1,30}', name) or
                not re.fullmatch(r'[a-z_][a-z0-9_-]*@100\.[0-9.]+', host['target']) or
                not isinstance(host.get('services'), list) or not host['services'] or len(set(host['services'])) != len(host['services'])):
            raise ValueError('invalid_configuration')
        for key in ('key', 'knownHosts'):
            if not Path(host[key]).is_absolute() or not Path(host[key]).is_file():
                raise ValueError('missing_ssh_material')
    if not isinstance(config.get('pushUrls'), list) or not config['pushUrls']:
        raise ValueError('push_target_required')
    if not isinstance(config.get('heartbeatUrls', []), list):
        raise ValueError('invalid_heartbeat_targets')
    endpoints = []
    for value in config['pushUrls'] + config.get('heartbeatUrls', []):
        url = urlsplit(value)
        if url.scheme != 'https' or not url.hostname or url.username or url.password or url.fragment:
            raise ValueError('invalid_push_target')
        # Kuma identifies its Push monitor by path, not status/message query.
        endpoints.append((url.hostname.lower().rstrip('.'), url.port if url.port is not None else 443, url.path or '/'))
    boundary = len(config['pushUrls'])
    if set(endpoints[:boundary]) & set(endpoints[boundary:]):
        raise ValueError('overlapping_push_targets')
    if 'incidentNotifications' in config:
        validate_destination(config['incidentNotifications'])
    return config


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    parser.add_argument('--once', action='store_true')
    args = parser.parse_args()
    config = read_config(args.config)
    path = Path(config['state'])
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    with open(str(path) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state = json.loads(path.read_text()) if path.exists() else {'targets': {}}
        stop = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        while not stop.is_set():
            reports = collect(config)
            result = cycle(config, state, reports, recover=lambda host, key, version:
                           ssh(config['hosts'][host], 'recover ' + key + ' ' + str(version)))
            receipts = deliver(config, result['ok'])
            notifications = notify(config, state, reports, result, receipts)
            print(json.dumps({'event': 'oracle_watchdog', 'at': time.time(), **result, **receipts,
                              'notifications': notifications}), flush=True)
            if args.once:
                return
            stop.wait(30)


PUSH_CHILD = """import json, sys
# -I excludes CWD/PYTHONPATH. This exact directory is the installed, root-owned
# watchdog source, never a path supplied by configuration or the receiver.
sys.path.insert(0, sys.argv[1])
accepted = False
try:
    from oracle_watchdog import push
    raw = sys.stdin.buffer.read(32769)
    if len(raw) <= 32768:
        value = json.loads(raw)
        if (isinstance(value, dict) and set(value) == {'url', 'ok'} and
                isinstance(value['url'], str) and type(value['ok']) is bool):
            push(value['url'], value['ok'])
            accepted = True
except Exception:
    pass
sys.stdout.write('1\\n' if accepted else '0\\n')
"""


def safe_push(url, ok, *, deadline_seconds=5):
    """Bound DNS/connect too; neither endpoint nor remote errors enter argv/logs."""
    try:
        if (not isinstance(url, str) or type(ok) is not bool or
                type(deadline_seconds) not in (int, float) or not math.isfinite(deadline_seconds) or deadline_seconds <= 0):
            return False
        payload = json.dumps({'url': url, 'ok': ok}).encode('utf-8')
        if len(payload) > 32768:
            return False
        process = subprocess.Popen([sys.executable, '-I', '-c', PUSH_CHILD, str(Path(__file__).resolve().parent)],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env={}, start_new_session=True)
        expired = threading.Event()

        def kill():
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

        def deadline():
            expired.set()
            kill()

        timer = threading.Timer(min(5, deadline_seconds), deadline)
        timer.daemon = True
        timer.start()
        try:
            process.stdin.write(payload)
            process.stdin.close()
            # Read the cap while streaming, not after capture_output has grown.
            output = process.stdout.read(65)
            if len(output) > 64:
                return False
            process.wait()
            return process.returncode == 0 and not expired.is_set() and output == b'1\n'
        finally:
            timer.cancel()
            # A finished leader can leave descendants holding stdout open.
            kill()
            process.wait()
            process.stdout.close()
            if not process.stdin.closed:
                process.stdin.close()
    except Exception:
        return False


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print(json.dumps({'event': 'oracle_watchdog_failed'}), flush=True)
        raise SystemExit(1)
