"""Provider retries cannot reset Oracle's durable outage observation."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

OPS = Path(__file__).resolve().parents[1] / 'scripts' / 'ops'


class ProviderObservationTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(OPS))
        self.addCleanup(lambda: sys.path.remove(str(OPS)))
        spec = importlib.util.spec_from_file_location('oracle_watchdog', OPS / 'oracle_watchdog.py')
        self.w = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.w)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'state.json'
        self.config = {'recover': True, 'hosts': {'m3': {}}, 'state': str(self.path)}
        self.state = {'targets': {}}
        self.row = {'key': 'monitor', 'version': 12, 'replicas': 1, 'settled': True,
                    'ok': True, 'recoverable': False, 'reason': 'ok', 'providerFailures': ['tagline-ko']}
        self.recoveries = []

    def cycle(self, now):
        return self.w.cycle(self.config, self.state, {'m3': {'services': [self.row]}}, now=now,
                            recover=lambda *args: self.recoveries.append(args))

    def test_continuous_retries_alert_at_thirty_minutes_without_recovery(self):
        for now in range(1000, 2800, 30):
            self.assertTrue(self.cycle(now)['ok'])
        result = self.cycle(2800)
        self.assertFalse(result['ok'])
        self.assertIn({'target': 'm3/monitor', 'stage': 'tagline-ko', 'reason': 'upstream_stalled'}, result['events'])
        self.assertEqual(self.recoveries, [])

    def test_state_reload_and_release_change_preserve_continuous_outage(self):
        for now in range(1000, 1900, 30):
            self.cycle(now)
        self.state = json.loads(self.path.read_text())
        self.row['version'] += 1
        for now in range(1900, 2800, 30):
            self.assertTrue(self.cycle(now)['ok'])
        self.assertFalse(self.cycle(2800)['ok'])

    def test_success_pause_or_legacy_heartbeat_clears_observation(self):
        for now in range(1000, 2800, 30):
            self.cycle(now)
        self.row.pop('providerFailures')
        self.assertTrue(self.cycle(2800)['ok'])
        self.row['providerFailures'] = ['tagline-ko']
        self.assertTrue(self.cycle(2830)['ok'])

    def test_observation_gap_or_clock_rollback_restarts_duration(self):
        for now in range(1000, 2800, 30):
            self.cycle(now)
        self.assertTrue(self.cycle(3000)['ok'])
        self.assertTrue(self.cycle(2000)['ok'])
        self.assertEqual(self.recoveries, [])

    def test_each_stage_is_independent(self):
        for now in range(1000, 2800, 30):
            self.row['providerFailures'] = ['tagline-ko'] + (['intro-check'] if now >= 1900 else [])
            self.cycle(now)
        events = self.cycle(2800)['events']
        self.assertEqual([row.get('stage') for row in events if row['reason'] == 'upstream_stalled'], ['tagline-ko'])
        self.row['providerFailures'] = ['intro-check']
        self.assertTrue(self.cycle(2830)['ok'])

    def test_only_unique_fixed_stage_keys_are_accepted(self):
        for value in [['unknown'], ['tagline-ko', 'tagline-ko'], 'tagline-ko', [None], list(range(8))]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.w.validate_report({'services': [{**self.row, 'providerFailures': value}]})

    def test_corrupt_or_nonfinite_history_restarts_observation_without_crashing(self):
        for history in ['corrupt', [], None, {'first': float('nan'), 'last': 2770},
                        {'first': 1000, 'last': float('inf')}, {'first': 1000, 'last': 2801},
                        {'first': 2771, 'last': 2770}, {'first': True, 'last': 2770}]:
            with self.subTest(history=history):
                self.state = {'targets': {'m3/monitor': {'at': 2770, 'version': 12, 'bad': 0,
                              'attempts': [], 'providerFailures': {'tagline-ko': history}}}}
                self.assertTrue(self.cycle(2800)['ok'])
                self.assertEqual(self.state['targets']['m3/monitor']['providerFailures']['tagline-ko'],
                                 {'first': 2800, 'last': 2800})
                self.assertEqual(self.recoveries, [])


if __name__ == '__main__':
    unittest.main()
