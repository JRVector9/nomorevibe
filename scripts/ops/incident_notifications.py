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
# Kept import-free for this module's isolated (-I) Telegram child process.
REVIEW_STAGES = frozenset({'first', 'second'})
REVIEW_REASONS = frozenset({'capacity_blocked', 'consumer_missing', 'worker_missing',
                          'upstream_stalled', 'local_stalled', 'review_stalled'})
# 2026-10-31: the monitor's summarized model-ledger alarms. An unknown-outcome call alone (확인 못함 · 사람 검토) is
# a human review list at /admin/models and never an incident; per-request incidents were removed.
CAPACITY_REASONS = frozenset({'dispatch_stuck', 'review_backlog', 'review_stale'})
FAULTS = frozenset({'probe_unknown', 'replica_intent_changed', 'replicas_missing', 'warming_up',
                    'database_unavailable', 'web_page_failed', 'web_not_ready', 'monitor_stale',
                    'pipeline_alarm', 'container_unhealthy', 'native_unit_failed',
                    'native_unit_inactive', 'native_unit_unknown'})
# 2026-11-10 운영자: 「문제가 있거나 장애가 날 때만 받고 싶다」 — 하루 알림 48건 중 46건이 배포 때 앱이 다시 뜨는 「warming_up」(3분 준비)이었다.
# 재시작 직후의 잠깐 고장은 알리지 않는다: warming_up 은 늘, 나머지 셋은 10분 안에 재시작(warming_up)이 있었을 때만 잠깐 고장으로 본다.
# pipeline_alarm 의 재시작은 함대 전체에서 가장 최근 것이다(oracle_watchdog) — 배포 창에서 다른 앱이 다시 뜨는 동안의 진행 경보도 같이 유예한다.
# 고장이 끊김 없이 RESTART_GRACE_SECONDS 넘게 이어지면(크래시 루프·재시작 뒤 멈춤) 예전처럼 알린다. 감시가 시각을 주지 않으면(옛 판) 예전대로 알린다.
RESTART_GRACE_REASONS = frozenset({'warming_up', 'replicas_missing', 'web_not_ready', 'pipeline_alarm'})
RESTART_GRACE_SECONDS = 600
# 2026-11-11 운영자: 「배포 동안은 단계 멈춤 알람을 붙잡아 두자」. 배포 창은 T+0 에 모델 접수를 DRAINING 으로 두고 잡 ~10개를 멈추며,
# 첫 앱 재시작은 2~3분 뒤다 — 그 사이의 pipeline_alarm 은 위 재시작 유예를 받지 못해 알림이 됐다(03:52:50Z faultSeconds 35·restartSeconds 3880).
# monitor 가 보고한 접수 모드가 DRAINING 인 동안(감시가 잰 DRAIN 나이 drainSeconds) pipeline_alarm 은 DRAIN 나이와 끊김 없는 고장 길이가
# 모두 DRAIN_HOLD_SECONDS 보다 짧을 때만 붙잡아 둔다. 보통 창은 15분 안팎이라 20분이다. DRAIN 이 20분을 넘기면(멈춘 DRAIN) 또는
# 경보가 끊김 없이 20분 이어지면 예전 문구 그대로 알린다. OPEN·disabled 이거나 감시가 모드를 주지 않으면(옛 monitor·gateway·watchdog) 예전대로다.
# pipeline_alarm 밖의 사유(웹·복제본·DB·단계별 progress-*·검수·공급자·장부)는 바뀌지 않는다.
DRAIN_HOLD_SECONDS = 1200
# 알림 한 줄의 한국어 설명 — 무슨 상황인지 알 수 있게(2026-11-10). 영어 사유 코드는 그대로 앞에 둔다(로그·감시 기록과 맞춰 찾기)
SERVICE_TEXT = {
    'probe_unknown': '감시가 이 호스트의 상태를 읽지 못함 — 호스트·게이트웨이 확인',
    'replica_intent_changed': '서비스 복제본 수 설정이 바뀜',
    'replicas_missing': '컨테이너가 떠 있지 않음',
    'warming_up': '10분 넘게 재시작을 되풀이함 — 크래시 루프 의심',
    'database_unavailable': 'DB 에 연결하지 못함',
    'web_page_failed': '웹 페이지 응답 실패',
    'web_not_ready': '웹이 준비 상태가 아님',
    'monitor_stale': '감시(monitor) 관측이 멈춤',
    'pipeline_alarm': '파이프라인 단계가 멈춤 — 운영 홈 확인',
    'container_unhealthy': '컨테이너 상태 점검 실패',
    'native_unit_failed': '호스트 서비스 실패',
    'native_unit_inactive': '호스트 서비스가 꺼져 있음',
    'native_unit_unknown': '호스트 서비스 상태를 알 수 없음',
}
# 2026-11-12 운영 콘솔 조각 4b: 휴대폰 알림 — 운영 홈 할 일(멈춤·평소와 다름)의 알림 줄(console_alerts). monitor 보고의 consoleAlerts 를
# 줄 id 마다 한 번 보낸다(제목·사실 한 줄·그 할 일로 가는 주소). 앱이 할 일의 생김·해소(10분 연속 없음)·조용한 시간·그대로 둠을 정해 줄을 열고 닫으므로
# 여기서는 보고된 줄이 사라지면 보낸 표시를 바로 지운다(같은 할 일이 다시 생기면 새 줄 id — 다시 보낸다). 칸이 없는 보고(옛 monitor·읽기 실패)는 모름이다.
# 상태에는 열쇠(host/service/id)와 보냄 표시만 둔다 — 알림 글은 보낼 때 보고에서 읽고 상태·로그에 남기지 않는다.
# 보고의 주소는 관리자 화면 경로뿐이다(게이트웨이가 검사) — 사이트 주소는 이 쪽 설정 adminOrigin(https, 선택)이 붙인다. 없으면 경로만 보낸다.
CONSOLE_HEADER = 'NoMoreVibe 할 일 알림'
MESSAGE_LIMIT = 4096
RESPONSE_LIMIT = 16384
INPUT_LIMIT = 32768
PIPELINE_RECOVERY_SECONDS = 600
PIPELINE_RECOVERY_GAP_SECONDS = 150


def _seconds(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def restart_grace(event):
    """재시작 직후의 잠깐 고장이면 True — 알림을 만들지 않는다. 10분 넘게 이어지면 False(알린다)."""
    reason = event.get('reason')
    fault = _seconds(event.get('faultSeconds'))
    if reason not in RESTART_GRACE_REASONS or fault is None or fault >= RESTART_GRACE_SECONDS:
        return False
    if reason == 'warming_up':
        return True
    restart = _seconds(event.get('restartSeconds'))
    return restart is not None and restart < RESTART_GRACE_SECONDS


def drain_hold(event):
    """배포 창 DRAIN 동안의 진행 경보면 True — 알림을 만들지 않는다. DRAIN 이나 경보가 20분을 넘기면 False(알린다)."""
    fault, drain = _seconds(event.get('faultSeconds')), _seconds(event.get('drainSeconds'))
    return (event.get('reason') == 'pipeline_alarm' and fault is not None and drain is not None and
            fault < DRAIN_HOLD_SECONDS and drain < DRAIN_HOLD_SECONDS)


def valid_review_failures(value):
    return (isinstance(value, list) and len(value) <= len(REVIEW_STAGES) and
            all(isinstance(row, dict) and set(row) == {'stage', 'reason'} and
                isinstance(row['stage'], str) and row['stage'] in REVIEW_STAGES and
                isinstance(row['reason'], str) and row['reason'] in REVIEW_REASONS for row in value) and
            len({row['stage'] for row in value}) == len(value))


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
             or stage in REVIEW_STAGES and reason in REVIEW_REASONS
             or _stage_signature(stage, reason)
             or stage == 'capacity' and reason in CAPACITY_REASONS))


def _stage_signature(stage, reason):
    # Lazy import keeps the isolated Telegram transport independent of siblings.
    from recovery_gateway import STAGE_FAILURE_REASONS
    return (isinstance(stage, str) and isinstance(reason, str) and stage.startswith('progress-') and
            reason in STAGE_FAILURE_REASONS.get(stage[len('progress-'):], ()))


def _finite_time(value, now):
    return type(value) in (int, float) and math.isfinite(value) and 0 <= value <= now


def _gradual(parts):
    """pipeline_alarm 과 장부 경보(capacity)는 명시적 양호가 600초 이어져야 해제한다 — 문턱 근처 깜빡임이 알림을 되풀이하지 않는다."""
    return parts[2] == 'service' and parts[3] == 'pipeline_alarm' or parts[2] == 'capacity'


def _load_incident(signature, item, now):
    """버전 1 장애. 파이프라인·장부 경보 복구 시각은 선택이며 재시작 뒤에도 남는다."""
    first = item.get('firstSeen')
    record = {'sent': item.get('sent') is True, 'firstSeen': first if _finite_time(first, now) else now}
    parts = signature.split('/')
    if _gradual(parts):
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


def _console_key(config, value):
    if not isinstance(value, str) or len(value.split('/')) != 3:
        return False
    host, service, alert = value.split('/')
    return (host in config['hosts'] and re.fullmatch(r'[a-z0-9-]{1,60}', service) is not None and
            re.fullmatch(r'[1-9][0-9]{0,14}', alert) is not None)


def _console_alerts(config, stored, reports, now):
    """보고된 알림 줄과 보낸 표시를 맞춘다. 돌려주는 것: (표시, 지금 보고된 줄 글)."""
    from recovery_gateway import valid_console_alerts
    marks = {}
    for key, item in stored.items() if isinstance(stored, dict) else []:
        if _console_key(config, key) and isinstance(item, dict):
            first = item.get('firstSeen')
            marks[key] = {'sent': item.get('sent') is True, 'firstSeen': first if _finite_time(first, now) else now}
    current = {}
    for host in config['hosts']:
        report = reports.get(host)
        if not isinstance(report, dict) or not isinstance(report.get('services'), list):
            continue
        for row in report['services']:
            if (not isinstance(row, dict) or not isinstance(row.get('key'), str) or 'consoleAlerts' not in row or
                    not valid_console_alerts(row['consoleAlerts'])):
                continue
            prefix = host + '/' + row['key'] + '/'
            reported = {prefix + str(alert['id']): alert for alert in row['consoleAlerts']}
            for key in [key for key in marks if key.startswith(prefix) and key not in reported]:
                del marks[key]
            for key, alert in reported.items():
                marks.setdefault(key, {'sent': False, 'firstSeen': now})
                current[key] = alert
    return marks, current


def _admin_origin(config):
    value = config.get('adminOrigin')
    return value.rstrip('/') if isinstance(value, str) and re.fullmatch(r'https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?', value) else ''


def _console_message(marks, current, origin=''):
    pending = sorted((key for key, item in marks.items() if not item['sent'] and key in current),
                     key=lambda key: (marks[key]['firstSeen'], key))
    message, included = CONSOLE_HEADER, []
    for key in pending:
        alert = current[key]
        line = '\n- ' + alert['title'] + ('\n  ' + alert['fact'] if alert['fact'] else '') + '\n  ' + origin + alert['href']
        if len(message) + len(line) > MESSAGE_LIMIT:
            break
        message += line
        included.append(key)
    return message, included


def notify(config, state, reports, result, receipts, *, now=None, send=send_telegram):
    """One batch of new/pending incidents. Only explicit observations resolve an incident."""
    if 'incidentNotifications' not in config:
        return {'enabled': False}
    destination = validate_destination(config['incidentNotifications'])
    from recovery_gateway import valid_stage_failures
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
            if parts[0] == host and _gradual(parts):
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
                for signature, item in incidents.items():
                    parts = signature.split('/')
                    if signature == pipeline or isinstance(service, str) and parts[:3] == [host, service, 'capacity']:
                        _reset_pipeline_recovery(item)
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
            reviews = row.get('reviewFailures')
            if valid_review_failures(reviews):
                current = {(failure['stage'], failure['reason']) for failure in reviews}
                clear(lambda parts: parts[:2] == [host, service] and parts[2] in REVIEW_STAGES
                      and (parts[2], parts[3]) not in current)
            stages = row.get('stageFailures')
            if valid_stage_failures(stages):
                current = {('progress-' + failure['stage'], failure['reason']) for failure in stages}
                clear(lambda parts: parts[:2] == [host, service] and parts[2].startswith('progress-')
                      and (parts[2], parts[3]) not in current)
            # 장부 경보는 요약이 있는 명시적 관측(unknown 아님)에서 그 사유가 600초 계속 없어야 해제한다. 확인 못함(review)만
            # 남은 것도 해제 관측이다. 관측 누락·구버전 요약 없는 형식·읽기 실패는 복구가 아니다.
            current = None
            capacity = row.get('capacityUnknowns')
            if isinstance(capacity, dict):
                try:
                    from recovery_gateway import validate_capacity_unknowns
                    capacity = validate_capacity_unknowns(capacity)
                    if capacity['status'] != 'unknown' and 'alarmReasons' in capacity:
                        current = set(capacity['alarmReasons'])
                except ValueError:
                    pass
            for signature, item in list(incidents.items()):
                parts = signature.split('/')
                if parts[:3] != [host, service, 'capacity']:
                    continue
                if current is None or parts[3] in current:
                    _reset_pipeline_recovery(item)
                elif _advance_pipeline_recovery(item, now):
                    del incidents[signature]
                else:
                    quiet.add(signature)

    for event in result.get('events', []):
        if not isinstance(event, dict) or not _target(config, event.get('target')):
            continue
        stage, reason = event.get('stage', 'service'), event.get('reason')
        if not ((stage in STAGES and reason == 'upstream_stalled') or
                (stage in REVIEW_STAGES and reason in REVIEW_REASONS and type(event.get('bad')) is int and event['bad'] >= 2) or
                (_stage_signature(stage, reason) and type(event.get('bad')) is int and event['bad'] >= 2) or
                (stage == 'capacity' and reason in CAPACITY_REASONS) or
                (stage == 'service' and reason in FAULTS and type(event.get('bad')) is int and event['bad'] >= 2
                 and not restart_grace(event) and not drain_hold(event))):
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
    message, included = 'NoMoreVibe 장애 알림', []
    for signature in pending:
        host, service, stage, reason = signature.split('/')
        label = stage[len('progress-'):] if stage.startswith('progress-') else stage
        line = '\n- ' + host + '/' + service + ('/' + label if stage != 'service' else '') + ' ' + reason
        if stage == 'service' and reason in SERVICE_TEXT:
            line += ' — ' + SERVICE_TEXT[reason]
        elif stage in REVIEW_STAGES:
            line += ' (' + ('provider completion evidence required; restart does not release capacity' if reason == 'capacity_blocked'
                            else 'local fenced supervisor handles recovery' if reason == 'local_stalled'
                            else 'operator attention required; no automatic model kill') + ')'
        elif stage == 'capacity':
            line += ' (' + ('a dispatched model call past its bound still holds a slot; check the worker and /admin/models'
                            if reason == 'dispatch_stuck' else
                            'unknown-outcome model calls are piling up unreviewed; review them at /admin/models') + ')'
        if len(message) + len(line) > MESSAGE_LIMIT:
            break
        message += line
        included.append(signature)
    console, alerts = _console_alerts(config, stored.get('console', {}) if isinstance(stored, dict) and stored.get('version') == 1 else {},
                                      reports, now)
    state['notifications'] = {'version': 1, 'incidents': incidents, 'console': console}
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
    # 휴대폰 알림(할 일) — 장애 알림과 따로 한 통. 받아들여진 줄만 보냄으로 적는다(아니면 다음 주기에 다시)
    console_message, console_included = _console_message(console, alerts, _admin_origin(config))
    console_accepted = None
    if console_included:
        try:
            console_accepted = send(destination, console_message) is True
        except Exception:
            console_accepted = False
        if console_accepted:
            for key in console_included:
                console[key]['sent'] = True
            save(config['state'], state)
    return {'enabled': True, 'accepted': accepted, 'sent': len(included) if accepted else 0,
            'pending': sum(not item['sent'] for item in incidents.values()),
            'consoleAccepted': console_accepted, 'consoleSent': len(console_included) if console_accepted else 0,
            'consolePending': sum(not item['sent'] and key in alerts for key, item in console.items())}


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
