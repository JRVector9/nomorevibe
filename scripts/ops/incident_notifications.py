#!/usr/bin/env python3
"""Optional per-incident Telegram receipts; no credentials or remote bodies enter state/logs."""
import http.client
import json
import math
from pathlib import Path
import re
import subprocess
import sys
import time


STAGES = frozenset({'reason-translate', 'crawl-tagline', 'keywords', 'keyword-verify',
                    'product-translate', 'tagline-ko', 'intro-check'})
FAULTS = frozenset({'probe_unknown', 'replica_intent_changed', 'replicas_missing', 'warming_up',
                    'database_unavailable', 'web_page_failed', 'web_not_ready', 'monitor_stale',
                    'pipeline_alarm', 'container_unhealthy', 'native_unit_failed',
                    'native_unit_inactive', 'native_unit_unknown'})
MESSAGE_LIMIT = 4096
RESPONSE_LIMIT = 16384
INPUT_LIMIT = 32768
PIPELINE_RECOVERY_SECONDS = 600
PIPELINE_RECOVERY_GAP_SECONDS = 150


def _request_id(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', value) is not None


def validate_destination(value):
    if (not isinstance(value, dict) or set(value) != {'botToken', 'chatId'} or
            not isinstance(value['botToken'], str) or
            not re.fullmatch(r'[1-9][0-9]{4,19}:[A-Za-z0-9_-]{20,128}', value['botToken']) or
            not isinstance(value['chatId'], str) or not re.fullmatch(r'-?[1-9][0-9]{0,19}', value['chatId'])):
        raise ValueError('invalid_incident_notification_configuration')
    return value


def telegram_request(destination, text):
    """Child-only transport. The parent enforces the total DNS/connect/read deadline."""
    connection = None
    try:
        validate_destination(destination)
        if not isinstance(text, str) or not 1 <= len(text) <= MESSAGE_LIMIT:
            return False
        connection = http.client.HTTPSConnection('api.telegram.org', 443, timeout=5)
        payload = json.dumps({'chat_id': destination['chatId'], 'text': text,
                              'disable_web_page_preview': True}).encode('utf-8')
        connection.request('POST', '/bot' + destination['botToken'] + '/sendMessage', body=payload,
                           headers={'Content-Type': 'application/json'})
        response = connection.getresponse()
        body = response.read(RESPONSE_LIMIT + 1)
        if response.status != 200 or len(body) > RESPONSE_LIMIT:
            return False
        receipt = json.loads(body)
        result = receipt.get('result') if isinstance(receipt, dict) else None
        return (receipt.get('ok') is True and isinstance(result, dict) and
                type(result.get('message_id')) is int and result['message_id'] > 0)
    except Exception:
        return False
    finally:
        if connection is not None:
            connection.close()


def send_telegram(destination, text, *, deadline_seconds=5):
    """Kill/reap one isolated child on deadline, including a wedged DNS resolver."""
    try:
        validate_destination(destination)
        if (not isinstance(text, str) or not 1 <= len(text) <= MESSAGE_LIMIT or
                type(deadline_seconds) not in (int, float) or not math.isfinite(deadline_seconds) or deadline_seconds <= 0):
            return False
        payload = json.dumps({'destination': destination, 'text': text}).encode('utf-8')
        if len(payload) > INPUT_LIMIT:
            return False
        result = subprocess.run([sys.executable, '-I', str(Path(__file__).resolve()), '--send'],
                                input=payload, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                env={}, timeout=min(5, deadline_seconds), check=False)
        return result.returncode == 0 and result.stdout == b'{"ok":true}\n'
    except Exception:
        return False


def _target(config, value):
    if not isinstance(value, str) or len(value.split('/')) != 2:
        return False
    host, service = value.split('/')
    return (host in config['hosts'] and re.fullmatch(r'[a-z0-9-]{1,30}', host) and
            re.fullmatch(r'[a-z0-9-]{1,60}', service) and
            (service == 'host' or service in config['hosts'][host].get('services', [])))


def _signature(config, value):
    if not isinstance(value, str) or len(value.split('/')) != 4:
        return False
    host, service, stage, reason = value.split('/')
    if host == 'receiver':
        setting = {'pipeline': 'pushUrls', 'heartbeat': 'heartbeatUrls'}.get(service)
        return (setting is not None and re.fullmatch(r'0|[1-9][0-9]{0,4}', stage) and
                int(stage) < len(config.get(setting, [])) and reason == 'push_failed')
    return (_target(config, host + '/' + service) and
            (stage == 'service' and reason in FAULTS or stage in STAGES and reason == 'upstream_stalled'
             or _request_id(stage) and reason in ('model_indeterminate', 'model_reclaim_overdue')))


def _finite_time(value, now):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= now


def _load_incident(signature, item, now):
    """버전 1 장애. 파이프라인 복구 시각은 선택이며 재시작 뒤에도 남는다."""
    first = item.get('firstSeen')
    record = {'sent': item.get('sent') is True, 'firstSeen': first if _finite_time(first, now) else now}
    parts = signature.split('/')
    if parts[2] == 'service' and parts[3] == 'pipeline_alarm':
        started, seen = item.get('clearSince'), item.get('lastClearAt')
        if not (started is None and seen is None):
            if _finite_time(started, now) and _finite_time(seen, now) and started <= seen:
                record['clearSince'] = started
                record['lastClearAt'] = seen
    return record


def _reset_pipeline_recovery(item):
    item.pop('clearSince', None)
    item.pop('lastClearAt', None)


def _advance_pipeline_recovery(item, now):
    """양호 관측 간격이 150초 이내면 연속이다. 간격·역행·불완전 시각은 다시 시작한다."""
    started, seen = item.get('clearSince'), item.get('lastClearAt')
    if not (_finite_time(started, now) and _finite_time(seen, now) and started <= seen and
            now - seen <= PIPELINE_RECOVERY_GAP_SECONDS):
        started = now
    item['clearSince'] = started
    item['lastClearAt'] = now
    return now - started >= PIPELINE_RECOVERY_SECONDS


def notify(config, state, reports, result, receipts, *, now=None, send=send_telegram):
    """One batch of new/pending incidents. Only explicit observations resolve an incident."""
    if 'incidentNotifications' not in config:
        return {'enabled': False}
    destination = validate_destination(config['incidentNotifications'])
    now = time.time() if now is None else now
    stored = state.get('notifications', {})
    old = stored.get('incidents', {}) if isinstance(stored, dict) and stored.get('version') == 1 else {}
    incidents = {}
    for signature, item in old.items() if isinstance(old, dict) else []:
        if _signature(config, signature) and isinstance(item, dict):
            incidents[signature] = _load_incident(signature, item, now)
    quiet = set()

    def clear(predicate):
        for signature in list(incidents):
            if predicate(signature.split('/')):
                del incidents[signature]

    def pause_pipeline(host):
        for signature, item in incidents.items():
            parts = signature.split('/')
            if parts[0] == host and parts[2] == 'service' and parts[3] == 'pipeline_alarm':
                _reset_pipeline_recovery(item)

    # 보고서가 없거나 불완전하면 복구가 아니고 pipeline_alarm 연속 구간을 끊는다.
    # 그 서명은 명시적 양호 행이 150초 이하 간격으로 600초 쌓여야만 지운다.
    # 그동안 양호로 관측되면 아직 보내지 못한 건은 보류한다. 다른 서비스 사유는
    # 첫 명시적 복구나 사유 교체에서 즉시 정리한다. provider 메타데이터가 없으면
    # 그 장애는 그대로 둔다.
    for host in config['hosts']:
        report = reports.get(host)
        if not isinstance(report, dict) or not isinstance(report.get('services'), list):
            pause_pipeline(host)
            continue
        rows = report['services']
        if (not rows or len(rows) > 30 or any(not isinstance(row, dict) or not isinstance(row.get('key'), str) for row in rows) or
                len({row['key'] for row in rows}) != len(rows) or
                {row['key'] for row in rows} != set(config['hosts'][host].get('services', []))):
            pause_pipeline(host)
            continue
        clear(lambda parts: parts[:3] == [host, 'host', 'service'])
        for row in rows:
            if not isinstance(row, dict):
                continue
            service = row.get('key')
            pipeline = host + '/' + service + '/service/pipeline_alarm' if isinstance(service, str) else None
            if (not isinstance(service, str) or not _target(config, host + '/' + service) or
                    type(row.get('ok')) is not bool or row.get('reason') not in FAULTS | {'ok'}):
                if pipeline in incidents:
                    _reset_pipeline_recovery(incidents[pipeline])
                continue
            reason = row['reason']
            prefix = [host, service, 'service']
            good = row['ok'] is True and reason == 'ok'
            fault = row['ok'] is False and reason in FAULTS

            row_ok = row['ok']

            def stale(parts, prefix=prefix, fault=fault, reason=reason, row_ok=row_ok):
                if parts[:3] != prefix:
                    return False
                if parts[3] == 'pipeline_alarm':
                    return fault and reason != 'pipeline_alarm'
                return row_ok or parts[3] != reason

            clear(stale)
            item = incidents.get(pipeline)
            if item is not None and good:
                if _advance_pipeline_recovery(item, now):
                    del incidents[pipeline]
                else:
                    quiet.add(pipeline)
            elif item is not None:
                _reset_pipeline_recovery(item)
            failures = row.get('providerFailures')
            if isinstance(failures, list) and all(isinstance(stage, str) and stage in STAGES for stage in failures):
                clear(lambda parts: parts[:2] == [host, service] and parts[2] in STAGES and parts[2] not in failures)
            capacity = row.get('capacityUnknowns')
            if isinstance(capacity, dict):
                try:
                    from recovery_gateway import validate_capacity_unknowns
                    capacity = validate_capacity_unknowns(capacity)
                    if capacity['status'] != 'unknown' and not capacity['truncated']:
                        pending_requests = {item['requestId'] for item in capacity['requests']}
                        clear(lambda parts: parts[:2] == [host, service] and _request_id(parts[2]) and parts[2] not in pending_requests)
                except ValueError:
                    pass

    for event in result.get('events', []):
        if not isinstance(event, dict) or not _target(config, event.get('target')):
            continue
        stage, reason = event.get('stage', 'service'), event.get('reason')
        if reason in ('model_indeterminate', 'model_reclaim_overdue') and _request_id(event.get('requestId')):
            stage = event['requestId']
        if not ((stage in STAGES and reason == 'upstream_stalled') or
                (_request_id(stage) and reason in ('model_indeterminate', 'model_reclaim_overdue')) or
                (stage == 'service' and reason in FAULTS and type(event.get('bad')) is int and event['bad'] >= 2)):
            continue
        signature = event['target'] + '/' + stage + '/' + reason
        incidents.setdefault(signature, {'sent': False, 'firstSeen': now})

    for namespace, key, targets in [('pipeline', 'receipts', 'pushUrls'), ('heartbeat', 'heartbeatReceipts', 'heartbeatUrls')]:
        values = receipts.get(key, [])
        if not isinstance(values, list):
            continue
        for index, accepted in enumerate(values[:len(config.get(targets, []))]):
            signature = 'receiver/' + namespace + '/' + str(index) + '/push_failed'
            if accepted is True:
                incidents.pop(signature, None)
            elif accepted is False:
                incidents.setdefault(signature, {'sent': False, 'firstSeen': now})

    pending = sorted((key for key, item in incidents.items() if not item['sent'] and key not in quiet),
                     key=lambda key: (incidents[key]['firstSeen'], key))
    message, included = 'NoMoreVibe incidents', []
    for signature in pending:
        host, service, stage, reason = signature.split('/')
        line = '\n- ' + host + '/' + service + ('/' + stage if stage != 'service' else '') + ' ' + reason
        if len(message) + len(line) > MESSAGE_LIMIT:
            break
        message += line
        included.append(signature)
    state['notifications'] = {'version': 1, 'incidents': incidents}
    from recovery_gateway import save
    save(config['state'], state)
    accepted = None
    if included:
        try:
            accepted = send(destination, message) is True
        except Exception:
            accepted = False
        if accepted:
            for signature in included:
                incidents[signature]['sent'] = True
            save(config['state'], state)
    return {'enabled': True, 'accepted': accepted, 'sent': len(included) if accepted else 0,
            'pending': sum(not item['sent'] for item in incidents.values())}


def _child():
    accepted = False
    try:
        payload = sys.stdin.buffer.read(INPUT_LIMIT + 1)
        if len(payload) <= INPUT_LIMIT:
            value = json.loads(payload)
            if isinstance(value, dict) and set(value) == {'destination', 'text'}:
                accepted = telegram_request(value['destination'], value['text'])
    except Exception:
        pass
    print('{"ok":true}' if accepted else '{"ok":false}')


if __name__ == '__main__':
    if sys.argv[1:] == ['--send']:
        _child()
