"""Safety checks for the production release operator tool."""

import importlib.util
import io
import json
import os
import subprocess
import sys
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

    def test_web_may_scale_out_but_workers_stay_single(self):
        self.assertTrue(release.replicas_allowed('web', 4))
        self.assertTrue(release.replicas_allowed('web', release.WEB_MAX_REPLICAS))
        self.assertFalse(release.replicas_allowed('web', release.WEB_MAX_REPLICAS + 1))
        self.assertFalse(release.replicas_allowed('web', 0))
        self.assertFalse(release.replicas_allowed('web', True))
        self.assertTrue(release.replicas_allowed('worker', 1))
        self.assertFalse(release.replicas_allowed('worker', 2))

        apps = self.apps()
        apps['web-m3']['replicas'] = 4
        apps['web-mini']['replicas'] = 2
        with patch.object(release, 'probe', return_value={'ready': True}) as probe:
            release.baseline(FakeClient(apps), self.target)
        # 기준선은 Dokploy 에 새 수를 적어 두고 아직 배포하지 않은 상태도 받는다 — 실행 수 = 원하는 수만 본다
        self.assertTrue(all(len(call.args) == 3 for call in probe.call_args_list))

        apps['crawler-m3']['replicas'] = 2
        with patch.object(release, 'probe') as probe:
            with self.assertRaisesRegex(ValueError, 'crawler-m3_baseline_not_ready'):
                release.baseline(FakeClient(apps), self.target)
            probe.assert_not_called()

    def test_wait_checks_the_configured_replica_count(self):
        apps = self.apps()
        apps['web-m3'].update({'replicas': 4, 'dockerImage': self.target['web'],
                               'env': 'RELEASE_TAG=' + self.new_sha + '\n'})
        client = FakeClient(apps, deployment_id='new')
        with patch.object(release, 'probe', return_value={'ready': True, 'instanceId': 'm3-web'}) as probe:
            result = release.check_app_deployed(client, 'web-m3', self.target, 'old')
        self.assertEqual(result['instanceId'], 'm3-web')
        self.assertEqual(probe.call_args.args[3], 4)

    def run_probe(self, replicas, containers, expected):
        """원격 상태 확인을 가짜 docker 로 그대로 돌린다 — 실제로 원격에서 도는 코드와 같은 문자열이다."""
        web = self.target['web']
        fixture = {'service': 'svc\t' + web + '\t' + replicas, 'containers': containers}
        fake = ('import json,os,sys\n'
                'f=json.loads(os.environ["FAKE_DOCKER"]);a=sys.argv[1:]\n'
                'if a[:2]==["service","ls"]: print(f["service"])\n'
                'elif a[0]=="ps": print("\\n".join(c["id"] for c in f["containers"]))\n'
                'elif a[0]=="inspect":\n'
                ' c=next(c for c in f["containers"] if c["id"]==a[1])\n'
                ' print(json.dumps([{"Config":{"Image":c["image"],"Env":["RELEASE_TAG="+c["sha"],"NEXT_DEPLOYMENT_ID="+c["sha"]],'
                '"Labels":{"com.docker.swarm.service.name":"svc"}},"State":{"Running":True}}]))\n'
                'elif a[0]=="exec":\n'
                ' c=next(c for c in f["containers"] if c["id"]==a[1])\n'
                ' print(json.dumps({"status":"ok","db":"ok","release":c["sha"],"instanceId":"m3-web"}))\n')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'docker'
            path.write_text('#!' + sys.executable + '\n' + fake)
            path.chmod(0o755)
            out = subprocess.run([sys.executable, '-c', release.REMOTE_PROBE, 'svc', web, self.new_sha, 'web', expected],
                                 capture_output=True, text=True, check=True,
                                 env={**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'],
                                      'FAKE_DOCKER': json.dumps(fixture)})
        return json.loads(out.stdout)

    def test_probe_requires_every_web_replica_on_the_new_release(self):
        fresh = {'image': self.target['web'], 'sha': self.new_sha}
        ready = self.run_probe('4/4', [dict(fresh, id=f'c{i}') for i in range(4)], '4')
        self.assertTrue(ready['ready'])
        self.assertEqual(ready['instanceId'], 'm3-web')

        stale = [dict(fresh, id=f'c{i}') for i in range(3)] + [{'id': 'old', 'image': self.old_web, 'sha': self.old_sha}]
        self.assertFalse(self.run_probe('4/4', stale, '4')['ready'])
        # 아직 다 뜨지 않았거나 Dokploy 에 적은 수와 다르면 준비가 아니다
        self.assertFalse(self.run_probe('3/4', [dict(fresh, id=f'c{i}') for i in range(3)], '4')['ready'])
        self.assertFalse(self.run_probe('2/2', [dict(fresh, id=f'c{i}') for i in range(2)], '4')['ready'])
        self.assertTrue(self.run_probe('2/2', [dict(fresh, id=f'c{i}') for i in range(2)], 'any')['ready'])

    def test_html_purge_after_release_uses_only_the_purge_token(self):
        with patch.object(release, 'run', side_effect=RuntimeError('command_failed:security:44')):
            self.assertEqual(release.purge_html(), {'htmlPurge': 'skipped', 'reason': 'no_purge_token'})

        calls = []
        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            return subprocess.CompletedProcess(command, 0, stdout='{"success": true, "errors": []}', stderr='')
        with patch.object(release, 'run', return_value='purge-secret'), \
             patch.object(release.subprocess, 'run', side_effect=fake_run):
            self.assertEqual(release.purge_html(), {'htmlPurge': 'ok', 'errors': []})
        command, kwargs = calls[0]
        self.assertIn('{"tags":["html"]}', command)
        self.assertTrue(command[-1].endswith('/zones/' + release.CLOUDFLARE_ZONE_ID + '/purge_cache'))
        # 토큰은 명령줄에 남기지 않는다 — curl 이 파일 기술자로 읽는다
        self.assertFalse(any('purge-secret' in part for part in command))
        self.assertEqual(len(kwargs['pass_fds']), 1)

    def test_cloudfront_html_invalidation_is_optional_and_uses_the_operator_profile(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('NMV_CLOUDFRONT_DISTRIBUTION_ID', None)
            self.assertEqual(release.purge_cloudfront_html(), {'cloudfrontHtml': 'skipped', 'reason': 'no_distribution_id'})
        with patch.object(release, 'run', return_value='InProgress') as run:
            self.assertEqual(release.purge_cloudfront_html('E123'), {'cloudfrontHtml': 'ok', 'status': 'InProgress'})
        command = run.call_args.args[0]
        self.assertEqual(command[:3], ['aws', 'cloudfront', 'create-invalidation'])
        self.assertIn('nomorevibe', command)
        self.assertEqual(command[command.index('--paths') + 1], '#html')

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
