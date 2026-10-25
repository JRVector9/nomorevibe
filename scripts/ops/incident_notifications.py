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
            (stage == 'service' and reason in FAULTS or stage in STAGES and reason == 'upstream_stalled'))


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
            first = item.get('firstSeen')
            first = first if type(first) in (int, float) and math.isfinite(first) and 0 <= first <= now else now
            incidents[signature] = {'sent': item.get('sent') is True, 'firstSeen': first}

    def clear(predicate):
        for signature in list(incidents):
            if predicate(signature.split('/')):
                del incidents[signature]

    # A missing report is not recovery. Service reason changes replace that service's
    # old fault, while missing provider metadata preserves its independent incident.
    for host in config['hosts']:
        report = reports.get(host)
        if not isinstance(report, dict) or not isinstance(report.get('services'), list):
            continue
        rows = report['services']
        if (not rows or len(rows) > 30 or any(not isinstance(row, dict) or not isinstance(row.get('key'), str) for row in rows) or
                len({row['key'] for row in rows}) != len(rows) or
                {row['key'] for row in rows} != set(config['hosts'][host].get('services', []))):
            continue
        clear(lambda parts: parts[:3] == [host, 'host', 'service'])
        for row in rows:
            if (not isinstance(row, dict) or not _target(config, host + '/' + str(row.get('key', ''))) or
                    type(row.get('ok')) is not bool or row.get('reason') not in FAULTS | {'ok'}):
                continue
            service, reason = row['key'], row['reason']
            clear(lambda parts: parts[:3] == [host, service, 'service'] and (row['ok'] or parts[3] != reason))
            failures = row.get('providerFailures')
            if isinstance(failures, list) and all(isinstance(stage, str) and stage in STAGES for stage in failures):
                clear(lambda parts: parts[:2] == [host, service] and parts[2] in STAGES and parts[2] not in failures)

    for event in result.get('events', []):
        if not isinstance(event, dict) or not _target(config, event.get('target')):
            continue
        stage, reason = event.get('stage', 'service'), event.get('reason')
        if not ((stage in STAGES and reason == 'upstream_stalled') or
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

    pending = sorted((key for key, item in incidents.items() if not item['sent']),
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
