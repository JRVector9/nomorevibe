"""Oracle watches the worker's automatic release: an unknown request older than 5 minutes becomes its own incident."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

OPS = Path(__file__).resolve().parents[1] / 'scripts' / 'ops'
REQUEST = '00000000-0000-4000-8000-000000000002'
OTHER = '00000000-0000-4000-8000-000000000003'


class CapacityReclaimOverdueTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(OPS))
        self.addCleanup(lambda: sys.path.remove(str(OPS)))
        spec = importlib.util.spec_from_file_location('oracle_watchdog', OPS / 'oracle_watchdog.py')
        self.w = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.w)
        from incident_notifications import notify
        self.notify = notify
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'state.json'
        self.config = {'recover': True, 'hosts': {'m3': {'services': ['monitor']}}, 'state': str(self.path)}
        self.state = {'targets': {}}
        self.request = {'requestId': REQUEST, 'routeId': 'ai1-supa', 'groupId': 'supa-gpu', 'oldPolicy': False, 'localEndRecorded': True}
        self.row = {'key': 'monitor', 'version': 12, 'replicas': 1, 'settled': True,
                    'ok': False, 'recoverable': False, 'reason': 'pipeline_alarm',
                    'capacityUnknowns': {'status': 'alarm', 'truncated': False, 'requests': [self.request]}}
        self.recover = Mock()

    def cycle(self, now):
        result = self.w.cycle(self.config, self.state, {'m3': {'services': [self.row]}}, now=now, recover=self.recover)
        self.state = json.loads(self.path.read_text())
        return result

    def overdue(self, result):
        return [event for event in result['events'] if event.get('reason') == 'model_reclaim_overdue']

    def test_escalates_only_after_the_automatic_release_window(self):
        self.assertEqual(self.overdue(self.cycle(1000)), [])
        self.assertEqual(self.overdue(self.cycle(1000 + self.w.CAPACITY_RECLAIM_OVERDUE_SECONDS - 1)), [])
        late = self.overdue(self.cycle(1000 + self.w.CAPACITY_RECLAIM_OVERDUE_SECONDS))
        self.assertEqual(late, [{'target': 'm3/monitor', 'reason': 'model_reclaim_overdue', 'requestId': REQUEST,
                                 'routeId': 'ai1-supa', 'ageSeconds': self.w.CAPACITY_RECLAIM_OVERDUE_SECONDS}])
        self.recover.assert_not_called()  # Oracle never gains model/DB authority

    def test_released_request_resets_and_a_partial_read_keeps_the_clock(self):
        self.cycle(1000)
        # A failed read must not restart the clock of a request it could not list.
        self.row['capacityUnknowns'] = {'status': 'alarm', 'truncated': True, 'requests': []}
        self.cycle(1100)
        self.row['capacityUnknowns'] = {'status': 'alarm', 'truncated': False, 'requests': [self.request]}
        self.assertEqual(len(self.overdue(self.cycle(1300))), 1)
        # Worker released it: a complete empty read clears; a new request starts its own clock.
        self.row['capacityUnknowns'] = {'status': 'ok', 'truncated': False, 'requests': []}
        self.row.update(ok=True, reason='ok')
        self.assertTrue(self.cycle(1330)['ok'])
        self.assertNotIn('capacitySeen', self.state['targets']['m3/monitor'])
        self.row['capacityUnknowns'] = {'status': 'alarm', 'truncated': False, 'requests': [{**self.request, 'requestId': OTHER}]}
        self.row.update(ok=False, reason='pipeline_alarm')
        self.assertEqual(self.overdue(self.cycle(1360)), [])

    def test_overdue_is_a_separate_per_request_notification(self):
        self.config['incidentNotifications'] = {'botToken': '123456:' + 'a' * 30, 'chatId': '123456'}
        send = Mock(return_value=True)
        reports = {'m3': {'services': [self.row]}}
        self.notify(self.config, self.state, reports, self.cycle(1000), {}, now=1000, send=send)
        self.notify(self.config, self.state, reports, self.cycle(1400), {}, now=1400, send=send)
        signature = 'm3/monitor/' + REQUEST + '/model_reclaim_overdue'
        self.assertIn(signature, self.state['notifications']['incidents'])
        self.assertIn('model_reclaim_overdue', send.call_args.args[1])
        self.row['capacityUnknowns'] = {'status': 'ok', 'truncated': False, 'requests': []}
        self.row.update(ok=True, reason='ok')
        self.notify(self.config, self.state, reports, self.cycle(1430), {}, now=1430, send=send)
        self.assertNotIn(signature, self.state['notifications']['incidents'])


if __name__ == '__main__':
    unittest.main()
