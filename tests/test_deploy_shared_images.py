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
            with patch.object(release, 'check_app_deployed', return_value={'app': 'publisher-mini'}) as gate:
                result = release.restore(client, path, 'publisher-mini', 'token')
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
    """PR11d: read-only coverage of all 13 production Dokploy apps plus connect-agent; `run` stays the same 8 apps."""

    def setUp(self):
        self.sha = 'b' * 40

    def fleet(self, release_tag=None):
        return {short: {'sourceType': 'docker' if short in release.APPS else 'github', 'applicationStatus': 'done', 'replicas': 1,
                        'env': 'RELEASE_TAG=' + (release_tag or self.sha) + '\nSECRET_TOKEN=do-not-print\n', 'appName': 'service-' + short}
                for short in release.KNOWN_APPS}

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
        self.assertEqual((result['appCount'], result['complete'], result['pending']), (14, True, []))
        self.assertEqual({short: row['deployedBy'] for short, row in result['apps'].items()},
                         {short: 'run' if short in release.APPS else 'manual-git-build' for short in release.KNOWN_APPS})
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
            self.assertEqual((app_id, name, kind), ('', '', 'worker'))
            self.assertEqual(server, release.MINI if short.endswith('-mini') else release.M3)
            self.assertNotIn(short, release.KNOWN_APPS)
        self.assertEqual(release.release_order(), release.ORDER)

    def test_an_unregistered_consumer_is_refused_before_any_dokploy_request(self):
        client = release.Dokploy('unused-key')
        with patch.object(client, 'request') as request:
            for short in CONSUMERS:
                with self.assertRaisesRegex(ValueError, short + '_app_unregistered'):
                    client.app(short)
                with self.assertRaisesRegex(ValueError, short + '_app_unregistered'):
                    client.latest(short)
            request.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'ai3-consumer-m3_unknown_app'):
            release.app_metadata('ai3-consumer-m3')
        with self.assertRaisesRegex(ValueError, 'ai1-consumer-mini_app_unregistered'):
            release.consumer_apps(['ai1'])
        with self.assertRaisesRegex(ValueError, 'agent-scan-consumer-m3_app_unregistered'):
            release.consumer_apps(['agent-scan'])

    def test_main_refuses_unregistered_or_misused_consumer_targets_before_keychain(self):
        base = ['--sha', self.new_sha, '--worker-image', self.target['worker'], '--web-image', self.target['web']]
        for arguments, error in ((['plan'] + base + ['--consumer', 'ai2'], 'ai2-consumer-mini_app_unregistered'),
                                 (['run'] + base + ['--snapshot', '/private/tmp/x.json', '--consumer', 'ai1'], 'ai1-consumer-mini_app_unregistered'),
                                 (['plan'] + base + ['--consumer', 'agent-scan'], 'agent-scan-consumer-m3_app_unregistered'),
                                 (['restore', '--snapshot', '/private/tmp/x.json', '--app', 'agent-scan-consumer-m3'], 'agent-scan-consumer-m3_app_unregistered'),
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
        self.assertEqual((result['appCount'], result['complete']), (14, True))
        self.assertEqual(result['consumerApps'], dict.fromkeys(CONSUMERS, 'unregistered'))
        fleet['ai2-consumer-m3']['env'] = 'RELEASE_TAG=' + self.old_sha + '\n'
        with self.registered():
            result = release.inventory(FakeClient(fleet), self.new_sha)
        self.assertEqual((result['appCount'], result['complete'], result['pending']), (19, False, ['ai2-consumer-m3']))
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
            with self.gated(gated), self.probe(*outcomes), \
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


if __name__ == '__main__':
    unittest.main()
