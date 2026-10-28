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


if __name__ == '__main__':
    unittest.main()
