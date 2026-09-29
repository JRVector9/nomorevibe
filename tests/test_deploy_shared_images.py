"""Safety checks for the production release operator tool."""

import importlib.util
import io
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / 'scripts/ops/deploy_shared_images.py'
SPEC = importlib.util.spec_from_file_location('deploy_shared_images', SOURCE)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


class FakeClient:
    def __init__(self, apps, deployment_id='old'):
        self.apps = apps
        self.deployment_id = deployment_id
        self.requests = []

    def app(self, short):
        return self.apps[short]

    def latest(self, short):
        return {'deploymentId': self.deployment_id, 'status': 'done'}

    def request(self, path, payload=None):
        self.requests.append(path)
        if payload and path in ('application.saveEnvironment', 'application.saveDockerProvider'):
            short = next(name for name, metadata in release.APPS.items()
                         if metadata[0] == payload['applicationId'])
            if path == 'application.saveEnvironment':
                self.apps[short].update({key: payload[key] for key in
                                         ('env', 'buildArgs', 'buildSecrets')})
            else:
                self.apps[short]['dockerImage'] = payload['dockerImage']


class ReleaseSafetyTests(unittest.TestCase):
    def setUp(self):
        self.old_sha = 'a' * 40
        self.new_sha = 'b' * 40
        self.old_worker = release.IMAGE_PREFIX['worker'] + 'sha256:' + 'c' * 64
        self.old_web = release.IMAGE_PREFIX['web'] + 'sha256:' + 'd' * 64
        self.target = release.validate_target(self.new_sha,
            release.IMAGE_PREFIX['worker'] + 'sha256:' + 'e' * 64,
            release.IMAGE_PREFIX['web'] + 'sha256:' + 'f' * 64)

    def apps(self):
        apps = {short: {
            'sourceType': 'docker', 'applicationStatus': 'done', 'autoDeploy': False,
            'replicas': 1, 'dockerImage': self.old_web if metadata[3] == 'web' else self.old_worker,
            'env': 'RELEASE_TAG=' + self.old_sha + '\n', 'appName': 'service-' + short,
        } for short, metadata in release.APPS.items()}
        for short in ('web-mini', 'web-m3'):
            apps[short]['env'] += ('NEXT_DEPLOYMENT_ID=' + self.old_sha + '\n'
                                   'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=sample-key\n')
            apps[short]['buildSecrets'] = 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=sample-key\n'
        return apps

    def test_rejects_unexpected_registry_and_nonimmutable_images(self):
        with self.assertRaisesRegex(ValueError, 'invalid_worker_image'):
            release.validate_target(self.new_sha, 'ghcr.io/other/worker@sha256:' + 'e' * 64,
                                    self.target['web'])
        with self.assertRaisesRegex(ValueError, 'invalid_web_image'):
            release.validate_target(self.new_sha, self.target['worker'],
                                    'ghcr.io/jrvector9/nomorevibe-runtime-web:latest')

    def test_baseline_rejects_mixed_release_before_any_probe(self):
        apps = self.apps()
        apps['reviewer-mini']['env'] = 'RELEASE_TAG=' + '9' * 40 + '\n'
        with patch.object(release, 'probe') as probe:
            with self.assertRaisesRegex(ValueError, 'baseline_release_mismatch'):
                release.baseline(FakeClient(apps), self.target)
            probe.assert_not_called()

    def test_baseline_rejects_web_build_runtime_key_drift(self):
        apps = self.apps()
        apps['web-mini']['buildSecrets'] = 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=other-key\n'
        with patch.object(release, 'probe') as probe:
            with self.assertRaisesRegex(ValueError, 'web_key_mismatch'):
                release.baseline(FakeClient(apps), self.target)
            probe.assert_not_called()

    def test_stage_refuses_app_changed_after_preflight(self):
        apps = self.apps()
        apps['publisher-mini']['dockerImage'] = self.target['worker']
        client = FakeClient(apps)
        previous = {'sha': self.old_sha, 'worker': self.old_worker, 'web': self.old_web}
        with self.assertRaisesRegex(ValueError, 'changed_since_preflight'):
            release.stage_and_deploy(client, 'publisher-mini', self.target, 'token', previous)
        self.assertEqual(client.requests, [])

    def test_wait_requires_new_deployment_and_actual_runtime(self):
        apps = self.apps()
        apps['crawler-mini'].update({'env': 'RELEASE_TAG=' + self.new_sha + '\n',
                                     'dockerImage': self.target['worker']})
        client = FakeClient(apps, deployment_id='old')
        with patch.object(release.time, 'monotonic', side_effect=[0, 0, 2]), \
             patch.object(release.time, 'sleep'), patch.object(release, 'probe') as probe:
            with self.assertRaisesRegex(TimeoutError, 'verification_timeout'):
                release.check_app_deployed(client, 'crawler-mini', self.target, 'old', timeout=1)
            probe.assert_not_called()
        client.deployment_id = 'new'
        with patch.object(release, 'probe', return_value={'ready': False}), \
             patch.object(release.time, 'monotonic', side_effect=[0, 0, 2]), \
             patch.object(release.time, 'sleep'):
            with self.assertRaisesRegex(TimeoutError, 'verification_timeout'):
                release.check_app_deployed(client, 'crawler-mini', self.target, 'old', timeout=1)
        with patch.object(release, 'probe', return_value={'ready': True}):
            result = release.check_app_deployed(client, 'crawler-mini', self.target, 'old')
            self.assertEqual(result['service'], 'healthy')

    def test_failed_role_gate_stops_before_next_role_or_web(self):
        steps = []
        def stage(_client, short, _target, _token, _previous):
            steps.append(short)
            return {'app': short}
        with patch.object(release, 'save_snapshot'), \
             patch.object(release, 'stage_and_deploy', side_effect=stage), \
             patch.object(release, 'monitor_gate', side_effect=TimeoutError('publisher_gate')), \
             redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(TimeoutError, 'publisher_gate'):
                release.deploy(None, self.target, 'token',
                               {'apps': {}, 'previous': {'sha': self.old_sha}},
                               '/private/tmp/snapshot.json')
        self.assertEqual(steps, ['publisher-mini', 'publisher-m3'])

    def test_replace_setting_requires_one_line(self):
        self.assertEqual(release.replace_setting('# a\nRELEASE_TAG=old\n', 'RELEASE_TAG', self.new_sha),
                         '# a\nRELEASE_TAG=' + self.new_sha + '\n')
        with self.assertRaisesRegex(ValueError, 'RELEASE_TAG_line_count_2'):
            release.replace_setting('RELEASE_TAG=1\nRELEASE_TAG=2\n', 'RELEASE_TAG', self.new_sha)

    def test_snapshot_is_private_and_restore_uses_previous_digest(self):
        apps = self.apps()
        current = apps['publisher-mini']
        current['dockerImage'] = self.target['worker']
        current['env'] = 'RELEASE_TAG=' + self.new_sha + '\n'
        previous = {'sha': self.old_sha, 'worker': self.old_worker, 'web': self.old_web}
        original = dict(current, dockerImage=self.old_worker,
                        env='RELEASE_TAG=' + self.old_sha + '\n')
        client = FakeClient(apps)
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'snapshot.json')
            release.save_snapshot(path, self.target,
                                  {'previous': previous, 'apps': {'publisher-mini': original}})
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
            with patch.object(release, 'check_app_deployed', return_value={'app': 'publisher-mini'}) as gate:
                result = release.restore(client, path, 'publisher-mini', 'token')
            self.assertEqual(result['app'], 'publisher-mini')
            self.assertEqual(client.requests, ['application.saveEnvironment',
                                               'application.saveDockerProvider', 'application.deploy'])
            gate.assert_called_once_with(client, 'publisher-mini', previous, 'old')


if __name__ == '__main__':
    unittest.main()
