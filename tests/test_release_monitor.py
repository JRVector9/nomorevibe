"""Offline monitor rollout and timestamped receiver-acknowledgement proofs."""
import copy
import importlib.util
import inspect
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / 'scripts/ops/release_monitor.py'
if SOURCE.exists():
    SPEC = importlib.util.spec_from_file_location('release_monitor', SOURCE)
    monitor = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(monitor)
else:
    monitor = None


class MonitorRolloutTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(monitor, 'Monitor rollout verifier has not been implemented')
        self.old, self.new = 'a' * 40, 'b' * 40
        self.old_image, self.new_image = 'sha256:' + 'c' * 64, 'sha256:' + 'd' * 64
        self.target = {'sha': self.new, 'worker': monitor.git.shared.IMAGE_PREFIX['worker'] + self.new_image,
                       'web': monitor.git.shared.IMAGE_PREFIX['web'] + 'sha256:' + 'e' * 64}
        app_id, name, (server, _), _ = monitor.git.shared.app_metadata('monitor-m3')
        command = '/sbin/tini -- node --import tsx scripts/watch-failover-readiness.ts'
        health = {'Test': ['CMD', 'node', '--import', 'tsx', 'scripts/monitor-healthcheck.ts'],
                  'Interval': 30000000000}
        self.original = {'applicationId': app_id, 'name': name, 'serverId': server, 'appName': 'monitor-service',
            'sourceType': 'docker', 'dockerBuildStage': 'monitor',
            'dockerImage': monitor.git.shared.IMAGE_PREFIX['worker'] + self.old_image,
            'applicationStatus': 'done', 'autoDeploy': False, 'replicas': 1,
            'command': command, 'env': 'RELEASE_TAG=' + self.old + '\nWORKER_ROLE=monitor\nSECRET=private\n',
            'buildArgs': '', 'buildSecrets': '', 'healthCheckSwarm': health}
        self.manifest = {'package-lock.json': 'f' * 64}
        service_env = self.original['env'].splitlines()
        spec = {'Name': self.original['appName'], 'Mode': {'Replicated': {'Replicas': 1}}, 'TaskTemplate': {
            'ForceUpdate': 2, 'Resources': {'Limits': {'MemoryBytes': 134217728}}, 'ContainerSpec': {
                'Image': self.original['dockerImage'], 'Env': service_env, 'Healthcheck': health,
                'Mounts': [{'Type': 'bind', 'Source': '/data', 'Target': '/state', 'ReadOnly': True}]}}}
        self.started = datetime.now(timezone.utc) - timedelta(seconds=20)
        config = {'Env': ['NODE_ENV=production', *service_env], 'Image': self.original['dockerImage'],
            'Entrypoint': command.split(), 'Cmd': None, 'Healthcheck': health, 'User': 'worker', 'WorkingDir': '/app',
            'Labels': {'com.docker.swarm.service.name': self.original['appName']}}
        image_config = {'Env': ['NODE_ENV=production'], 'Healthcheck': {'Test': ['CMD', 'worker-healthcheck']},
                        'Labels': {'org.opencontainers.image.revision': self.old}}
        self.previous = {'serviceId': 'service-id', 'version': {'Index': 1}, 'updateStatus': {'State': 'completed'},
            'serviceSpec': spec, 'specHash': monitor.git.spec_hash(spec), 'images': [{'Id': self.old_image, 'Config': image_config}],
            'containers': [{'id': 'c' * 64, 'image': self.old_image, 'config': config,
                'mounts': [{'Type': 'bind', 'Source': '/data', 'Destination': '/state', 'RW': False}],
                'codeHashes': self.manifest, 'state': {'Running': True, 'Health': {'Status': 'healthy'},
                'StartedAt': (self.started - timedelta(hours=1)).isoformat()}}]}
        self.app = monitor.fleet.expected_api('monitor-m3', self.original, self.target)
        self.current = copy.deepcopy(self.previous)
        self.current['version']['Index'] = 2
        self.current['serviceSpec']['TaskTemplate']['ForceUpdate'] = 3
        cs = self.current['serviceSpec']['TaskTemplate']['ContainerSpec']
        cs.update(Image=self.target['worker'], Env=self.app['env'].splitlines())
        self.current['specHash'] = monitor.git.spec_hash(self.current['serviceSpec'])
        self.current['containers'][0].update(id='d' * 64, image=self.new_image)
        self.current['containers'][0]['config'].update(Image=self.target['worker'], Env=['NODE_ENV=production', *cs['Env']])
        self.current['containers'][0]['state']['StartedAt'] = self.started.isoformat()
        self.current['images'][0]['Id'] = self.new_image
        self.current['images'][0]['Config']['Labels']['org.opencontainers.image.revision'] = self.new
        self.client = Client(self.app)
        self.inspect = patch.object(monitor.git, 'inspect_runtime', side_effect=lambda *_, **__: copy.deepcopy(self.current))
        self.inspect.start(); self.addCleanup(self.inspect.stop)
        self.push = patch.object(monitor, 'read_push_receipts', return_value={
            'verified': True, 'primary': True, 'external': True, 'fresh': True, 'stateUp': True})
        self.push.start(); self.addCleanup(self.push.stop)

    def check(self, **kwargs):
        return monitor.check_monitor_deployed(self.client, 'monitor-m3', self.target, self.original,
            'old-deployment', self.manifest, self.previous, timeout=.02, pause=0, **kwargs)

    def test_done_new_id_exact_monitor_source_and_both_receiver_acks_succeed_without_stdout(self):
        output = io.StringIO()
        with redirect_stdout(output):
            result = self.check()
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(result['deploymentId'], 'new-deployment')
        self.assertEqual(result['pushReceipts'], {'primary': True, 'external': True})
        self.assertEqual(result['image'], self.target['worker'])
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(self.client.mutations, 0)

    def test_old_or_running_deployment_never_inspects_or_uses_receipts(self):
        for latest in ({'deploymentId': 'old-deployment', 'status': 'done'},
                       {'deploymentId': 'new-deployment', 'status': 'running'}):
            self.client.latest_row = latest
            with self.subTest(latest=latest), patch.object(monitor.git, 'inspect_runtime') as inspect:
                with self.assertRaises(TimeoutError): self.check()
                inspect.assert_not_called()

    def test_old_container_never_passes_and_a_missing_receiver_receipt_is_never_verified(self):
        self.current['containers'][0]['id'] = self.previous['containers'][0]['id']
        with self.assertRaises(TimeoutError): self.check()
        self.current['containers'][0]['id'] = 'd' * 64
        self.push.stop()
        with patch.object(monitor, 'read_push_receipts', return_value={'verified': False, 'primary': True, 'external': False}):
            result = self.check()
        # The deployment is proven, so the missing acknowledgement is handed over rather than reported as verified.
        self.assertEqual(result['verification'], monitor.HUMAN_REVIEW)
        self.assertNotEqual(result['pushReceipts'], {'primary': True, 'external': True})

    def test_monitor_verification_waits_five_minutes_and_other_apps_keep_their_own_timeouts(self):
        self.assertEqual(monitor.MONITOR_VERIFY_TIMEOUT_SECONDS, 300)
        self.assertEqual(inspect.signature(monitor.check_monitor_deployed).parameters['timeout'].default,
                         monitor.MONITOR_VERIFY_TIMEOUT_SECONDS)
        self.assertEqual(inspect.signature(monitor.git.check_deployed).parameters['timeout'].default, 480)
        self.assertIsNone(inspect.signature(monitor.git.shared.check_app_deployed).parameters['timeout'].default)

    def test_proven_deployment_with_push_state_down_is_handed_to_a_human_after_the_timeout(self):
        # 2026-10-31: both receivers acknowledged (ok:true) but the watcher pushed state=down because the ledger
        # raised dispatch_stuck, so stateUp never became true inside the window.
        observed = {'verified': False, 'primary': True, 'external': True, 'fresh': True, 'stateUp': False}
        self.push.stop()
        output = io.StringIO()
        with patch.object(monitor, 'read_push_receipts', return_value=observed), redirect_stdout(output):
            result = self.check()
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(result['verification'], monitor.HUMAN_REVIEW)
        self.assertEqual(result['reason'], 'monitor_push_state_not_up')
        self.assertEqual(result['pushReceipts'], observed)
        self.assertEqual((result['app'], result['deploymentId'], result['deployment'], result['service']),
                         ('monitor-m3', 'new-deployment', 'done', 'healthy'))
        self.assertEqual((result['image'], result['containerId'], result['source']),
                         (self.target['worker'], 'd' * 64, 'sha256-manifest'))
        self.assertEqual(result['verifyTimeoutSeconds'], .02)
        self.assertNotIn('private', json.dumps(result))
        self.assertEqual(self.client.mutations, 0)

    def test_hand_over_reason_names_the_first_missing_push_proof(self):
        cases = (({'verified': False, 'primary': False, 'external': False, 'fresh': False, 'stateUp': False}, 'monitor_push_receipts_unreadable'),
                 ({'verified': False, 'primary': True, 'external': True, 'fresh': True, 'stateUp': False}, 'monitor_push_state_not_up'),
                 ({'verified': False, 'primary': False, 'external': False, 'fresh': False, 'stateUp': True}, 'monitor_push_receipt_stale'),
                 ({'verified': False, 'primary': True, 'external': False, 'fresh': True, 'stateUp': True}, 'monitor_push_receiver_not_acknowledged'),
                 ({}, 'monitor_push_receipts_unreadable'), (None, 'monitor_push_receipts_unreadable'))
        for receipts, reason in cases:
            with self.subTest(receipts=receipts):
                self.assertEqual(monitor.push_block_reason(receipts), reason)
        self.push.stop()
        for receipts, reason in cases[:4]:
            with self.subTest(receipts=receipts), patch.object(monitor, 'read_push_receipts', return_value=receipts):
                self.assertEqual(self.check()['reason'], reason)

    def test_unproven_deployment_still_stops_after_the_timeout_instead_of_a_hand_over(self):
        self.push.stop()
        down = {'verified': False, 'primary': True, 'external': True, 'fresh': True, 'stateUp': False}
        self.push = patch.object(monitor, 'read_push_receipts', return_value=down); self.push.start()
        # Never done with a new id: no deployment to hand over.
        self.client.latest_row = {'deploymentId': 'new-deployment', 'status': 'running'}
        with self.assertRaisesRegex(TimeoutError, 'monitor-m3_source_health_or_push_verification_timeout'): self.check()
        self.client.latest_row = {'deploymentId': 'new-deployment', 'status': 'done'}
        # Done, but the runtime is still the old container on the last poll (flapped back after one ready read).
        old = copy.deepcopy(self.current); old['containers'][0]['id'] = self.previous['containers'][0]['id']
        reads = iter([copy.deepcopy(self.current)])
        self.inspect.stop()
        with patch.object(monitor.git, 'inspect_runtime', side_effect=lambda *_, **__: next(reads, copy.deepcopy(old))):
            with self.assertRaises(TimeoutError): self.check()
        self.inspect.start()
        # Done and healthy, but the image carries the old revision: the deployment is not proven.
        self.current['images'][0]['Config']['Labels']['org.opencontainers.image.revision'] = self.old
        with self.assertRaises(TimeoutError): self.check()
        self.current['images'][0]['Config']['Labels']['org.opencontainers.image.revision'] = self.new
        # Rollback or API drift still stop immediately.
        self.current['updateStatus']['State'] = 'rollback_completed'
        with self.assertRaises(monitor.git.shared.SwarmRollback): self.check()
        self.current['updateStatus']['State'] = 'completed'
        self.app['autoDeploy'] = True
        with self.assertRaises(monitor.git.shared.ReleaseStopped): self.check()
        self.assertEqual(self.client.mutations, 0)

    def test_container_replacement_during_hand_over_readback_is_rejected(self):
        self.push.stop()
        down = {'verified': False, 'primary': True, 'external': True, 'fresh': True, 'stateUp': False}
        changed = copy.deepcopy(self.current); changed['containers'][0]['id'] = 'e' * 64
        self.inspect.stop()
        reads = []
        def inspect_runtime(*_, **__):
            reads.append(1)
            return copy.deepcopy(self.current) if len(reads) == 1 else copy.deepcopy(changed)
        with patch.object(monitor, 'read_push_receipts', return_value=down), \
                patch.object(monitor.git, 'inspect_runtime', side_effect=inspect_runtime):
            with self.assertRaisesRegex(monitor.git.shared.ReleaseStopped, 'changed_during_push_readback'):
                # One poll inside the window, then the deadline passes during the pause.
                monitor.check_monitor_deployed(self.client, 'monitor-m3', self.target, self.original,
                    'old-deployment', self.manifest, self.previous, timeout=.005, pause=.01)
        self.inspect.start()

    def test_human_review_record_keeps_codes_booleans_and_capacity_summary_without_values(self):
        evidence = {'app': 'monitor-m3', 'deploymentId': 'new-deployment', 'deployment': 'done', 'service': 'healthy',
                    'verification': monitor.HUMAN_REVIEW, 'reason': 'monitor_push_state_not_up', 'verifyTimeoutSeconds': 300,
                    'pushReceipts': {'verified': False, 'primary': True, 'external': True, 'fresh': True, 'stateUp': False}}
        report = {'check-failover-readiness.ts': {'overall': 'alarm', 'readiness': {'roles': []}, 'capacityUnknowns': {
                      'status': 'alarm', 'truncated': False, 'count': 0, 'oldestAgeSeconds': None, 'stuckDispatched': 1,
                      'alarmReasons': ['dispatch_stuck'],
                      'requests': [{'requestId': 'secret-request-id', 'routeId': 'https://secret.invalid/route', 'groupId': 'g'}]}},
                  'check-worker-progress.ts': {'overall': 'ok'}}
        self.client.app_row = {**self.app, 'appName': 'crawler-service'}
        with patch.object(monitor.git.shared, 'ssh_python', return_value=json.dumps(report)) as remote:
            record = monitor.human_review_record(self.client, evidence)
        self.assertEqual(remote.call_args.args[:3], (monitor.git.shared.M3[1], monitor.git.shared.REMOTE_MONITOR, 'crawler-service'))
        self.assertEqual((record['status'], record['verification'], record['reason'], record['lastPushState']),
                         ('human-review-required', monitor.HUMAN_REVIEW, 'monitor_push_state_not_up', 'down'))
        self.assertEqual(record['pushReceipts'], evidence['pushReceipts'])
        self.assertEqual(record['capacityUnknowns'], {'status': 'alarm', 'monitorOverall': 'alarm', 'count': 0, 'stuckDispatched': 1,
                                                      'oldestAgeSeconds': None, 'alarmReasons': ['dispatch_stuck']})
        self.assertEqual(record['operatorChecks'], list(monitor.OPERATOR_CHECKS))
        text = json.dumps(record)
        for leaked in ('secret', 'https://', 'requests'):
            self.assertNotIn(leaked, text)
        self.assertEqual(self.client.mutations, 0)
        # An unreadable report is unread, never ok; an unreadable push event is an unknown state.
        with patch.object(monitor.git.shared, 'ssh_python', side_effect=RuntimeError('ssh failed')):
            unread = monitor.human_review_record(self.client, {**evidence, 'pushReceipts': {key: False for key in monitor.PUSH_FIELDS}})
        self.assertEqual((unread['capacityUnknowns'], unread['lastPushState']), ({'status': 'unread'}, 'unknown'))
        for broken in ('not json', json.dumps({'check-failover-readiness.ts': {'overall': 'unknown'}}),
                       json.dumps({'check-failover-readiness.ts': {'overall': 'bad', 'capacityUnknowns': {
                           'status': 'fine', 'count': -1, 'stuckDispatched': '1', 'alarmReasons': ['https://x', 'review_stale', 7]}}})):
            with self.subTest(broken=broken[:20]), patch.object(monitor.git.shared, 'ssh_python', return_value=broken):
                summary = monitor.capacity_alarm_summary(self.client)
                self.assertIn(summary['status'], ('unread',))
                if 'alarmReasons' in summary:
                    self.assertEqual(summary, {'status': 'unread', 'monitorOverall': 'unknown', 'count': None, 'stuckDispatched': None,
                                               'oldestAgeSeconds': None, 'alarmReasons': ['review_stale']})

    def test_healthy_old_image_source_mount_role_health_or_resources_never_pass(self):
        original = copy.deepcopy(self.current)
        mutations = [lambda r: r['containers'][0]['codeHashes'].update({'package-lock.json': '0' * 64}),
            lambda r: r['images'][0]['Config']['Labels'].update({'org.opencontainers.image.revision': self.old}),
            lambda r: r['containers'][0]['config']['Env'].append('WORKER_ROLE=other'),
            lambda r: r['containers'][0]['mounts'][0].update(RW=True),
            lambda r: r['containers'][0]['config'].update(Healthcheck={'Test': ['CMD', 'true']}),
            lambda r: r['serviceSpec']['TaskTemplate']['Resources']['Limits'].update(MemoryBytes=1)]
        for mutation in mutations:
            self.current = copy.deepcopy(original); mutation(self.current)
            self.current['specHash'] = monitor.git.spec_hash(self.current['serviceSpec'])
            with self.subTest(mutation=mutation), self.assertRaises((TimeoutError, monitor.git.shared.ReleaseStopped)):
                self.check()

    def test_rollback_and_api_configuration_drift_stop_without_retry(self):
        self.current['updateStatus']['State'] = 'rollback_completed'
        with self.assertRaises(monitor.git.shared.SwarmRollback): self.check()
        self.current['updateStatus']['State'] = 'completed'
        self.app['autoDeploy'] = True
        with self.assertRaises(monitor.git.shared.ReleaseStopped): self.check()
        self.assertEqual(self.client.mutations, 0)

    def test_container_replacement_during_receipt_readback_is_rejected(self):
        changed = copy.deepcopy(self.current)
        changed['containers'][0]['id'] = 'e' * 64
        with patch.object(monitor.git, 'inspect_runtime', side_effect=[self.current, changed]):
            with self.assertRaises(monitor.git.shared.ReleaseStopped): self.check()


class Client:
    def __init__(self, app):
        self.app_row = app
        self.latest_row = {'deploymentId': 'new-deployment', 'status': 'done'}
        self.mutations = 0
    def app(self, _): return copy.deepcopy(self.app_row)
    def latest(self, _): return copy.deepcopy(self.latest_row)
    def request(self, *_):
        self.mutations += 1
        raise AssertionError('verifier must be read only')


class PushReceiptTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(monitor, 'Monitor rollout verifier has not been implemented')
        self.now = datetime.now(timezone.utc)
        self.started = self.now - timedelta(seconds=20)
        self.at = self.now - timedelta(seconds=10)

    def line(self, **changes):
        receipt = {'event': 'monitor.push', 'state': 'up', 'receipts': [
            {'target': name, 'ok': True, 'attemptedAt': self.at.isoformat()} for name in ('primary', 'external')]}
        receipt.update(changes)
        return self.at.isoformat() + ' ' + json.dumps(receipt)

    def verdict(self, lines):
        return monitor.push_receipt_verdict(lines, self.started.isoformat(), now=self.now.timestamp())

    def test_real_watcher_receipt_shape_is_timestamped_new_container_fresh_and_both_receivers(self):
        self.assertTrue(self.verdict([self.line()])['verified'])
        for change in ({'state': 'down'}, {'receipts': []}, {'receipts': [
                {'target': 'primary', 'ok': True, 'attemptedAt': self.at.isoformat()}]}, {'receipts': [
                {'target': name, 'ok': name == 'primary', 'attemptedAt': self.at.isoformat()} for name in ('primary', 'external')]}):
            with self.subTest(change=change): self.assertFalse(self.verdict([self.line(**change)])['verified'])

    def test_older_preboot_future_or_superseded_failed_push_is_not_accepted(self):
        for at in (self.started - timedelta(seconds=1), self.now + timedelta(minutes=1), self.now - timedelta(minutes=3)):
            self.at = at
            self.assertFalse(self.verdict([self.line()])['verified'])
        self.at = self.now - timedelta(seconds=10)
        success = self.line()
        self.at += timedelta(seconds=1)
        failed = self.line(receipts=[{'target': name, 'ok': False, 'attemptedAt': self.at.isoformat()}
                                    for name in ('primary', 'external')])
        self.assertFalse(self.verdict([failed, success])['verified'])

    def test_rfc3339nano_z_and_offsets_preserve_exact_order_on_python39(self):
        actual = '2026-10-26T00:35:03.948294479Z'
        self.assertEqual(monitor._timestamp(actual), Decimal('1792974903.948294479'))
        self.assertEqual(monitor._timestamp(actual), monitor._timestamp('2026-10-26T09:35:03.948294479+09:00'))
        self.assertEqual(monitor._timestamp(actual), monitor._timestamp('2026-10-25T20:35:03.948294479-04:00'))
        self.assertLess(monitor._timestamp(actual), monitor._timestamp('2026-10-26T00:35:03.948294480Z'))
        for fraction in ('1', '12', '123', '1234', '12345', '123456', '1234567', '12345678', '123456789'):
            with self.subTest(fraction=fraction):
                self.assertIsNotNone(monitor._timestamp('2026-10-26T00:35:03.' + fraction + 'Z'))

    def test_malformed_or_ambiguous_timestamps_are_rejected(self):
        for value in (None, 42, '', '2026-10-26', '2026-10-26T00:35:03',
                      '2026-10-26 00:35:03Z', '2026-10-26X00:35:03+00:00',
                      '2026-10-26T00:35:03.Z', '2026-10-26T00:35:03,123Z',
                      '2026-10-26T00:35:03.1234567890Z', '2026-10-26T00:35:03Z ',
                      '2026-10-26T00:35:03+0000', '2026-10-26T00:35:03+00:00:01',
                      '2026-10-26T00:35:03+01:60', '2026-10-26T00:35:03+24:00',
                      '2026-10-26T00:35:03-00:00', '2026-02-30T00:35:03Z',
                      '2026-10-26T24:35:03Z', '2026-10-26T00:35:60Z'):
            with self.subTest(value=value): self.assertIsNone(monitor._timestamp(value))

    def test_nanosecond_latest_down_and_duplicate_event_never_pass(self):
        started, now = '2026-10-26T00:35:03.948294479Z', Decimal('1792974920')
        def line(at, state):
            return at + ' ' + json.dumps({'event': 'monitor.push', 'state': state, 'receipts': [
                {'target': name, 'ok': True, 'attemptedAt': at} for name in ('primary', 'external')]})
        up = line('2026-10-26T00:35:10.000000001Z', 'up')
        down = line('2026-10-26T00:35:10.000000002Z', 'down')
        self.assertTrue(monitor.push_receipt_verdict([up], started, now=now)['verified'])
        verdict = monitor.push_receipt_verdict([down, up], started, now=now)
        self.assertEqual(verdict, {'verified': False, 'primary': True, 'external': True, 'fresh': True, 'stateUp': False})
        self.assertFalse(monitor.push_receipt_verdict([up, up], started, now=now)['verified'])
        before_boot = line('2026-10-26T00:35:03.948294478Z', 'up')
        self.assertFalse(monitor.push_receipt_verdict([before_boot], started, now=now)['verified'])

    def test_nano_receipts_enforce_stale_and_future_boundaries(self):
        started, now = '2026-10-26T00:30:00Z', Decimal('1792974920')
        for stamp in ('2026-10-26T00:33:49.999999999Z', '2026-10-26T00:35:25.000000001Z'):
            event = {'event': 'monitor.push', 'state': 'up', 'receipts': [
                {'target': name, 'ok': True, 'attemptedAt': stamp} for name in ('primary', 'external')]}
            with self.subTest(stamp=stamp):
                self.assertFalse(monitor.push_receipt_verdict([stamp + ' ' + json.dumps(event)], started, now=now)['verified'])

    def test_malformed_duplicate_oversized_or_unclocked_receipts_fail_closed(self):
        for receipts in ([{'target': [], 'ok': True}, {'target': 'external', 'ok': True}],
                         [{'target': 'primary', 'ok': True, 'attemptedAt': self.at.isoformat()}] * 2,
                         [{'target': name, 'ok': True, 'attemptedAt': '2026-10-25T10:00:00'}
                          for name in ('primary', 'external')]):
            with self.subTest(receipts=receipts):
                self.assertFalse(self.verdict([self.line(receipts=receipts)])['verified'])
        self.assertFalse(self.verdict(['x' * 16385])['verified'])
        self.assertFalse(self.verdict([self.line()] * 129)['verified'])

    def test_remote_log_reader_returns_only_booleans_and_keeps_raw_secrets_remote(self):
        fake = '''import json,os,sys
assert sys.argv[1:]==['logs','--timestamps','--since',os.environ['FAKE_STARTED'],'--tail','128','d'*64]
print(os.environ['FAKE_LOGS'])
'''
        with tempfile.TemporaryDirectory() as directory:
            docker = Path(directory) / 'docker'
            docker.write_text('#!' + sys.executable + '\n' + fake); docker.chmod(0o755)
            env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'],
                   'FAKE_LOGS': 'https://secret.invalid/private-token\n' + self.line(),
                   'FAKE_STARTED': self.started.isoformat(timespec='microseconds').replace('+00:00', '479Z')}
            result = subprocess.run([sys.executable, '-c', monitor.REMOTE_PUSH_RECEIPTS, 'd' * 64, env['FAKE_STARTED']],
                env=env, capture_output=True, text=True, timeout=5, check=True)
        summary = json.loads(result.stdout)
        self.assertTrue(summary['verified'])
        self.assertTrue(all(type(value) is bool for value in summary.values()))
        self.assertNotIn('private-token', result.stdout)
        self.assertEqual(result.stderr, '')


if __name__ == '__main__': unittest.main()
