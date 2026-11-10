"""2026-10-31: unknown-outcome model calls are a human review list, not an Oracle incident.

Owner decision 2026-10-30: an `indeterminate` call never stops work; it only goes to "확인 못함 — 사람 검토" (/admin/models).
Oracle relays the monitor's review summary as information and pages only for the monitor's summarized alarm reasons
(review backlog/stale over its thresholds, or an occupying dispatched row past its bound). No model/DB authority.
"""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock

OPS = Path(__file__).resolve().parents[1] / 'scripts' / 'ops'
REQUEST = '00000000-0000-4000-8000-000000000001'
OTHER = '00000000-0000-4000-8000-000000000002'


class CapacityReviewTests(unittest.TestCase):
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
        self.config = {'recover': True, 'hosts': {'m3': {'services': ['monitor']}}, 'state': str(self.path),
                       'incidentNotifications': {'botToken': '123456:' + 'a' * 30, 'chatId': '123456'}}
        self.state = {'targets': {}}
        self.request = {'requestId': REQUEST, 'routeId': 'product-translate', 'groupId': 'm1-mlx', 'oldPolicy': True, 'localEndRecorded': True}
        self.review = {'status': 'review', 'truncated': False, 'requests': [self.request], 'count': 1,
                       'oldestAgeSeconds': 7200, 'stuckDispatched': 0, 'alarmReasons': []}
        self.row = {'key': 'monitor', 'version': 12, 'replicas': 1, 'settled': True,
                    'ok': True, 'recoverable': False, 'reason': 'ok', 'capacityUnknowns': self.review}
        self.recover = Mock()
        self.send = Mock(return_value=True)

    def cycle(self, now, report=None):
        reports = {'m3': {'services': [self.row]}} if report is None else report
        result = self.w.cycle(self.config, self.state, reports, now=now, recover=self.recover)
        self.state = json.loads(self.path.read_text())
        notifications = self.notify(self.config, self.state, reports, result, {}, now=now, send=self.send)
        self.state = json.loads(self.path.read_text())
        return result, notifications

    def alarm(self, reasons=('review_backlog',), count=51, stuck=0):
        requests = [self.request] if count else []
        return {'status': 'alarm', 'truncated': False, 'requests': requests, 'count': count,
                'oldestAgeSeconds': 7200 if count else None, 'stuckDispatched': stuck, 'alarmReasons': list(reasons)}

    def incidents(self):
        return self.state.get('notifications', {}).get('incidents', {})

    def test_review_queue_is_information_only_and_never_pages(self):
        for index in range(25):  # well past the old 5-minute per-request overdue escalation
            result, notifications = self.cycle(1000 + index * 30)
            self.assertTrue(result['ok'])
            self.assertIn({'target': 'm3/monitor', 'reason': 'model_review_pending', 'truncated': False, 'count': 1,
                           'oldestAgeSeconds': 7200}, result['events'])
            self.assertFalse([event for event in result['events'] if event.get('stage') == 'capacity'])
            self.assertEqual(notifications['pending'], 0)
            self.row['version'] += 1
        self.send.assert_not_called()
        self.recover.assert_not_called()
        self.assertNotIn('capacitySeen', self.state['targets']['m3/monitor'])

    def test_pre_upgrade_monitor_alarm_shape_is_review_and_old_request_incidents_and_clock_are_dropped(self):
        self.row['capacityUnknowns'] = {'status': 'alarm', 'truncated': False, 'requests': [self.request]}
        self.state = {'targets': {'m3/monitor': {'at': 990, 'bad': 1, 'capacitySeen': {REQUEST: 100}}},
                      'notifications': {'version': 1, 'incidents': {
                          'm3/monitor/' + REQUEST + '/model_indeterminate': {'sent': False, 'firstSeen': 100},
                          'm3/monitor/' + REQUEST + '/model_reclaim_overdue': {'sent': False, 'firstSeen': 400}}}}
        result, notifications = self.cycle(1000)
        self.assertTrue(result['ok'])
        self.assertEqual(self.incidents(), {})
        self.assertNotIn('capacitySeen', self.state['targets']['m3/monitor'])
        self.send.assert_not_called()

    def test_summarized_alarm_is_one_incident_per_reason_and_clears_after_ten_clear_minutes(self):
        self.row.update(ok=False, reason='pipeline_alarm', capacityUnknowns=self.alarm(('dispatch_stuck', 'review_backlog'), stuck=1))
        result, _ = self.cycle(1000)
        self.assertFalse(result['ok'])
        self.assertIn({'target': 'm3/monitor', 'stage': 'capacity', 'reason': 'review_backlog', 'count': 51,
                       'oldestAgeSeconds': 7200, 'stuckDispatched': 1}, result['events'])
        signatures = {'m3/monitor/capacity/dispatch_stuck', 'm3/monitor/capacity/review_backlog'}
        self.assertEqual(set(self.incidents()), signatures)
        self.assertIn('m3/monitor/capacity review_backlog', self.send.call_args.args[1])
        self.assertIn('/admin/models', self.send.call_args.args[1])
        self.assertNotIn(REQUEST, self.send.call_args.args[1])
        # Back under the threshold: review-only observations are a clear, but only after 600 continuous seconds.
        self.row.update(ok=True, reason='ok', capacityUnknowns=self.review)
        for now in range(1030, 1630, 30):
            self.assertTrue(self.cycle(now)[0]['ok'])
            self.assertEqual(set(self.incidents()), signatures)
        self.cycle(1630)
        self.assertEqual(self.incidents(), {})
        self.assertEqual(self.send.call_count, 1)

    def test_review_only_alarm_is_not_an_oracle_alarm_but_keeps_one_notice(self):
        """Owner decision 2026-11-10: review_* reasons only with no stuck dispatched row -> UP, the condition stays visible."""
        stale = self.alarm(('review_stale',), count=35)
        self.row['capacityUnknowns'] = stale  # new gateway: the row follows the monitor's own overall (ok)
        self.w.validate_report({'services': [self.row]})  # an ok row with a review-only alarm is not a false recovery claim
        for index in range(25):
            result, notifications = self.cycle(1000 + index * 30)
            self.assertTrue(result['ok'])
            self.assertIn({'target': 'm3/monitor', 'stage': 'capacity', 'reason': 'review_stale', 'count': 35,
                           'oldestAgeSeconds': 7200, 'stuckDispatched': 0}, result['events'])
            self.assertEqual(notifications['pending'], 0)
        self.assertEqual(self.state['targets']['m3/monitor']['capacityUnknowns'], stale)
        self.assertEqual(set(self.incidents()), {'m3/monitor/capacity/review_stale'})
        self.assertEqual(self.send.call_count, 1)  # one Telegram notice, not repeated
        self.assertIn('m3/monitor/capacity review_stale', self.send.call_args.args[1])
        self.assertIn('/admin/models', self.send.call_args.args[1])
        self.assertTrue(self.cycle(1800, report={'m3': None})[0]['ok'])  # a stored review-only alarm is not an alarm either
        self.recover.assert_not_called()

    def test_review_only_alarm_with_another_monitor_alarm_or_a_stuck_row_still_alarms(self):
        # The monitor's own overall is not ok (another alarm, or a pre-2026-11-10 monitor): DOWN after two samples, as before.
        self.row.update(ok=False, reason='pipeline_alarm', capacityUnknowns=self.alarm(('review_stale',), count=35))
        self.assertTrue(self.cycle(1000)[0]['ok'])
        self.assertFalse(self.cycle(1030)[0]['ok'])
        # A stuck dispatched row next to the review reasons is an alarm at once.
        self.state = {'targets': {}}
        self.path.unlink()
        self.row.update(capacityUnknowns=self.alarm(('dispatch_stuck', 'review_stale'), count=35, stuck=1))
        self.assertFalse(self.cycle(2000)[0]['ok'])
        self.recover.assert_not_called()

    def test_flapping_or_unobserved_alarm_does_not_resend_or_clear(self):
        self.row.update(ok=False, reason='pipeline_alarm', capacityUnknowns=self.alarm())
        self.cycle(1000)
        signature = 'm3/monitor/capacity/review_backlog'
        for now in range(1030, 2000, 60):
            self.row.update(ok=True, reason='ok', capacityUnknowns=self.review)
            self.cycle(now)
            self.row.update(ok=False, reason='pipeline_alarm', capacityUnknowns=self.alarm())
            self.cycle(now + 30)
        self.assertIn(signature, self.incidents())
        self.row.update(ok=True, reason='ok', capacityUnknowns=self.review)
        self.cycle(2100)
        self.cycle(2130, report={'m3': None})  # missing report restarts the clear interval
        self.row.pop('capacityUnknowns')       # summary-less (old monitor) observation is not a clear either
        for now in range(2160, 2900, 30):
            self.cycle(now)
        self.assertIn(signature, self.incidents())
        self.assertEqual(self.send.call_count, 1)

    def test_stuck_dispatch_alarms_without_review_rows(self):
        self.row.update(ok=False, reason='pipeline_alarm', capacityUnknowns=self.alarm(('dispatch_stuck',), count=0, stuck=1))
        result, _ = self.cycle(1000)
        self.assertFalse(result['ok'])
        self.assertIn('m3/monitor/capacity/dispatch_stuck', self.incidents())
        self.assertIn('still holds a slot', self.send.call_args.args[1])
        self.recover.assert_not_called()

    def test_missing_or_failed_read_cannot_clear_and_a_failed_read_alarms(self):
        self.cycle(1000)
        self.assertTrue(self.cycle(1010, report={'m3': None})[0]['ok'])  # one missed probe of a review-only target
        self.row.pop('capacityUnknowns')
        self.assertTrue(self.cycle(1030)[0]['ok'])
        self.assertEqual(self.state['targets']['m3/monitor']['capacityUnknowns'], self.review)
        self.row.update(ok=False, reason='pipeline_alarm', capacityUnknowns={'status': 'unknown', 'truncated': False, 'requests': []})
        self.assertFalse(self.cycle(1060)[0]['ok'])
        self.assertEqual(self.state['targets']['m3/monitor']['capacityUnknowns'], self.review)
        empty = {'status': 'ok', 'truncated': False, 'requests': [], 'count': 0, 'oldestAgeSeconds': None,
                 'stuckDispatched': 0, 'alarmReasons': []}
        self.row.update(ok=True, reason='ok', capacityUnknowns=empty)
        self.assertTrue(self.cycle(1090)[0]['ok'])
        self.assertEqual(self.state['targets']['m3/monitor']['capacityUnknowns'], empty)
        self.recover.assert_not_called()

    def test_unreachable_host_alarms_on_a_stored_alarm_but_not_on_a_stored_review(self):
        self.cycle(1000)
        self.assertTrue(self.cycle(1010, report={'m3': None})[0]['ok'])
        self.row['capacityUnknowns'] = self.alarm()  # review-only alarm (2026-11-10)
        self.cycle(1020)
        self.assertTrue(self.cycle(1030, report={'m3': None})[0]['ok'])
        self.row.update(ok=False, reason='pipeline_alarm', capacityUnknowns=self.alarm(('dispatch_stuck',), count=0, stuck=1))
        self.cycle(1040)
        self.assertFalse(self.cycle(1050, report={'m3': None})[0]['ok'])

    def test_incomplete_replica_review_cannot_clear_a_known_alarm_after_ten_minutes(self):
        from recovery_gateway import merge_capacity_unknowns
        known_alarm = self.alarm()
        self.row.update(ok=False, reason='pipeline_alarm', capacityUnknowns=known_alarm)
        self.cycle(1000)
        signature = 'm3/monitor/capacity/review_backlog'
        partial = merge_capacity_unknowns([self.review], complete=False)
        self.row['capacityUnknowns'] = partial
        for now in range(1030, 1720, 30):
            result, _ = self.cycle(now)
            self.assertFalse(result['ok'])
            self.assertIn(signature, self.incidents())
            self.assertNotIn('clearSince', self.incidents()[signature])
            self.assertEqual(self.state['targets']['m3/monitor']['capacityUnknowns'], known_alarm)
        self.recover.assert_not_called()

    def test_rejects_false_recovery_claims_duplicate_ids_private_data_and_invalid_summaries(self):
        valid = [self.review, self.alarm(), self.alarm(('dispatch_stuck',), count=0, stuck=1),
                 {'status': 'review', 'truncated': True, 'requests': [], 'count': 70, 'oldestAgeSeconds': 5, 'stuckDispatched': 0, 'alarmReasons': []},
                 {'status': 'alarm', 'truncated': False, 'requests': [self.request]},  # pre-upgrade shape = review pending
                 {'status': 'unknown', 'truncated': False, 'requests': []}]
        for capacity in valid:
            with self.subTest(valid=capacity):
                row = {**self.row, 'capacityUnknowns': capacity}
                if self.w.capacity_alarm(capacity):
                    row.update(ok=False, reason='pipeline_alarm')
                self.w.validate_report({'services': [row]})
        for patch in [{'requests': [self.request, self.request]}, {'status': 'ok'}, {'status': 'alarm'}, {'truncated': 'false'},
                      {'requests': [{**self.request, 'token': 'never transport credentials'}]},
                      {'requests': [{**self.request, 'groupId': 'bad\nlabel'}]}, {'requests': []}, {'count': 0},
                      {'count': True}, {'oldestAgeSeconds': -1}, {'alarmReasons': ['review_stale', 'review_backlog'], 'status': 'alarm'},
                      {'alarmReasons': ['private'], 'status': 'alarm'}, {'stuckDispatched': 1}, {'truncated': True},
                      {'status': 'unknown'}, {'note': 'extra'}]:
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.w.validate_report({'services': [{**self.row, 'capacityUnknowns': {**self.review, **patch}}]})
        partial = dict(self.review)
        partial.pop('stuckDispatched')
        with self.assertRaises(ValueError):
            self.w.validate_report({'services': [{**self.row, 'capacityUnknowns': partial}]})
        for capacity in [self.alarm(('dispatch_stuck',), count=0, stuck=1), self.alarm(('dispatch_stuck', 'review_backlog'), stuck=1)]:
            for patch in [{'ok': True, 'reason': 'ok'}, {'recoverable': True}]:
                with self.subTest(claim=patch, capacity=capacity), self.assertRaises(ValueError):
                    self.w.validate_report({'services': [{**self.row, 'ok': False, 'reason': 'pipeline_alarm',
                                                          'capacityUnknowns': capacity, **patch}]})
        # A review-only alarm (2026-11-10) is not an incident, so an ok row is not a false claim; recoverable still is.
        self.w.validate_report({'services': [{**self.row, 'capacityUnknowns': self.alarm()}]})
        with self.assertRaises(ValueError):
            self.w.validate_report({'services': [{**self.row, 'recoverable': True, 'capacityUnknowns': self.alarm()}]})


if __name__ == '__main__':
    unittest.main()
