"""Safety checks for the production release operator tool."""

import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
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
        # 알림 메일을 켜면 maintenance 가 보내므로 발신 키·끄기 링크 서명 비밀도 받는다
        maintenance_keys = publisher_keys | {'WORKER_ROLE', 'LOGIN_EMAIL_API_KEY', 'LOGIN_EMAIL_FROM', 'PUBLIC_AUTH_SECRET'}
        for short in ('publisher-mini', 'publisher-m3', 'maintenance-mini', 'maintenance-m3'):
            allowed = maintenance_keys if short.startswith('maintenance') else publisher_keys
            apps[short]['env'] = '\n'.join(line for line in apps[short]['env'].splitlines() if line.split('=', 1)[0] in allowed) + '\n'
        self.assertTrue(release.github_integration_preflight(FakeClient(apps), apps)['configurationMatched'])

    def test_integration_preflight_requires_maintenance_mail_keys_when_email_is_enabled(self):
        for key in ('LOGIN_EMAIL_API_KEY', 'LOGIN_EMAIL_FROM', 'PUBLIC_AUTH_SECRET'):
            apps = self.integration_apps()
            apps['maintenance-m3']['env'] = release.replace_setting(apps['maintenance-m3']['env'], key, '')
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key + '_missing'):
                release.github_integration_preflight(FakeClient(apps), apps)
            apps = self.integration_apps()
            apps['maintenance-mini']['env'] = release.replace_setting(apps['maintenance-mini']['env'], key, 'x' * 40)
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key + '_mismatch') as raised:
                release.github_integration_preflight(FakeClient(apps), apps)
            self.assertNotIn('mail-secret', str(raised.exception))
        # 메일을 끈 웹(키 없음)이면 maintenance 에도 키가 없어야 한다 — GitHub 로그인만으로 운영하는 지금 모양은 그대로 통과한다
        apps = self.integration_apps()
        for short in ('web-mini', 'web-m3', 'maintenance-mini', 'maintenance-m3'):
            apps[short]['env'] = '\n'.join(line for line in apps[short]['env'].splitlines() if not line.startswith('LOGIN_EMAIL_')) + '\n'
        self.assertTrue(release.github_integration_preflight(FakeClient(apps), apps)['configurationMatched'])
        apps['maintenance-mini']['env'] += 'LOGIN_EMAIL_API_KEY=mail-secret\nLOGIN_EMAIL_FROM=login@example.test\n'
        with self.assertRaisesRegex(ValueError, 'LOGIN_EMAIL_maintenance_only'):
            release.github_integration_preflight(FakeClient(apps), apps)

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
                 patch.object(release, 'agent_scan_release_gate', return_value={'agentScanGate': 'release_gated'}), \
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
            with patch.object(release, 'probe', return_value={'ready': False}) as runtime, \
                 patch.object(release, 'check_app_deployed', return_value={'app': 'publisher-mini'}) as gate:
                result = release.restore(client, path, 'publisher-mini', 'token')
            runtime.assert_called_once_with('publisher-mini', current, previous, detail=True)
            self.assertEqual(result['app'], 'publisher-mini')
            self.assertEqual(client.requests, ['application.saveEnvironment',
                                               'application.saveDockerProvider', 'application.deploy'])
            gate.assert_called_once_with(client, 'publisher-mini', previous, 'old')


class OracleOfflineRoutingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        fixture_spec = importlib.util.spec_from_file_location(
            'oracle_runtime_fixtures', SOURCE.parents[2] / 'tests/test_oracle_runtime.py')
        self.fixtures = importlib.util.module_from_spec(fixture_spec)
        with patch.object(sys, 'path', sys.path[:]):
            fixture_spec.loader.exec_module(self.fixtures)
        self.prepared = self.fixtures.prepared(self.root / 'prepared')
        self.expected = self.root / 'expected-host.json'
        self.observed = self.root / 'observed-host.json'
        self.expected.write_text(json.dumps(self.fixtures.HOST))
        self.observed.write_text(json.dumps(self.fixtures.HOST))
        self.sha = 'a' * 40
        self.archive, self.digest = self.build(self.sha)
        self.offline = self.root / 'offline'
        self.legacy_run = self.enterContext(patch.object(release, 'run', return_value='unused-key'))
        self.dokploy = self.enterContext(patch.object(release, 'Dokploy'))

    def build(self, sha):
        archive = self.root / (sha + '.tar.gz')
        with patch.object(self.fixtures.builder, 'runtime_platform', return_value=self.fixtures.RUNTIME):
            result = self.fixtures.builder.build_release(self.prepared, archive, sha, 'v24.19.0')
        return archive, result['archiveSha256']

    def arguments(self, action='oracle-plan', sha=None, archive=None, digest=None):
        return [action, '--sha', sha or self.sha, '--archive', str(archive or self.archive),
                '--archive-sha256', digest or self.digest, '--expected-host', str(self.expected),
                '--observed-host', str(self.observed)]

    def invoke(self, arguments):
        output = io.StringIO()
        with redirect_stdout(output):
            release.main(arguments)
        return json.loads(output.getvalue())

    def test_oracle_plan_delegates_before_any_keychain_or_dokploy_access(self):
        before = sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*'))
        result = self.invoke(self.arguments())
        self.assertEqual(result, {'action': 'oracle-plan', 'releaseSha': self.sha, 'files': 14,
                                  'readiness': 'unverified', 'activationAllowed': False})
        self.assertEqual(sorted(str(path.relative_to(self.root)) for path in self.root.rglob('*')), before)
        self.legacy_run.assert_not_called()
        self.dokploy.assert_not_called()

    def test_oracle_install_and_explicit_rollback_use_actual_offline_current_cas(self):
        sentinel = self.offline / 'opt/nomorevibe-x/status'
        sentinel.parent.mkdir(parents=True)
        sentinel.write_bytes(b'existing-X-state')
        first = self.invoke(self.arguments('oracle-install') + ['--staging-root', str(self.offline)])
        self.assertEqual(first['previous'], None)
        self.assertEqual(first['current'], self.sha)
        other_sha = 'b' * 40
        other, other_digest = self.build(other_sha)
        second = self.invoke(self.arguments('oracle-install', other_sha, other, other_digest) +
                             ['--staging-root', str(self.offline), '--expected-current', self.sha])
        self.assertEqual(second['previous'], self.sha)
        self.assertEqual(second['current'], other_sha)
        rollback = self.invoke(self.arguments('oracle-rollback') +
                               ['--staging-root', str(self.offline), '--expected-current', other_sha])
        self.assertEqual(rollback['current'], self.sha)
        self.assertEqual(os.readlink(self.offline / 'opt/nomorevibe-core/current'), 'releases/' + self.sha)
        for result in (first, second, rollback):
            self.assertFalse(result['activationAllowed'])
            self.assertEqual(result['readiness'], 'unverified')
        self.assertEqual(sentinel.read_bytes(), b'existing-X-state')
        staged_launcher = self.offline / f'opt/nomorevibe-core/releases/{self.sha}/deploy/oracle/launch.py'
        self.assertEqual(staged_launcher.read_bytes(), (self.fixtures.SOURCE / 'launch.py').read_bytes())

    def test_oracle_rejects_missing_cross_family_and_abbreviated_arguments_before_io(self):
        valid = self.arguments()
        without_host = valid[:valid.index('--expected-host')]
        cases = [without_host, valid + ['--worker-image', self.archive.as_posix()],
                 valid + ['--snapshot', str(self.offline)], valid + ['--app', 'web-m3'],
                 valid + ['--migration-verified'], valid + ['--staging-root', str(self.offline)],
                 valid + ['--expected-current', self.sha],
                 self.arguments('oracle-install'),
                 self.arguments('oracle-rollback') + ['--staging-root', str(self.offline)],
                 [part if part != '--archive-sha256' else '--archive-sha' for part in valid],
                 ['plan', '--archive', str(self.archive)]]
        for arguments in cases:
            with self.subTest(arguments=arguments), redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as caught:
                    release.main(arguments)
                self.assertEqual(caught.exception.code, 2)
                self.assertFalse(self.offline.exists())
        self.legacy_run.assert_not_called()
        self.dokploy.assert_not_called()

    def test_oracle_identity_and_archive_errors_leave_offline_tree_absent(self):
        base = self.arguments('oracle-install') + ['--staging-root', str(self.offline)]
        for boundary in ('sha', 'host', 'archive'):
            with self.subTest(boundary=boundary):
                arguments = base[:]
                if boundary == 'sha':
                    arguments[arguments.index('--sha') + 1] = 'f' * 40
                elif boundary == 'host':
                    self.observed.write_text(json.dumps({**self.fixtures.HOST, 'instance': 'onetwoday'}))
                else:
                    self.archive.write_bytes(self.archive.read_bytes() + b'changed')
                try:
                    with self.assertRaises(ValueError):
                        release.main(arguments)
                    self.assertFalse(self.offline.exists())
                finally:
                    self.observed.write_text(json.dumps(self.fixtures.HOST))
        self.legacy_run.assert_not_called()
        self.dokploy.assert_not_called()

    def test_oracle_missing_or_stale_current_preserves_pointer_and_verified_stage(self):
        self.invoke(self.arguments('oracle-install') + ['--staging-root', str(self.offline)])
        base = self.offline / 'opt/nomorevibe-core'
        original = (base / f'releases/{self.sha}/release.json').read_bytes()
        other_sha = 'b' * 40
        other, digest = self.build(other_sha)
        for current in (None, 'c' * 40):
            arguments = self.arguments('oracle-install', other_sha, other, digest) + ['--staging-root', str(self.offline)]
            if current is not None:
                arguments += ['--expected-current', current]
            with self.subTest(current=current), self.assertRaisesRegex(ValueError, 'current_release_changed'):
                release.main(arguments)
            self.assertEqual(os.readlink(base / 'current'), 'releases/' + self.sha)
            self.assertEqual((base / f'releases/{self.sha}/release.json').read_bytes(), original)
            self.assertTrue((base / f'releases/{other_sha}').is_dir())
        self.legacy_run.assert_not_called()
        self.dokploy.assert_not_called()

    def test_oracle_rollback_reconstructs_missing_approved_target_without_guessing(self):
        self.invoke(self.arguments('oracle-install') + ['--staging-root', str(self.offline)])
        other_sha = 'b' * 40
        other, digest = self.build(other_sha)
        self.invoke(self.arguments('oracle-install', other_sha, other, digest) +
                    ['--staging-root', str(self.offline), '--expected-current', self.sha])
        base = self.offline / 'opt/nomorevibe-core'
        shutil.rmtree(base / f'releases/{self.sha}')
        result = self.invoke(self.arguments('oracle-rollback') +
                             ['--staging-root', str(self.offline), '--expected-current', other_sha])
        self.assertEqual(result['previous'], other_sha)
        self.assertEqual(result['current'], self.sha)
        self.assertTrue((base / f'releases/{self.sha}/package.json').is_file())
        self.legacy_run.assert_not_called()
        self.dokploy.assert_not_called()

    def test_oracle_refuses_live_root_and_ancestor_excluded_namespace(self):
        excluded = self.root / 'nomorevibe-x'
        excluded.mkdir()
        (excluded / 'child').mkdir()
        (excluded / 'sentinel').write_bytes(b'preserved')
        alias = self.root / 'alias'
        alias.symlink_to(excluded, target_is_directory=True)
        before = sorted(str(path.relative_to(excluded)) for path in excluded.rglob('*'))
        for destination in (Path('/'), alias / 'child'):
            with self.subTest(destination=destination), self.assertRaisesRegex(ValueError, 'offline_staging_root_required'):
                release.main(self.arguments('oracle-install') + ['--staging-root', str(destination)])
        self.assertEqual(sorted(str(path.relative_to(excluded)) for path in excluded.rglob('*')), before)
        self.assertEqual((excluded / 'sentinel').read_bytes(), b'preserved')
        self.legacy_run.assert_not_called()
        self.dokploy.assert_not_called()

    def test_oracle_native_error_identity_and_cleanup_group_propagate_to_inprocess_caller(self):
        _, manager = release.oracle_modules()
        original, cleanup = OSError('private-read-detail'), OSError('private-close-detail')
        combined = BaseExceptionGroup('original-and-cleanup', [original, cleanup])
        for error in (original, combined):
            with self.subTest(error=type(error).__name__), patch.object(manager, 'inspect_archive', side_effect=error):
                with self.assertRaises(Exception) as caught:
                    release.main(self.arguments())
                self.assertIs(caught.exception, error)
        self.assertFalse(self.offline.exists())
        self.legacy_run.assert_not_called()
        self.dokploy.assert_not_called()

    def test_oracle_cli_loads_fixed_repository_manager_and_returns_only_safe_error_fields(self):
        private_archive = self.root / 'private-credential-detail.tar.gz'
        arguments = self.arguments()
        arguments[arguments.index('--archive') + 1] = str(private_archive)
        command = [sys.executable, str(SOURCE), *arguments]
        failed = subprocess.run(command, cwd=self.root, capture_output=True, text=True, timeout=5)
        self.assertEqual(failed.returncode, 1)
        self.assertEqual(json.loads(failed.stdout), {'error': 'ValueError', 'code': 'oracle_offline_release_failed',
                                                   'readiness': 'unverified', 'activationAllowed': False})
        self.assertNotIn('private-credential-detail', failed.stdout + failed.stderr)
        self.assertEqual(failed.stderr, '')
        planned = subprocess.run([sys.executable, str(SOURCE), *self.arguments()], cwd=self.root,
                                 capture_output=True, text=True, timeout=5)
        self.assertEqual(planned.returncode, 0, planned.stderr)
        self.assertFalse(json.loads(planned.stdout)['activationAllowed'])
        self.assertFalse(self.offline.exists())



class FleetInventoryTests(unittest.TestCase):
    """Read-only coverage of the 16-app fleet; the shared-image release stays at 8 apps by default."""

    def setUp(self):
        self.sha = 'b' * 40

    # 2026-10-20: agent-scan-consumer-m3 is the one consumer app that exists in Dokploy; inventory covers it like an image worker
    REGISTERED_CONSUMERS = ('agent-scan-consumer-m3',)

    def fleet(self, release_tag=None):
        return {short: {'sourceType': 'docker' if short in release.APPS or short in release.CONSUMER_APPS or short in release.AUXILIARY_APPS else 'github',
                        'applicationStatus': 'done', 'replicas': 1,
                        'env': 'RELEASE_TAG=' + (release_tag or self.sha) + '\nSECRET_TOKEN=do-not-print\n', 'appName': 'service-' + short}
                for short in tuple(release.KNOWN_APPS) + self.REGISTERED_CONSUMERS}

    def test_catalog_covers_the_production_fleet_and_never_oracle_or_unregistered_split_roles(self):
        self.assertEqual(release.ORDER, tuple(release.APPS))
        self.assertEqual(len(release.APPS), 8)
        self.assertEqual(sorted(release.GIT_BUILD_APPS), ['connect-agent-m3', 'maintenance-m3', 'maintenance-mini',
                                                           'scheduler-m3', 'text-m3', 'text-mini'])
        self.assertEqual(len(set(release.APPS) | set(release.GIT_BUILD_APPS)) - 1, 13)  # connect-agent is outside the 13
        ids = [metadata[0] for metadata in release.KNOWN_APPS.values()]
        self.assertEqual(len(ids), len(set(ids)))
        for short in release.KNOWN_APPS:
            self.assertFalse(any(word in short for word in ('oracle', 'translation', 'product-health', 'site-evidence', 'official-news')))

    def test_inventory_reads_every_app_without_writes_or_secret_values(self):
        client = FakeClient(self.fleet())
        result = release.inventory(client, self.sha)
        self.assertEqual(client.requests, [])
        self.assertEqual((result['appCount'], result['complete'], result['pending']), (16, True, []))
        self.assertEqual({short: row['deployedBy'] for short, row in result['apps'].items()},
                         {short: 'manual-docker' if short in release.AUXILIARY_APPS else 'run' if short in release.APPS or short in release.CONSUMER_APPS else 'manual-git-build'
                          for short in tuple(release.KNOWN_APPS) + self.REGISTERED_CONSUMERS})
        self.assertNotIn('do-not-print', json.dumps(result))
        self.assertEqual((result['splitRoleApps'], result['oracle']), ('none_registered', 'outside_dokploy'))

    def test_a_lagging_git_build_app_or_missing_release_line_is_reported_incomplete(self):
        apps = self.fleet()
        apps['text-m3']['env'] = 'RELEASE_TAG=' + 'a' * 40 + '\n'
        apps['scheduler-m3']['env'] = 'WORKER_ROLE=scheduler\n'
        result = release.inventory(FakeClient(apps), self.sha)
        self.assertFalse(result['complete'])
        self.assertEqual(result['pending'], ['scheduler-m3', 'text-m3'])
        with self.assertRaisesRegex(ValueError, 'invalid_release_sha'):
            release.inventory(FakeClient(apps), 'main')

    def test_dokploy_identity_is_checked_for_git_build_apps(self):
        client = release.Dokploy('unused-key')
        with patch.object(client, 'request', return_value={'applicationId': 'Pi0loosJrKsse_UQ0mln9', 'name': 'other-app',
                                                          'serverId': release.M3[0], 'appName': 'app-text'}):
            with self.assertRaisesRegex(ValueError, 'text-m3_identity_mismatch'):
                client.app('text-m3')
        with patch.object(client, 'request', return_value={'applicationId': 'Pi0loosJrKsse_UQ0mln9', 'name': 'nomorevibe-text-m3',
                                                          'serverId': release.M3[0], 'appName': 'app-text'}):
            self.assertEqual(client.app('text-m3')['name'], 'nomorevibe-text-m3')

    def test_monitor_inventory_reports_a_stale_or_failed_auxiliary_without_exposing_push_urls(self):
        for drift, pending in (({'env': 'RELEASE_TAG=' + 'a' * 40 + '\nPUSH_URL=https://receiver.invalid/private-token\n'}, ['monitor-m3']),
                               ({'env': 'PUSH_URL=https://receiver.invalid/private-token\n'}, ['monitor-m3']),
                               ({'applicationStatus': 'error'}, [])):
            apps = self.fleet()
            apps['monitor-m3'].update(drift)
            client = FakeClient(apps)
            with self.subTest(drift=tuple(drift)):
                result = release.inventory(client, self.sha)
                self.assertEqual(result['appCount'], 16)
                self.assertFalse(result['complete'])
                self.assertEqual(result['pending'], pending)
                self.assertEqual(result['apps']['monitor-m3']['deployedBy'], 'manual-docker')
                self.assertNotIn('private-token', json.dumps(result))
                self.assertEqual(client.requests, [])

    def test_monitor_identity_requires_its_registered_app_server_and_docker_monitor_stage(self):
        self.assertEqual(release.app_metadata('monitor-m3'),
                         ('WbGj-YxQGHNEoGElyTLBq', 'nomorevibe-monitor-m3', release.M3, 'monitor'))
        identity = {'applicationId': 'WbGj-YxQGHNEoGElyTLBq', 'name': 'nomorevibe-monitor-m3', 'serverId': release.M3[0],
                    'appName': 'nomorevibe-monitor-m3-7i7xmc', 'sourceType': 'docker', 'dockerBuildStage': 'monitor'}
        client = release.Dokploy('unused-key')
        with patch.object(client, 'request', return_value=identity) as request:
            self.assertEqual(client.app('monitor-m3'), identity)
            request.assert_called_once_with('application.one?applicationId=WbGj-YxQGHNEoGElyTLBq')
        for drift in ({'applicationId': 'other-app'}, {'name': 'nomorevibe-crawler-m3'}, {'serverId': release.MINI[0]},
                      {'sourceType': 'github'}, {'dockerBuildStage': 'worker'}, {'dockerBuildStage': 'runner'},
                      {'dockerBuildStage': None}):
            with self.subTest(drift=drift), patch.object(client, 'request', return_value=dict(identity, **drift)):
                with self.assertRaisesRegex(ValueError, 'monitor-m3_identity_mismatch'):
                    client.app('monitor-m3')

    def test_main_inventory_accepts_only_sha_and_exits_nonzero_when_incomplete(self):
        for extra in (['--worker-image', 'x'], ['--snapshot', '/private/tmp/x.json'], ['--migration-verified'], []):
            arguments = ['inventory'] + (['--sha', self.sha] if extra else []) + extra
            with self.subTest(extra=extra), patch.object(release, 'run') as keychain, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    release.main(arguments)
                keychain.assert_not_called()
        apps = self.fleet()
        apps['text-mini']['env'] = 'RELEASE_TAG=' + 'a' * 40 + '\n'
        for fleet, code in ((self.fleet(), None), (apps, 2)):
            output = io.StringIO()
            with patch.object(release, 'run', return_value='operator-secret'), \
                 patch.object(release, 'Dokploy', return_value=FakeClient(fleet)), redirect_stdout(output):
                if code is None:
                    release.main(['inventory', '--sha', self.sha])
                else:
                    with self.assertRaises(SystemExit) as caught:
                        release.main(['inventory', '--sha', self.sha])
                    self.assertEqual(caught.exception.code, code)
            self.assertNotIn('operator-secret', output.getvalue())
            self.assertEqual(json.loads(output.getvalue())['complete'], code is None)


class AuxiliaryReleaseIsolationTests(unittest.TestCase):
    """Auxiliary commands and healthchecks must survive a normal shared-image release unchanged."""

    def setUp(self):
        ReleaseSafetyTests.setUp(self)

    def test_default_baseline_and_run_never_read_or_deploy_the_auxiliary_monitor(self):
        apps = ReleaseSafetyTests.apps(self)
        # A broken auxiliary must not block a shared-image release or be rewritten by it.
        apps['monitor-m3'] = {'sourceType': 'docker', 'applicationStatus': 'error', 'env': 'RELEASE_TAG=older\n',
                              'dockerBuildStage': 'monitor', 'command': 'tini -- watch-worker-progress'}
        client = FakeClient(apps)
        with patch.object(client, 'app', wraps=client.app) as read_app, \
             patch.object(client, 'latest', wraps=client.latest) as read_latest, \
             patch.object(release, 'probe', return_value={'ready': True}):
            state = release.baseline(client, self.target)
        self.assertEqual(tuple(state['apps']), release.ORDER)
        self.assertEqual([call.args[0] for call in read_app.call_args_list], list(release.ORDER))
        self.assertEqual([call.args[0] for call in read_latest.call_args_list], list(release.ORDER))
        for parallel in (False, True):
            deployed = []
            with self.subTest(parallel=parallel), patch.object(release, 'save_snapshot'), \
                 patch.object(release, 'stage_and_deploy', side_effect=lambda _c, short, _t, _k, _p: deployed.append(short) or {'app': short}), \
                 patch.object(release, 'monitor_gate', return_value={}), patch.object(release, 'public_gate', return_value={}), \
                 patch.object(release, 'purge_html', return_value={}), redirect_stdout(io.StringIO()):
                release.deploy(client, self.target, 'unused-token', state, '/private/tmp/unused-snapshot.json', parallel_roles=parallel)
                self.assertCountEqual(deployed, release.ORDER)
                self.assertEqual(len(deployed), 8)
        self.assertEqual(client.requests, [])
        self.assertEqual(apps['monitor-m3']['command'], 'tini -- watch-worker-progress')

    def test_restore_rejects_monitor_before_keychain_or_dokploy_even_if_snapshot_lists_it(self):
        with patch.object(release, 'run') as keychain, patch.object(release, 'Dokploy') as dokploy, redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                release.main(['restore', '--snapshot', '/private/tmp/unused-snapshot.json', '--app', 'monitor-m3'])
            keychain.assert_not_called()
            dokploy.assert_not_called()
        client = FakeClient({})
        with patch.object(release, 'read_snapshot', return_value={'apps': {'monitor-m3': {}}}), \
             patch.object(client, 'app', wraps=client.app) as read_app:
            with self.assertRaisesRegex(ValueError, 'app_missing_from_snapshot'):
                release.restore(client, '/private/tmp/unused-snapshot.json', 'monitor-m3', 'unused-token')
            read_app.assert_not_called()
        self.assertEqual(client.requests, [])


AI_CONSUMERS = ('ai1-consumer-mini', 'ai1-consumer-m3', 'ai2-consumer-mini', 'ai2-consumer-m3')
# E5: the agent-scan consumer runs crawler code on M3 only (its other host is Oracle).
CONSUMERS = AI_CONSUMERS + ('agent-scan-consumer-m3',)


class ConsumerAppRegistrationTests(unittest.TestCase):
    """PR06e: AI1/AI2 consumer apps are known by name only; an empty Dokploy ID is refused, never guessed; `run` is unchanged without --consumer."""

    def setUp(self):
        self.old_sha, self.new_sha = 'a' * 40, 'b' * 40
        self.old_worker = release.IMAGE_PREFIX['worker'] + 'sha256:' + 'c' * 64
        self.old_web = release.IMAGE_PREFIX['web'] + 'sha256:' + 'd' * 64
        self.target = release.validate_target(self.new_sha, release.IMAGE_PREFIX['worker'] + 'sha256:' + 'e' * 64,
                                              release.IMAGE_PREFIX['web'] + 'sha256:' + 'f' * 64)

    def registered(self):
        """Fixture IDs only — the real Dokploy apps do not exist yet."""
        return patch.dict(release.CONSUMER_APPS, {short: ('fixture-' + short, 'nomorevibe-' + short, metadata[2], metadata[3])
                                                  for short, metadata in release.CONSUMER_APPS.items()})

    def apps(self):
        apps = ReleaseSafetyTests.apps(self)
        for short in CONSUMERS:
            apps[short] = dict(apps['reviewer-m3'], appName='service-' + short)
        return apps

    def test_consumer_apps_are_unregistered_and_outside_the_existing_fleet(self):
        self.assertEqual(tuple(release.CONSUMER_APPS), CONSUMERS)
        for short, (app_id, name, server, kind) in release.CONSUMER_APPS.items():
            if short in AI_CONSUMERS:
                self.assertEqual((app_id, name, kind), ('', '', 'worker'))
            self.assertEqual(server, release.MINI if short.endswith('-mini') else release.M3)
            self.assertNotIn(short, release.KNOWN_APPS)
        self.assertEqual(release.release_order(), release.ORDER)

    def test_the_agent_scan_consumer_app_is_registered_on_m3(self):
        # 2026-10-20: created in Dokploy as a copy of crawler-m3; it is still released only with --consumer agent-scan
        self.assertEqual(release.CONSUMER_APPS['agent-scan-consumer-m3'],
                         ('LIRNQFq9mWGBOWRshJ-19', 'nomorevibe-agent-scan-consumer-m3', release.M3, 'worker'))
        self.assertEqual(release.consumer_apps(['agent-scan']), ('agent-scan-consumer-m3',))

    def test_an_unregistered_consumer_is_refused_before_any_dokploy_request(self):
        client = release.Dokploy('unused-key')
        with patch.object(client, 'request') as request:
            for short in AI_CONSUMERS:
                with self.assertRaisesRegex(ValueError, short + '_app_unregistered'):
                    client.app(short)
                with self.assertRaisesRegex(ValueError, short + '_app_unregistered'):
                    client.latest(short)
            request.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'ai3-consumer-m3_unknown_app'):
            release.app_metadata('ai3-consumer-m3')
        with self.assertRaisesRegex(ValueError, 'ai1-consumer-mini_app_unregistered'):
            release.consumer_apps(['ai1'])

    def test_main_refuses_unregistered_or_misused_consumer_targets_before_keychain(self):
        base = ['--sha', self.new_sha, '--worker-image', self.target['worker'], '--web-image', self.target['web']]
        for arguments, error in ((['plan'] + base + ['--consumer', 'ai2'], 'ai2-consumer-mini_app_unregistered'),
                                 (['run'] + base + ['--snapshot', '/private/tmp/x.json', '--consumer', 'ai1'], 'ai1-consumer-mini_app_unregistered'),
                                 (['restore', '--snapshot', '/private/tmp/x.json', '--app', 'ai1-consumer-m3'], 'ai1-consumer-m3_app_unregistered')):
            with self.subTest(arguments=arguments), patch.object(release, 'run') as keychain, patch.object(release, 'Dokploy') as dokploy:
                with self.assertRaisesRegex(ValueError, error):
                    release.main(arguments)
                keychain.assert_not_called()
                dokploy.assert_not_called()
        for arguments in (['plan'] + base + ['--consumer', 'ai1', '--consumer', 'ai1'], ['plan'] + base + ['--consumer', 'ai3'],
                          ['inventory', '--sha', self.new_sha, '--consumer', 'ai1'],
                          ['restore', '--snapshot', '/private/tmp/x.json', '--app', 'reviewer-m3', '--consumer', 'ai1']):
            with self.subTest(arguments=arguments), patch.object(release, 'run') as keychain, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    release.main(arguments)
                keychain.assert_not_called()

    def test_inventory_lists_unregistered_consumers_without_counting_them_and_covers_registered_ones(self):
        fleet = {short: {'sourceType': 'docker', 'applicationStatus': 'done', 'replicas': 1, 'env': 'RELEASE_TAG=' + self.new_sha + '\n'}
                 for short in tuple(release.KNOWN_APPS) + CONSUMERS}
        result = release.inventory(FakeClient(fleet), self.new_sha)
        self.assertEqual((result['appCount'], result['complete']), (16, True))
        self.assertEqual(result['consumerApps'], {**dict.fromkeys(AI_CONSUMERS, 'unregistered'), 'agent-scan-consumer-m3': 'registered'})
        fleet['ai2-consumer-m3']['env'] = 'RELEASE_TAG=' + self.old_sha + '\n'
        with self.registered():
            result = release.inventory(FakeClient(fleet), self.new_sha)
        self.assertEqual((result['appCount'], result['complete'], result['pending']), (20, False, ['ai2-consumer-m3']))
        self.assertEqual(result['consumerApps'], dict.fromkeys(CONSUMERS, 'registered'))
        self.assertEqual({short: result['apps'][short]['deployedBy'] for short in CONSUMERS}, dict.fromkeys(CONSUMERS, 'run'))

    def test_registered_consumer_identity_is_checked_like_an_image_worker(self):
        with self.registered():
            client = release.Dokploy('unused-key')
            identity = {'applicationId': 'fixture-ai1-consumer-m3', 'name': 'nomorevibe-ai1-consumer-m3', 'serverId': release.M3[0],
                        'appName': 'app-ai1', 'dockerBuildStage': 'worker'}
            with patch.object(client, 'request', return_value=identity):
                self.assertEqual(client.app('ai1-consumer-m3')['name'], 'nomorevibe-ai1-consumer-m3')
            for drift in ({'name': 'nomorevibe-reviewer-m3'}, {'serverId': release.MINI[0]}, {'dockerBuildStage': 'runner'}):
                with self.subTest(drift=drift), patch.object(client, 'request', return_value=dict(identity, **drift)):
                    with self.assertRaisesRegex(ValueError, 'ai1-consumer-m3_identity_mismatch'):
                        client.app('ai1-consumer-m3')

    def test_baseline_includes_only_selected_consumers_with_the_same_release_image_and_single_replica(self):
        apps = self.apps()
        with self.registered(), patch.object(release, 'probe', return_value={'ready': True}) as probe:
            state = release.baseline(FakeClient(apps), self.target, ('ai1-consumer-mini', 'ai1-consumer-m3'))
            self.assertEqual(tuple(state['apps']), release.ORDER[:4] + ('ai1-consumer-mini', 'ai1-consumer-m3') + release.ORDER[4:])
            self.assertEqual([call.args[0] for call in probe.call_args_list], list(state['apps']))
            for key, value, error in (('env', 'RELEASE_TAG=' + '9' * 40 + '\n', 'ai1-consumer-m3_baseline_release_mismatch'),
                                      ('replicas', 2, 'ai1-consumer-m3_baseline_not_ready'),
                                      ('dockerImage', self.old_web, 'ai1-consumer-m3_baseline_not_ready')):
                broken = self.apps()
                broken['ai1-consumer-m3'][key] = value
                with self.subTest(key=key), self.assertRaisesRegex(ValueError, error):
                    release.baseline(FakeClient(broken), self.target, ('ai1-consumer-mini', 'ai1-consumer-m3'))
        with patch.object(release, 'probe', return_value={'ready': True}):
            self.assertEqual(tuple(release.baseline(FakeClient(self.apps()), self.target)['apps']), release.ORDER)

    def test_run_deploys_selected_consumers_right_after_the_reviewer_pair_before_its_gate(self):
        steps = []
        with self.registered(), patch.object(release, 'save_snapshot'), \
             patch.object(release, 'stage_and_deploy', side_effect=lambda _c, short, _t, _k, _p: steps.append(short) or {'app': short}), \
             patch.object(release, 'monitor_gate', side_effect=lambda _c, role: steps.append('gate:' + role) or {'role': role}), \
             patch.object(release, 'public_gate', return_value={}), patch.object(release, 'purge_html', return_value={}), \
             redirect_stdout(io.StringIO()):
            release.deploy(None, self.target, 'token', {'apps': {}, 'previous': {}}, '/private/tmp/s.json', AI_CONSUMERS)
        self.assertEqual(steps, ['publisher-mini', 'publisher-m3', 'gate:publisher', 'reviewer-mini', 'reviewer-m3', *AI_CONSUMERS,
                                 'gate:reviewer', 'crawler-mini', 'crawler-m3', 'gate:crawler', 'web-mini', 'web-m3'])

    def test_agent_scan_consumer_follows_the_crawler_pair_before_its_gate(self):
        """E5: the M3-only agent-scan app runs crawler code; selecting it leaves every other app and gate where it was."""
        with self.registered():
            self.assertEqual(release.consumer_apps(['agent-scan']), ('agent-scan-consumer-m3',))
            self.assertEqual(release.consumer_apps(['ai1', 'agent-scan']), ('ai1-consumer-mini', 'ai1-consumer-m3', 'agent-scan-consumer-m3'))
        self.assertEqual(release.release_order(('agent-scan-consumer-m3',)),
                         release.ORDER[:6] + ('agent-scan-consumer-m3',) + release.ORDER[6:])
        self.assertEqual(release.release_order(CONSUMERS), release.ORDER[:4] + AI_CONSUMERS + release.ORDER[4:6]
                         + ('agent-scan-consumer-m3',) + release.ORDER[6:])
        steps = []
        with self.registered(), patch.object(release, 'save_snapshot'), \
             patch.object(release, 'stage_and_deploy', side_effect=lambda _c, short, _t, _k, _p: steps.append(short) or {'app': short}), \
             patch.object(release, 'monitor_gate', side_effect=lambda _c, role: steps.append('gate:' + role) or {'role': role}), \
             patch.object(release, 'public_gate', return_value={}), patch.object(release, 'purge_html', return_value={}), \
             redirect_stdout(io.StringIO()):
            release.deploy(None, self.target, 'token', {'apps': {}, 'previous': {}}, '/private/tmp/s.json', CONSUMERS)
        self.assertEqual(steps, ['publisher-mini', 'publisher-m3', 'gate:publisher', 'reviewer-mini', 'reviewer-m3', *AI_CONSUMERS,
                                 'gate:reviewer', 'crawler-mini', 'crawler-m3', 'agent-scan-consumer-m3', 'gate:crawler', 'web-mini', 'web-m3'])

    def test_stage_and_restore_use_the_consumer_app_id_and_worker_image(self):
        class ConsumerClient(FakeClient):
            def request(self, path, payload=None):
                self.requests.append((path, payload and payload['applicationId']))
                if path == 'application.saveEnvironment':
                    self.apps['ai2-consumer-mini'].update(env=payload['env'])
                elif path == 'application.saveDockerProvider':
                    self.apps['ai2-consumer-mini']['dockerImage'] = payload['dockerImage']
        apps = self.apps()
        previous = {'sha': self.old_sha, 'worker': self.old_worker, 'web': self.old_web}
        with self.registered(), patch.object(release, 'check_app_deployed', return_value={'app': 'ai2-consumer-mini'}) as gate:
            client = ConsumerClient(apps)
            release.stage_and_deploy(client, 'ai2-consumer-mini', self.target, 'token', previous)
            self.assertEqual(client.requests, [(path, 'fixture-ai2-consumer-mini') for path in
                                               ('application.saveEnvironment', 'application.saveDockerProvider', 'application.deploy')])
            self.assertEqual((apps['ai2-consumer-mini']['dockerImage'], release.setting(apps['ai2-consumer-mini']['env'], 'RELEASE_TAG')),
                             (self.target['worker'], self.new_sha))
            gate.assert_called_once_with(client, 'ai2-consumer-mini', self.target, 'old')
            with tempfile.TemporaryDirectory() as directory:
                path = str(Path(directory) / 'snapshot.json')
                original = dict(apps['ai2-consumer-mini'], dockerImage=self.old_worker, env='RELEASE_TAG=' + self.old_sha + '\n')
                release.save_snapshot(path, self.target, {'previous': previous, 'apps': {'ai2-consumer-mini': original}})
                client.requests.clear()
                release.restore(client, path, 'ai2-consumer-mini', 'token')
            self.assertEqual([request[1] for request in client.requests], ['fixture-ai2-consumer-mini'] * 3)
            self.assertEqual(apps['ai2-consumer-mini']['dockerImage'], self.old_worker)

    def test_main_plan_passes_selected_consumers_to_baseline_and_prints_their_order(self):
        apps = self.apps()
        state = {'apps': apps, 'previous': {'sha': self.old_sha, 'worker': self.old_worker, 'web': self.old_web}}
        output = io.StringIO()
        with self.registered(), patch.object(release, 'run', side_effect=['operator-secret', self.new_sha, '']), \
             patch.object(release, 'main_sha_and_token', return_value='registry-secret'), \
             patch.object(release, 'Dokploy', return_value=FakeClient(apps)), patch.object(release, 'baseline', return_value=state) as baseline, \
             patch.object(release, 'github_integration_preflight', return_value={}), patch.object(release, 'monitor_gate'), \
             patch.object(release, 'agent_scan_release_gate', return_value={'agentScanGate': 'release_gated'}), \
             patch.object(release, 'pre_pull'), redirect_stdout(output):
            release.main(['plan', '--sha', self.new_sha, '--worker-image', self.target['worker'], '--web-image', self.target['web'],
                          '--consumer', 'ai2'])
        self.assertEqual(baseline.call_args.args[2], ('ai2-consumer-mini', 'ai2-consumer-m3'))
        self.assertEqual(json.loads(output.getvalue())['plan'],
                         list(release.ORDER[:4]) + ['ai2-consumer-mini', 'ai2-consumer-m3'] + list(release.ORDER[4:]))


class MigrationGateTests(unittest.TestCase):
    """F4: a release with DB changes is refused unless the production journal is mechanically confirmed (read-only)."""

    def setUp(self):
        self.sql = b'CREATE TABLE x (id int);\n--> statement-breakpoint\nSELECT 1;\n'
        self.journal = {'entries': [{'idx': 0, 'when': 1000, 'tag': '0000_first'}, {'idx': 1, 'when': 2000, 'tag': '0001_second'}]}
        self.digest = __import__('hashlib').sha256(self.sql).hexdigest()

    def blobs(self, journal=None):
        files = {'drizzle/meta/_journal.json': json.dumps(journal or self.journal).encode(), 'drizzle/0001_second.sql': self.sql}
        return patch.object(release, 'git_blob', side_effect=lambda _sha, path: files[path])

    def test_journal_hashes_the_exact_committed_bytes_and_requires_strictly_increasing_when(self):
        with self.blobs():
            self.assertEqual(release.migration_journal('b' * 40), {'count': 2, 'when': 2000, 'tag': '0001_second', 'hash': self.digest})
        for entries in ([{'when': 2000, 'tag': '0000_a'}, {'when': 2000, 'tag': '0001_b'}], [{'when': 3000, 'tag': '0000_a'}, {'when': 2000, 'tag': '0001_b'}],
                        [{'when': '2000', 'tag': '0001_b'}], []):
            with self.subTest(entries=entries), self.blobs({'entries': entries}), self.assertRaisesRegex(ValueError, 'migration_journal_'):
                release.migration_journal('b' * 40)

    def gate(self, state=None, error=None):
        client = FakeClient({'crawler-m3': {'appName': 'app-crawler'}})
        probe = patch.object(release, 'ssh_python', side_effect=error) if error else \
            patch.object(release, 'ssh_python', return_value=json.dumps(state))
        with self.blobs(), probe as remote:
            try:
                return release.migration_gate(client, 'b' * 40)
            finally:
                if remote.call_args:
                    self.assertEqual(remote.call_args.args[:5], (release.M3[1], release.REMOTE_MIGRATIONS, 'app-crawler', '2000', release.MIGRATION_STATE_SCRIPT))

    def test_gate_passes_only_when_latest_applied_count_and_hash_match(self):
        self.assertEqual(self.gate({'applied': 2, 'latest': '2000', 'hash': self.digest}),
                         {'migrations': 'applied', 'latestTag': '0001_second', 'applied': 2})
        # An already applied newer migration (DB ahead of code) is still compatible.
        self.assertEqual(self.gate({'applied': 3, 'latest': '3000', 'hash': self.digest})['applied'], 3)
        for state, code in (({'applied': 1, 'latest': '1000', 'hash': None}, 'database_migrations_not_applied'),
                            ({'applied': 1, 'latest': '3000', 'hash': None}, 'database_migrations_not_applied'),
                            ({'applied': 2, 'latest': '2000', 'hash': 'f' * 64}, 'database_migration_hash_mismatch'),
                            ({'applied': 2, 'latest': None, 'hash': None}, 'database_migration_state_unknown'),
                            ({'applied': '2', 'latest': '2000', 'hash': self.digest}, 'database_migration_state_unknown'),
                            ([], 'database_migration_state_unknown')):
            with self.subTest(state=state), self.assertRaisesRegex(ValueError, code):
                self.gate(state)

    def test_gate_refuses_when_the_state_cannot_be_read(self):
        for error in (RuntimeError('command_failed:ssh:255'), subprocess.TimeoutExpired('ssh', 60), json.JSONDecodeError('x', 'y', 0)):
            with self.subTest(error=type(error).__name__), self.assertRaisesRegex(ValueError, 'database_migration_state_unknown'):
                self.gate(error=error)

    def test_remote_probe_is_a_bound_read_only_query(self):
        script = release.MIGRATION_STATE_SCRIPT
        self.assertIn("sql.begin('read only'", script)
        self.assertIn("SET LOCAL statement_timeout='5s'", script)
        self.assertIn('${process.argv[1]}::bigint', script)
        self.assertIsNone(re.search(r'\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b', script, re.I))
        self.assertNotIn('{', release.REMOTE_MIGRATIONS.replace('{{.ID}}', ''))

    def main_with_changes(self, gate):
        test = ReleaseSafetyTests('test_replace_setting_requires_one_line')
        test.setUp()
        apps = test.apps()
        state = {'apps': apps, 'previous': {'sha': test.old_sha, 'worker': test.old_worker, 'web': test.old_web}}
        args = ['plan', '--sha', test.new_sha, '--worker-image', test.target['worker'], '--web-image', test.target['web'], '--migration-verified']
        output = io.StringIO()
        with patch.object(release, 'run', side_effect=['operator-secret', test.new_sha, 'drizzle/0102_next.sql']), \
             patch.object(release, 'main_sha_and_token', return_value='registry-secret'), \
             patch.object(release, 'Dokploy', return_value=FakeClient(apps)), patch.object(release, 'baseline', return_value=state), \
             patch.object(release, 'github_integration_preflight', return_value={}), patch.object(release, 'migration_gate', **gate) as checked, \
             patch.object(release, 'agent_scan_release_gate', return_value={'agentScanGate': 'release_gated'}), \
             patch.object(release, 'monitor_gate') as monitor, patch.object(release, 'pre_pull') as pull, redirect_stdout(output):
            try:
                release.main(args)
            finally:
                self.assertEqual(checked.call_args.args[1], test.new_sha)
                self.calls = (monitor.call_count, pull.call_count)
        return json.loads(output.getvalue())

    def test_main_with_db_changes_checks_the_journal_before_any_gate_pull_or_deploy(self):
        with self.assertRaisesRegex(ValueError, 'database_migrations_not_applied'):
            self.main_with_changes({'side_effect': ValueError('database_migrations_not_applied')})
        self.assertEqual(self.calls, (0, 0))
        result = self.main_with_changes({'return_value': {'migrations': 'applied', 'latestTag': '0102_next', 'applied': 103}})
        self.assertEqual(self.calls, (1, 1))
        self.assertEqual(result['databaseMigrations'], {'migrations': 'applied', 'latestTag': '0102_next', 'applied': 103})

    @unittest.skipUnless(os.environ.get('TEST_DATABASE_URL'), 'needs a local migrated test database (TEST_DATABASE_URL)')
    def test_probe_script_reads_the_real_drizzle_journal_and_matches_the_committed_hash(self):
        root = Path(__file__).resolve().parents[1]
        journal = release.migration_journal('HEAD')

        def local_probe(_host, _source, _service, when, script, timeout=None, url=os.environ['TEST_DATABASE_URL']):
            result = subprocess.run(['node', '--input-type=module', '-e', script, when], cwd=root, capture_output=True, text=True, timeout=60,
                                    env={**os.environ, 'DATABASE_URL': url})
            if result.returncode:
                raise RuntimeError('local_probe_failed')
            return result.stdout.strip().splitlines()[-1]
        client = FakeClient({'crawler-m3': {'appName': 'local'}})
        with patch.object(release, 'ssh_python', side_effect=local_probe):
            self.assertEqual(release.migration_gate(client, 'HEAD'), {'migrations': 'applied', 'latestTag': journal['tag'], 'applied': journal['count']})
            # A code journal ahead of the database (an unapplied newer entry) is refused.
            ahead = {**journal, 'when': journal['when'] + 1, 'count': journal['count'] + 1}
            with patch.object(release, 'migration_journal', return_value=ahead), self.assertRaisesRegex(ValueError, 'database_migrations_not_applied'):
                release.migration_gate(client, 'HEAD')
        unreachable = 'postgres://nomorevibe:nomorevibe@127.0.0.1:9/nomorevibe_test'
        with patch.object(release, 'ssh_python', side_effect=lambda *args, **kwargs: local_probe(*args[:5], url=unreachable)), \
             self.assertRaisesRegex(ValueError, 'database_migration_state_unknown'):
            release.migration_gate(client, 'HEAD')


class AgentScanReleaseGateTests(unittest.TestCase):
    """P2-7: crawler code without the agent-scan legacy write gate is never restored or released while the control is not legacy."""

    def setUp(self):
        test = ReleaseSafetyTests('test_replace_setting_requires_one_line')
        test.setUp()
        self.test = test
        self.apps = test.apps()
        for short in release.AGENT_SCAN_PROBE_APPS:
            self.apps[short]['appName'] = 'probe-' + short

    def gated(self, gated):
        source = b'import x;\nawait assertLegacyAgentScanWrite(tx);\n' if gated else b'// before 0105\n'
        return patch.object(release, 'git_blob', side_effect=lambda _sha, path: source if path == release.AGENT_SCAN_GATE[0] else b'')

    def probe(self, *outcomes):
        """Each probe container answers in turn: a mode string, or an exception for an unreachable container."""
        answers = iter(outcomes)

        def remote(_host, source, service, _when, script, timeout=None):
            self.assertEqual((source, script), (release.REMOTE_MIGRATIONS, release.AGENT_SCAN_MODE_SCRIPT))
            self.probed.append(service)
            answer = next(answers)
            if isinstance(answer, Exception):
                raise answer
            return json.dumps({'mode': answer})
        self.probed = []
        return patch.object(release, 'ssh_python', side_effect=remote)

    def restore(self, short, gated, *outcomes):
        current = self.apps[short]
        current['dockerImage'] = self.test.target['worker']
        current['env'] = 'RELEASE_TAG=' + self.test.new_sha + '\n'
        previous = {'sha': self.test.old_sha, 'worker': self.test.old_worker, 'web': self.test.old_web}
        original = dict(current, dockerImage=self.test.old_worker, env='RELEASE_TAG=' + self.test.old_sha + '\n')
        client = FakeClient(self.apps)
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'snapshot.json')
            release.save_snapshot(path, self.test.target, {'previous': previous, 'apps': {short: original}})
            # 실행은 아직 새 릴리스다 — 설정만 되돌리는 길이 아니라 다시 배포하는 길을 본다
            with self.gated(gated), self.probe(*outcomes), patch.object(release, 'probe', return_value={'ready': False}), \
                 patch.object(release, 'check_app_deployed', return_value={'app': short}):
                try:
                    return release.restore(client, path, short, 'token')
                finally:
                    self.requests = client.requests

    def test_restore_refuses_an_ungated_crawler_release_while_items_or_draining_before_any_write(self):
        for mode in ('items', 'draining'):
            with self.subTest(mode=mode), self.assertRaisesRegex(ValueError, f'agent_scan_ungated_release_while_{mode}'):
                self.restore('crawler-m3', False, mode)
            self.assertEqual(self.requests, [])

    def test_restore_of_an_ungated_crawler_release_proceeds_only_once_the_control_is_legacy_or_absent(self):
        for mode in ('legacy', 'absent'):
            with self.subTest(mode=mode):
                result = self.restore('crawler-mini', False, mode)
                self.assertEqual(result, {'app': 'crawler-mini', 'agentScanGate': 'ungated_release_allowed', 'agentScanMode': mode})
                self.assertEqual(self.requests, ['application.saveEnvironment', 'application.saveDockerProvider', 'application.deploy'])
                # 되돌릴 crawler 컨테이너가 아니라 다른 worker 컨테이너에서 먼저 읽는다
                self.assertEqual(self.probed, ['probe-reviewer-m3'])

    def test_a_gated_release_needs_no_database_read_and_other_roles_are_never_checked(self):
        self.assertEqual(self.restore('crawler-m3', True), {'app': 'crawler-m3', 'agentScanGate': 'release_gated'})
        self.assertEqual(self.probed, [])
        self.assertEqual(self.restore('publisher-mini', False), {'app': 'publisher-mini'})
        self.assertEqual(self.probed, [])

    def test_an_unreadable_mode_is_a_refusal_after_trying_every_probe_container(self):
        with self.assertRaisesRegex(ValueError, 'agent_scan_mode_unknown'):
            self.restore('crawler-m3', False, RuntimeError('command_failed:ssh:255'), subprocess.TimeoutExpired('ssh', 60), 'unexpected')
        self.assertEqual(self.probed, ['probe-reviewer-m3', 'probe-publisher-m3', 'probe-crawler-m3'])
        self.assertEqual(self.requests, [])
        # 한 컨테이너가 안 되면 다음 컨테이너에서 읽는다
        self.assertEqual(self.restore('crawler-m3', False, RuntimeError('command_failed:ssh:255'), 'legacy')['agentScanMode'], 'legacy')
        self.assertEqual(self.probed, ['probe-reviewer-m3', 'probe-publisher-m3'])

    def test_main_checks_the_target_release_before_any_gate_pull_or_deploy(self):
        state = {'apps': self.apps, 'previous': {'sha': self.test.old_sha, 'worker': self.test.old_worker, 'web': self.test.old_web}}
        args = ['plan', '--sha', self.test.new_sha, '--worker-image', self.test.target['worker'], '--web-image', self.test.target['web']]
        with patch.object(release, 'run', side_effect=['operator-secret', self.test.new_sha, '']), \
             patch.object(release, 'main_sha_and_token', return_value='registry-secret'), \
             patch.object(release, 'Dokploy', return_value=FakeClient(self.apps)), patch.object(release, 'baseline', return_value=state), \
             patch.object(release, 'github_integration_preflight', return_value={}), self.gated(False), self.probe('items'), \
             patch.object(release, 'monitor_gate') as monitor, patch.object(release, 'pre_pull') as pull, redirect_stdout(io.StringIO()), \
             self.assertRaisesRegex(ValueError, 'agent_scan_ungated_release_while_items'):
            release.main(args)
        self.assertEqual((monitor.call_count, pull.call_count), (0, 0))

    def test_mode_probe_is_a_bound_read_only_query(self):
        script = release.AGENT_SCAN_MODE_SCRIPT
        self.assertIn("sql.begin('read only'", script)
        self.assertIn("SET LOCAL statement_timeout='5s'", script)
        self.assertIsNone(re.search(r'\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT)\b', script, re.I))

    @unittest.skipUnless(os.environ.get('TEST_DATABASE_URL'), 'needs a local migrated test database (TEST_DATABASE_URL)')
    def test_mode_probe_reads_the_real_control_row(self):
        root = Path(__file__).resolve().parents[1]
        result = subprocess.run(['node', '--input-type=module', '-e', release.AGENT_SCAN_MODE_SCRIPT, '0'], cwd=root, capture_output=True,
                                text=True, timeout=60, env={**os.environ, 'DATABASE_URL': os.environ['TEST_DATABASE_URL']})
        self.assertEqual(result.returncode, 0)
        self.assertIn(json.loads(result.stdout.strip().splitlines()[-1])['mode'], ('legacy', 'draining', 'items'))


AT = re.compile(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ')


def lines(output):
    return [json.loads(line) for line in output.getvalue().splitlines()]


class ReleaseSpeedTests(unittest.TestCase):
    """2026-10-22: 시각·소요 시간 기록, 두 서버 동시 pre-pull, prepull 명령, 짧은 확인 간격, --parallel-roles."""

    def setUp(self):
        test = ReleaseSafetyTests('test_replace_setting_requires_one_line')
        test.setUp()
        self.test = test
        self.target = test.target
        self.previous = {'sha': test.old_sha, 'worker': test.old_worker, 'web': test.old_web}

    def run_deploy(self, *, parallel_roles=False, consumers=(), stage=None, gate=None, unchanged=None):
        """가짜 단계로 deploy 를 돌리고 (단계 기록, 출력 줄, 예외)를 돌려준다."""
        events, lock = [], __import__('threading').Lock()

        def record(item):
            with lock:
                events.append(item)

        def default_stage(_client, short, _target, _token, _previous):
            record(short)
            return {'app': short, 'deployment': 'done', 'service': 'healthy'}

        def default_gate(_client, role, **kwargs):
            record(('gate', role, kwargs.get('roles'), kwargs.get('timeout')))
            return {'role': role} if 'roles' not in kwargs else {'roles': list(kwargs['roles'])}

        output, error = io.StringIO(), None
        with patch.object(release, 'save_snapshot'), \
             patch.object(release, 'stage_and_deploy', side_effect=stage or default_stage), \
             patch.object(release, 'unchanged_since_preflight', side_effect=unchanged or (lambda _c, short, _p: record(('check', short)))), \
             patch.object(release, 'monitor_gate', side_effect=gate or default_gate), \
             patch.object(release, 'public_gate', side_effect=lambda sha: record('public') or {'publicHealth': 'ok'}), \
             patch.object(release, 'purge_html', return_value={'htmlPurge': 'skipped'}), redirect_stdout(output):
            try:
                release.deploy(None, self.target, 'token', {'apps': {}, 'previous': self.previous}, '/private/tmp/s.json',
                               consumers, parallel_roles=parallel_roles)
            except Exception as caught:
                error = caught
        return events, lines(output), error

    def test_every_progress_line_has_utc_time_and_the_last_line_sums_up_each_app_and_gate(self):
        events, out, error = self.run_deploy()
        self.assertIsNone(error)
        self.assertTrue(all(AT.fullmatch(line['at']) for line in out))
        self.assertEqual(events, ['publisher-mini', 'publisher-m3', ('gate', 'publisher', None, None), 'reviewer-mini', 'reviewer-m3',
                                  ('gate', 'reviewer', None, None), 'crawler-mini', 'crawler-m3', ('gate', 'crawler', None, None),
                                  'web-mini', 'web-m3', 'public'])
        self.assertTrue(all(isinstance(line['seconds'], float) for line in out if 'app' in line or 'role' in line))
        summary = out[-1]['summary']
        self.assertEqual(summary['mode'], 'sequential')
        self.assertEqual(list(summary['durations']), list(release.ORDER[:2]) + ['gate:publisher'] + list(release.ORDER[2:4])
                         + ['gate:reviewer'] + list(release.ORDER[4:6]) + ['gate:crawler', 'web-mini', 'web-m3', 'public'])
        self.assertIsInstance(summary['totalSeconds'], float)

    def test_a_stopped_release_still_reports_the_durations_so_far(self):
        def gate(_client, role, **_kwargs):
            raise TimeoutError(role + '_monitor_gate_timeout')
        events, out, error = self.run_deploy(gate=gate)
        self.assertIsInstance(error, TimeoutError)
        self.assertEqual(events, ['publisher-mini', 'publisher-m3'])
        self.assertTrue(out[-2]['stopped'])
        self.assertEqual(out[-2]['touched'], ['publisher-mini', 'publisher-m3'])
        self.assertEqual(list(out[-1]['summary']['durations']), ['publisher-mini', 'publisher-m3', 'gate:publisher'])

    def test_default_rollout_is_the_previous_sequence_and_parallel_keeps_standby_first_and_consumers_before_the_gate(self):
        sequential = release.rollout_steps()
        self.assertEqual([names for kind, names in sequential if kind == 'deploy'], [(short,) for short in release.ORDER])
        self.assertEqual(release.describe_steps(sequential),
                         ['deploy:publisher-mini', 'deploy:publisher-m3', 'gate:publisher', 'deploy:reviewer-mini', 'deploy:reviewer-m3',
                          'gate:reviewer', 'deploy:crawler-mini', 'deploy:crawler-m3', 'gate:crawler', 'deploy:web-mini', 'deploy:web-m3',
                          'public'])
        self.assertEqual(release.describe_steps(release.rollout_steps(parallel_roles=True)),
                         ['deploy:publisher-mini,reviewer-mini,crawler-mini', 'deploy:publisher-m3,reviewer-m3,crawler-m3',
                          'gate:publisher,reviewer,crawler', 'deploy:web-mini', 'deploy:web-m3', 'public'])
        self.assertEqual(release.describe_steps(release.rollout_steps(CONSUMERS, True))[:5],
                         ['deploy:publisher-mini,reviewer-mini,crawler-mini', 'deploy:publisher-m3,reviewer-m3,crawler-m3',
                          'deploy:ai1-consumer-mini,ai2-consumer-mini', 'deploy:ai1-consumer-m3,ai2-consumer-m3,agent-scan-consumer-m3',
                          'gate:publisher,reviewer,crawler'])

    def test_parallel_roles_rolls_out_standbys_together_then_primaries_then_one_gate_then_web_one_by_one(self):
        threading = __import__('threading')
        barrier = threading.Barrier(3, timeout=5)
        seen, lock = [], threading.Lock()

        def stage(_client, short, _target, _token, _previous):
            if not short.startswith('web-'):
                barrier.wait()  # 셋이 동시에 들어와야 풀린다 — 차례로 돌면 BrokenBarrierError
            with lock:
                seen.append(short)
            return {'app': short}
        events, out, error = self.run_deploy(parallel_roles=True, stage=stage)
        self.assertIsNone(error)
        self.assertEqual(set(seen[:3]), {'publisher-mini', 'reviewer-mini', 'crawler-mini'})
        self.assertEqual(set(seen[3:6]), {'publisher-m3', 'reviewer-m3', 'crawler-m3'})
        self.assertEqual(seen[6:], ['web-mini', 'web-m3'])
        # 묶음마다 먼저 셋 다 읽기 확인, 관문은 crawler-m3 컨테이너에서 세 역할을 한 번에, 한도는 넉넉히
        self.assertEqual([item for item in events if item[0] == 'check'],
                         [('check', role + '-' + host) for host in ('mini', 'm3') for role in release.ROLES])
        self.assertEqual([item for item in events if item[0] == 'gate'],
                         [('gate', 'crawler', release.ROLES, release.PARALLEL_GATE_TIMEOUT)])
        self.assertEqual(out[0]['mode'], 'parallel-roles')
        self.assertEqual(out[-1]['summary']['mode'], 'parallel-roles')
        self.assertIn('gate:publisher,reviewer,crawler', out[-1]['summary']['durations'])

    def test_parallel_batch_writes_nothing_when_any_app_changed_since_preflight(self):
        def unchanged(_client, short, _previous):
            if short == 'reviewer-mini':
                raise ValueError('reviewer-mini_changed_since_preflight')
        staged = []
        events, out, error = self.run_deploy(parallel_roles=True, unchanged=unchanged,
                                             stage=lambda _c, short, _t, _k, _p: staged.append(short) or {'app': short})
        self.assertIsInstance(error, ValueError)
        self.assertEqual(staged, [])
        self.assertEqual((out[-2]['stopped'], out[-2]['touched']), (True, []))

    def test_parallel_batch_waits_for_every_started_app_then_stops_before_the_gate_and_web(self):
        def stage(_client, short, _target, _token, _previous):
            if short == 'reviewer-m3':
                raise TimeoutError('reviewer-m3_verification_timeout')
            return {'app': short}
        events, out, error = self.run_deploy(parallel_roles=True, stage=stage)
        self.assertEqual(str(error), 'reviewer-m3_verification_timeout')
        apps = {line['app']: line for line in out if 'app' in line}
        self.assertEqual(set(apps), {role + '-' + host for role in release.ROLES for host in ('mini', 'm3')})
        self.assertEqual((apps['reviewer-m3']['failed'], apps['reviewer-m3']['detail']), (True, 'reviewer-m3_verification_timeout'))
        self.assertFalse(any(item[0] == 'gate' for item in events if isinstance(item, tuple)))
        self.assertNotIn('public', events)
        self.assertIn('reviewer-m3', out[-1]['summary']['durations'])
        # 되돌릴 후보: 두 묶음의 여섯 앱 전부(순차였다면 reviewer 쌍까지만)
        self.assertEqual(out[-2]['touched'], [role + '-' + host for host in ('mini', 'm3') for role in release.ROLES])

    def test_monitor_gate_for_several_roles_waits_until_every_role_is_ready(self):
        def report(reasons):
            reasons = {'maintenance': 'ready', 'text': 'ready', **reasons}
            readiness = {'overall': 'ok' if all(reason == 'ready' for reason in reasons.values()) else 'alarm',
                         'roles': [{'role': role, 'reason': reason} for role, reason in reasons.items()],
                         'scheduler': {'reason': 'ready'}}
            return json.dumps({'check-failover-readiness.ts': {'overall': readiness['overall'], 'readiness': readiness},
                               'check-worker-progress.ts': {'overall': 'ok'}})
        answers = [report({'publisher': 'ready', 'reviewer': 'release_mismatch', 'crawler': 'ready'}),
                   report(dict.fromkeys(release.ROLES, 'ready'))]
        client = FakeClient({'crawler-m3': {'appName': 'service-crawler-m3'}})
        with patch.object(release, 'ssh_python', side_effect=answers) as remote, patch.object(release.time, 'sleep') as sleep:
            result = release.monitor_gate(client, 'crawler', roles=release.ROLES)
        self.assertEqual(result, {'roles': list(release.ROLES), 'readiness': 'ready', 'progress': 'ok'})
        self.assertEqual(remote.call_count, 2)
        sleep.assert_called_once_with(release.MONITOR_POLL_SECONDS)
        with patch.object(release, 'ssh_python', return_value=report(dict.fromkeys(release.ROLES, 'ready'))):
            self.assertEqual(release.monitor_gate(client, 'crawler'), {'role': 'crawler', 'readiness': 'ready', 'progress': 'ok'})

    def test_polling_is_tighter_but_not_continuous(self):
        import inspect
        self.assertEqual(inspect.signature(release.check_app_deployed).parameters['pause'].default, release.APP_POLL_SECONDS)
        self.assertEqual(inspect.signature(release.monitor_gate).parameters['pause'].default, release.MONITOR_POLL_SECONDS)
        self.assertTrue(2 <= release.APP_POLL_SECONDS <= release.MONITOR_POLL_SECONDS <= 3)

    def test_pre_pull_runs_both_servers_at_the_same_time_and_waits_for_both_on_failure(self):
        threading = __import__('threading')
        barrier = threading.Barrier(2, timeout=5)
        hosts = []

        def remote(host, source, images, sha, key_hash, input_text=None, timeout=None):
            self.assertEqual((source, sha, input_text, timeout), (release.REMOTE_PULL, self.target['sha'], 'registry-secret', 180))
            barrier.wait()  # 두 서버가 동시에 받아야 풀린다
            hosts.append(host)
            if host == release.MINI[1] and self.fail_mini:
                raise RuntimeError('command_failed:ssh:1')
            return json.dumps({'pulled': True})
        for fail in (False, True):
            self.fail_mini, hosts[:] = fail, []
            barrier.reset()
            output = io.StringIO()
            with self.subTest(fail=fail), patch.object(release, 'ssh_python', side_effect=remote), redirect_stdout(output):
                if fail:
                    with self.assertRaisesRegex(RuntimeError, 'command_failed:ssh:1'):
                        release.pre_pull(self.target, 'registry-secret', 'sample-key')
                else:
                    release.pre_pull(self.target, 'registry-secret', 'sample-key')
            self.assertEqual(sorted(hosts), sorted((release.MINI[1], release.M3[1])))
            pulled = {line['server']: line['imagesPulled'] for line in lines(output)}
            self.assertEqual(pulled, {'mini': not fail, 'm3': True})
            self.assertNotIn('registry-secret', output.getvalue())
            self.assertNotIn('sample-key', output.getvalue())

    def test_prepull_reads_only_the_two_web_keys_and_never_writes(self):
        apps = self.test.apps()
        client = FakeClient(apps)
        with patch.object(release, 'main_sha_and_token', return_value='registry-secret'), patch.object(release, 'pre_pull') as pull:
            self.assertEqual(release.prepull(client, self.target), {'prepull': 'done', 'targetRelease': self.target['sha']})
        pull.assert_called_once_with(self.target, 'registry-secret', 'sample-key')
        self.assertEqual(client.requests, [])
        apps['web-m3']['buildSecrets'] = 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=other-key\n'
        with patch.object(release, 'main_sha_and_token', return_value='registry-secret'), patch.object(release, 'pre_pull') as pull, \
             self.assertRaisesRegex(ValueError, 'web-m3_web_key_mismatch') as raised:
            release.prepull(client, self.target)
        pull.assert_not_called()
        self.assertNotIn('other-key', str(raised.exception))

    def test_main_prepull_needs_no_checkout_and_rejects_release_only_arguments_before_keychain(self):
        base = ['--sha', self.target['sha'], '--worker-image', self.target['worker'], '--web-image', self.target['web']]
        for arguments in (['prepull'] + base + ['--snapshot', '/private/tmp/x.json'], ['prepull'] + base + ['--migration-verified'],
                          ['prepull'] + base + ['--consumer', 'agent-scan'], ['prepull'] + base + ['--parallel-roles'],
                          ['prepull', '--sha', self.target['sha']], ['inventory', '--sha', self.target['sha'], '--parallel-roles']):
            with self.subTest(arguments=arguments), patch.object(release, 'run') as keychain, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    release.main(arguments)
                keychain.assert_not_called()
        with patch.object(release, 'run') as keychain, self.assertRaisesRegex(ValueError, 'invalid_web_image'):
            release.main(['prepull', '--sha', self.target['sha'], '--worker-image', self.target['worker'], '--web-image', 'web:latest'])
        keychain.assert_not_called()
        output = io.StringIO()
        with patch.object(release, 'run', return_value='operator-secret') as keychain, \
             patch.object(release, 'Dokploy', return_value=FakeClient(self.test.apps())), \
             patch.object(release, 'main_sha_and_token', return_value='registry-secret'), patch.object(release, 'pre_pull'), \
             redirect_stdout(output):
            release.main(['prepull'] + base)
        self.assertEqual(keychain.call_count, 1)  # Keychain 만 — git checkout 확인·baseline 이 없다
        result = lines(output)[-1]
        self.assertEqual((result['prepull'], result['targetRelease']), ('done', self.target['sha']))
        self.assertTrue(AT.fullmatch(result['at']))
        self.assertNotIn('operator-secret', output.getvalue())

    def test_main_plan_prints_the_parallel_rollout_and_preflight_timings_and_run_passes_the_mode(self):
        apps = self.test.apps()
        state = {'apps': apps, 'previous': self.previous}
        base = ['--sha', self.target['sha'], '--worker-image', self.target['worker'], '--web-image', self.target['web'], '--parallel-roles']
        for action in ('plan', 'run'):
            output = io.StringIO()
            arguments = [action] + base + (['--snapshot', '/private/tmp/unused.json'] if action == 'run' else [])
            with self.subTest(action=action), patch.object(release, 'run', side_effect=['operator-secret', self.target['sha'], '']), \
                 patch.object(release, 'main_sha_and_token', return_value='registry-secret'), \
                 patch.object(release, 'Dokploy', return_value=FakeClient(apps)), patch.object(release, 'baseline', return_value=state), \
                 patch.object(release, 'github_integration_preflight', return_value={}), patch.object(release, 'monitor_gate'), \
                 patch.object(release, 'agent_scan_release_gate', return_value={'agentScanGate': 'release_gated'}), \
                 patch.object(release, 'pre_pull'), patch.object(release, 'deploy') as deploy, redirect_stdout(output):
                release.main(arguments)
            plan = lines(output)[-1]
            self.assertEqual(plan['plan'], list(release.ORDER))
            self.assertEqual(plan['mode'], 'parallel-roles')
            self.assertEqual(plan['rollout'], release.describe_steps(release.rollout_steps((), True)))
            self.assertEqual(list(plan['preflight']['durations']), ['baseline', 'gate:crawler', 'prePull'])
            self.assertEqual(deploy.call_count, int(action == 'run'))
            if action == 'run':
                self.assertTrue(deploy.call_args.kwargs['parallel_roles'])

    def test_cli_error_line_has_the_time_and_only_the_error_code(self):
        failed = subprocess.run([sys.executable, str(SOURCE), 'prepull', '--sha', 'not-a-sha', '--worker-image', 'x', '--web-image', 'y'],
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(failed.returncode, 1)
        line = json.loads(failed.stdout)
        self.assertEqual((line['error'], line['detail']), ('ValueError', 'invalid_release_sha'))
        self.assertTrue(AT.fullmatch(line['at']))


class SwarmRollbackResumeTests(unittest.TestCase):
    """2026-10-22 #597: Swarm 되돌림을 알아채 한 번 다시 배포하고, 멈춘 run 을 --resume 으로 이어 가며, 관문은 유효한 소유자를 받는다."""

    def setUp(self):
        test = ReleaseSafetyTests('test_replace_setting_requires_one_line')
        test.setUp()
        self.test = test
        self.target = test.target
        self.previous = {'sha': test.old_sha, 'worker': test.old_worker, 'web': test.old_web}

    # ---- 원격 확인: UpdateStatus·태스크 오류 -------------------------------------------------------------------
    def run_probe(self, fixture, *, detail=False, image=None):
        fake = ('import json,os,sys\n'
                'f=json.loads(os.environ["FAKE_DOCKER"]);a=sys.argv[1:]\n'
                'if a[:2]==["service","ls"]: print("svc\\t"+f["serviceImage"]+"\\t1/1")\n'
                'elif a[:2]==["service","inspect"]: print(json.dumps(f["updateStatus"]))\n'
                'elif a[:2]==["service","ps"]: print("\\n".join(json.dumps(t) for t in f["tasks"]))\n'
                'elif a[0]=="ps": print("c1")\n'
                'elif a[0]=="inspect":\n'
                ' print(json.dumps([{"Config":{"Image":f["containerImage"],"Env":["RELEASE_TAG="+f["sha"]],'
                '"Labels":{"com.docker.swarm.service.name":"svc"}},"State":{"Running":True,"Health":{"Status":"healthy"}}}]))\n')
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'docker'
            path.write_text('#!' + sys.executable + '\n' + fake)
            path.chmod(0o755)
            args = ['svc', image or self.target['worker'], self.target['sha'], 'worker', '1'] + (['detail'] if detail else [])
            out = subprocess.run([sys.executable, '-c', release.REMOTE_PROBE, *args], capture_output=True, text=True, check=True,
                                 env={**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'],
                                      'FAKE_DOCKER': json.dumps(fixture)})
        return json.loads(out.stdout)

    def test_probe_reports_a_swarm_rollback_and_the_failed_task_error_only_when_not_ready(self):
        rolled_back = {'serviceImage': self.previous['worker'], 'containerImage': self.previous['worker'], 'sha': self.previous['sha'],
                       'updateStatus': {'State': 'rollback_completed', 'Message': 'rollback completed'},
                       'tasks': [{'Name': 'svc.1', 'Error': ''},
                                 {'Name': 'svc.1', 'Error': 'No such container: 6f1c2e\nsecret=<value>' + 'x' * 300}]}
        result = self.run_probe(rolled_back)
        self.assertFalse(result['ready'])
        self.assertEqual(result['updateState'], 'rollback_completed')
        self.assertEqual(len(result['taskErrors']), 1)
        error = result['taskErrors'][0]
        self.assertTrue(error.startswith('No such container: 6f1c2e?secret=?value?'))  # 줄바꿈·꺾쇠는 걸러진다
        self.assertEqual(len(error), 160)
        healthy = dict(rolled_back, serviceImage=self.target['worker'], containerImage=self.target['worker'], sha=self.target['sha'],
                       updateStatus={'State': 'completed'})
        self.assertNotIn('updateState', self.run_probe(healthy))  # 준비면 Swarm 을 더 읽지 않는다
        self.assertEqual(self.run_probe(healthy, detail=True)['updateState'], 'completed')
        never_updated = dict(healthy, updateStatus=None, tasks=[])
        self.assertTrue(self.run_probe(never_updated, detail=True)['ready'])
        self.assertNotIn('updateState', self.run_probe(never_updated, detail=True))

    # ---- 확인·한 번 다시 배포 ---------------------------------------------------------------------------------
    def staged_apps(self, short='crawler-m3'):
        apps = self.test.apps()
        apps[short].update({'dockerImage': self.target['worker'], 'env': 'RELEASE_TAG=' + self.target['sha'] + '\n'})
        return apps

    def test_wait_stops_on_a_swarm_rollback_instead_of_timing_out(self):
        client = FakeClient(self.staged_apps(), deployment_id='new')
        evidence = {'ready': False, 'serviceImageMatch': False, 'updateState': 'rollback_completed',
                    'taskErrors': ['No such container: 6f1c2e']}
        with patch.object(release, 'probe', return_value=evidence), patch.object(release.time, 'sleep') as sleep:
            with self.assertRaises(release.SwarmRollback) as raised:
                release.check_app_deployed(client, 'crawler-m3', self.target, 'old')
        self.assertEqual(str(raised.exception), 'crawler-m3_swarm_rollback_completed:task_error=No such container: 6f1c2e')
        self.assertEqual(raised.exception.state, 'rollback_completed')
        sleep.assert_not_called()  # 4분 시간 초과를 기다리지 않는다
        # 되돌림이 아니면 예전처럼 기다리고, 시간이 넘으면 마지막 태스크 오류를 붙인다
        with patch.object(release, 'probe', return_value={'ready': False, 'updateState': 'updating', 'taskErrors': ['task: non-zero exit (1)']}), \
             patch.object(release.time, 'monotonic', side_effect=[0, 0, 2]), patch.object(release.time, 'sleep'):
            with self.assertRaisesRegex(TimeoutError, r'^crawler-m3_verification_timeout:task_error=task: non-zero exit \(1\)$'):
                release.check_app_deployed(client, 'crawler-m3', self.target, 'old', timeout=1)

    def test_a_rollback_is_redeployed_once_after_swarm_settles(self):
        client = FakeClient(self.staged_apps())
        rollback = release.SwarmRollback('crawler-m3', {'updateState': 'rollback_completed', 'taskErrors': ['No such container: 6f1c2e']})
        output = io.StringIO()
        with patch.object(release, 'check_app_deployed', side_effect=[rollback, {'app': 'crawler-m3', 'deployment': 'done'}]) as wait, \
             patch.object(release, 'await_rollback_settled') as settled, redirect_stdout(output):
            result = release.deploy_app(client, 'crawler-m3', self.target)
        self.assertEqual(result, {'app': 'crawler-m3', 'deployment': 'done', 'swarmRedeploys': 1})
        self.assertEqual(client.requests, ['application.deploy', 'application.deploy'])
        self.assertEqual(wait.call_count, 2)
        settled.assert_called_once_with(client, 'crawler-m3', self.target)
        line = lines(output)[0]
        self.assertEqual((line['app'], line['swarmRollback'], line['taskErrors'], line['action']),
                         ('crawler-m3', 'rollback_completed', ['No such container: 6f1c2e'], 'redeploy_once'))

    def test_a_second_rollback_stops_with_the_failed_task_error_and_paused_is_never_redeployed(self):
        client = FakeClient(self.staged_apps())
        rollback = release.SwarmRollback('crawler-m3', {'updateState': 'rollback_completed', 'taskErrors': ['No such container: 6f1c2e']})
        with patch.object(release, 'check_app_deployed', side_effect=[rollback, rollback]), \
             patch.object(release, 'await_rollback_settled'), redirect_stdout(io.StringIO()):
            with self.assertRaises(release.ReleaseStopped) as raised:
                release.deploy_app(client, 'crawler-m3', self.target)
        self.assertEqual(str(raised.exception), 'crawler-m3_swarm_rollback_repeated:task_error=No such container: 6f1c2e')
        self.assertEqual(client.requests, ['application.deploy', 'application.deploy'])
        self.assertEqual(release.error_fields(raised.exception)['detail'], str(raised.exception))

        client = FakeClient(self.staged_apps())
        paused = release.SwarmRollback('crawler-m3', {'updateState': 'paused', 'updateMessage': 'update paused due to failure'})
        with patch.object(release, 'check_app_deployed', side_effect=[paused]), \
             patch.object(release, 'await_rollback_settled') as settled, redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(release.ReleaseStopped, '^crawler-m3_swarm_paused:message=update paused due to failure$'):
                release.deploy_app(client, 'crawler-m3', self.target)
        self.assertEqual(client.requests, ['application.deploy'])
        settled.assert_not_called()

    def test_redeploy_waits_for_the_rollback_to_finish_and_stops_on_a_paused_rollback(self):
        client = FakeClient(self.staged_apps())
        answers = [{'ready': False, 'updateState': 'rollback_started'}, {'ready': False, 'updateState': 'rollback_completed'}]
        with patch.object(release, 'probe', side_effect=answers) as remote, patch.object(release.time, 'sleep'):
            self.assertEqual(release.await_rollback_settled(client, 'crawler-m3', self.target)['updateState'], 'rollback_completed')
        self.assertEqual(remote.call_count, 2)
        with patch.object(release, 'probe', return_value={'ready': False, 'updateState': 'rollback_paused', 'taskErrors': ['boom']}), \
             patch.object(release.time, 'sleep'):
            with self.assertRaisesRegex(release.ReleaseStopped, '^crawler-m3_swarm_rollback_paused:task_error=boom$'):
                release.await_rollback_settled(client, 'crawler-m3', self.target)
        with patch.object(release, 'probe', return_value={'ready': False, 'updateState': 'rollback_started'}), \
             patch.object(release.time, 'monotonic', side_effect=[0, 0, 2]), patch.object(release.time, 'sleep'):
            with self.assertRaisesRegex(release.ReleaseStopped, '^crawler-m3_swarm_rollback_unsettled$'):
                release.await_rollback_settled(client, 'crawler-m3', self.target, timeout=1)

    def test_stage_and_restore_go_through_the_rollback_aware_deploy(self):
        apps = self.test.apps()
        client = FakeClient(apps)
        with patch.object(release, 'deploy_app', return_value={'app': 'crawler-m3'}) as deploy:
            release.stage_and_deploy(client, 'crawler-m3', self.target, 'token', self.previous)
        deploy.assert_called_once_with(client, 'crawler-m3', self.target)
        self.assertEqual(client.requests, ['application.saveEnvironment', 'application.saveDockerProvider'])

    # ---- restore: 실행이 이미 이전 릴리스면 설정만 ---------------------------------------------------------------
    def restore_with(self, evidence):
        apps = self.staged_apps('publisher-m3')
        original = dict(apps['publisher-m3'], dockerImage=self.previous['worker'], env='RELEASE_TAG=' + self.previous['sha'] + '\n')
        client = FakeClient(apps)
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'snapshot.json')
            release.save_snapshot(path, self.target, {'previous': self.previous, 'apps': {'publisher-m3': original}})
            with patch.object(release, 'probe', return_value=evidence), \
                 patch.object(release, 'deploy_app', return_value={'app': 'publisher-m3', 'deployment': 'done'}) as deploy:
                result = release.restore(client, path, 'publisher-m3', 'token')
        return result, client.requests, deploy

    def test_restore_only_rewrites_the_configuration_when_swarm_already_runs_the_previous_release(self):
        result, requests, deploy = self.restore_with({'ready': True, 'updateState': 'rollback_completed'})
        self.assertEqual((result['restored'], result['runtime'], result['deployment']), ('configuration_only', 'already_previous', 'skipped'))
        self.assertEqual(requests, ['application.saveEnvironment', 'application.saveDockerProvider'])  # 재시작 없음
        deploy.assert_not_called()
        # 실행이 새 릴리스거나 Swarm update 가 아직 진행 중이면 예전처럼 다시 배포한다
        for evidence in ({'ready': False}, {'ready': True, 'updateState': 'updating'}, {'ready': True, 'updateState': 'rollback_started'}):
            with self.subTest(evidence=evidence):
                result, requests, deploy = self.restore_with(evidence)
                self.assertEqual(result, {'app': 'publisher-m3', 'deployment': 'done'})
                deploy.assert_called_once()
                self.assertEqual(deploy.call_args.args[1:], ('publisher-m3', self.previous))

    # ---- --resume ------------------------------------------------------------------------------------------------
    def mixed_after_597(self):
        """#597 첫 시도 뒤: publisher·reviewer 쌍과 crawler-mini 는 새 릴리스, crawler-m3 는 설정만 새 릴리스(Swarm 이 되돌림), 웹은 이전."""
        originals = self.test.apps()
        for short in ('web-mini', 'web-m3'):
            originals[short]['buildArgs'] = 'NEXT_DEPLOYMENT_ID=' + self.previous['sha'] + '\n'
        current = json.loads(json.dumps(originals))
        for short in ('publisher-mini', 'publisher-m3', 'reviewer-mini', 'reviewer-m3', 'crawler-mini', 'crawler-m3'):
            env, build_args = release.staged_settings(originals[short], 'worker', self.target['sha'])
            current[short].update({'dockerImage': self.target['worker'], 'env': env, 'buildArgs': build_args})
        snapshot = {'target': self.target, 'previous': self.previous, 'apps': originals}
        return snapshot, current

    def fake_runtime(self, rolled_back=('crawler-m3',), unknown=(), settle='rollback_completed'):
        def remote(short, app, expected, replicas='any', detail=False):
            if short in unknown:
                return {'ready': False}
            on_target = app['dockerImage'] in (self.target['worker'], self.target['web']) and short not in rolled_back
            ready = (expected['sha'] == self.target['sha']) == on_target
            return {'ready': ready, **({'updateState': settle} if detail else {})}
        return remote

    def test_resume_classifies_each_app_from_the_snapshot_and_the_actual_runtime(self):
        snapshot, current = self.mixed_after_597()
        client = FakeClient(current)
        with patch.object(release, 'probe', side_effect=self.fake_runtime()):
            state = release.resume_baseline(client, self.target, snapshot)
        self.assertEqual(state['resume'], {'publisher-mini': 'done', 'publisher-m3': 'done', 'reviewer-mini': 'done', 'reviewer-m3': 'done',
                                           'crawler-mini': 'done', 'crawler-m3': 'redeploy', 'web-mini': 'previous', 'web-m3': 'previous'})
        self.assertEqual(state['mixedRoles'], {'crawler': ('release_mismatch',)})
        self.assertEqual(state['previous'], self.previous)
        self.assertEqual(client.requests, [])  # 읽기만

    def test_resume_refuses_unexplained_drift_or_unknown_runtime_before_any_write(self):
        snapshot, current = self.mixed_after_597()
        drifted = json.loads(json.dumps(current))
        drifted['reviewer-m3']['env'] += 'EXTRA_FLAG=true\n'
        cases = [('reviewer-m3_unexplained_drift', drifted, snapshot, {}),
                 ('resume_snapshot_target_mismatch', current, dict(snapshot, target=dict(self.target, sha='9' * 40)), {}),
                 ('crawler-m3_resume_runtime_unknown', current, snapshot, {'unknown': ('crawler-m3',)}),
                 ('crawler-m3_resume_swarm_updating', current, snapshot, {'settle': 'updating'})]
        image = json.loads(json.dumps(current))
        image['web-mini']['dockerImage'] = release.IMAGE_PREFIX['web'] + 'sha256:' + '1' * 64
        cases.append(('web-mini_unexplained_drift', image, snapshot, {}))
        for code, apps, snap, runtime in cases:
            with self.subTest(code=code):
                client = FakeClient(apps)
                with patch.object(release, 'probe', side_effect=self.fake_runtime(**runtime)) as remote:
                    with self.assertRaisesRegex(ValueError, '^' + code):
                        release.resume_baseline(client, self.target, snap)
                self.assertEqual(client.requests, [])
                if 'drift' in code or 'mismatch' in code:
                    remote.assert_not_called()  # 설정 확인이 실행 확인보다 먼저다

    def test_resume_skips_finished_apps_redeploys_the_rolled_back_one_and_keeps_the_original_snapshot(self):
        snapshot, current = self.mixed_after_597()
        client = FakeClient(current)
        with patch.object(release, 'probe', side_effect=self.fake_runtime()):
            state = release.resume_baseline(client, self.target, snapshot)
        events, output = [], io.StringIO()
        with patch.object(release, 'save_snapshot') as save, \
             patch.object(release, 'stage_and_deploy', side_effect=lambda _c, short, *_a: events.append(('stage', short)) or {'app': short}), \
             patch.object(release, 'deploy_app', side_effect=lambda _c, short, _t: events.append(('redeploy', short)) or {'app': short}), \
             patch.object(release, 'monitor_gate', side_effect=lambda _c, role, **_k: events.append(('gate', role)) or {'role': role}), \
             patch.object(release, 'public_gate', return_value={'publicHealth': 'ok'}), \
             patch.object(release, 'purge_html', return_value={'htmlPurge': 'skipped'}), redirect_stdout(output):
            release.deploy(client, self.target, 'token', state, '/private/tmp/stopped.json')
        save.assert_not_called()  # 되돌릴 이전 설정은 멈춘 run 의 스냅샷에 있다
        self.assertEqual(events, [('gate', 'publisher'), ('gate', 'reviewer'), ('redeploy', 'crawler-m3'), ('gate', 'crawler'),
                                  ('stage', 'web-mini'), ('stage', 'web-m3')])
        out = lines(output)
        self.assertEqual(out[0]['resumed'], ['publisher-mini', 'publisher-m3', 'reviewer-mini', 'reviewer-m3', 'crawler-mini', 'crawler-m3'])
        skipped = [line['app'] for line in out if line.get('resume') == 'already_target']
        self.assertEqual(skipped, ['publisher-mini', 'publisher-m3', 'reviewer-mini', 'reviewer-m3', 'crawler-mini'])
        self.assertEqual(client.requests, [])

    def test_a_resumed_app_changed_after_the_resume_preflight_is_not_touched(self):
        snapshot, current = self.mixed_after_597()
        client = FakeClient(current)
        current['crawler-m3']['env'] = 'RELEASE_TAG=' + self.previous['sha'] + '\n'
        with patch.object(release, 'deploy_app') as deploy, self.assertRaisesRegex(ValueError, 'crawler-m3_changed_since_preflight'):
            release.resume_app(client, 'crawler-m3', self.target, 'token', self.previous, 'redeploy')
        deploy.assert_not_called()

    def test_main_resume_reads_the_stopped_snapshot_and_lets_the_preflight_gate_accept_the_half_released_pair(self):
        snapshot, current = self.mixed_after_597()
        base = ['--sha', self.target['sha'], '--worker-image', self.target['worker'], '--web-image', self.target['web']]
        for arguments in (['run'] + base + ['--resume'], ['restore', '--snapshot', '/private/tmp/x.json', '--app', 'crawler-m3', '--resume'],
                          ['prepull'] + base + ['--resume', '--snapshot', '/private/tmp/x.json']):
            with self.subTest(arguments=arguments), patch.object(release, 'run') as keychain, redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    release.main(arguments)
                keychain.assert_not_called()
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / 'stopped.json')
            release.save_snapshot(path, self.target, {'previous': self.previous, 'apps': snapshot['apps']})
            output, client = io.StringIO(), FakeClient(current)
            with patch.object(release, 'run', side_effect=['operator-secret', self.target['sha'], '']), \
                 patch.object(release, 'main_sha_and_token', return_value='registry-secret'), \
                 patch.object(release, 'Dokploy', return_value=client), \
                 patch.object(release, 'probe', side_effect=self.fake_runtime()), patch.object(release, 'baseline') as fresh, \
                 patch.object(release, 'github_integration_preflight', return_value={}), \
                 patch.object(release, 'agent_scan_release_gate', return_value={'agentScanGate': 'release_gated'}), \
                 patch.object(release, 'monitor_gate', return_value={'role': 'crawler', 'readiness': 'ready', 'progress': 'ok',
                                                                     'standbyActive': ['text']}) as gate, \
                 patch.object(release, 'pre_pull'), patch.object(release, 'deploy') as deploy, redirect_stdout(output):
                release.main(['run'] + base + ['--resume', '--snapshot', path])
        fresh.assert_not_called()
        gate.assert_called_once_with(client, 'crawler', strict=(),
                                     allow={'crawler': ('release_mismatch',)})
        plan = lines(output)[-1]
        self.assertEqual(plan['resume']['crawler-m3'], 'redeploy')
        self.assertEqual(plan['standbyActive'], ['text'])
        self.assertEqual(deploy.call_args.args[3]['resume']['web-m3'], 'previous')
        self.assertEqual(deploy.call_args.args[4], path)

    # ---- 감시 관문: 유효한 소유자 ----------------------------------------------------------------------------------
    @staticmethod
    def reports(scheduler='ready', progress='ok', **reasons):
        roles = {'publisher': 'ready', 'reviewer': 'ready', 'crawler': 'ready', 'maintenance': 'ready', 'text': 'ready', **reasons}
        readiness = {'overall': 'ok', 'roles': [{'role': role, 'reason': reason} for role, reason in roles.items()],
                     'scheduler': {'reason': scheduler}}
        return {'check-failover-readiness.ts': {'overall': 'ok', 'readiness': readiness}, 'check-worker-progress.ts': {'overall': progress}}

    def test_gate_accepts_whichever_valid_holder_except_for_the_role_just_released(self):
        verdict = release.gate_verdict
        # 배포 전: 예비가 쥔 역할도 유효한 소유자다(예비를 먼저 올리면 주가 되찾는다)
        self.assertTrue(verdict(self.reports(crawler='standby_active'), ('crawler',), strict=())['passed'])
        self.assertEqual(verdict(self.reports(crawler='standby_active'), ('crawler',), strict=())['standbyActive'], ['crawler'])
        # 방금 올린 역할은 M3 주가 쥐어야 한다 — 예비가 쥐면 넘겨주기를 기다린다
        held = verdict(self.reports(crawler='standby_active'), ('crawler',))
        self.assertEqual((held['passed'], held['handoff'], held['blocking']), (False, True, ['crawler=standby_active']))
        other = verdict(self.reports(text='standby_active'), ('crawler',))
        self.assertEqual((other['passed'], other['standbyActive']), (True, ['text']))
        # 유효한 소유자가 아닌 상태와 scheduler·진행은 예전처럼 막는다
        for reasons, blocking in (({'crawler': 'primary_quarantined'}, 'crawler=primary_quarantined'),
                                  ({'text': 'lease_expired'}, 'text=lease_expired'), ({'reviewer': 'standby_missing'}, 'reviewer=standby_missing'),
                                  ({'scheduler': 'replica_missing'}, 'scheduler=replica_missing'), ({'progress': 'alarm'}, 'progress=alarm')):
            with self.subTest(reasons=reasons):
                result = verdict(self.reports(**reasons), ('crawler',), strict=())
                self.assertEqual((result['passed'], result['blocking']), (False, [blocking]))
        # --resume 의 반쯤 올린 쌍
        self.assertFalse(verdict(self.reports(crawler='release_mismatch'), ('crawler',), strict=())['passed'])
        self.assertTrue(verdict(self.reports(crawler='release_mismatch'), ('crawler',), strict=(),
                                allow={'crawler': ('release_mismatch',)})['passed'])
        # 보고가 비면(DB 읽기 실패) 통과하지 않는다
        empty = {'check-failover-readiness.ts': {'overall': 'unknown', 'readiness': None}, 'check-worker-progress.ts': {'overall': 'ok'}}
        self.assertFalse(verdict(empty, ('crawler',))['passed'])

    def test_gate_waits_longer_for_the_primary_to_take_back_a_standby_held_role(self):
        client = FakeClient({'crawler-m3': {'appName': 'service-crawler-m3'}})
        answers = iter([self.reports(crawler='standby_active')] * 3 + [self.reports()])
        clock = iter([0, 0, 100, 130, 200])  # 시작, 확인 셋(120초 한도를 넘김), 넷째에 주가 되찾음
        output = io.StringIO()
        with patch.object(release, 'ssh_python', side_effect=lambda *a, **k: json.dumps(next(answers))), \
             patch.object(release.time, 'monotonic', side_effect=lambda: next(clock)), patch.object(release.time, 'sleep'), \
             redirect_stdout(output):
            self.assertEqual(release.monitor_gate(client, 'crawler'), {'role': 'crawler', 'readiness': 'ready', 'progress': 'ok'})
        self.assertEqual(lines(output)[0]['handoff'], 'waiting_for_primary')
        # 더 기다려도 주가 못 되찾으면 받지 못한 사유를 붙여 멈춘다
        clock = iter([0, 0, 100, 400])
        with patch.object(release, 'ssh_python', return_value=json.dumps(self.reports(crawler='standby_active'))), \
             patch.object(release.time, 'monotonic', side_effect=lambda: next(clock)), patch.object(release.time, 'sleep'), \
             redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(TimeoutError, '^crawler_monitor_gate_timeout:crawler=standby_active$'):
                release.monitor_gate(client, 'crawler')
        # 다른 역할의 경보는 넘겨주기가 아니므로 한도를 늘리지 않는다
        clock = iter([0, 0, 130])
        with patch.object(release, 'ssh_python', return_value=json.dumps(self.reports(progress='alarm'))), \
             patch.object(release.time, 'monotonic', side_effect=lambda: next(clock)), patch.object(release.time, 'sleep'):
            with self.assertRaisesRegex(TimeoutError, '^crawler_monitor_gate_timeout:progress=alarm$'):
                release.monitor_gate(client, 'crawler')


if __name__ == '__main__':
    unittest.main()
