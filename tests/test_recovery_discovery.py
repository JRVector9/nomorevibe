"""CI-only discovery transport regressions; no Docker, SSH, DB or network fixture."""
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

OPS = Path(__file__).resolve().parents[1] / 'scripts' / 'ops'


def envelope(covered=(), failures=()):
    return {'v': 1, 'covered': list(covered),
            'failures': [{'source': source, 'reason': reason} for source, reason in failures]}


class DiscoveryTransportTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('discovery_gateway_fixture', OPS / 'recovery_gateway.py')
        self.g = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.g)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'health.json'

    def probe(self, value):
        node = shutil.which('node')
        self.assertIsNotNone(node, 'CI must supply Node for the embedded read-only probe')
        self.path.write_text(json.dumps({'checkedAt': 1_000_000, 'overall': 'ok', 'discoveryFailures': value}))
        result = subprocess.run([node, '-e', 'Date.now=()=>1000000;\n' + self.g.MONITOR_PROBE],
                                env={'MONITOR_HEALTH_PATH': str(self.path)}, capture_output=True, text=True,
                                timeout=10, check=True)
        return json.loads(result.stdout)

    def invalid(self):
        source, reason = 'github-latest', 'no_progress'
        good = envelope([source], [(source, reason)])
        return [[], None, 'private-value', {}, {**good, 'v': True}, {**good, 'v': 2},
                {**good, 'private': 'private-value'}, {**good, 'covered': source},
                {**good, 'covered': [source, source]}, {**good, 'covered': [source] * 8},
                {**good, 'covered': [None]}, {**good, 'covered': ['private-value']},
                {**good, 'failures': 'private-value'}, {**good, 'failures': [None]},
                {**good, 'failures': good['failures'] * 2},
                {**good, 'failures': [{'source': source, 'reason': 'private-value'}]},
                {**good, 'failures': [{'source': 'show-hn', 'reason': reason}]},
                {**good, 'failures': [{**good['failures'][0], 'private': 'private-value'}]}]

    def test_fixed_schema_accepts_partial_and_empty_coverage_but_never_an_empty_list(self):
        self.assertTrue(self.g.valid_discovery_failures(envelope()))
        self.assertTrue(self.g.valid_discovery_failures(envelope(sorted(self.g.DISCOVERY_SOURCES))))
        for value in self.invalid():
            with self.subTest(value=value):
                self.assertFalse(self.g.valid_discovery_failures(value))

    def test_embedded_probe_preserves_only_strict_valid_envelopes_in_canonical_order(self):
        value = envelope(['show-hn', 'github-latest'], [('show-hn', 'upstream_stalled'), ('github-latest', 'no_progress')])
        self.assertEqual(self.probe(value), {'fresh': True, 'overall': 'ok', 'discoveryFailures':
            envelope(['github-latest', 'show-hn'], [('github-latest', 'no_progress'), ('show-hn', 'upstream_stalled')])})
        self.assertEqual(self.probe(envelope())['discoveryFailures'], envelope())
        for value in self.invalid():
            with self.subTest(value=value):
                result = self.probe(value)
                self.assertNotIn('discoveryFailures', result)
                self.assertTrue(result['fresh'])
                self.assertNotIn('private-value', json.dumps(result))

    def test_merge_intersects_coverage_and_unions_faults_without_false_clear(self):
        first = envelope(['github-latest', 'show-hn'], [('github-latest', 'no_progress')])
        second = envelope(['github-latest', 'korean-apply'])
        self.assertEqual(self.g.merge_discovery_failures([first, second]),
                         envelope(['github-latest'], [('github-latest', 'no_progress')]))
        self.assertEqual(self.g.merge_discovery_failures([second, first]),
                         self.g.merge_discovery_failures([first, second]))
        self.assertEqual(self.g.merge_discovery_failures([first, envelope()]), envelope())
        self.assertEqual(self.g.merge_discovery_failures([first, None]), envelope())
        self.assertEqual(self.g.merge_discovery_failures([first, []]), envelope())

    def test_conflicting_reasons_remove_only_that_source_from_coverage(self):
        first = envelope(['github-latest', 'show-hn'], [('github-latest', 'no_progress'), ('show-hn', 'worker_missing')])
        second = envelope(['github-latest', 'show-hn'], [('github-latest', 'upstream_stalled')])
        self.assertEqual(self.g.merge_discovery_failures([first, second]),
                         envelope(['show-hn'], [('show-hn', 'worker_missing')]))

    def observe(self, checks):
        ids = ['a' * 12, 'b' * 12][:len(checks)]
        service = {'ID': 'fixed-monitor', 'Version': {'Index': 12}, 'UpdatedAt': '1970-01-01T00:00:01Z',
                   'Spec': {'Mode': {'Replicated': {'Replicas': len(ids)}}}}
        containers = [{'Id': cid + '0' * 52, 'State': {'StartedAt': '1970-01-01T00:00:01Z',
                       'Health': {'Status': 'healthy'}}} for cid in ids]

        def run(argv):
            if argv[:3] == ['docker', 'service', 'inspect']:
                return json.dumps([service])
            if argv[:2] == ['docker', 'ps']:
                return '\n'.join(ids)
            if argv[:2] == ['docker', 'inspect']:
                return json.dumps(containers)
            if argv[:2] == ['docker', 'exec']:
                self.assertEqual(argv[3:], ['node', '-e', self.g.MONITOR_PROBE])
                return json.dumps(checks[ids.index(argv[2])])
            self.fail('unexpected command')

        return self.g.observe('monitor', {'service': 'fixed-monitor', 'kind': 'monitor', 'replicas': len(ids)}, run=run, now=1000)

    def test_old_missing_or_stale_replica_never_supplies_discovery_clear_or_recovery_authority(self):
        fault = envelope(['github-latest'], [('github-latest', 'no_progress')])
        fresh = {'fresh': True, 'overall': 'ok', 'discoveryFailures': fault}
        row = self.observe([fresh, {'fresh': True, 'overall': 'ok'}])
        self.assertEqual(row['discoveryFailures'], envelope())
        self.assertFalse(row['recoverable'])
        self.assertNotIn('discoveryFailures', self.observe([{'fresh': True, 'overall': 'ok'}]))
        row = self.observe([fresh, {'fresh': False, 'overall': 'ok', 'discoveryFailures': envelope(['github-latest'])}])
        self.assertEqual(row['reason'], 'monitor_stale')
        self.assertNotIn('discoveryFailures', row)
        self.assertTrue(row['recoverable'])  # existing stale-monitor policy, not a discovery grant
        row = self.observe([fresh])
        self.assertEqual(row['discoveryFailures'], fault)
        self.assertFalse(row['recoverable'])


if __name__ == '__main__':
    unittest.main()
