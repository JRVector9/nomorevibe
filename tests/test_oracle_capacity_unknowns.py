"""Request identity survives unrelated successes/releases; no model restart authority is granted."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

OPS = Path(__file__).resolve().parents[1] / 'scripts' / 'ops'
REQUEST = '00000000-0000-4000-8000-000000000001'


class CapacityUnknownTests(unittest.TestCase):
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
        self.request = {'requestId': REQUEST, 'routeId': 'product-translate', 'groupId': 'm1-mlx', 'oldPolicy': True, 'localEndRecorded': True}
        self.row = {'key': 'monitor', 'version': 12, 'replicas': 1, 'settled': True,
                    'ok': False, 'recoverable': False, 'reason': 'pipeline_alarm',
                    'capacityUnknowns': {'status': 'alarm', 'truncated': False, 'requests': [self.request]}}
        self.recover = Mock()

    def cycle(self, now=1000):
        return self.w.cycle(self.config, self.state, {'m3': {'services': [self.row]}}, now=now, recover=self.recover)

    def test_request_identity_and_required_proof_survive_reload_and_release_changes(self):
        for index in range(4):
            result = self.cycle(1000 + index * 30)
            self.assertFalse(result['ok'])
            self.assertIn({'target': 'm3/monitor', 'reason': 'model_indeterminate', **self.request,
                           'recovery': 'provider_exit_required'}, result['events'])
            self.state = json.loads(self.path.read_text())
            self.row['version'] += 1
        self.recover.assert_not_called()

    def test_missing_observation_is_not_a_recovery_and_only_explicit_clear_removes_request(self):
        self.cycle()
        missing = self.w.cycle(self.config, self.state, {'m3': None}, now=1010, recover=self.recover)
        self.assertFalse(missing['ok'])
        self.row.pop('capacityUnknowns')
        self.row.update(ok=True, reason='ok')
        self.assertFalse(self.cycle(1030)['ok'])
        self.row['capacityUnknowns'] = {'status': 'unknown', 'truncated': False, 'requests': []}
        self.row.update(ok=False, reason='pipeline_alarm')
        self.assertFalse(self.cycle(1060)['ok'])
        self.row['capacityUnknowns'] = {'status': 'ok', 'truncated': False, 'requests': []}
        self.row.update(ok=True, reason='ok')
        self.assertTrue(self.cycle(1090)['ok'])
        self.assertEqual(self.state['targets']['m3/monitor']['capacityUnknowns']['requests'], [])
        self.recover.assert_not_called()

    def test_unproven_local_end_and_truncation_remain_alarms(self):
        self.request['localEndRecorded'] = False
        result = self.cycle()
        self.assertIn('local_and_provider_exit_required', [row.get('recovery') for row in result['events']])
        self.row['capacityUnknowns'] = {'status': 'alarm', 'truncated': True, 'requests': []}
        self.assertFalse(self.cycle(1030)['ok'])

    def test_rejects_false_recovery_claims_duplicate_ids_private_data_and_invalid_summaries(self):
        for patch in [{'requests': [self.request, self.request]}, {'status': 'ok'}, {'truncated': 'false'},
                      {'requests': [{**self.request, 'token': 'never transport credentials'}]},
                      {'requests': [{**self.request, 'groupId': 'bad\nlabel'}]}, {'requests': []}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.w.validate_report({'services': [{**self.row, 'capacityUnknowns': {**self.row['capacityUnknowns'], **patch}}]})
        for patch in [{'ok': True}, {'recoverable': True}]:
            with self.assertRaises(ValueError):
                self.w.validate_report({'services': [{**self.row, **patch}]})

    def test_notification_is_per_request_and_clears_only_with_a_complete_observation(self):
        self.config['incidentNotifications'] = {'botToken': '123456:' + 'a' * 30, 'chatId': '123456'}
        send = Mock(return_value=True)
        reports = {'m3': {'services': [self.row]}}
        result = self.cycle()
        self.notify(self.config, self.state, reports, result, {}, now=1000, send=send)
        self.assertIn(REQUEST, send.call_args.args[1])
        self.notify(self.config, self.state, reports, self.cycle(1030), {}, now=1030, send=send)
        # The service-level pipeline incident reaches its two-sample gate here; the request itself is not sent twice.
        self.assertNotIn(REQUEST, send.call_args.args[1])
        self.notify(self.config, self.state, reports, self.cycle(1040), {}, now=1040, send=send)
        self.assertEqual(send.call_count, 2)
        self.row['capacityUnknowns'] = {'status': 'alarm', 'truncated': True, 'requests': []}
        self.notify(self.config, self.state, reports, self.cycle(1060), {}, now=1060, send=send)
        signature = 'm3/monitor/' + REQUEST + '/model_indeterminate'
        self.assertIn(signature, self.state['notifications']['incidents'])
        self.row['capacityUnknowns'] = {'status': 'ok', 'truncated': False, 'requests': []}
        self.row.update(ok=True, reason='ok')
        self.notify(self.config, self.state, reports, self.cycle(1090), {}, now=1090, send=send)
        self.assertNotIn(signature, self.state['notifications']['incidents'])


if __name__ == '__main__':
    unittest.main()
