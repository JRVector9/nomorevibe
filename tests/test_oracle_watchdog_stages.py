"""Uncovered stage faults have independent durable receipts, without recovery authority."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

OPS = Path(__file__).resolve().parents[1] / 'scripts' / 'ops'


def load(name):
    spec = importlib.util.spec_from_file_location(name, OPS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StageNotificationTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(OPS))
        self.addCleanup(lambda: sys.path.remove(str(OPS)))
        self.w = load('oracle_watchdog')
        self.n = load('incident_notifications')
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'state.json'
        self.config = {'recover': True, 'hosts': {'m3': {'services': ['monitor']}}, 'state': str(self.path),
                       'incidentNotifications': {'botToken': '123456:' + 'a' * 30, 'chatId': '123456'}}
        self.row = {'key': 'monitor', 'version': 12, 'replicas': 1, 'settled': True,
                    'ok': False, 'recoverable': False, 'reason': 'pipeline_alarm', 'stageFailures': []}
        self.state = {'targets': {}}
        self.messages = []

    def cycle(self, now, *, missing_host=False):
        reports = {'m3': None if missing_host else {'services': [self.row]}}
        result = self.w.cycle(self.config, self.state, reports, now=now,
                              recover=lambda *args: self.fail('stage observations cannot authorize recovery'))
        receipt = self.n.notify(self.config, self.state, reports, result, {}, now=now,
                                send=lambda _, message: self.messages.append(message) or True)
        self.state = json.loads(self.path.read_text())
        return result, receipt

    def stage_events(self, result):
        return [event for event in result['events'] if event.get('stage', '').startswith('progress-')]

    def incidents(self):
        return self.state['notifications']['incidents']

    def test_new_stage_alerts_while_aggregate_is_down_and_receipts_survive_restart(self):
        self.cycle(1000)
        self.cycle(1030)
        self.assertEqual(len(self.messages), 1)
        self.row['stageFailures'] = [{'stage': 'fetch', 'reason': 'no_progress'}]
        self.assertEqual(self.stage_events(self.cycle(1060)[0]), [])
        result, receipt = self.cycle(1090)
        self.assertFalse(result['ok'])
        self.assertTrue(receipt['accepted'])
        self.assertIn('m3/monitor/fetch no_progress', self.messages[-1])
        self.assertNotIn('pipeline_alarm', self.messages[-1])
        self.assertIn('m3/monitor/progress-fetch/no_progress', self.incidents())
        self.row['stageFailures'].append({'stage': 'publish', 'reason': 'worker_missing'})
        self.cycle(1120)
        self.cycle(1150)
        self.assertEqual(len(self.messages), 3)
        self.assertIn('m3/monitor/publish worker_missing', self.messages[-1])
        self.assertNotIn('fetch', self.messages[-1])
        self.row['version'] += 1
        self.cycle(1180)
        self.assertEqual(len(self.messages), 3)
        self.assertEqual(self.state['targets']['m3/monitor']['attempts'], [])

    def test_missing_metadata_resets_fresh_samples_but_never_clears_an_incident(self):
        fault = [{'stage': 'intro-check', 'reason': 'no_progress'}]
        self.row['stageFailures'] = fault
        self.cycle(1000)
        self.row.pop('stageFailures')
        self.cycle(1030)
        self.row['stageFailures'] = fault
        self.assertEqual(self.stage_events(self.cycle(1060)[0]), [])
        self.assertEqual(len(self.stage_events(self.cycle(1090)[0])), 1)
        signature = 'm3/monitor/progress-intro-check/no_progress'
        self.row.pop('stageFailures')
        self.cycle(1120)
        self.assertIn(signature, self.incidents())
        self.assertNotIn('stageFailures', self.state['targets']['m3/monitor'])
        self.row['stageFailures'] = fault
        self.assertEqual(self.stage_events(self.cycle(1150)[0]), [])
        self.cycle(1180)
        self.assertEqual(sum('/intro-check no_progress' in message for message in self.messages), 1)

    def test_a_missing_host_does_not_bridge_consecutive_samples_or_clear_receipts(self):
        self.row['stageFailures'] = [{'stage': 'role-text', 'reason': 'restart_loop'}]
        self.cycle(1000)
        self.cycle(1030, missing_host=True)
        self.assertEqual(self.stage_events(self.cycle(1060)[0]), [])
        self.assertEqual(len(self.stage_events(self.cycle(1090)[0])), 1)
        signature = 'm3/monitor/progress-role-text/restart_loop'
        self.cycle(1120, missing_host=True)
        self.assertIn(signature, self.incidents())
        self.assertEqual(self.stage_events(self.cycle(1150)[0]), [])

    def test_changed_reason_gap_and_clock_rollback_require_two_new_observations(self):
        self.row['stageFailures'] = [{'stage': 'publish', 'reason': 'no_progress'}]
        self.cycle(1000)
        self.cycle(1030)
        self.row['stageFailures'] = [{'stage': 'publish', 'reason': 'worker_missing'}]
        self.assertEqual(self.stage_events(self.cycle(1060)[0]), [])
        self.assertNotIn('m3/monitor/progress-publish/no_progress', self.incidents())
        self.assertEqual(self.stage_events(self.cycle(1300)[0]), [])
        self.assertEqual(self.stage_events(self.cycle(1200)[0]), [])
        self.assertEqual(len(self.stage_events(self.cycle(1230)[0])), 1)

    def test_explicit_empty_clears_only_generic_namespace_and_allows_a_later_alert(self):
        self.row['stageFailures'] = [{'stage': 'tagline-ko', 'reason': 'no_progress'}]
        self.cycle(1000)
        self.cycle(1030)
        legacy = {'m3/monitor/tagline-ko/upstream_stalled', 'm3/monitor/first/capacity_blocked'}
        for signature in legacy:
            self.incidents()[signature] = {'sent': True, 'firstSeen': 1000}
        self.row['stageFailures'] = []
        self.cycle(1060)
        self.assertTrue(legacy <= self.incidents().keys())
        self.assertNotIn('m3/monitor/progress-tagline-ko/no_progress', self.incidents())
        self.row['stageFailures'] = [{'stage': 'tagline-ko', 'reason': 'no_progress'}]
        self.cycle(1090)
        self.cycle(1120)
        self.assertEqual(sum('/tagline-ko no_progress' in message for message in self.messages), 2)

    def test_legacy_report_and_empty_metadata_remain_compatible(self):
        self.row.pop('stageFailures')
        self.w.validate_report({'services': [self.row]})
        self.cycle(1000)
        self.row['stageFailures'] = []
        self.w.validate_report({'services': [self.row]})
        self.assertEqual(self.stage_events(self.cycle(1030)[0]), [])

    def test_fixed_schema_refuses_duplicates_private_fields_and_uncovered_stages(self):
        valid = {'stage': 'fetch', 'reason': 'no_progress'}
        for value in ['private-token', [valid, valid], [None],
                      [{'stage': 'first', 'reason': 'no_progress'}],
                      [{'stage': 'private-token', 'reason': 'no_progress'}],
                      [{'stage': 'fetch', 'reason': 'private-token'}],
                      [{'stage': 'scheduler', 'reason': 'no_progress'}],
                      [{**valid, 'body': 'private-token'}]]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.w.validate_report({'services': [{**self.row, 'stageFailures': value}]})


if __name__ == '__main__':
    unittest.main()
