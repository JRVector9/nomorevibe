import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

PATH = Path(__file__).resolve().parents[1] / 'scripts/ops/oracle_watchdog.py'


class WatchdogTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(PATH.exists(), 'independent Oracle watchdog must exist')
        sys.path.insert(0, str(PATH.parent))
        self.addCleanup(lambda: sys.path.remove(str(PATH.parent)))
        spec = importlib.util.spec_from_file_location('oracle_watchdog', PATH)
        self.w = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.w)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = {'targets': {}}
        self.config = {'recover': True, 'hosts': {'m3': {}}, 'state': str(Path(self.tmp.name) / 'state.json')}
        self.row = {'key': 'web', 'version': 12, 'replicas': 4, 'ok': False,
                    'recoverable': True, 'settled': True, 'reason': 'web_page_failed'}
        self.attempts = []

    def cycle(self, now=1000, **kwargs):
        return self.w.cycle(self.config, self.state, {'m3': {'services': [self.row]}}, now=now,
                            recover=lambda *args: self.attempts.append(args) or {'result': 'requested'}, **kwargs)

    def test_three_samples_then_persist_before_dispatch(self):
        self.cycle()
        self.cycle(1030)
        self.assertEqual(self.attempts, [])
        self.cycle(1060)
        self.assertEqual(self.attempts, [('m3', 'web', 12)])
        self.assertTrue(Path(self.config['state']).exists())
        self.assertEqual(self.state['targets']['m3/web']['attempts'], [1060])

    def test_no_recovery_for_pipeline_alarm_db_unknown_or_missing_host(self):
        self.row.update(recoverable=False, reason='pipeline_alarm')
        for now in [1000, 1030, 1060]:
            self.cycle(now)
        result = self.w.cycle(self.config, self.state, {'m3': None}, now=1090,
                              recover=lambda *args: self.attempts.append(args))
        self.assertFalse(result['ok'])
        self.assertEqual(self.attempts, [])

    def test_version_change_restarts_observation_and_recovery_limits_persist(self):
        self.cycle()
        self.cycle(1030)
        self.row['version'] = 13
        self.cycle(1060)
        self.assertEqual(self.attempts, [])
        self.cycle(1090)
        self.cycle(1120)
        self.assertEqual(len(self.attempts), 1)
        for now in [1150, 1180, 1210]:
            self.cycle(now)
        self.assertEqual(len(self.attempts), 1)

    def test_success_resets_streak_but_not_daily_attempts(self):
        for now in [1000, 1030, 1060]:
            self.cycle(now)
        self.row.update(ok=True, recoverable=False, reason='ok')
        result = self.cycle(1090)
        self.assertTrue(result['ok'])
        self.assertEqual(self.state['targets']['m3/web']['bad'], 0)
        self.assertEqual(self.state['targets']['m3/web']['attempts'], [1060])

    def test_observation_gap_does_not_count_as_consecutive_failure(self):
        self.cycle()
        self.cycle(1030)
        self.cycle(2000)
        self.assertEqual(self.attempts, [])

    def test_native_consumer_failure_requires_three_verified_samples(self):
        self.row.update(key='agent-scan', replicas=1, reason='native_unit_failed')
        self.cycle()
        self.cycle(1030)
        self.assertEqual(self.attempts, [])
        self.cycle(1060)
        self.assertEqual(self.attempts, [('m3', 'agent-scan', 12)])

    def test_inactive_or_unknown_native_unit_is_alarm_only(self):
        for reason in ('native_unit_inactive', 'native_unit_unknown'):
            self.state = {'targets': {}}
            self.row.update(key='agent-scan', reason=reason, recoverable=False)
            for now in (1000, 1030, 1060):
                result = self.cycle(now)
            self.assertFalse(result['ok'])
        self.assertEqual(self.attempts, [])

    def test_nonactionable_alarm_does_not_count_toward_recovery(self):
        self.row.update(recoverable=False, reason='pipeline_alarm')
        self.cycle()
        self.cycle(1030)
        self.row.update(recoverable=True, reason='monitor_stale')
        self.cycle(1060)
        self.assertEqual(self.attempts, [])

    def test_shadow_mode_and_invalid_response_never_mutate(self):
        self.config['recover'] = False
        for now in [1000, 1030, 1060]:
            self.cycle(now)
        self.assertEqual(self.attempts, [])
        for report in [{'services': []}, {'services': [self.row, self.row]}, {'services': 'bad'}]:
            with self.assertRaises(ValueError):
                self.w.validate_report(report)


if __name__ == '__main__':
    unittest.main()
