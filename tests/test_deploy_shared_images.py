"""Safety checks for the production release operator tool."""

import importlib.util
import io
import json
import os
import re
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

    def integration_apps(self, enabled=True):
        apps = self.apps()
        for short in ('maintenance-mini', 'maintenance-m3'):
            apps[short] = {'sourceType': 'github', 'applicationStatus': 'done', 'autoDeploy': True, 'replicas': 1,
                           'env': 'RELEASE_TAG=' + self.old_sha + '\nWORKER_ROLE=maintenance\n', 'appName': 'service-' + short}
        flags = ('PUBLIC_USER_AUTH_ENABLED', 'GITHUB_STAR_ENABLED', 'PRODUCT_FEEDBACK_ENABLED', 'GITHUB_FEEDBACK_DELIVERY_ENABLED')
        secrets = {'NEXT_PUBLIC_SITE_URL': 'https://nomorevibe.example', 'PUBLIC_AUTH_SECRET': 'p' * 40,
                   'AUTH_SECRET': 'a' * 40, 'LOGIN_EMAIL_API_KEY': 'mail-secret', 'LOGIN_EMAIL_FROM': 'login@example.test',
                   'GITHUB_INTEGRATION_SECRET': 'i' * 40, 'GITHUB_STAR_APP_ID': '101', 'GITHUB_STAR_APP_CLIENT_ID': 'star-client',
                   'GITHUB_STAR_APP_CLIENT_SECRET': 'star-secret', 'GITHUB_STAR_APP_WEBHOOK_SECRET': 'star-webhook-secret',
                   'GITHUB_FEEDBACK_APP_ID': '202', 'GITHUB_FEEDBACK_APP_SLUG': 'feedback-app', 'GITHUB_FEEDBACK_APP_CLIENT_ID': 'feedback-client',
                   'GITHUB_FEEDBACK_APP_CLIENT_SECRET': 'feedback-secret', 'GITHUB_FEEDBACK_APP_PRIVATE_KEY': 'feedback-private-key',
                   'GITHUB_FEEDBACK_APP_WEBHOOK_SECRET': 'feedback-webhook-secret'}
        for short in ('web-mini', 'web-m3', 'publisher-mini', 'publisher-m3', 'maintenance-mini', 'maintenance-m3'):
            names = flags if short.startswith('web') else ('GITHUB_FEEDBACK_DELIVERY_ENABLED',)
            if short.startswith('maintenance'):
                names += ('GITHUB_STAR_ENABLED',)
            apps[short]['env'] += ''.join(key + '=' + ('true' if enabled else 'false') + '\n' for key in names)
            apps[short]['env'] += ''.join(key + '=' + value + '\n' for key, value in secrets.items())
        return apps

    def test_integration_preflight_rejects_flag_or_secret_drift_without_any_write(self):
        apps = self.integration_apps()
        apps['publisher-mini']['env'] = release.replace_setting(apps['publisher-mini']['env'], 'GITHUB_FEEDBACK_APP_PRIVATE_KEY', 'different-private-key')
        client = FakeClient(apps)
        with self.assertRaisesRegex(ValueError, 'GITHUB_FEEDBACK_APP_PRIVATE_KEY_mismatch'):
            release.github_integration_preflight(client, apps)
        self.assertEqual(client.requests, [])
        apps = self.integration_apps()
        apps['web-mini']['env'] = release.replace_setting(apps['web-mini']['env'], 'PRODUCT_FEEDBACK_ENABLED', 'false')
        with self.assertRaisesRegex(ValueError, 'PRODUCT_FEEDBACK_ENABLED_mismatch'):
            release.github_integration_preflight(FakeClient(apps), apps)

    def test_integration_preflight_requires_enabled_credentials_and_exact_flags(self):
        for key in ('PUBLIC_AUTH_SECRET', 'LOGIN_EMAIL_API_KEY', 'GITHUB_STAR_APP_CLIENT_SECRET', 'GITHUB_FEEDBACK_APP_PRIVATE_KEY'):
            apps = self.integration_apps()
            apps['web-mini']['env'] = release.replace_setting(apps['web-mini']['env'], key, '')
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                release.github_integration_preflight(FakeClient(apps), apps)
        apps = self.integration_apps()
        apps['web-mini']['env'] = release.replace_setting(apps['web-mini']['env'], 'GITHUB_STAR_ENABLED', '1')
        with self.assertRaisesRegex(ValueError, 'GITHUB_STAR_ENABLED_invalid'):
            release.github_integration_preflight(FakeClient(apps), apps)

    def test_integration_preflight_checks_maintenance_read_only_without_deployment_assumptions(self):
        apps = self.integration_apps()
        output = io.StringIO()
        client = FakeClient(apps)
        with redirect_stdout(output):
            report = release.github_integration_preflight(client, apps)
        self.assertTrue(report['configurationMatched'])
        self.assertEqual(report['maintenance']['maintenance-mini']['sourceType'], 'github')
        self.assertTrue(report['maintenance']['maintenance-mini']['autoDeploy'])
        self.assertEqual(client.requests, [])
        self.assertEqual(tuple(release.APPS), release.ORDER)
        self.assertEqual(len(release.ORDER), 8)
        self.assertNotIn('maintenance-mini', release.ORDER)
        self.assertNotIn('mail-secret', json.dumps(report) + output.getvalue())
        self.assertNotIn('feedback-private-key', json.dumps(report) + output.getvalue())

    def test_integration_preflight_allows_disabled_unconfigured_apps_and_rejects_shared_app_identity(self):
        apps = self.integration_apps(False)
        for short in ('web-mini', 'web-m3', 'publisher-mini', 'publisher-m3', 'maintenance-mini', 'maintenance-m3'):
            apps[short]['env'] = '\n'.join(line for line in apps[short]['env'].splitlines()
                                          if not line.startswith(('GITHUB_', 'LOGIN_', 'PUBLIC_AUTH_SECRET='))
                                          or line.split('=', 1)[0].endswith('_ENABLED')) + '\n'
        self.assertTrue(release.github_integration_preflight(FakeClient(apps), apps)['configurationMatched'])
        apps = self.integration_apps()
        for short in ('web-mini', 'web-m3', 'publisher-mini', 'publisher-m3', 'maintenance-mini', 'maintenance-m3'):
            apps[short]['env'] = release.replace_setting(apps[short]['env'], 'GITHUB_FEEDBACK_APP_ID', '101')
        with self.assertRaisesRegex(ValueError, 'github_app_identity_reused'):
            release.github_integration_preflight(FakeClient(apps), apps)

    def test_integration_preflight_rejects_dependencies_and_maintenance_drift(self):
        apps = self.integration_apps()
        for short in ('web-mini', 'web-m3'):
            apps[short]['env'] = release.replace_setting(apps[short]['env'], 'PUBLIC_USER_AUTH_ENABLED', 'false')
        with self.assertRaisesRegex(ValueError, 'flag_dependency'):
            release.github_integration_preflight(FakeClient(apps), apps)
        apps = self.integration_apps()
        apps['maintenance-mini']['env'] = release.replace_setting(apps['maintenance-mini']['env'], 'RELEASE_TAG', '9' * 40)
        with self.assertRaisesRegex(ValueError, 'RELEASE_TAG_mismatch'):
            release.github_integration_preflight(FakeClient(apps), apps)
        apps = self.integration_apps()
        apps['maintenance-mini']['env'] = release.replace_setting(apps['maintenance-mini']['env'], 'WORKER_ROLE', 'publisher')
        with self.assertRaisesRegex(ValueError, 'maintenance_not_ready'):
            release.github_integration_preflight(FakeClient(apps), apps)

    def test_main_runs_integration_preflight_before_any_pull_or_deployment(self):
        apps = self.integration_apps()
        apps['web-mini']['env'] = release.replace_setting(apps['web-mini']['env'], 'PUBLIC_AUTH_SECRET', '')
        client = FakeClient(apps)
        state = {'apps': apps, 'previous': {'sha': self.old_sha, 'worker': self.old_worker, 'web': self.old_web}}
        args = ['plan', '--sha', self.new_sha, '--worker-image', self.target['worker'], '--web-image', self.target['web']]
        with patch.object(release, 'run', side_effect=['operator-secret', self.new_sha]), \
             patch.object(release, 'main_sha_and_token', return_value='registry-secret'), \
             patch.object(release, 'Dokploy', return_value=client), patch.object(release, 'baseline', return_value=state), \
             patch.object(release, 'pre_pull') as pull, patch.object(release, 'deploy') as deploy:
            with self.assertRaisesRegex(ValueError, 'PUBLIC_AUTH_SECRET'):
                release.main(args)
            pull.assert_not_called()
            deploy.assert_not_called()
        self.assertEqual(client.requests, [])

    def test_integration_preflight_accepts_minimum_worker_credential_scope(self):
        apps = self.integration_apps()
        publisher_keys = {'RELEASE_TAG', 'NEXT_PUBLIC_SITE_URL', 'GITHUB_FEEDBACK_DELIVERY_ENABLED', 'GITHUB_FEEDBACK_APP_ID', 'GITHUB_FEEDBACK_APP_PRIVATE_KEY'}
        maintenance_keys = publisher_keys | {'WORKER_ROLE'}
        for short in ('publisher-mini', 'publisher-m3', 'maintenance-mini', 'maintenance-m3'):
            allowed = maintenance_keys if short.startswith('maintenance') else publisher_keys
            apps[short]['env'] = '\n'.join(line for line in apps[short]['env'].splitlines() if line.split('=', 1)[0] in allowed) + '\n'
        self.assertTrue(release.github_integration_preflight(FakeClient(apps), apps)['configurationMatched'])

    def test_integration_preflight_defaults_legacy_missing_flags_to_false(self):
        apps = self.integration_apps(False)
        for app in apps.values():
            app['env'] = '\n'.join(line for line in app['env'].splitlines()
                                   if line.split('=', 1)[0] not in release.INTEGRATION_FLAGS) + '\n'
        report = release.github_integration_preflight(FakeClient(apps), apps)
        self.assertEqual(report['flags'], dict.fromkeys(release.INTEGRATION_FLAGS, False))
        # An explicitly disabled peer has the same effective runtime value.
        apps['web-mini']['env'] += 'PUBLIC_USER_AUTH_ENABLED=false\n'
        self.assertEqual(release.github_integration_preflight(FakeClient(apps), apps)['flags'], report['flags'])
        apps['web-mini']['env'] += 'PUBLIC_USER_AUTH_ENABLED=false\n'
        with self.assertRaisesRegex(ValueError, 'PUBLIC_USER_AUTH_ENABLED_line_count_2'):
            release.github_integration_preflight(FakeClient(apps), apps)

    def test_main_allows_a_legacy_disabled_configuration_in_plan_and_run(self):
        for action in ('plan', 'run'):
            apps = self.integration_apps(False)
            for app in apps.values():
                app['env'] = '\n'.join(line for line in app['env'].splitlines()
                                       if line.split('=', 1)[0] not in release.INTEGRATION_FLAGS) + '\n'
            state = {'apps': apps, 'previous': {'sha': self.old_sha, 'worker': self.old_worker, 'web': self.old_web}}
            args = [action, '--sha', self.new_sha, '--worker-image', self.target['worker'], '--web-image', self.target['web']]
            if action == 'run':
                args += ['--snapshot', '/private/tmp/unused-test-snapshot.json']
            with self.subTest(action=action), patch.object(release, 'run', side_effect=['operator-secret', self.new_sha, '']), \
                 patch.object(release, 'main_sha_and_token', return_value='registry-secret'), \
                 patch.object(release, 'Dokploy', return_value=FakeClient(apps)), patch.object(release, 'baseline', return_value=state), \
                 patch.object(release, 'monitor_gate'), patch.object(release, 'pre_pull'), patch.object(release, 'deploy') as deploy, \
                 redirect_stdout(io.StringIO()):
                release.main(args)
                self.assertEqual(deploy.call_count, int(action == 'run'))

    def test_integration_preflight_compares_complete_multiline_pem_without_disclosure(self):
        apps = self.integration_apps()
        key = 'GITHUB_FEEDBACK_APP_PRIVATE_KEY'
        pem = '-----BEGIN PRIVATE KEY-----\nsample-body-one\n-----END PRIVATE KEY-----'
        for short in ('web-mini', 'web-m3', 'publisher-mini', 'publisher-m3', 'maintenance-mini', 'maintenance-m3'):
            apps[short]['env'] = release.replace_setting(apps[short]['env'], key, '"' + pem + '"')
        output = io.StringIO()
        with redirect_stdout(output):
            report = release.github_integration_preflight(FakeClient(apps), apps)
        self.assertTrue(report['configurationMatched'])
        apps['publisher-mini']['env'] = apps['publisher-mini']['env'].replace('sample-body-one', 'sample-body-two')
        with redirect_stdout(output), self.assertRaisesRegex(ValueError, key + '_mismatch') as raised:
            release.github_integration_preflight(FakeClient(apps), apps)
        evidence = json.dumps(report) + output.getvalue() + str(raised.exception)
        self.assertNotIn('sample-body-one', evidence)
        self.assertNotIn('sample-body-two', evidence)
        self.assertNotIn('BEGIN PRIVATE KEY', evidence)
        # Dotenv quoted newlines and double-quoted escaped newlines are equivalent.
        apps['publisher-mini']['env'] = re.sub(r'(?ms)^' + key + r'=".*?"$', lambda _: key + '=' + json.dumps(pem), apps['publisher-mini']['env'])
        self.assertTrue(release.github_integration_preflight(FakeClient(apps), apps)['configurationMatched'])

    def test_dotenv_parser_rejects_duplicate_or_unterminated_quoted_keys_without_values(self):
        apps = self.integration_apps()
        apps['web-mini']['env'] += 'GITHUB_FEEDBACK_APP_PRIVATE_KEY="secret-body\n'
        with self.assertRaisesRegex(ValueError, 'GITHUB_FEEDBACK_APP_PRIVATE_KEY_line_count_2') as raised:
            release.github_integration_preflight(FakeClient(apps), apps)
        self.assertNotIn('secret-body', str(raised.exception))
        apps = self.integration_apps()
        apps['web-mini']['env'] = release.replace_setting(apps['web-mini']['env'], 'GITHUB_FEEDBACK_APP_PRIVATE_KEY', '"secret-body')
        with self.assertRaisesRegex(ValueError, 'GITHUB_FEEDBACK_APP_PRIVATE_KEY_unterminated'):
            release.github_integration_preflight(FakeClient(apps), apps)

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
