"""CI-only independent discovery incidents with explicit per-source coverage."""
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


def envelope(covered=(), failures=()):
    return {'v': 1, 'covered': list(covered),
            'failures': [{'source': source, 'reason': reason} for source, reason in failures]}


class DiscoveryNotificationTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(OPS))
        self.addCleanup(lambda: sys.path.remove(str(OPS)))
        self.w, self.n = load('oracle_watchdog'), load('incident_notifications')
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'state.json'
        self.config = {'recover': True, 'hosts': {'m3': {'services': ['monitor']}}, 'state': str(self.path),
                       'incidentNotifications': {'botToken': '123456:' + 'a' * 30, 'chatId': '123456'}}
        self.row = {'key': 'monitor', 'version': 12, 'replicas': 1, 'settled': True,
                    'ok': False, 'recoverable': False, 'reason': 'pipeline_alarm'}
        self.state, self.messages, self.accept = {'targets': {}}, [], True

    def cycle(self, now, missing_host=False):
        reports = {'m3': None if missing_host else {'services': [self.row]}}
        result = self.w.cycle(self.config, self.state, reports, now=now,
                              recover=lambda *args: self.fail('discovery faults cannot authorize recovery'))

        def send(_, message):
            self.messages.append(message)
            return self.accept

        receipt = self.n.notify(self.config, self.state, reports, result, {}, now=now, send=send)
        self.state = json.loads(self.path.read_text())
        return result, receipt

    def fault(self, source='github-latest', reason='no_progress'):
        self.row['discoveryFailures'] = envelope([source], [(source, reason)])

    def events(self, result):
        return [row for row in result['events'] if row.get('stage', '').startswith('discovery-')]

    def incidents(self):
        return self.state['notifications']['incidents']

    def test_all_sources_have_independent_fixed_incidents_while_aggregate_already_down(self):
        self.cycle(1000)
        self.cycle(1030)
        sources = ['github-latest', 'github-full', 'show-hn', 'korean-query', 'korean-shared', 'korean-language', 'korean-apply']
        self.row['discoveryFailures'] = envelope(sources, [(source, 'no_progress') for source in sources])
        self.assertEqual(self.events(self.cycle(1060)[0]), [])
        result, receipt = self.cycle(1090)
        self.assertEqual(len(self.events(result)), 7)
        self.assertFalse(result['ok'])
        self.assertTrue(receipt['accepted'])
        self.assertNotIn('pipeline_alarm', self.messages[-1])
        for source in sources:
            self.assertIn('m3/monitor/discovery-' + source + '/no_progress', self.incidents())
        self.row['version'] += 1
        self.cycle(1120)
        self.assertEqual(len(self.messages), 2)
        self.assertEqual(self.state['targets']['m3/monitor']['attempts'], [])

    def test_empty_or_partial_coverage_and_legacy_reports_preserve_receipts_but_reset_unknown_counters(self):
        self.fault()
        self.cycle(1000)
        self.cycle(1030)
        signature = 'm3/monitor/discovery-github-latest/no_progress'
        for now, value in [(1060, envelope()), (1090, envelope(['show-hn'])), (1120, None)]:
            if value is None:
                self.row.pop('discoveryFailures')
            else:
                self.row['discoveryFailures'] = value
            self.cycle(now)
            self.assertIn(signature, self.incidents())
            self.assertNotIn('discoveryFailures', self.state['targets']['m3/monitor'])
        self.fault()
        self.assertEqual(self.events(self.cycle(1150)[0]), [])
        self.assertEqual(len(self.events(self.cycle(1180)[0])), 1)
        self.assertEqual(sum('discovery-github-latest' in message for message in self.messages), 1)

    def test_host_gap_long_gap_and_rollback_never_bridge_two_samples(self):
        self.fault()
        self.cycle(1000)
        self.cycle(1030, missing_host=True)
        self.assertEqual(self.events(self.cycle(1060)[0]), [])
        self.assertEqual(self.events(self.cycle(1300)[0]), [])
        self.assertEqual(self.events(self.cycle(1200)[0]), [])
        self.assertEqual(len(self.events(self.cycle(1230)[0])), 1)
        self.cycle(1260, missing_host=True)
        signature = 'm3/monitor/discovery-github-latest/no_progress'
        self.assertIn(signature, self.incidents())
        self.assertEqual(self.events(self.cycle(1290)[0]), [])

    def test_a_stale_service_row_cannot_supply_a_discovery_clear_or_fresh_sample(self):
        self.fault()
        self.cycle(1000)
        self.cycle(1030)
        self.row['reason'] = 'monitor_stale'
        self.row['discoveryFailures'] = envelope(['github-latest'])
        self.cycle(1060)
        self.assertIn('m3/monitor/discovery-github-latest/no_progress', self.incidents())
        self.assertNotIn('discoveryFailures', self.state['targets']['m3/monitor'])
        self.fault()
        self.assertEqual(self.events(self.cycle(1090)[0]), [])
        self.row['reason'] = 'pipeline_alarm'
        self.assertEqual(self.events(self.cycle(1120)[0]), [])
        self.assertEqual(len(self.events(self.cycle(1150)[0])), 1)

    def test_unknown_source_resets_only_its_counter_and_freshness_boundary_is_inclusive(self):
        self.row['discoveryFailures'] = envelope(['github-latest', 'show-hn'],
            [('github-latest', 'no_progress'), ('show-hn', 'worker_missing')])
        self.cycle(1000)
        self.fault('show-hn', 'worker_missing')
        self.assertEqual([event['stage'] for event in self.events(self.cycle(1150)[0])], ['discovery-show-hn'])
        self.row['discoveryFailures'] = envelope(['github-latest', 'show-hn'],
            [('github-latest', 'no_progress'), ('show-hn', 'worker_missing')])
        self.assertEqual([event['stage'] for event in self.events(self.cycle(1180)[0])], ['discovery-show-hn'])
        self.assertEqual(self.events(self.cycle(1331)[0]), [])
        self.assertEqual(len(self.events(self.cycle(1361)[0])), 2)

    def test_corrupt_nonfinite_or_future_stored_history_requires_two_new_samples(self):
        self.fault()
        for history in ['corrupt', None, [], {'at': float('nan'), 'reason': 'no_progress', 'bad': 2},
                        {'at': float('inf'), 'reason': 'no_progress', 'bad': 2},
                        {'at': 1001, 'reason': 'no_progress', 'bad': 2},
                        {'at': True, 'reason': 'no_progress', 'bad': 2},
                        {'at': 990, 'reason': 'no_progress', 'bad': True},
                        {'at': 990, 'reason': 'upstream_stalled', 'bad': 2}]:
            with self.subTest(history=history):
                self.state = {'targets': {'m3/monitor': {'at': 990, 'version': 12, 'bad': 0, 'attempts': [],
                    'discoveryFailures': {'github-latest': history}}}}
                self.assertEqual(self.events(self.cycle(1000)[0]), [])
                self.assertEqual(self.state['targets']['m3/monitor']['discoveryFailures']['github-latest'],
                                 {'at': 1000, 'reason': 'no_progress', 'bad': 1})

    def test_explicit_coverage_clears_only_its_source_and_reason_change_needs_two_samples(self):
        self.row['discoveryFailures'] = envelope(['github-latest', 'show-hn'],
            [('github-latest', 'no_progress'), ('show-hn', 'consumer_missing')])
        self.cycle(1000)
        self.cycle(1030)
        legacy = {'m3/monitor/progress-fetch/no_progress', 'm3/monitor/first/capacity_blocked',
                  'm3/monitor/tagline-ko/upstream_stalled'}
        for signature in legacy:
            self.incidents()[signature] = {'sent': True, 'firstSeen': 1000}
        self.row['discoveryFailures'] = envelope(['github-latest'])
        self.cycle(1060)
        self.assertTrue(legacy <= self.incidents().keys())
        self.assertIn('m3/monitor/discovery-show-hn/consumer_missing', self.incidents())
        self.assertNotIn('m3/monitor/discovery-github-latest/no_progress', self.incidents())
        self.fault('show-hn', 'upstream_stalled')
        self.assertEqual(self.events(self.cycle(1090)[0]), [])
        self.assertNotIn('m3/monitor/discovery-show-hn/consumer_missing', self.incidents())
        self.assertEqual(len(self.events(self.cycle(1120)[0])), 1)
        self.assertIn('m3/monitor/discovery-show-hn/upstream_stalled', self.incidents())

    def test_explicit_clear_allows_a_later_fault_to_alert_again_but_release_turnover_does_not(self):
        self.fault()
        self.cycle(1000)
        self.row['version'] += 1
        self.assertEqual(len(self.events(self.cycle(1030)[0])), 1)
        self.row['discoveryFailures'] = envelope(['github-latest'])
        self.cycle(1060)
        self.fault()
        self.assertEqual(self.events(self.cycle(1090)[0]), [])
        self.cycle(1120)
        self.assertEqual(sum('discovery-github-latest' in message for message in self.messages), 2)

    def test_failed_notification_ack_retries_without_erasing_durable_incident(self):
        self.fault('korean-language', 'worker_missing')
        self.accept = False
        self.cycle(1000)
        self.cycle(1030)
        signature = 'm3/monitor/discovery-korean-language/worker_missing'
        self.assertFalse(self.incidents()[signature]['sent'])
        self.row.pop('discoveryFailures')
        self.accept = True
        self.cycle(1060)
        self.assertTrue(self.incidents()[signature]['sent'])
        self.cycle(1090)
        self.assertEqual(sum('discovery-korean-language' in message for message in self.messages), 2)

    def test_invalid_envelopes_and_events_cannot_enter_state_or_clear_old_incidents(self):
        self.fault()
        self.cycle(1000)
        self.cycle(1030)
        signature = 'm3/monitor/discovery-github-latest/no_progress'
        valid = envelope(['github-latest'], [('github-latest', 'no_progress')])
        for value in [[], {**valid, 'v': True}, {**valid, 'covered': []},
                      {**valid, 'private': 'private-value'}, {**valid, 'covered': ['github-latest'] * 2}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.w.validate_report({'services': [{**self.row, 'discoveryFailures': value}]})
        self.row['discoveryFailures'] = []  # notifier independently refuses a malformed clear
        self.n.notify(self.config, self.state, {'m3': {'services': [self.row]}}, {'events': [
            {'target': 'm3/monitor', 'stage': 'discovery-private-value', 'reason': 'no_progress', 'bad': 2},
            {'target': 'm3/monitor', 'stage': 'discovery-show-hn', 'reason': 'private-value', 'bad': 2},
            {'target': 'm3/monitor', 'stage': 'discovery-show-hn', 'reason': 'no_progress', 'bad': True}]}, {}, now=1060,
            send=lambda *args: self.fail('invalid events cannot alert'))
        self.assertIn(signature, self.incidents())
        self.assertNotIn('private-value', json.dumps(self.state))


if __name__ == '__main__':
    unittest.main()
