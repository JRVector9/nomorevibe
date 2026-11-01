"""Monitor heartbeat compatibility and fixed provider metadata at the SSH boundary."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ProviderProbeTests(unittest.TestCase):
    def setUp(self):
        self.gateway = load('recovery_gateway_provider', ROOT / 'scripts/ops/recovery_gateway.py')
        self.fixtures = load('recovery_provider_fixtures', ROOT / 'tests/test_recovery_observation.py')

    @unittest.skipUnless(shutil.which('node'), 'Node is needed to execute the actual in-container probe')
    def test_actual_node_probe_preserves_legacy_and_sanitizes_provider_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = Path(directory) / 'health.json'
            for extra, expected in [({}, {}), ({'providerFailures': []}, {'providerFailures': []}),
                                    ({'providerFailures': 'private-token'}, {}),
                                    ({'providerFailures': ['keywords', 'keywords', 'private-token', {'secret': 'value'}]},
                                     {'providerFailures': ['keywords']})]:
                with self.subTest(extra=extra):
                    heartbeat.write_text(json.dumps({'checkedAt': int(time.time() * 1000), 'overall': 'ok', **extra}))
                    result = subprocess.run(['node', '-e', self.gateway.MONITOR_PROBE], check=True, timeout=10,
                                            capture_output=True, env={**os.environ, 'MONITOR_HEALTH_PATH': str(heartbeat)})
                    self.assertEqual(json.loads(result.stdout), {'fresh': True, 'overall': 'ok', **expected})
                    self.assertNotIn(b'private-token', result.stdout)

    def test_only_fresh_monitor_replica_provider_signals_cross_the_boundary(self):
        fixture = self.fixtures.DockerFixture(self.gateway, kind='monitor')
        fixture.monitor[self.fixtures.IDS[0]]['providerFailures'] = ['keywords', 'private-token', 'keywords']
        fixture.monitor[self.fixtures.IDS[1]]['providerFailures'] = ['intro-check']
        row = fixture.observe()
        self.assertEqual(row['providerFailures'], ['intro-check', 'keywords'])
        self.assertTrue(row['ok'])
        self.assertFalse(row['recoverable'])
        fixture.monitor[self.fixtures.IDS[1]]['fresh'] = False
        row = fixture.observe()
        self.assertEqual(row['reason'], 'monitor_stale')
        self.assertNotIn('providerFailures', row)

    def test_legacy_and_empty_heartbeat_do_not_invent_an_outage(self):
        fixture = self.fixtures.DockerFixture(self.gateway, kind='monitor')
        self.assertNotIn('providerFailures', fixture.observe())
        for check in fixture.monitor.values():
            check['providerFailures'] = []
        self.assertEqual(fixture.observe().get('providerFailures'), [])
        # A legacy replica cannot turn missing metadata into a confirmed recovery.
        fixture.monitor[self.fixtures.IDS[1]].pop('providerFailures')
        self.assertNotIn('providerFailures', fixture.observe())

    @unittest.skipUnless(shutil.which('node'), 'Node is needed to execute the actual in-container probe')
    def test_review_probe_keeps_only_complete_fixed_observations(self):
        valid = [{'stage': 'first', 'reason': 'capacity_blocked'}, {'stage': 'second', 'reason': 'local_stalled'}]
        values = [(valid, valid), ([], []), ('private-token', None),
                  ([{'stage': 'first', 'reason': 'private-token'}], None),
                  ([{'stage': 'first', 'reason': 'capacity_blocked', 'secret': 'private-token'}], None),
                  ([valid[0], valid[0]], None), ([None], None)]
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = Path(directory) / 'health.json'
            for value, expected in values:
                with self.subTest(value=value):
                    heartbeat.write_text(json.dumps({'checkedAt': int(time.time() * 1000), 'overall': 'alarm', 'reviewFailures': value}))
                    result = subprocess.run(['node', '-e', self.gateway.MONITOR_PROBE], check=True, timeout=10,
                                            capture_output=True, env={**os.environ, 'MONITOR_HEALTH_PATH': str(heartbeat)})
                    report = json.loads(result.stdout)
                    if expected is None:
                        self.assertNotIn('reviewFailures', report)
                    else:
                        self.assertEqual(report['reviewFailures'], expected)
                    self.assertNotIn(b'private-token', result.stdout)

    def test_review_metadata_requires_all_fresh_replicas_and_never_grants_recovery(self):
        fixture = self.fixtures.DockerFixture(self.gateway, kind='monitor')
        failure = {'stage': 'first', 'reason': 'capacity_blocked'}
        for check in fixture.monitor.values():
            check['reviewFailures'] = [failure]
        row = fixture.observe()
        self.assertEqual(row['reviewFailures'], [failure])
        self.assertFalse(row['recoverable'])
        fixture.monitor[self.fixtures.IDS[1]]['reviewFailures'] = [{'stage': 'first', 'reason': 'local_stalled'}]
        self.assertNotIn('reviewFailures', fixture.observe())
        fixture.monitor[self.fixtures.IDS[1]].pop('reviewFailures')
        self.assertNotIn('reviewFailures', fixture.observe())
        for check in fixture.monitor.values():
            check['reviewFailures'] = []
        self.assertEqual(fixture.observe()['reviewFailures'], [])
        fixture.monitor[self.fixtures.IDS[0]]['fresh'] = False
        self.assertNotIn('reviewFailures', fixture.observe())


class StageProbeTests(unittest.TestCase):
    def setUp(self):
        self.gateway = load('recovery_gateway_stages', ROOT / 'scripts/ops/recovery_gateway.py')
        self.fixtures = load('recovery_stage_fixtures', ROOT / 'tests/test_recovery_observation.py')

    @unittest.skipUnless(shutil.which('node'), 'Node is needed to execute the actual in-container probe')
    def test_actual_probe_preserves_legacy_and_only_complete_fixed_stage_metadata(self):
        all_stages = [{'stage': stage, 'reason': sorted(reasons)[0]}
                      for stage, reasons in self.gateway.STAGE_FAILURE_REASONS.items()]
        valid = {'stage': 'publish', 'reason': 'no_progress'}
        values = [(None, None), ([], []), (all_stages, all_stages), ([valid], [valid]),
                  ('private-token', None), ([valid, valid], None), ([None], None),
                  ([{'stage': 'first', 'reason': 'no_progress'}], None),
                  ([{'stage': 'private-token', 'reason': 'no_progress'}], None),
                  ([{'stage': 'scheduler', 'reason': 'no_progress'}], None),
                  ([{**valid, 'body': 'private-token'}], None)]
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = Path(directory) / 'health.json'
            for value, expected in values:
                with self.subTest(value=value):
                    payload = {'checkedAt': int(time.time() * 1000), 'overall': 'alarm'}
                    if value is not None:
                        payload['stageFailures'] = value
                    heartbeat.write_text(json.dumps(payload))
                    result = subprocess.run(['node', '-e', self.gateway.MONITOR_PROBE], check=True, timeout=10,
                                            capture_output=True, env={**os.environ, 'MONITOR_HEALTH_PATH': str(heartbeat)})
                    report = json.loads(result.stdout)
                    if expected is None:
                        self.assertNotIn('stageFailures', report)
                    else:
                        self.assertEqual(report['stageFailures'], expected)
                    self.assertNotIn(b'private-token', result.stdout)

    def test_only_complete_fresh_nonconflicting_replica_metadata_can_clear(self):
        fixture = self.fixtures.DockerFixture(self.gateway, kind='monitor')
        first, second = [fixture.monitor[cid] for cid in self.fixtures.IDS]
        fault = {'stage': 'fetch', 'reason': 'no_progress'}
        first['stageFailures'] = [fault]
        self.assertNotIn('stageFailures', fixture.observe())  # old second replica
        second['stageFailures'] = []
        row = fixture.observe()
        self.assertEqual(row['stageFailures'], [fault])
        self.assertFalse(row['recoverable'])
        second['stageFailures'] = [{'stage': 'fetch', 'reason': 'worker_missing'}]
        self.assertNotIn('stageFailures', fixture.observe())
        second['stageFailures'] = [{'stage': 'publish', 'reason': 'worker_missing'}]
        self.assertEqual(fixture.observe()['stageFailures'], [fault, second['stageFailures'][0]])
        second['fresh'] = False
        self.assertNotIn('stageFailures', fixture.observe())
        second['fresh'] = True
        first['stageFailures'] = second['stageFailures'] = []
        self.assertEqual(fixture.observe()['stageFailures'], [])


class CapacityProbeTests(unittest.TestCase):
    """2026-10-31: review (확인 못함 · 사람 검토) passes through as information; only a summarized alarm/unread ledger fails the row."""
    def setUp(self):
        self.gateway = load('recovery_gateway_capacity', ROOT / 'scripts/ops/recovery_gateway.py')
        self.fixtures = load('recovery_capacity_fixtures', ROOT / 'tests/test_recovery_observation.py')
        self.request = {'requestId': '00000000-0000-4000-8000-000000000001', 'routeId': 'product-translate',
                        'groupId': 'm1-mlx', 'oldPolicy': True, 'localEndRecorded': True}
        self.review = {'status': 'review', 'truncated': False, 'requests': [self.request], 'count': 1,
                       'oldestAgeSeconds': 7200, 'stuckDispatched': 0, 'alarmReasons': []}
        self.alarm = {**self.review, 'status': 'alarm', 'count': 51, 'alarmReasons': ['review_backlog']}
        self.legacy = {'status': 'alarm', 'truncated': False, 'requests': [self.request]}
        self.empty = {'status': 'ok', 'truncated': False, 'requests': [], 'count': 0, 'oldestAgeSeconds': None,
                      'stuckDispatched': 0, 'alarmReasons': []}
        self.unknown = {'status': 'unknown', 'truncated': False, 'requests': []}

    @unittest.skipUnless(shutil.which('node'), 'Node is needed for the actual probe')
    def test_actual_node_probe_carries_only_bounded_allowlisted_request_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = Path(directory) / 'health.json'
            for value, expected in [(self.review, self.review), (self.alarm, self.alarm), (self.legacy, self.legacy),
                                    (self.empty, self.empty),
                                    ({**self.review, 'note': 'private-token', 'requests': [{**self.request, 'token': 'private-token'}]}, self.review),
                                    ({**self.review, 'requests': [{'requestId': 'private-token'}]}, self.unknown),
                                    ({**self.review, 'count': 'private-token'}, self.unknown),
                                    ({**self.alarm, 'alarmReasons': ['private-token']}, self.unknown),
                                    ({**self.legacy, 'status': 'ok'}, self.unknown)]:
                with self.subTest(value=value):
                    heartbeat.write_text(json.dumps({'checkedAt': int(time.time() * 1000), 'overall': 'ok', 'capacityUnknowns': value}))
                    result = subprocess.run(['node', '-e', self.gateway.MONITOR_PROBE], check=True, timeout=10,
                                            capture_output=True, env={**os.environ, 'MONITOR_HEALTH_PATH': str(heartbeat)})
                    self.assertEqual(json.loads(result.stdout)['capacityUnknowns'], expected)
                    self.assertNotIn(b'private-token', result.stdout)

    def observe(self, *values, overall='ok'):
        fixture = self.fixtures.DockerFixture(self.gateway, kind='monitor')
        for cid, value in zip(self.fixtures.IDS, values):
            fixture.monitor[cid]['overall'] = overall
            if value is not None:
                fixture.monitor[cid]['capacityUnknowns'] = value
        return fixture.observe()

    def test_review_queue_is_informational_and_keeps_a_healthy_monitor_ok(self):
        row = self.observe(self.review, self.review)
        self.assertEqual(row['capacityUnknowns'], self.review)
        self.assertEqual((row['reason'], row['ok'], row['recoverable']), ('ok', True, False))

    def test_summarized_alarm_or_unread_ledger_fails_the_row_without_recovery(self):
        for values in [(self.alarm, self.review), (self.unknown, self.empty), (self.empty, None),
                       ({**self.review, 'count': 0}, self.empty)]:  # contradictory summary is unread, never a clear
            with self.subTest(values=values):
                row = self.observe(*values)
                self.assertEqual((row['reason'], row['ok'], row['recoverable']), ('pipeline_alarm', False, False))
                self.assertTrue(self.gateway.capacity_alarm(row['capacityUnknowns']))
        self.assertEqual(self.observe(self.alarm, self.review)['capacityUnknowns'],
                         {**self.alarm, 'alarmReasons': ['review_backlog']})
        self.assertEqual(self.observe(self.empty, None)['capacityUnknowns'], self.unknown)
        self.assertEqual(self.observe(self.empty, self.empty)['capacityUnknowns'], self.empty)

    def test_pre_upgrade_monitor_alarm_is_read_as_review_and_its_own_overall_still_decides_the_row(self):
        row = self.observe(self.legacy, self.legacy, overall='alarm')
        self.assertEqual(row['capacityUnknowns'], {**self.legacy, 'status': 'review'})
        self.assertFalse(self.gateway.capacity_alarm(row['capacityUnknowns']))
        self.assertEqual(row['reason'], 'pipeline_alarm')  # old monitor still reports overall=alarm until it is redeployed
        self.assertEqual(self.observe(self.legacy, self.legacy)['reason'], 'ok')

    def test_partial_replica_review_or_alarm_never_becomes_an_explicit_summary_clear(self):
        for values in [(self.review, None), (self.review, self.unknown), (self.legacy, None),
                       (self.alarm, None), (self.alarm, self.unknown)]:
            with self.subTest(values=values):
                row = self.observe(*values)
                self.assertEqual(row['capacityUnknowns'], self.unknown)
                self.assertEqual((row['reason'], row['ok'], row['recoverable']),
                                 ('pipeline_alarm', False, False))
                self.assertNotIn('alarmReasons', row['capacityUnknowns'])

    def test_merge_keeps_every_alarm_reason_and_the_largest_backlog(self):
        other = {**self.review, 'requests': [{**self.request, 'requestId': '00000000-0000-4000-8000-000000000002'}],
                 'stuckDispatched': 2, 'alarmReasons': ['dispatch_stuck'], 'status': 'alarm', 'oldestAgeSeconds': 90000}
        merged = self.gateway.merge_capacity_unknowns([self.alarm, other], True)
        self.assertEqual(merged['status'], 'alarm')
        self.assertEqual(merged['alarmReasons'], ['dispatch_stuck', 'review_backlog'])
        self.assertEqual((merged['count'], merged['oldestAgeSeconds'], merged['stuckDispatched'], len(merged['requests'])), (51, 90000, 2, 2))
        mixed = self.gateway.merge_capacity_unknowns([self.legacy, self.review], True)
        self.assertEqual(mixed, {'status': 'review', 'truncated': False, 'requests': [self.request]})


if __name__ == '__main__':
    unittest.main()
