"""Offline monitor rollout and timestamped receiver-acknowledgement proofs."""
import copy
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
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

    def test_old_container_or_missing_receiver_receipt_does_not_pass(self):
        self.current['containers'][0]['id'] = self.previous['containers'][0]['id']
        with self.assertRaises(TimeoutError): self.check()
        self.current['containers'][0]['id'] = 'd' * 64
        self.push.stop()
        with patch.object(monitor, 'read_push_receipts', return_value={'verified': False, 'primary': True, 'external': False}):
            with self.assertRaises(TimeoutError): self.check()

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
                   'FAKE_STARTED': self.started.isoformat()}
            result = subprocess.run([sys.executable, '-c', monitor.REMOTE_PUSH_RECEIPTS, 'd' * 64, self.started.isoformat()],
                env=env, capture_output=True, text=True, timeout=5, check=True)
        summary = json.loads(result.stdout)
        self.assertTrue(summary['verified'])
        self.assertTrue(all(type(value) is bool for value in summary.values()))
        self.assertNotIn('private-token', result.stdout)
        self.assertEqual(result.stderr, '')


if __name__ == '__main__': unittest.main()
