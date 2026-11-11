"""Independent incident receipts survive an aggregate DOWN and observer restarts."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch


OPS = Path(__file__).resolve().parents[1] / 'scripts' / 'ops'
DESTINATION = {'botToken': '123456789:abcdefghijklmnopqrstuvwxyz_0123456789', 'chatId': '-1001234567890'}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NotificationTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((OPS / 'incident_notifications.py').exists(), 'per-incident notifier must exist')
        sys.path.insert(0, str(OPS))
        self.addCleanup(lambda: sys.path.remove(str(OPS)))
        self.n = load('incident_notifications_fixture', OPS / 'incident_notifications.py')
        self.w = load('oracle_watchdog_notifications', OPS / 'oracle_watchdog.py')
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'state.json'
        self.config = {'recover': False, 'hosts': {'m3': {'services': ['web', 'monitor']}},
                       'pushUrls': ['https://receiver.test/private-token'],
                       'heartbeatUrls': ['https://receiver.test/private-heartbeat'],
                       'state': str(self.path), 'incidentNotifications': DESTINATION}
        self.state = {'targets': {}}
        self.rows = [self.row('web'), self.row('monitor')]
        self.reports = {'m3': {'services': self.rows}}
        self.receipts = {'receipts': [True], 'heartbeatReceipts': [True]}
        self.messages = []
        self.accept = True

    @staticmethod
    def row(key, reason='ok'):
        return {'key': key, 'version': 12, 'replicas': 1, 'settled': True,
                'ok': reason == 'ok', 'recoverable': False, 'reason': reason}

    def send(self, destination, message):
        self.assertEqual(destination, DESTINATION)
        self.messages.append(message)
        return self.accept

    def cycle(self, now):
        result = self.w.cycle(self.config, self.state, self.reports, now=now)
        receipt = self.n.notify(self.config, self.state, self.reports, result, self.receipts, now=now, send=self.send)
        return result, receipt

    def fail_service(self, key='web', reason='web_page_failed'):
        self.rows[:] = [self.row(key, reason) if row['key'] == key else row for row in self.rows]

    def alarm_pipeline(self):
        self.rows[:] = [self.row('web'), self.row('monitor', 'pipeline_alarm')]

    def recover_rows(self):
        self.rows[:] = [self.row('web'), self.row('monitor')]

    def set_row(self, key, reason='ok', version=12):
        row = {**self.row(key, reason), 'version': version}
        self.rows[:] = [row if item['key'] == key else item for item in self.rows]

    def test_deploy_restart_warm_up_is_not_an_incident(self):
        # 2026-11-10 운영: 배포 때 앱마다 3분 준비(warming_up)가 알림 46건이 됐다 — 새 판으로 다시 떠 3분 안에 정상이면 알리지 않는다
        self.set_row('web', 'warming_up', version=13)
        for now in (1000, 1060, 1120, 1180):
            self.cycle(now)
        self.set_row('web', 'ok', version=13)
        self.cycle(1240)
        self.assertEqual(self.messages, [])
        self.assertEqual(self.state['notifications']['incidents'], {})

    def test_restart_loop_alerts_once_after_ten_minutes_in_korean(self):
        # 재시작을 되풀이하면(크래시 루프) 판 번호와 사유가 바뀌어도 고장은 이어진 것으로 보고 10분 뒤 한 번 알린다
        for index, now in enumerate(range(1000, 1600, 60)):
            self.set_row('web', 'warming_up' if index % 3 else 'replicas_missing', version=12)
            self.cycle(now)
        self.assertEqual(self.messages, [])
        self.set_row('web', 'warming_up', version=12)
        self.cycle(1600)
        self.cycle(1660)
        self.assertEqual(len(self.messages), 1)
        self.assertTrue(self.messages[0].startswith('NoMoreVibe 장애 알림\n- m3/web warming_up — 10분 넘게 재시작을 되풀이함'))

    def test_pipeline_alarm_right_after_monitor_restart_waits_but_plain_alarm_alerts(self):
        # 감시가 다시 뜬 직후의 파이프라인 경보(멈춘 잡 재개 전)는 10분 안에 풀리면 알리지 않는다
        self.set_row('monitor', 'warming_up', version=13)
        self.cycle(1000)
        self.cycle(1060)
        self.set_row('monitor', 'pipeline_alarm', version=13)
        self.cycle(1120)
        self.cycle(1180)
        self.set_row('monitor', 'ok', version=13)
        self.cycle(1240)
        self.assertEqual(self.messages, [])
        # 재시작 없이 난 경보는 예전처럼 두 번째 관측에서 알린다
        self.set_row('monitor', 'pipeline_alarm', version=13)
        for now in (2000, 2060, 2120):
            self.cycle(now)
        self.assertEqual(len(self.messages), 1)
        self.assertIn('m3/monitor pipeline_alarm — 파이프라인 단계가 멈춤', self.messages[0])

    def test_pipeline_alarm_while_other_apps_restart_waits_for_ten_minutes(self):
        # 2026-11-10 10:28Z: 배포 창에서 다른 앱(text·maintenance)이 다시 뜨는 동안 monitor 의 진행 경보가 알림이 됐다 — monitor 자신은 재시작 전이었다
        self.set_row('web', 'warming_up', version=13)
        self.cycle(1000)
        self.set_row('monitor', 'pipeline_alarm', version=12)
        self.cycle(1035)
        self.cycle(1070)
        self.set_row('web', 'ok', version=13)
        self.cycle(1105)
        self.assertEqual(self.messages, [])
        # 진행 경보가 10분 넘게 이어지면(배포가 아니라 진짜 멈춤) 알린다
        for now in range(1140, 1700, 35):
            self.cycle(now)
        self.assertEqual(len(self.messages), 1)
        self.assertIn('m3/monitor pipeline_alarm — 파이프라인 단계가 멈춤', self.messages[0])

    def test_replicas_missing_without_restart_and_old_watchdog_events_alert_as_before(self):
        self.set_row('web', 'replicas_missing')
        self.cycle(1000)
        self.cycle(1060)
        self.assertEqual(len(self.messages), 1)
        self.assertIn('m3/web replicas_missing — 컨테이너가 떠 있지 않음', self.messages[0])
        # 시각이 없는 옛 감시의 사건은 재시작 유예를 받지 않는다(알림을 잃지 않게)
        self.assertFalse(self.n.restart_grace({'reason': 'warming_up', 'bad': 2}))
        self.assertTrue(self.n.restart_grace({'reason': 'warming_up', 'bad': 2, 'faultSeconds': 120}))
        self.assertFalse(self.n.restart_grace({'reason': 'warming_up', 'bad': 3, 'faultSeconds': 600}))
        self.assertFalse(self.n.restart_grace({'reason': 'database_unavailable', 'bad': 2, 'faultSeconds': 60, 'restartSeconds': 30}))

    # 2026-11-11 배포 창 DRAIN: monitor 행의 capacityMode = {'mode', 'ageSeconds'}(gateway 가 monitor 시계로 잰 updated_at 나이)
    def monitor_at(self, now, reason='ok', mode='draining', changed=None, version=12):
        row = {**self.row('monitor', reason), 'version': version}
        if mode is not None:
            row['capacityMode'] = {'mode': mode, 'ageSeconds': max(0, round(now - (now if changed is None else changed)))}
        self.rows[:] = [row if item['key'] == 'monitor' else item for item in self.rows]

    def pipeline_event(self, result):
        return next(event for event in result['events'] if event.get('target') == 'm3/monitor' and 'stage' not in event
                    and 'recovery' not in event)

    def test_pipeline_alarm_in_drain_before_any_restart_is_held(self):
        # 2026-11-11 03:52:50Z 그대로: 마지막 재시작은 65분 전, DRAIN 03:48:59Z, 3분 뒤 진행 경보 두 표본(35초) 뒤 정상
        self.set_row('web', 'warming_up', version=13)
        self.cycle(1000)
        self.set_row('web', 'ok', version=13)
        self.cycle(1035)
        drain = 4880
        for now in (drain + 30, drain + 65, drain + 100, drain + 135, drain + 170):
            self.monitor_at(now, changed=drain)
            self.cycle(now)
        for now in (drain + 205, drain + 240):
            self.monitor_at(now, 'pipeline_alarm', changed=drain)
            result, _ = self.cycle(now)
        event = self.pipeline_event(result)
        self.assertEqual((event['reason'], event['bad'], event['faultSeconds']), ('pipeline_alarm', 2, 35))
        self.assertGreaterEqual(event['restartSeconds'], 600)  # 재시작 유예는 받지 못한다
        self.assertEqual(event['drainSeconds'], 240)
        self.assertTrue(self.n.drain_hold(event))
        self.monitor_at(drain + 275, changed=drain)
        self.cycle(drain + 275)
        self.assertEqual(self.messages, [])
        self.assertEqual(self.state['notifications']['incidents'], {})

    def test_old_monitor_without_mode_and_explicit_open_alert_as_before(self):
        for mode in (None, 'open', 'disabled'):
            with self.subTest(mode=mode):
                self.state, self.messages = {'targets': {}}, []
                for now in (5000, 5035):
                    self.monitor_at(now, 'pipeline_alarm', mode=mode, changed=4000)
                    result, _ = self.cycle(now)
                self.assertNotIn('drainSeconds', self.pipeline_event(result))
                self.assertEqual(len(self.messages), 1)
                self.assertIn('m3/monitor pipeline_alarm — 파이프라인 단계가 멈춤 — 운영 홈 확인', self.messages[0])

    def test_alarm_through_a_stuck_drain_pages_once_after_twenty_minutes(self):
        drain = 1000
        sent_at = []
        for now in range(drain + 35, drain + 1400, 35):
            self.monitor_at(now, 'pipeline_alarm', changed=drain)
            result, _ = self.cycle(now)
            if self.messages and not sent_at:
                sent_at.append(now)
                self.assertGreaterEqual(self.pipeline_event(result)['drainSeconds'], self.n.DRAIN_HOLD_SECONDS)
        self.assertEqual(len(self.messages), 1)
        self.assertTrue(drain + self.n.DRAIN_HOLD_SECONDS <= sent_at[0] < drain + self.n.DRAIN_HOLD_SECONDS + 35)
        self.assertEqual(self.messages[0], 'NoMoreVibe 장애 알림\n- m3/monitor pipeline_alarm — 파이프라인 단계가 멈춤 — 운영 홈 확인')

    def test_drain_already_older_than_the_bound_pages_on_the_second_observation(self):
        # 감시가 처음 보는 DRAIN 이어도 monitor 가 보고한 나이(updated_at)가 20분을 넘으면 붙잡지 않는다(멈춘 DRAIN)
        for now in (5000, 5035):
            self.monitor_at(now, 'pipeline_alarm', changed=5000 - 1500)
            self.cycle(now)
        self.assertEqual(len(self.messages), 1)

    def test_drain_clock_is_not_restarted_by_toggles_or_policy_writes(self):
        drain = 1000
        for now in range(drain + 30, drain + 600, 35):
            self.monitor_at(now, changed=drain)
            self.cycle(now)
        # 같은 창 안에서 정책 쓰기가 updated_at 을 당긴다 — 보고 나이는 0 이 되지만 DRAIN 시계는 처음 DRAIN 에 묶인다
        self.monitor_at(drain + 640, changed=drain + 630)
        self.cycle(drain + 640)
        self.assertEqual(self.state['targets']['m3/monitor']['drain']['since'], drain)
        # OPEN 뒤 5분 안에 다시 DRAIN: 새 updated_at 이지만 시계는 이어진다
        for now in range(drain + 675, drain + 900, 35):
            self.monitor_at(now, mode='open')
            self.cycle(now)
        sent_at = None
        for now in range(drain + 920, drain + 1500, 35):
            self.monitor_at(now, 'pipeline_alarm' if now >= drain + 990 else 'ok', changed=drain + 910)
            result, _ = self.cycle(now)
            if self.messages and sent_at is None:
                sent_at = now
                self.assertGreaterEqual(self.pipeline_event(result)['drainSeconds'], self.n.DRAIN_HOLD_SECONDS)
        self.assertEqual(len(self.messages), 1)
        self.assertTrue(drain + self.n.DRAIN_HOLD_SECONDS <= sent_at < drain + self.n.DRAIN_HOLD_SECONDS + 35)

    def test_next_window_after_ten_minutes_open_gets_a_fresh_hold(self):
        for now in range(1000, 1600, 35):
            self.monitor_at(now, changed=1000)
            self.cycle(now)
        for now in range(1600, 2150, 35):
            self.monitor_at(now, mode='open')
            self.cycle(now)
        self.assertEqual(self.state['targets']['m3/monitor']['drain']['since'], 1000)  # 마지막 DRAIN 뒤 10분 동안은 남는다
        for now in range(2150, 2300, 35):
            self.monitor_at(now, mode='open')
            self.cycle(now)
        self.assertNotIn('drain', self.state['targets']['m3/monitor'])
        drain = 2400
        for now in range(drain + 30, drain + 200, 35):
            self.monitor_at(now, changed=drain)
            self.cycle(now)
        self.assertEqual(self.state['targets']['m3/monitor']['drain']['since'], drain)
        for now in (drain + 205, drain + 240, drain + 275):
            self.monitor_at(now, 'pipeline_alarm', changed=drain)
            self.cycle(now)
        self.assertEqual(self.messages, [])

    def test_a_sample_without_mode_carries_the_drain_only_briefly(self):
        # 칸이 빠진 표본(읽기 실패·monitor 재시작)은 마지막 DRAIN 관측 150초 안에서만 DRAIN 으로 이어 본다
        drain = 1000
        self.monitor_at(drain + 30, changed=drain)
        self.cycle(drain + 30)
        sent_at = None
        for now in range(drain + 65, drain + 400, 35):
            self.monitor_at(now, 'pipeline_alarm', mode=None)
            self.cycle(now)
            if self.messages and sent_at is None:
                sent_at = now
        self.assertEqual(len(self.messages), 1)
        self.assertTrue(drain + 30 + self.w.DRAIN_CARRY_SECONDS < sent_at <= drain + 30 + self.w.DRAIN_CARRY_SECONDS + 35)

    def test_other_faults_during_drain_alert_as_before(self):
        drain = 1000
        self.fail_service('web', 'web_page_failed')
        for now in (drain + 30, drain + 65):
            self.monitor_at(now, changed=drain)
            self.cycle(now)
        self.assertEqual(len(self.messages), 1)
        self.assertIn('m3/web web_page_failed', self.messages[0])
        for reason in ('web_page_failed', 'database_unavailable', 'replicas_missing', 'web_not_ready', 'container_unhealthy', 'monitor_stale'):
            self.assertFalse(self.n.drain_hold({'reason': reason, 'bad': 2, 'faultSeconds': 60, 'drainSeconds': 60}))
        hold = {'reason': 'pipeline_alarm', 'bad': 2, 'faultSeconds': 60, 'drainSeconds': 60}
        self.assertTrue(self.n.drain_hold(hold))
        for change in ({'drainSeconds': 1200}, {'faultSeconds': 1200}, {'drainSeconds': None}, {'drainSeconds': -1},
                       {'drainSeconds': float('nan')}, {'drainSeconds': True}, {'drainSeconds': '60'}, {'faultSeconds': None}):
            with self.subTest(change=change):
                self.assertFalse(self.n.drain_hold({**hold, **change}))
        self.assertFalse(self.n.drain_hold({'reason': 'pipeline_alarm', 'bad': 2, 'faultSeconds': 60}))

    def test_report_mode_field_is_validated(self):
        valid = {**self.row('monitor'), 'capacityMode': {'mode': 'draining', 'ageSeconds': 30}}
        self.w.validate_report({'services': [valid]})
        for value in ({'mode': 'private-token', 'ageSeconds': 30}, {'mode': 'open', 'ageSeconds': -1},
                      {'mode': 'open', 'ageSeconds': True}, {'mode': 'open', 'ageSeconds': 1.5},
                      {'mode': 'open', 'ageSeconds': 10 ** 9 + 1}, {'mode': 'open'}, ['open', 30],
                      {'mode': 'open', 'ageSeconds': 30, 'changedAt': 1}, {'mode': ['open'], 'ageSeconds': 30}):
            with self.subTest(value=value):
                with self.assertRaises(ValueError):
                    self.w.validate_report({'services': [{**valid, 'capacityMode': value}]})

    def test_new_fault_alerts_while_aggregate_is_already_down_and_ack_survives_reload(self):
        self.fail_service()
        self.cycle(1000)
        self.assertEqual(self.messages, [])
        self.assertFalse(self.cycle(1030)[0]['ok'])
        self.state = json.loads(self.path.read_text())
        self.cycle(1060)
        self.assertEqual(len(self.messages), 1)
        self.fail_service('monitor', 'monitor_stale')
        self.assertFalse(self.cycle(1090)[0]['ok'])
        self.cycle(1120)
        self.assertEqual(len(self.messages), 2)
        self.assertIn('m3/monitor', self.messages[-1])
        self.assertNotIn('web_page_failed', self.messages[-1])
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)

    def test_failed_receipt_retries_and_marks_sent_only_after_ack(self):
        self.fail_service()
        self.accept = False
        self.cycle(1000)
        self.cycle(1030)
        self.state = json.loads(self.path.read_text())
        self.assertFalse(next(iter(self.state['notifications']['incidents'].values()))['sent'])
        self.cycle(1060)
        self.accept = True
        self.cycle(1090)
        self.cycle(1120)
        self.assertEqual(len(self.messages), 3)
        self.assertTrue(next(iter(self.state['notifications']['incidents'].values()))['sent'])

    def test_monitor_container_fault_alerts_without_creating_recovery_authority(self):
        self.config['recover'] = True
        self.fail_service('monitor', 'container_unhealthy')
        self.cycle(1000)
        self.assertEqual(self.messages, [])
        result, receipt = self.cycle(1030)
        self.assertFalse(result['ok'])
        self.assertTrue(receipt['accepted'])
        self.assertIn('m3/monitor container_unhealthy', self.messages[-1])
        self.assertNotIn('recovery', self.messages[-1])
        self.state = json.loads(self.path.read_text())
        self.cycle(1060)
        self.assertEqual(len(self.messages), 1)
        self.assertEqual(self.state['targets']['m3/monitor']['attempts'], [])
        self.recover_rows()
        self.cycle(1090)
        self.assertEqual(self.state['notifications']['incidents'], {})

    def test_unknown_host_does_not_clear_service_fault_but_explicit_recovery_allows_realert(self):
        self.fail_service()
        self.cycle(1000)
        self.cycle(1030)
        signature = next(iter(self.state['notifications']['incidents']))
        self.reports['m3'] = None
        self.cycle(1060)
        self.cycle(1090)
        self.assertIn(signature, self.state['notifications']['incidents'])
        self.reports['m3'] = {'services': self.rows}
        self.cycle(1120)
        self.assertEqual(sum('web_page_failed' in text for text in self.messages), 1)
        self.rows[:] = [self.row('web'), self.row('monitor')]
        self.cycle(1150)
        self.assertEqual(self.state['notifications']['incidents'], {})
        self.fail_service()
        self.cycle(1180)
        self.cycle(1210)
        self.assertEqual(sum('web_page_failed' in text for text in self.messages), 2)

    def test_new_explicit_reason_replaces_unsent_old_reason(self):
        self.fail_service()
        self.accept = False
        self.cycle(1000)
        self.cycle(1030)
        self.fail_service(reason='database_unavailable')
        self.cycle(1060)
        incidents = self.state['notifications']['incidents']
        self.assertEqual(len(incidents), 1)
        self.assertIn('database_unavailable', next(iter(incidents)))
        self.assertNotIn('web_page_failed', self.messages[-1])

    def provider_alarm(self, stage='tagline-ko', now=2800):
        self.rows[1]['providerFailures'] = [stage]
        self.state['targets']['m3/monitor'] = {'at': now - 30, 'version': 12, 'bad': 0,
            'attempts': [], 'providerFailures': {stage: {'first': now - 1800, 'last': now - 30}}}
        return self.cycle(now)

    def test_provider_absence_is_unknown_and_explicit_empty_snapshot_allows_realert(self):
        self.assertFalse(self.provider_alarm()[0]['ok'])
        self.rows[1].pop('providerFailures')
        self.cycle(2830)
        self.assertEqual(len(self.state['notifications']['incidents']), 1)
        self.rows[1]['providerFailures'] = []
        self.cycle(2860)
        self.assertEqual(self.state['notifications']['incidents'], {})
        self.provider_alarm(now=5000)
        self.assertEqual(sum('tagline-ko' in message for message in self.messages), 2)

    def test_provider_incidents_are_independent_of_other_stage_and_service_recovery(self):
        self.provider_alarm()
        self.rows[1]['providerFailures'] = ['tagline-ko', 'intro-check']
        self.state['targets']['m3/monitor']['providerFailures']['intro-check'] = {'first': 1000, 'last': 2800}
        self.cycle(2830)
        self.assertEqual(len(self.messages), 2)
        self.assertIn('intro-check', self.messages[-1])
        self.rows[1]['providerFailures'] = ['intro-check']
        self.cycle(2860)
        self.assertEqual(len(self.state['notifications']['incidents']), 1)
        self.assertIn('intro-check', next(iter(self.state['notifications']['incidents'])))

    def test_review_capacity_is_a_distinct_incident_even_when_pipeline_is_already_down(self):
        self.alarm_pipeline()
        self.cycle(1000)
        self.cycle(1030)
        self.rows[1]['reviewFailures'] = [{'stage': 'first', 'reason': 'capacity_blocked'}]
        self.cycle(1060)
        _, receipt = self.cycle(1090)
        self.assertTrue(receipt['accepted'])
        self.assertIn('m3/monitor/first capacity_blocked', self.messages[-1])
        self.assertIn('restart does not release capacity', self.messages[-1])
        self.state = json.loads(self.path.read_text())
        self.cycle(1120)
        self.assertEqual(sum('/first capacity_blocked' in message for message in self.messages), 1)
        self.rows[1].pop('reviewFailures')
        self.cycle(1150)
        self.assertIn('m3/monitor/first/capacity_blocked', self.state['notifications']['incidents'])
        self.rows[1]['reviewFailures'] = []
        self.cycle(1180)
        self.assertNotIn('m3/monitor/first/capacity_blocked', self.state['notifications']['incidents'])

    def test_review_local_stall_labels_existing_supervisor_recovery_and_second_is_independent(self):
        self.rows[1]['reviewFailures'] = [{'stage': 'first', 'reason': 'local_stalled'},
                                          {'stage': 'second', 'reason': 'consumer_missing'}]
        self.cycle(1000)
        self.cycle(1030)
        self.assertIn('local fenced supervisor handles recovery', self.messages[-1])
        self.assertIn('m3/monitor/second consumer_missing', self.messages[-1])
        self.rows[1]['reviewFailures'] = [{'stage': 'second', 'reason': 'consumer_missing'}]
        self.cycle(1060)
        self.assertEqual(set(self.state['notifications']['incidents']), {'m3/monitor/second/consumer_missing'})

    def test_receiver_namespaces_and_indices_dedupe_independently_and_true_clears(self):
        self.receipts = {'receipts': [False], 'heartbeatReceipts': [False]}
        self.cycle(1000)
        self.assertEqual(len(self.messages), 1)
        self.assertIn('receiver/pipeline/0', self.messages[0])
        self.assertIn('receiver/heartbeat/0', self.messages[0])
        self.cycle(1030)
        self.assertEqual(len(self.messages), 1)
        self.receipts['receipts'] = [True]
        self.cycle(1060)
        self.receipts['receipts'] = [False]
        self.cycle(1090)
        self.assertEqual(len(self.messages), 2)
        self.assertNotIn('receiver/heartbeat/0', self.messages[-1])

    def test_only_included_incidents_are_acked_and_later_batches_remain_pending(self):
        self.config['hosts'] = {host: {'services': [f'service-{n:02d}-' + 'x' * 48 for n in range(30)]}
                                for host in ('m3', 'mini', 'osaka')}
        self.reports = {host: {'services': [self.row(key, 'replicas_missing') for key in inventory['services']]}
                        for host, inventory in self.config['hosts'].items()}
        self.cycle(1000)
        self.cycle(1030)
        self.assertEqual(len(self.messages), 1)
        self.assertLessEqual(len(self.messages[0]), 4096)
        incidents = self.state['notifications']['incidents']
        sent = sum(item['sent'] for item in incidents.values())
        self.assertGreater(sent, 0)
        self.assertLess(sent, 90)
        self.assertEqual(sum(line.startswith('- ') for line in self.messages[0].splitlines()), sent)
        self.cycle(1060)
        self.assertEqual(len(self.messages), 2)
        self.assertGreater(sum(item['sent'] for item in self.state['notifications']['incidents'].values()), sent)
        self.assertTrue(set(self.messages[0].splitlines()[1:]).isdisjoint(self.messages[1].splitlines()[1:]))

    def test_unconfigured_notifier_has_no_transport_or_notification_state(self):
        self.config.pop('incidentNotifications')
        self.fail_service()
        self.cycle(1000)
        self.cycle(1030)
        self.assertEqual(self.messages, [])
        self.assertNotIn('notifications', self.state)

    def test_watchdog_main_passes_observations_and_receiver_receipts_to_notifier(self):
        self.fail_service()
        self.receipts['heartbeatReceipts'] = [False]
        for now in (1000, 1030):
            output = io.StringIO()
            def notify(config, state, reports, result, receipts):
                return self.n.notify(config, state, reports, result, receipts, now=now, send=self.send)
            with patch.object(sys, 'argv', ['oracle_watchdog.py', '--config', 'private-config', '--once']), \
                    patch.object(self.w, 'read_config', return_value=self.config), \
                    patch.object(self.w, 'collect', return_value=self.reports), \
                    patch.object(self.w, 'deliver', return_value=self.receipts), \
                    patch.object(self.w, 'notify', side_effect=notify), \
                    patch.object(self.w.signal, 'signal'), patch.object(self.w.time, 'time', return_value=now), \
                    contextlib.redirect_stdout(output):
                self.w.main()
            self.assertNotIn(DESTINATION['botToken'], output.getvalue())
            self.assertNotIn(DESTINATION['chatId'], output.getvalue())
            self.assertNotIn('private-token', output.getvalue())
        self.assertEqual(len(self.messages), 2)
        self.assertIn('receiver/heartbeat/0', self.messages[0])
        self.assertIn('web_page_failed', self.messages[1])

    def test_stored_or_event_payloads_cannot_escape_fixed_incident_fields(self):
        self.state['notifications'] = {'version': 1, 'incidents': {
            'private-token': {'sent': False, 'firstSeen': 1},
            'm3/web/service/private-token': {'sent': False, 'firstSeen': 1}}}
        result = {'ok': False, 'events': [{'target': 'm3/private-token', 'reason': 'web_page_failed', 'bad': 3},
                                         {'target': 'm3/web', 'reason': 'private-token', 'bad': 3}]}
        self.n.notify(self.config, self.state, self.reports, result, self.receipts, now=1000, send=self.send)
        self.assertEqual(self.messages, [])
        self.assertNotIn('private-token', json.dumps(self.state['notifications']))

    def test_incomplete_observation_cannot_resolve_a_host_incident(self):
        signature = 'm3/host/service/probe_unknown'
        self.state['notifications'] = {'version': 1, 'incidents': {signature: {'sent': True, 'firstSeen': 1000}}}
        self.n.notify(self.config, self.state, {'m3': {'services': [self.row('web')]}},
                      {'events': []}, self.receipts, now=1030, send=self.send)
        self.assertIn(signature, self.state['notifications']['incidents'])

    def test_pipeline_short_recovery_reload_and_relapse_do_not_resend(self):
        signature = 'm3/monitor/service/pipeline_alarm'
        self.alarm_pipeline()
        self.cycle(1000)
        self.cycle(1030)
        self.assertEqual(self.messages, ['NoMoreVibe 장애 알림\n- m3/monitor pipeline_alarm — 파이프라인 단계가 멈춤 — 운영 홈 확인'])
        self.recover_rows()
        self.cycle(1060)
        self.cycle(1210)
        self.assertEqual(len(self.messages), 1)
        stored = json.loads(self.path.read_text())
        incident = stored['notifications']['incidents'][signature]
        self.assertEqual(stored['notifications']['version'], 1)
        self.assertTrue(incident['sent'])
        self.assertEqual(incident['clearSince'], 1060)
        self.assertEqual(incident['lastClearAt'], 1210)
        self.state = stored
        self.cycle(1360)
        incident = self.state['notifications']['incidents'][signature]
        self.assertEqual(incident['clearSince'], 1060)
        self.assertEqual(incident['lastClearAt'], 1360)
        self.alarm_pipeline()
        self.cycle(1400)
        self.cycle(1430)
        self.assertEqual(len(self.messages), 1)
        incident = self.state['notifications']['incidents'][signature]
        self.assertTrue(incident['sent'])
        self.assertNotIn('clearSince', incident)

        self.messages.clear()
        self.state['notifications'] = {'version': 1, 'incidents': {}}
        self.state['targets'] = {}
        self.accept = False
        self.alarm_pipeline()
        self.cycle(5000)
        self.cycle(5030)
        self.assertEqual(len(self.messages), 1)
        self.assertFalse(self.state['notifications']['incidents'][signature]['sent'])
        self.recover_rows()
        self.accept = True
        self.cycle(5060)
        self.assertEqual(len(self.messages), 1)
        self.assertFalse(self.state['notifications']['incidents'][signature]['sent'])
        self.alarm_pipeline()
        self.cycle(5090)
        self.assertEqual(len(self.messages), 2)
        self.assertTrue(self.state['notifications']['incidents'][signature]['sent'])

    def test_pipeline_stable_600_recovery_rearms(self):
        self.assertEqual((self.n.PIPELINE_RECOVERY_SECONDS, self.n.PIPELINE_RECOVERY_GAP_SECONDS), (600, 150))
        signature = 'm3/monitor/service/pipeline_alarm'
        self.alarm_pipeline()
        self.cycle(2000)
        self.cycle(2030)
        self.assertEqual(len(self.messages), 1)
        self.recover_rows()
        start = 2060
        for now in range(start, start + 600, 150):
            self.cycle(now)
            incident = self.state['notifications']['incidents'][signature]
            self.assertEqual(incident['clearSince'], start)
            self.assertTrue(incident['sent'])
        self.state = json.loads(self.path.read_text())
        self.assertEqual(self.state['notifications']['incidents'][signature]['lastClearAt'], start + 450)
        self.cycle(start + 600)
        self.assertNotIn(signature, self.state['notifications']['incidents'])
        self.assertEqual(self.state['notifications']['version'], 1)
        self.assertEqual(len(self.messages), 1)
        self.alarm_pipeline()
        self.cycle(2700)
        self.cycle(2730)
        self.assertEqual(len(self.messages), 2)
        self.assertIn('m3/monitor pipeline_alarm', self.messages[-1])
        incident = self.state['notifications']['incidents'][signature]
        self.assertEqual(incident['firstSeen'], 2730)
        self.assertTrue(incident['sent'])
        self.assertNotIn('clearSince', incident)

    def test_pipeline_unknown_gap_and_rollback_do_not_clear(self):
        signature = 'm3/monitor/service/pipeline_alarm'
        self.alarm_pipeline()
        self.cycle(3000)
        self.cycle(3030)
        self.recover_rows()
        self.cycle(3060)
        self.reports['m3'] = None
        self.cycle(3120)
        self.reports['m3'] = {'services': self.rows}
        incident = self.state['notifications']['incidents'][signature]
        self.assertTrue(incident['sent'])
        self.assertNotIn('clearSince', incident)
        self.assertEqual(len(self.messages), 1)
        self.cycle(3180)
        self.assertEqual(self.state['notifications']['incidents'][signature]['clearSince'], 3180)

        incident = self.state['notifications']['incidents'][signature]
        incident['clearSince'] = 1000
        incident['lastClearAt'] = 3180
        self.cycle(3331)
        incident = self.state['notifications']['incidents'][signature]
        self.assertEqual((incident['clearSince'], incident['lastClearAt']), (3331, 3331))

        incident['clearSince'] = 1000
        incident['lastClearAt'] = 9000
        self.cycle(3400)
        incident = self.state['notifications']['incidents'][signature]
        self.assertEqual(incident['clearSince'], 3400)
        self.assertTrue(incident['sent'])

        incident['clearSince'] = float('nan')
        incident['lastClearAt'] = 3400
        self.cycle(3460)
        incident = self.state['notifications']['incidents'][signature]
        self.assertEqual(incident['clearSince'], 3460)

        incident['clearSince'] = 3400
        incident['lastClearAt'] = 1000
        self.cycle(4000)
        incident = self.state['notifications']['incidents'][signature]
        self.assertEqual(incident['clearSince'], 4000)

        incident['clearSince'] = 1000
        incident['lastClearAt'] = 4000
        self.alarm_pipeline()
        self.cycle(4100)
        incident = self.state['notifications']['incidents'][signature]
        self.assertTrue(incident['sent'])
        self.assertNotIn('clearSince', incident)
        self.recover_rows()
        self.cycle(4130)
        self.n.notify(self.config, self.state, {'m3': {'services': [self.row('web')]}},
                      {'events': []}, self.receipts, now=4200, send=self.send)
        incident = self.state['notifications']['incidents'][signature]
        self.assertTrue(incident['sent'])
        self.assertNotIn('clearSince', incident)
        self.reports['m3'] = {'services': self.rows}
        self.cycle(4800)
        incident = self.state['notifications']['incidents'][signature]
        self.assertEqual(incident['clearSince'], 4800)
        self.assertEqual(len(self.messages), 1)

    def test_unrelated_fault_provider_and_receiver_recovery_stays_immediate(self):
        self.fail_service()
        self.cycle(8000)
        self.cycle(8030)
        web = self.state['notifications']['incidents']['m3/web/service/web_page_failed']
        self.assertTrue(web['sent'])
        self.assertNotIn('clearSince', web)
        self.recover_rows()
        self.cycle(8060)
        self.assertEqual(self.state['notifications']['incidents'], {})
        self.fail_service()
        self.cycle(8090)
        self.cycle(8120)
        self.assertEqual(sum('web_page_failed' in text for text in self.messages), 2)
        self.recover_rows()
        self.cycle(8150)
        self.assertEqual(self.state['notifications']['incidents'], {})

        self.provider_alarm(now=10000)
        self.assertIn('m3/monitor/tagline-ko/upstream_stalled', self.state['notifications']['incidents'])
        self.rows[1]['providerFailures'] = []
        self.cycle(10030)
        self.assertEqual(self.state['notifications']['incidents'], {})
        self.assertEqual(len(self.messages), 3)

        signature = 'm3/monitor/service/pipeline_alarm'
        self.alarm_pipeline()
        self.cycle(11000)
        self.cycle(11030)
        self.recover_rows()
        self.cycle(11060)
        self.assertEqual(self.state['notifications']['incidents'][signature]['clearSince'], 11060)
        self.receipts['receipts'] = [False]
        self.cycle(11090)
        self.assertIn('receiver/pipeline/0', self.messages[-1])
        self.assertNotIn('pipeline_alarm', self.messages[-1])
        self.receipts['receipts'] = [True]
        self.cycle(11120)
        self.assertNotIn('receiver/pipeline/0/push_failed', self.state['notifications']['incidents'])
        self.assertEqual(self.state['notifications']['incidents'][signature]['clearSince'], 11060)
        self.fail_service('monitor', 'monitor_stale')
        self.cycle(11150)
        self.assertNotIn(signature, self.state['notifications']['incidents'])
        self.assertNotIn('monitor_stale', json.dumps(self.state['notifications']))
        self.cycle(11180)
        self.assertIn('m3/monitor/service/monitor_stale', self.state['notifications']['incidents'])
        self.assertIn('monitor_stale', self.messages[-1])
        self.assertNotIn('pipeline_alarm', self.messages[-1])
        self.assertEqual(len(self.messages), 6)

    def test_optional_configuration_is_validated_without_exposing_secrets(self):
        material = self.path.parent / 'ssh-material'
        material.touch(mode=0o600)
        self.config['hosts']['m3'].update(target='jr@100.64.0.1', key=str(material), knownHosts=str(material))
        path = self.path.parent / 'config.json'
        for destination in [None, {}, {**DESTINATION, 'url': 'private-token'},
                            {**DESTINATION, 'botToken': 'private-token'},
                            {**DESTINATION, 'chatId': 'https://private-token'},
                            {**DESTINATION, 'chatId': True}]:
            with self.subTest(destination=type(destination).__name__):
                self.config['incidentNotifications'] = destination
                path.write_text(json.dumps(self.config))
                path.chmod(0o600)
                with self.assertRaisesRegex(ValueError, 'invalid_incident_notification_configuration') as failure:
                    self.w.read_config(path)
                self.assertNotIn('private-token', str(failure.exception))


class FakeResponse:
    def __init__(self, connection):
        self.connection = connection
        self.status = connection.status

    def read(self, limit):
        self.connection.limits.append(limit)
        return self.connection.body[:limit]


class FakeConnection:
    status = 200
    body = b'{"ok":true,"result":{"message_id":123}}'
    instances = []

    def __init__(self, host, port, timeout):
        self.host, self.port, self.timeout = host, port, timeout
        self.requests, self.limits = [], []
        self.closed = False
        self.instances.append(self)

    def request(self, method, path, body, headers):
        self.requests.append((method, path, body, headers))

    def getresponse(self):
        return FakeResponse(self)

    def close(self):
        self.closed = True


class TelegramTransportTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue((OPS / 'incident_notifications.py').exists(), 'bounded Telegram transport must exist')
        self.n = load('incident_notifications_transport', OPS / 'incident_notifications.py')
        FakeConnection.status = 200
        FakeConnection.body = b'{"ok":true,"result":{"message_id":123}}'
        FakeConnection.instances = []
        factory = patch.object(self.n.http.client, 'HTTPSConnection', FakeConnection)
        factory.start()
        self.addCleanup(factory.stop)

    def test_fixed_https_target_plain_text_and_response_cap(self):
        with patch.dict(os.environ, {'HTTPS_PROXY': 'http://private-token.invalid'}):
            self.assertTrue(self.n.telegram_request(DESTINATION, 'fixed incident'))
        connection, = FakeConnection.instances
        self.assertEqual((connection.host, connection.port, connection.timeout), ('api.telegram.org', 443, 5))
        method, path, body, headers = connection.requests[0]
        self.assertEqual((method, path), ('POST', '/bot' + DESTINATION['botToken'] + '/sendMessage'))
        self.assertEqual(json.loads(body), {'chat_id': DESTINATION['chatId'], 'text': 'fixed incident', 'disable_web_page_preview': True})
        self.assertEqual(headers, {'Content-Type': 'application/json'})
        self.assertEqual(connection.limits, [16385])
        self.assertTrue(connection.closed)

    def test_redirect_errors_oversize_and_invalid_receipts_are_rejected(self):
        for body in [b'{"ok":false}', b'{"ok":1,"result":{"message_id":1}}', b'{"ok":true}',
                     b'{"ok":true,"result":{"message_id":true}}', b'{"ok":true,"result":{"message_id":0}}',
                     b'{"ok":true,"result":{"message_id":-1}}', b'{"ok":true,"result":{"message_id":"123"}}',
                     b'[]', b'private-token', b' ' * 16385]:
            with self.subTest(body=body[:20]):
                FakeConnection.body = body
                self.assertFalse(self.n.telegram_request(DESTINATION, 'fixed incident'))
                self.assertTrue(FakeConnection.instances[-1].closed)
        FakeConnection.body = b'{"ok":true,"result":{"message_id":123}}'
        for status in (301, 302, 307, 308, 400, 429, 500):
            FakeConnection.status = status
            self.assertFalse(self.n.telegram_request(DESTINATION, 'fixed incident'))
            self.assertEqual(len(FakeConnection.instances[-1].requests), 1)

    def test_secret_material_is_stdin_only_and_child_is_isolated_with_a_five_second_deadline(self):
        calls = []
        def run(argv, **kwargs):
            calls.append((argv, kwargs))
            return subprocess.CompletedProcess(argv, 0, stdout=b'{"ok":true}\n')
        with patch.object(self.n.subprocess, 'run', run):
            self.assertTrue(self.n.send_telegram(DESTINATION, 'fixed incident'))
        argv, kwargs = calls[0]
        self.assertEqual(argv, [sys.executable, '-I', str(OPS / 'incident_notifications.py'), '--send'])
        self.assertNotIn(DESTINATION['botToken'], repr(argv))
        self.assertNotIn(DESTINATION['chatId'], repr(argv))
        self.assertEqual(kwargs['timeout'], 5)
        self.assertIs(kwargs['stderr'], subprocess.DEVNULL)
        self.assertEqual(kwargs['env'], {})
        self.assertEqual(json.loads(kwargs['input']), {'destination': DESTINATION, 'text': 'fixed incident'})

    def test_actual_child_timeout_is_killed_without_secret_output(self):
        original = subprocess.run
        def stall(_argv, **kwargs):
            return original([sys.executable, '-I', '-c', 'import time;time.sleep(60)'], **kwargs)
        stdout, stderr = io.StringIO(), io.StringIO()
        started = time.monotonic()
        with patch.object(self.n.subprocess, 'run', stall), contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertFalse(self.n.send_telegram(DESTINATION, 'fixed incident', deadline_seconds=0.05))
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(stdout.getvalue() + stderr.getvalue(), '')

    def test_child_rejects_oversize_and_invalid_stdin_without_network_or_leaks(self):
        for payload in [b'x' * 32769, b'private-token', b'[]', b'{"destination":null,"text":"private-token"}',
                        json.dumps({'destination': DESTINATION, 'text': 'x' * 4097}).encode()]:
            completed = subprocess.run([sys.executable, '-I', str(OPS / 'incident_notifications.py'), '--send'],
                                       input=payload, capture_output=True, timeout=2)
            self.assertEqual(completed.returncode, 0)
            self.assertEqual(completed.stdout, b'{"ok":false}\n')
            self.assertEqual(completed.stderr, b'')


if __name__ == '__main__':
    unittest.main()
