"""Phone alerts for operating-home tasks (console 4b): the monitor's alert rows cross the SSH boundary only in a fixed, bounded shape."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
OPS = ROOT / 'scripts' / 'ops'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ALERT = {'id': 7, 'title': 'AI 1차가 거의 멈췄습니다', 'fact': '대기 857건 · 최근 1시간 3건', 'href': '/admin/flow?stage=first'}


class ConsoleAlertRelayTests(unittest.TestCase):
    def setUp(self):
        self.gateway = load('recovery_gateway_console_alerts', OPS / 'recovery_gateway.py')
        self.fixtures = load('recovery_console_alert_fixtures', ROOT / 'tests/test_recovery_observation.py')

    def test_valid_rows_and_rejected_shapes(self):
        valid = self.gateway.valid_console_alerts
        self.assertTrue(valid([]))
        self.assertTrue(valid([ALERT, {**ALERT, 'id': 8, 'fact': '', 'href': '/admin/flow#task-stop-admission'}]))
        for bad in ([{**ALERT, 'id': 0}], [{**ALERT, 'id': True}], [{**ALERT, 'id': '7'}], [ALERT, ALERT],
                    [{**ALERT, 'title': ''}], [{**ALERT, 'title': 'x' * 81}], [{**ALERT, 'fact': 'y' * 161}],
                    [{**ALERT, 'title': 'a\nb'}], [{**ALERT, 'fact': 'a‮b'}],
                    [{**ALERT, 'href': 'https://evil.test/phish'}], [{**ALERT, 'href': 'https://evil.test/admin/flow'}],
                    [{**ALERT, 'href': 'javascript:alert(1)'}], [{**ALERT, 'href': '//evil.test/admin'}],
                    [{**ALERT, 'href': '/admin/' + 'x' * 200}], [{**ALERT, 'secret': 'private-token'}],
                    [{**ALERT, 'id': index} for index in range(1, 10)], {'id': 7}, None):
            with self.subTest(bad=bad):
                self.assertFalse(valid(bad))

    @unittest.skipUnless(shutil.which('node'), 'Node is needed to execute the actual in-container probe')
    def test_actual_node_probe_relays_only_valid_alert_rows(self):
        now = int(time.time() * 1000)
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = Path(directory) / 'health.json'
            for value, expected in [([ALERT], [ALERT]), ([], []), ([{**ALERT, 'note': 'private-token'}], None),
                                    ([{**ALERT, 'href': 'https://evil.test/private-token'}], None), ('private-token', None), (None, None)]:
                with self.subTest(value=value):
                    body = {'checkedAt': now, 'overall': 'ok'}
                    if value is not None:
                        body['consoleAlerts'] = value
                    heartbeat.write_text(json.dumps(body))
                    result = subprocess.run(['node', '-e', 'Date.now=()=>' + str(now) + ';' + self.gateway.MONITOR_PROBE],
                                            check=True, timeout=10, capture_output=True,
                                            env={'PATH': os.environ.get('PATH', ''), 'MONITOR_HEALTH_PATH': str(heartbeat)})
                    report = json.loads(result.stdout)
                    self.assertEqual((report['fresh'], report['overall']), (True, 'ok'))
                    if expected is None:
                        self.assertNotIn('consoleAlerts', report)
                    else:
                        self.assertEqual(report['consoleAlerts'], expected)
                    self.assertNotIn(b'private-token', result.stdout)

    def observe(self, *values, overall='ok'):
        fixture = self.fixtures.DockerFixture(self.gateway, kind='monitor')
        for cid, value in zip(self.fixtures.IDS, values):
            fixture.monitor[cid]['overall'] = overall
            if value is not None:
                fixture.monitor[cid]['consoleAlerts'] = value
        return fixture.observe()

    def test_rows_cross_only_when_every_replica_agrees_and_never_change_the_service_row(self):
        second = {**ALERT, 'id': 9, 'title': '규칙 심사 보류가 갑자기 늘었습니다'}
        for overall, reason in (('ok', 'ok'), ('alarm', 'pipeline_alarm')):
            with self.subTest(overall=overall):
                row = self.observe([second, ALERT], [ALERT, second], overall=overall)
                self.assertEqual(row['consoleAlerts'], [ALERT, second])
                self.assertEqual((row['reason'], row['ok'], row['recoverable']), (reason, overall == 'ok', False))
        for values in [([ALERT], []), ([ALERT], None), (None, None), ([ALERT], [{**ALERT, 'title': 'x' * 81}])]:
            with self.subTest(values=values):
                row = self.observe(*values)
                self.assertNotIn('consoleAlerts', row)
                self.assertEqual((row['reason'], row['ok']), ('ok', True))
        self.assertEqual(self.observe([], [])['consoleAlerts'], [])
        self.assertNotIn('consoleAlerts', self.fixtures.DockerFixture(self.gateway, kind='web').observe())

    def test_watchdog_accepts_the_field_and_rejects_a_forged_one(self):
        sys.path.insert(0, str(OPS))
        try:
            watchdog = load('oracle_watchdog_console_alerts', OPS / 'oracle_watchdog.py')
        finally:
            sys.path.remove(str(OPS))
        row = {'key': 'monitor', 'version': 12, 'replicas': 1, 'settled': True, 'ok': True, 'recoverable': False, 'reason': 'ok', 'consoleAlerts': [ALERT]}
        self.assertEqual(watchdog.validate_report({'services': [row]}), {'services': [row]})
        with self.assertRaises(ValueError):
            watchdog.validate_report({'services': [{**row, 'consoleAlerts': [{**ALERT, 'href': 'https://evil.test/admin'}]}]})


if __name__ == '__main__':
    unittest.main()
