"""Phone alerts for operating-home tasks (console 4b): Oracle sends each relayed alert row once, again only as a new row."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest


OPS = Path(__file__).resolve().parents[1] / 'scripts' / 'ops'
DESTINATION = {'botToken': '123456789:abcdefghijklmnopqrstuvwxyz_0123456789', 'chatId': '-1001234567890'}


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def alert(alert_id, title='AI 1차가 거의 멈췄습니다', fact='대기 857건 · 최근 1시간 3건', href='/admin/flow?stage=first'):
    return {'id': alert_id, 'title': title, 'fact': fact, 'href': href}


class ConsoleAlertNotificationTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(OPS))
        self.addCleanup(lambda: sys.path.remove(str(OPS)))
        self.n = load('incident_notifications_console', OPS / 'incident_notifications.py')
        self.w = load('oracle_watchdog_console', OPS / 'oracle_watchdog.py')
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'state.json'
        self.config = {'recover': False, 'hosts': {'m3': {'services': ['web', 'monitor']}},
                       'pushUrls': ['https://receiver.test/private-token'], 'heartbeatUrls': ['https://receiver.test/private-heartbeat'],
                       'state': str(self.path), 'incidentNotifications': DESTINATION, 'adminOrigin': 'https://nomorevibe.example'}
        self.state = {'targets': {}}
        self.alerts = []
        self.messages = []
        self.accept = True

    def report(self, alerts):
        monitor = {'key': 'monitor', 'version': 12, 'replicas': 1, 'settled': True, 'ok': True, 'recoverable': False, 'reason': 'ok'}
        if alerts is not None:
            monitor['consoleAlerts'] = alerts
        web = {'key': 'web', 'version': 12, 'replicas': 1, 'settled': True, 'ok': True, 'recoverable': False, 'reason': 'ok'}
        return {'m3': {'services': [web, monitor]}}

    def send(self, destination, message):
        self.assertEqual(destination, DESTINATION)
        self.messages.append(message)
        return self.accept

    def cycle(self, now, alerts):
        reports = self.report(alerts)
        result = self.w.cycle(self.config, self.state, reports, now=now)
        return self.n.notify(self.config, self.state, reports, result, {'receipts': [True], 'heartbeatReceipts': [True]}, now=now, send=self.send)

    def test_a_new_row_is_sent_once_with_its_title_fact_and_link(self):
        receipt = self.cycle(1000, [alert(7)])
        self.assertEqual(self.messages, ['NoMoreVibe 할 일 알림\n- AI 1차가 거의 멈췄습니다\n  대기 857건 · 최근 1시간 3건\n'
                                         '  https://nomorevibe.example/admin/flow?stage=first'])
        self.assertEqual((receipt['consoleAccepted'], receipt['consoleSent'], receipt['consolePending']), (True, 1, 0))
        for now in (1030, 1060, 1090):
            self.cycle(now, [alert(7)])
        self.assertEqual(len(self.messages), 1)
        # 상태에는 열쇠와 보냄 표시만 — 알림 글은 남기지 않는다
        self.assertEqual(self.state['notifications']['console'], {'m3/monitor/7': {'sent': True, 'firstSeen': 1000}})
        self.assertNotIn('대기 857건', self.path.read_text())

    def test_a_row_that_closes_and_a_new_row_for_the_same_task_is_sent_again(self):
        self.cycle(1000, [alert(7)])
        self.cycle(1030, [])
        self.assertEqual(self.state['notifications']['console'], {})
        self.cycle(1060, [alert(8)])
        self.assertEqual(len(self.messages), 2)
        self.assertIn('- AI 1차가 거의 멈췄습니다', self.messages[1])

    def test_a_missing_or_unreadable_field_is_unknown_and_keeps_the_sent_mark(self):
        self.cycle(1000, [alert(7)])
        self.cycle(1030, None)  # 옛 monitor·읽기 실패
        reports = self.report([alert(7)])
        del reports['m3']
        result = self.w.cycle(self.config, self.state, reports, now=1060)
        self.n.notify(self.config, self.state, reports, result, {'receipts': [True], 'heartbeatReceipts': [True]}, now=1060, send=self.send)
        self.cycle(1090, [alert(7)])
        self.assertEqual(len(self.messages), 1)

    def test_a_rejected_send_is_retried_and_only_unsent_rows_go_next_time(self):
        self.accept = False
        receipt = self.cycle(1000, [alert(7)])
        self.assertEqual((receipt['consoleAccepted'], receipt['consolePending']), (False, 1))
        self.accept = True
        self.cycle(1030, [alert(7), alert(9, title='규칙 심사 보류가 갑자기 늘었습니다', fact='', href='/admin/flow#task-odd-hold-ambiguous')])
        self.assertEqual(len(self.messages), 2)
        self.assertEqual(self.messages[1], 'NoMoreVibe 할 일 알림\n- AI 1차가 거의 멈췄습니다\n  대기 857건 · 최근 1시간 3건\n'
                         '  https://nomorevibe.example/admin/flow?stage=first\n- 규칙 심사 보류가 갑자기 늘었습니다\n'
                         '  https://nomorevibe.example/admin/flow#task-odd-hold-ambiguous')
        self.cycle(1060, [alert(7), alert(9, title='규칙 심사 보류가 갑자기 늘었습니다', fact='', href='/admin/flow#task-odd-hold-ambiguous')])
        self.assertEqual(len(self.messages), 2)

    def test_without_admin_origin_the_path_is_sent_and_a_bad_origin_is_refused_by_config(self):
        del self.config['adminOrigin']
        self.cycle(1000, [alert(7)])
        self.assertTrue(self.messages[0].endswith('\n  /admin/flow?stage=first'))
        self.assertEqual(self.n._admin_origin({'adminOrigin': 'https://nomorevibe.example/'}), 'https://nomorevibe.example')
        self.assertEqual(self.n._admin_origin({'adminOrigin': 'http://nomorevibe.example'}), '')

    def test_service_incidents_are_unchanged_by_alert_rows(self):
        self.cycle(1000, [alert(7)])
        self.assertEqual(self.state['notifications']['incidents'], {})
        self.assertEqual(len(self.messages), 1)


if __name__ == '__main__':
    unittest.main()
