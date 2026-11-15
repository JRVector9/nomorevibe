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

    def fleet_cycle(self, now, web_reason, native=None):
        """m3 web row (its /api/health DB probe) + an osaka native consumer row in one cycle."""
        self.config['hosts'] = {'m3': {}, 'osaka': {}}
        web = {'key': 'web-m3', 'version': 5, 'replicas': 1, 'ok': web_reason == 'ok', 'recoverable': False,
               'settled': True, 'reason': web_reason}
        native = native or {'key': 'github-ko-discovery', 'version': 77, 'replicas': 1, 'ok': False, 'recoverable': True,
                            'settled': True, 'reason': 'native_unit_failed'}
        return self.w.cycle(self.config, self.state, {'m3': {'services': [web]}, 'osaka': {'services': [native]}}, now=now,
                            recover=lambda *args: self.attempts.append(args) or {'result': 'requested'})

    def test_native_recovery_waits_while_the_fleet_shows_the_database_down_without_spending_budget(self):
        # 2026-11-15: both daily attempts were spent at 03:21Z and 07:19Z while the DB was still down.
        results = [self.fleet_cycle(now, 'database_unavailable') for now in (1000, 1030, 1060, 1090)]
        self.assertEqual(self.attempts, [])
        self.assertEqual(self.state['targets']['osaka/github-ko-discovery']['attempts'], [])
        self.assertIn({'target': 'osaka/github-ko-discovery', 'recovery': 'deferred', 'cause': 'database_unavailable'},
                      results[-1]['events'])
        # The web probe flips to web_not_ready/warming_up mid-outage: still held for DATABASE_SETTLE_SECONDS.
        self.fleet_cycle(1120, 'web_not_ready')
        self.fleet_cycle(1240, 'ok')
        self.assertEqual(self.attempts, [])
        # Three minutes after the last database_unavailable the recovery runs, once, under the usual budget.
        result = self.fleet_cycle(1270, 'ok')
        self.assertEqual(self.attempts, [('osaka', 'github-ko-discovery', 77)])
        self.assertEqual(self.state['targets']['osaka/github-ko-discovery']['attempts'], [1270])
        self.assertIn({'target': 'osaka/github-ko-discovery', 'recovery': 'requested'}, result['events'])
        self.assertNotIn('database', self.state)
        self.fleet_cycle(1300, 'ok')
        self.assertEqual(len(self.attempts), 1)

    def test_database_hold_only_delays_database_dependent_recovery_and_needs_evidence(self):
        monitor = {'key': 'monitor-m3', 'version': 9, 'replicas': 1, 'ok': False, 'recoverable': True, 'settled': True,
                   'reason': 'monitor_stale'}
        for now in (1000, 1030, 1060):
            self.fleet_cycle(now, 'database_unavailable', native=monitor)
        self.assertEqual(self.attempts, [('osaka', 'monitor-m3', 9)])
        # No DB evidence at all (an unreadable host) is not "DB down": the native recovery proceeds as before.
        self.attempts.clear()
        self.state = {'targets': {}}
        self.config['hosts'] = {'m3': {}, 'osaka': {}}
        native = {'key': 'agent-scan', 'version': 7, 'replicas': 1, 'ok': False, 'recoverable': True, 'settled': True,
                  'reason': 'native_unit_failed'}
        for now in (1000, 1030, 1060):
            self.w.cycle(self.config, self.state, {'m3': None, 'osaka': {'services': [native]}}, now=now,
                         recover=lambda *args: self.attempts.append(args) or {'result': 'requested'})
        self.assertEqual(self.attempts, [('osaka', 'agent-scan', 7)])
        # A future or corrupt stored hold never delays forever.
        for value in ({'unavailableAt': 10 ** 12}, {'unavailableAt': float('nan')}, 'x'):
            state = {'targets': {}, 'database': value}
            self.assertFalse(self.w.database_hold(state, {}, 2000))
            self.assertNotIn('database', state)

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

    def test_invalid_recovery_history_cannot_open_a_fresh_mutation_budget(self):
        for attempts in [[-1], [2000], [float('nan')], [True], 'invalid']:
            with self.subTest(attempts=attempts):
                self.state = {'targets': {'m3/web': {'at': 970, 'version': 12, 'bad': 2,
                              'actionable': 2, 'reason': 'web_page_failed', 'attempts': attempts}}}
                for now in [1000, 1030, 1060]:
                    self.cycle(now)
                self.assertEqual(self.attempts, [])
                self.assertEqual(self.state['targets']['m3/web']['attempts'], [1000, 1000])


if __name__ == '__main__':
    unittest.main()
