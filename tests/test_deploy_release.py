import contextlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/ops/deploy_release.py'
spec = importlib.util.spec_from_file_location('release_under_test', SOURCE)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)
OLD, NEW = 'a' * 40, 'b' * 40
SECRET = 'synthetic-secret-value'


@contextlib.contextmanager
def observer_source_modes(mode):
    """Pin checkout tool modes for one test, then put the previous mode back."""
    module = release.load('observer_source_modes', 'release_observer.py')
    saved = []
    try:
        for relative in module.SOURCE_FILES:
            path = release.ROOT / relative
            saved.append((path, stat.S_IMODE(path.stat().st_mode)))
            os.chmod(path, mode)
        yield [path for path, _mode in saved]
    finally:
        for path, original in saved:
            os.chmod(path, original)


def saved_env(kind, **settings):
    lines = {'RELEASE_TAG': OLD, 'WORKER_ROLE': 'text', 'DB_POOL_MAX': '6', 'SECRET': '"' + SECRET + '"'}
    if kind == 'web':
        lines.update(NEXT_DEPLOYMENT_ID=OLD, WORKER_ROLE=None)
    lines.update(settings)
    return ''.join(key + '=' + value + '\n' for key, value in lines.items() if value is not None)


def live_env(kind, **settings):
    lines = {'RELEASE_TAG': OLD, 'WORKER_ROLE': 'text', 'DB_POOL_MAX': '6', 'SECRET': SECRET}
    if kind == 'web':
        lines.update(NEXT_DEPLOYMENT_ID=OLD, WORKER_ROLE=None)
    lines.update(settings)
    return [key + '=' + value for key, value in lines.items() if value is not None]


def drift_snapshot(**live):
    """text-mini (Git build) and publisher-m3 (Docker image) with optional live spec overrides per app."""
    snapshot = {'schemaVersion': 1, 'apps': {}, 'runtime': {}, 'baseline': {}, 'latest': {}}
    for short, source in (('text-mini', 'github'), ('text-m3', 'github'), ('publisher-m3', 'docker'), ('web-mini', 'docker')):
        kind = 'web' if short.startswith('web-') else 'worker'
        snapshot['apps'][short] = {'appName': 'service-' + short, 'sourceType': source, 'env': saved_env(kind)}
        snapshot['runtime'][short] = {'serviceSpec': {'TaskTemplate': {'ContainerSpec': {
            'Image': 'image', 'Env': live_env(kind, **live.get(short.replace('-', '_'), {}))}}}, 'containers': []}
        snapshot['baseline'][short] = {'release': OLD}
        snapshot['latest'][short] = {'status': 'done', 'deploymentId': 'old-' + short}
    return snapshot


class EnvDriftPreflightTests(unittest.TestCase):
    def test_env_drift_ignores_release_settings_and_names_changed_variables_without_values(self):
        snapshot = drift_snapshot(text_mini={'RELEASE_TAG': NEW, 'DB_POOL_MAX': '3', 'LEGACY_FLAG': '1', 'SECRET': None})
        found = release.env_drift(snapshot['apps']['text-mini'], snapshot['runtime']['text-mini'])
        self.assertEqual(found, {'missingInService': ['SECRET'], 'unexpectedInService': ['LEGACY_FLAG'],
                                 'valueChanged': ['DB_POOL_MAX']})
        self.assertNotIn(SECRET, json.dumps(found)); self.assertNotIn('=', json.dumps(found))
        same = drift_snapshot(web_mini={'RELEASE_TAG': NEW, 'NEXT_DEPLOYMENT_ID': NEW})
        self.assertEqual(release.env_drift(same['apps']['web-mini'], same['runtime']['web-mini']),
                         {'missingInService': [], 'unexpectedInService': [], 'valueChanged': []})
        self.assertEqual(release.env_drift_preflight(same, ['web-mini', 'text-mini', 'publisher-m3'])['checkedApps'],
                         ['web-mini', 'text-mini', 'publisher-m3'])

    def test_env_drift_preflight_names_the_first_drifted_app_and_lists_git_and_docker_apps(self):
        snapshot = drift_snapshot(text_mini={'DB_POOL_MAX': '3'}, publisher_m3={'NEW_FLAG': 'on'})
        with self.assertRaises(ValueError) as caught:
            release.env_drift_preflight(snapshot, ['publisher-m3', 'text-mini', 'web-mini'])
        self.assertEqual(str(caught.exception), 'publisher-m3_env_drift_redeploy_required')
        self.assertEqual(caught.exception.safe_detail, {'envDrift': {
            'publisher-m3': {'missingInService': [], 'unexpectedInService': ['NEW_FLAG'], 'valueChanged': []},
            'text-mini': {'missingInService': [], 'unexpectedInService': [], 'valueChanged': ['DB_POOL_MAX']}}})
        # Only the unselected app drifts: nothing to refuse.
        release.env_drift_preflight(snapshot, ['web-mini'])

    def test_create_plan_stops_on_env_drift_before_credentials_images_or_the_private_directory(self):
        snapshot = drift_snapshot(text_mini={'DB_POOL_MAX': '3'})
        def local_git(command, **kwargs):
            self.assertEqual(command[0], 'git')
            return NEW if 'rev-parse' in command else ''
        decision = {'selectedApps': ['text-mini', 'text-m3'], 'retainedApps': [], 'mode': 'role', 'rulesVersion': 'v2'}
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(release.shared, 'run', side_effect=local_git), \
                patch.object(release, 'read_private', return_value=snapshot), \
                patch.object(release, 'impact', return_value=decision), \
                patch.object(release, 'new_client', side_effect=AssertionError('credential accessed')), \
                patch.object(release.readiness, 'resolve_readiness', side_effect=AssertionError('CI read')), \
                patch.object(release.shared, 'ssh_python', side_effect=AssertionError('remote call')):
            output = Path(directory) / 'release-out'
            with self.assertRaisesRegex(ValueError, '^text-mini_env_drift_redeploy_required$'):
                release.create_plan(NEW, output, baseline_path=Path(directory) / 'baseline.json', baseline_sha='0' * 64)
            self.assertFalse(output.exists())

    def test_failure_report_exposes_bare_codes_and_hides_everything_else(self):
        for error, reason in ((ValueError('text-mini_env_drift_redeploy_required'), 'text-mini_env_drift_redeploy_required'),
                              (RuntimeError('batch_failed_review_all_started_app_receipts'), 'batch_failed_review_all_started_app_receipts'),
                              (release.PlanRefused('RELEASE_TAG_mismatch'), 'RELEASE_TAG_mismatch'),
                              (release.shared.ReleaseStopped('text-m3_swarm_paused:task_error=No such container'), 'inspect-private-receipts'),
                              (ValueError('token with spaces'), 'inspect-private-receipts'),
                              (ValueError('https://deploy.example/api?key=' + SECRET), 'inspect-private-receipts'),
                              (KeyError('DB_POOL_MAX'), 'inspect-private-receipts'),
                              (ValueError('ab'), 'inspect-private-receipts'),
                              (ValueError('x' * 161), 'inspect-private-receipts'),
                              (FileNotFoundError(2, 'No such file', '/private/path'), 'inspect-private-receipts')):
            with self.subTest(error=error):
                report = release.failure_report(error)
                self.assertEqual(report, {'status': 'release-not-complete', 'errorClass': type(error).__name__,
                                          'reason': reason, 'automaticRetry': False})
                self.assertNotIn(SECRET, json.dumps(report))
        coded = RuntimeError('free text'); coded.code = 'explicit_code'
        self.assertEqual(release.failure_report(coded)['reason'], 'explicit_code')
        coded.code = 'not a code'
        self.assertEqual(release.failure_report(coded)['reason'], 'inspect-private-receipts')

    def test_plan_failure_record_keeps_code_stage_and_names_without_values_and_never_raises(self):
        snapshot = drift_snapshot(text_mini={'DB_POOL_MAX': '3', 'SECRET': 'rotated-' + SECRET})
        with self.assertRaises(release.PlanRefused) as caught:
            release.env_drift_preflight(snapshot, ['text-mini'])
        with tempfile.TemporaryDirectory() as directory:
            store = Path(directory) / 'state/plan-failures'
            with patch.object(release, 'PLAN_FAILURE_DIR', store):
                path = release.record_plan_failure(caught.exception, 'plan')
                self.assertTrue(Path(path).is_relative_to(store)); self.assertTrue(path.endswith('.safe.json'))
                self.assertEqual(Path(path).stat().st_mode & 0o777, 0o600)
                self.assertEqual(store.stat().st_mode & 0o777, 0o700)
                text = Path(path).read_text()
                record = json.loads(text)
                self.assertEqual((record['stage'], record['reason'], record['errorClass'], record['status']),
                                 ('plan', 'text-mini_env_drift_redeploy_required', 'PlanRefused', 'release-not-complete'))
                self.assertEqual(record['detail'], {'envDrift': {'text-mini': {
                    'missingInService': [], 'unexpectedInService': [], 'valueChanged': ['DB_POOL_MAX', 'SECRET']}}})
                self.assertNotIn(SECRET, text); self.assertNotIn('=3', text); self.assertNotIn('=6', text)
                # Free-text messages are recorded by class only.
                other = release.record_plan_failure(FileNotFoundError(2, 'No such file', '/private/' + SECRET), 'plan')
                record = json.loads(Path(other).read_text())
                self.assertEqual((record['reason'], record['detail'], record['errorClass']), ('inspect-private-receipts', None, 'FileNotFoundError'))
                self.assertNotIn(SECRET, Path(other).read_text())
            blocked = Path(directory) / 'file'; blocked.write_text('x')
            with patch.object(release, 'PLAN_FAILURE_DIR', blocked / 'child'):
                self.assertIsNone(release.record_plan_failure(caught.exception, 'plan'))

    def test_cli_plan_failure_prints_the_safe_code_and_the_record_path_before_any_private_directory(self):
        snapshot = drift_snapshot(text_mini={'DB_POOL_MAX': '3'})
        decision = {'selectedApps': ['text-mini', 'text-m3'], 'retainedApps': [], 'mode': 'role', 'rulesVersion': 'v2'}
        cwd = os.getcwd(); self.addCleanup(os.chdir, cwd)
        with tempfile.TemporaryDirectory() as directory, \
                patch.object(release.shared, 'run', side_effect=lambda command, **kwargs: NEW if 'rev-parse' in command else ''), \
                patch.object(release, 'read_private', return_value=snapshot), \
                patch.object(release, 'impact', return_value=decision), \
                patch.object(release, 'PLAN_FAILURE_DIR', Path(directory) / 'plan-failures'), \
                patch.object(release, 'new_client', side_effect=AssertionError('credential accessed')):
            output = Path(directory) / 'release-out'
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = release.cli(['plan', '--sha', NEW, '--out', str(output), '--baseline', str(Path(directory) / 'baseline.json'),
                                    '--baseline-sha', '0' * 64])
            self.assertEqual(code, 1)
            report = json.loads(stdout.getvalue())
            self.assertEqual((report['status'], report['reason'], report['errorClass'], report['automaticRetry']),
                             ('release-not-complete', 'text-mini_env_drift_redeploy_required', 'PlanRefused', False))
            record = json.loads(Path(report['failureRecord']).read_text())
            self.assertEqual((record['stage'], record['reason']), ('plan', 'text-mini_env_drift_redeploy_required'))
            self.assertEqual(record['detail']['envDrift']['text-mini']['valueChanged'], ['DB_POOL_MAX'])
            self.assertFalse(output.exists())
            self.assertNotIn(SECRET, stdout.getvalue())


class ObserverSourcePreflightTests(unittest.TestCase):
    def fill(self, root, mode=0o644):
        module = release.load('observer_source_fill', 'release_observer.py')
        for relative in module.SOURCE_FILES:
            path = Path(root) / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('source\n')
            os.chmod(path, mode)
        return module

    def test_preflight_accepts_owner_0644_and_refuses_group_writable_with_a_safe_detail(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module = self.fill(root)
            receipt = release.observer_source_preflight(root)
            self.assertEqual(receipt['checkedFiles'], list(module.SOURCE_FILES))
            self.assertNotIn(str(root), json.dumps(receipt))
            self.assertNotIn(str(release.ROOT), json.dumps(receipt))
            os.chmod(root / module.SOURCE_FILES[0], 0o664)
            (root / module.SOURCE_FILES[1]).unlink()
            with self.assertRaises(release.PlanRefused) as caught:
                release.observer_source_preflight(root)
        self.assertEqual(caught.exception.code, 'observer_source_group_writable')
        self.assertTrue(release.SAFE_CODE.fullmatch(caught.exception.code))
        self.assertEqual(caught.exception.safe_detail['observerSources'][:2], [
            {'file': module.SOURCE_FILES[0], 'problem': 'group_or_world_writable'},
            {'file': module.SOURCE_FILES[1], 'problem': 'missing'}])
        text = json.dumps(caught.exception.safe_detail)
        self.assertNotIn(str(root), text)
        self.assertNotIn(str(release.ROOT), text)
        self.assertNotIn(SECRET, text)

    def test_each_problem_kind_has_its_own_plan_code(self):
        first_cases = (
            ('group', 0o664, 'observer_source_group_writable', 'group_or_world_writable'),
            ('world', 0o606, 'observer_source_group_writable', 'group_or_world_writable'),
        )
        for name, mode, code, problem in first_cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                module = self.fill(root)
                os.chmod(root / module.SOURCE_FILES[0], mode)
                with self.assertRaises(release.PlanRefused) as caught:
                    release.observer_source_preflight(root)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(caught.exception.safe_detail, {'observerSources': [
                    {'file': module.SOURCE_FILES[0], 'problem': problem}]})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module = self.fill(root)
            (root / module.SOURCE_FILES[0]).unlink()
            with self.assertRaises(release.PlanRefused) as caught:
                release.observer_source_preflight(root)
            self.assertEqual(caught.exception.code, 'observer_source_missing')
            self.assertEqual(caught.exception.safe_detail['observerSources'][0]['problem'], 'missing')
            self.fill(root)
            target = root / module.SOURCE_FILES[0]
            target.unlink()
            target.symlink_to(root / module.SOURCE_FILES[1])
            with self.assertRaises(release.PlanRefused) as caught:
                release.observer_source_preflight(root)
            self.assertEqual(caught.exception.code, 'observer_source_not_regular')
            self.assertEqual(caught.exception.safe_detail['observerSources'][0],
                             {'file': module.SOURCE_FILES[0], 'problem': 'not_regular'})
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            module = self.fill(root)
            with patch.object(os, 'getuid', return_value=os.getuid() + 1), \
                    self.assertRaises(release.PlanRefused) as caught:
                release.observer_source_preflight(root)
            self.assertEqual(caught.exception.code, 'observer_source_not_owned')
            self.assertEqual(caught.exception.safe_detail['observerSources'][0]['problem'], 'not_owned')
            self.assertNotIn(str(root), json.dumps(caught.exception.safe_detail))

    def test_create_plan_stops_on_a_group_writable_observer_source_before_credentials(self):
        snapshot = drift_snapshot()
        decision = {'selectedApps': ['text-mini', 'text-m3'], 'retainedApps': [], 'mode': 'role', 'rulesVersion': 'v2'}
        with observer_source_modes(0o644) as paths, tempfile.TemporaryDirectory() as directory, \
                patch.object(release.shared, 'run', side_effect=lambda command, **kwargs: NEW if 'rev-parse' in command else ''), \
                patch.object(release, 'read_private', return_value=snapshot), \
                patch.object(release, 'impact', return_value=decision), \
                patch.object(release, 'new_client', side_effect=AssertionError('credential accessed')), \
                patch.object(release.readiness, 'resolve_readiness', side_effect=AssertionError('CI read')), \
                patch.object(release.shared, 'ssh_python', side_effect=AssertionError('remote call')):
            os.chmod(paths[0], 0o664)
            output = Path(directory) / 'release-out'
            with self.assertRaises(release.PlanRefused) as caught:
                release.create_plan(NEW, output, baseline_path=Path(directory) / 'baseline.json', baseline_sha='0' * 64)
            self.assertEqual(str(caught.exception), 'observer_source_group_writable')
            self.assertEqual(caught.exception.safe_detail, {'observerSources': [
                {'file': 'scripts/ops/release_observer.py', 'problem': 'group_or_world_writable'}]})
            self.assertFalse(output.exists())
            recorded = release.record_plan_failure(caught.exception, 'plan', Path(directory) / 'plan-failures')
            text = Path(recorded).read_text()
            record = json.loads(text)
            self.assertEqual((record['stage'], record['reason'], record['errorClass']),
                             ('plan', 'observer_source_group_writable', 'PlanRefused'))
            self.assertEqual(record['detail']['observerSources'][0]['file'], 'scripts/ops/release_observer.py')
            self.assertNotIn(str(release.ROOT), text)
            self.assertNotIn(SECRET, text)

    def test_schedule_failure_receipt_keeps_the_reason_code_and_relative_file_only(self):
        module = release.load('observer_schedule_failure', 'release_observer.py')
        with observer_source_modes(0o644) as paths:
            os.chmod(paths[0], 0o664)
            with self.assertRaises(module.ObserverError) as caught:
                module._source_hashes()
        record = release.observation_failure(caught.exception)
        self.assertEqual(record['status'], 'schedule-failed')
        self.assertEqual(record['errorClass'], 'ObserverError')
        self.assertEqual(record['reason'], 'observer_source_group_writable')
        self.assertEqual(record['file'], 'scripts/ops/release_observer.py')
        self.assertNotIn(str(release.ROOT), json.dumps(record))
        absolute = module.ObserverError('observer_source_not_owned', source=str(paths[0]))
        hidden_path = release.observation_failure(absolute)
        self.assertEqual(hidden_path['reason'], 'observer_source_not_owned')
        self.assertNotIn('file', hidden_path)
        self.assertNotIn(str(release.ROOT), json.dumps(hidden_path))
        leaked = release.observation_failure(OSError('SECRET=' + SECRET))
        self.assertNotIn('reason', leaked)
        self.assertNotIn('file', leaked)
        self.assertNotIn(SECRET, json.dumps(leaked))
        self.assertEqual(leaked['errorClass'], 'OSError')


WORKER = release.shared.IMAGE_PREFIX['worker'] + 'sha256:' + 'c' * 64
WEB = release.shared.IMAGE_PREFIX['web'] + 'sha256:' + 'd' * 64
TARGET = {'sha': NEW, 'worker': WORKER, 'web': WEB}


class RetireSettingTests(unittest.TestCase):
    """plan --retire-setting NAME: the release deletes named saved settings from every app it redeploys."""

    def test_names_are_validated_sorted_deduplicated_and_protected_names_refused_without_echoing_values(self):
        self.assertEqual(release.validate_retired_settings(['CRAWL_REVIEW_MODEL', 'ABCLLM_API_KEY', 'ABCLLM_API_KEY']),
                         ('ABCLLM_API_KEY', 'CRAWL_REVIEW_MODEL'))
        self.assertEqual(release.validate_retired_settings([]), ()); self.assertEqual(release.validate_retired_settings(None), ())
        for bad in ('abcllm_api_key', 'Abc', '1ABC', 'A-B', 'A=B', '', ' A', 'A' * 65, 'ABCLLM API_KEY', None, 5):
            with self.subTest(bad=bad), self.assertRaises(release.PlanRefused) as caught:
                release.validate_retired_settings(['ABCLLM_API_KEY', bad])
            self.assertEqual((caught.exception.code, caught.exception.safe_detail), ('retire_setting_name_invalid', {}))
        for protected in ('RELEASE_TAG', 'NEXT_DEPLOYMENT_ID', 'WORKER_ROLE', 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY', 'DATABASE_URL',
                          'PUBLIC_USER_AUTH_ENABLED', 'GITHUB_FEEDBACK_APP_PRIVATE_KEY', 'AUTH_SECRET', 'LOGIN_EMAIL_FROM'):
            with self.subTest(protected=protected), self.assertRaises(release.PlanRefused) as caught:
                release.validate_retired_settings(['ABCLLM_API_KEY', protected])
            self.assertEqual(caught.exception.code, 'retire_setting_protected:' + protected)
            self.assertEqual(release.failure_report(caught.exception)['reason'], 'retire_setting_protected:' + protected)
        self.assertTrue(set(release.RELEASE_SETTINGS) | set(release.shared.INTEGRATION_SETTINGS) <= release.PROTECTED_SETTINGS)
        for name in ('ABCLLM_API_KEY', 'ABCLLM_SERVING_CONTRACTS', 'ABCLLM_TAGLINE_MODEL', 'PRODUCT_TRANSLATION_MODEL', 'CRAWL_REVIEW_MODEL'):
            self.assertNotIn(name, release.PROTECTED_SETTINGS)

    def test_cli_option_is_repeatable_and_a_refused_name_stops_before_any_baseline_read_or_credential(self):
        captured = {}
        cwd = os.getcwd(); self.addCleanup(os.chdir, cwd)
        with patch.object(release, 'create_plan', side_effect=lambda sha, out, **kwargs: captured.update(kwargs) or {'status': 'planned'}), \
                contextlib.redirect_stdout(io.StringIO()):
            release.main(['plan', '--sha', NEW, '--out', '/tmp/unused', '--retire-setting', 'CRAWL_REVIEW_MODEL',
                          '--retire-setting', 'ABCLLM_API_KEY'])
            self.assertEqual(captured['retire_settings'], ['CRAWL_REVIEW_MODEL', 'ABCLLM_API_KEY'])
            release.main(['plan', '--sha', NEW, '--out', '/tmp/unused'])
            self.assertEqual(captured['retire_settings'], [])
        for refused, reason in (('RELEASE_TAG', 'retire_setting_protected:RELEASE_TAG'), ('abcllm-api-key', 'retire_setting_name_invalid')):
            with self.subTest(refused=refused), tempfile.TemporaryDirectory() as directory, \
                    patch.object(release.shared, 'run', side_effect=AssertionError('git read')), \
                    patch.object(release, 'read_private', side_effect=AssertionError('baseline read')), \
                    patch.object(release.fleet, 'collect_baseline', side_effect=AssertionError('fleet read')), \
                    patch.object(release, 'new_client', side_effect=AssertionError('credential accessed')), \
                    patch.object(release, 'PLAN_FAILURE_DIR', Path(directory) / 'plan-failures'):
                output = Path(directory) / 'release-out'
                stdout = io.StringIO()
                with contextlib.redirect_stdout(stdout):
                    code = release.cli(['plan', '--sha', NEW, '--out', str(output), '--retire-setting', 'ABCLLM_API_KEY',
                                        '--retire-setting', refused])
                self.assertEqual(code, 1)
                report = json.loads(stdout.getvalue())
                self.assertEqual((report['status'], report['reason'], report['errorClass']), ('release-not-complete', reason, 'PlanRefused'))
                self.assertEqual(json.loads(Path(report['failureRecord']).read_text())['reason'], reason)
                self.assertFalse(output.exists())
                if refused == 'abcllm-api-key':
                    self.assertNotIn(refused, stdout.getvalue() + Path(report['failureRecord']).read_text())

    def target_apps(self):
        """publisher-m3 (Docker) and web-mini already serve the target release and images; text-m3 is still old."""
        snapshot = {'schemaVersion': 1, 'apps': {}, 'runtime': {}, 'baseline': {}, 'latest': {}}
        for short, kind, release_sha in (('publisher-m3', 'worker', NEW), ('web-mini', 'web', NEW), ('text-m3', 'worker', OLD)):
            env = saved_env(kind, RELEASE_TAG=release_sha, **({'NEXT_DEPLOYMENT_ID': release_sha} if kind == 'web' else {}))
            snapshot['apps'][short] = {'appName': 'service-' + short, 'sourceType': 'docker', 'env': env,
                                       'dockerImage': TARGET[kind] if release_sha == NEW else TARGET[kind].replace('c' * 64, 'e' * 64),
                                       'buildArgs': 'NEXT_DEPLOYMENT_ID=' + release_sha + '\n' if kind == 'web' else ''}
            snapshot['runtime'][short] = {'serviceSpec': {'TaskTemplate': {'ContainerSpec': {
                'Image': snapshot['apps'][short]['dockerImage'],
                'Env': live_env(kind, RELEASE_TAG=release_sha, **({'NEXT_DEPLOYMENT_ID': release_sha} if kind == 'web' else {}))}}},
                'containers': []}
            snapshot['baseline'][short] = {'release': release_sha}
            snapshot['latest'][short] = {'status': 'done', 'deploymentId': 'old-' + short}
        return snapshot

    def test_exact_target_app_that_still_carries_a_retired_setting_is_deployed_not_skipped(self):
        snapshot = self.target_apps()
        selected = ['publisher-m3', 'web-mini', 'text-m3']
        self.assertEqual(release.already_target(snapshot, TARGET, selected), ['publisher-m3', 'web-mini'])
        # publisher-m3 still saves the setting; web-mini's saved env is clean but its live spec still renders it.
        snapshot['apps']['publisher-m3']['env'] += 'ABCLLM_API_KEY="' + SECRET + '"\n'
        snapshot['runtime']['publisher-m3']['serviceSpec']['TaskTemplate']['ContainerSpec']['Env'].append('ABCLLM_API_KEY=' + SECRET)
        snapshot['runtime']['web-mini']['serviceSpec']['TaskTemplate']['ContainerSpec']['Env'].append('ABCLLM_API_KEY=' + SECRET)
        self.assertEqual(release.already_target(snapshot, TARGET, selected), ['publisher-m3', 'web-mini'])
        self.assertEqual(release.already_target(snapshot, TARGET, selected, ('ABCLLM_API_KEY',)), [])
        self.assertEqual(release.already_target(snapshot, TARGET, selected, ('CRAWL_REVIEW_MODEL',)), ['publisher-m3', 'web-mini'])
        found = release.retired_settings_found(snapshot, selected, ('ABCLLM_API_KEY', 'CRAWL_REVIEW_MODEL'))
        self.assertEqual(found, {'publisher-m3': {'savedEnv': ['ABCLLM_API_KEY'], 'liveSpec': ['ABCLLM_API_KEY']},
                                 'web-mini': {'savedEnv': [], 'liveSpec': ['ABCLLM_API_KEY']},
                                 'text-m3': {'savedEnv': [], 'liveSpec': []}})
        self.assertNotIn(SECRET, json.dumps(found))
        self.assertEqual(release.retired_settings_found(snapshot, selected, ()), {})
        # The saved env a redeploy writes drops the line for Docker workers and webs alike; nothing else changes.
        expected = release.fleet.expected_api('publisher-m3', snapshot['apps']['publisher-m3'], TARGET, ('ABCLLM_API_KEY',))
        self.assertEqual(expected['env'], saved_env('worker', RELEASE_TAG=NEW))
        self.assertEqual(release.fleet.expected_api('web-mini', snapshot['apps']['web-mini'], TARGET, ('ABCLLM_API_KEY',)),
                         release.fleet.expected_api('web-mini', snapshot['apps']['web-mini'], TARGET))

    def test_impact_widens_the_code_scope_to_carriers_and_their_role_pairs(self):
        fixtures_spec = importlib.util.spec_from_file_location('retire_runtime_fixtures', Path(__file__).with_name('test_release_runtime.py'))
        fixtures = importlib.util.module_from_spec(fixtures_spec); fixtures_spec.loader.exec_module(fixtures)
        apps, rows, latest = fixtures.fixture()
        snapshot = {'apps': apps, 'runtime': rows, 'latest': latest, 'baseline': {short: {'release': OLD} for short in apps}}
        apps['text-m3']['env'] += 'ABCLLM_API_KEY=' + SECRET + '\n'
        rows['text-m3']['serviceSpec']['TaskTemplate']['ContainerSpec']['Env'].append('ABCLLM_API_KEY=' + SECRET)
        rows['ai2-consumer-m3']['serviceSpec']['TaskTemplate']['ContainerSpec']['Env'].append('CRAWL_REVIEW_MODEL=gpt')
        calls = []
        def classify(repo, after, baseline, *, known_apps, consumer_apps, requested_apps=None):
            calls.append(requested_apps)
            registered = list(release.fleet.registered_apps())
            selected = {'web-mini', 'web-m3'}
            if requested_apps is not None:
                self.assertTrue(selected <= set(requested_apps))
                selected = release.scope._expand_units(set(requested_apps), known_apps=known_apps, consumer_apps=consumer_apps)
            return {'rulesVersion': 'v2', 'allApps': registered, 'selectedApps': [short for short in registered if short in selected],
                    'retainedApps': [short for short in registered if short not in selected],
                    'mode': 'full' if len(selected) == len(registered) else 'scoped'}
        with patch.object(release.scope, 'plan_for_baselines', side_effect=classify):
            plain = release.impact(snapshot, NEW)
            self.assertEqual((plain['selectedApps'], calls), (['web-mini', 'web-m3'], [None]))
            self.assertNotIn('retiredSettingCarriers', plain)
            widened = release.impact(snapshot, NEW, ('ABCLLM_API_KEY', 'CRAWL_REVIEW_MODEL'))
        registered = list(release.fleet.registered_apps())
        # The classifier is asked once more with the code scope plus the carriers, in registered order.
        self.assertEqual(calls, [None, None, [short for short in registered if short in {'web-mini', 'web-m3', 'text-m3', 'ai2-consumer-m3'}]])
        # text-m3 pulls its standby, the consumer pulls the reviewer pair and the other reviewer consumer.
        self.assertEqual(widened['selectedApps'], [short for short in registered if short in {
            'web-mini', 'web-m3', 'text-mini', 'text-m3', 'reviewer-mini', 'reviewer-m3', 'ai1-consumer-m3', 'ai2-consumer-m3'}])
        self.assertEqual(widened['retiredSettingCarriers'], [short for short in registered if short in {'text-m3', 'ai2-consumer-m3'}])
        self.assertNotIn(SECRET, json.dumps(widened))
        # Carriers already inside the code scope do not call the classifier a second time.
        calls.clear()
        apps['web-m3']['env'] += 'ABCLLM_API_KEY=' + SECRET + '\n'
        del apps['text-m3']; apps['text-m3'] = {**fixtures.fixture()[0]['text-m3']}
        rows['text-m3']['serviceSpec']['TaskTemplate']['ContainerSpec']['Env'].pop()
        rows['ai2-consumer-m3']['serviceSpec']['TaskTemplate']['ContainerSpec']['Env'].pop()
        with patch.object(release.scope, 'plan_for_baselines', side_effect=classify):
            same = release.impact(snapshot, NEW, ('ABCLLM_API_KEY', 'CRAWL_REVIEW_MODEL'))
        self.assertEqual((same['selectedApps'], same['retiredSettingCarriers'], calls), (['web-mini', 'web-m3'], ['web-m3'], [None]))

    def test_create_plan_records_retired_names_and_their_presence_without_values_and_hands_them_to_the_git_rollout(self):
        snapshot = drift_snapshot()
        for short in ('text-mini', 'text-m3'):
            snapshot['apps'][short]['env'] = saved_env('worker', ABCLLM_API_KEY='"' + SECRET + '"')
            snapshot['runtime'][short]['serviceSpec']['TaskTemplate']['ContainerSpec']['Env'] = live_env('worker', ABCLLM_API_KEY=SECRET)
        decision = {'selectedApps': ['text-mini', 'text-m3'], 'retainedApps': [], 'mode': 'scoped', 'rulesVersion': 'v2'}
        prepared, verified = {}, []
        def prepare(client, target, selected, root_snapshot, proof, **kwargs):
            prepared.update(kwargs, selected=list(selected)); return {'skipped': [], 'retiredSettings': list(kwargs.get('retired_settings', ()))}
        def verify_fleet(client, snapshot, target, selected, receipts, repo, **kwargs):
            verified.append((list(selected), kwargs)); return {}
        with observer_source_modes(0o644), tempfile.TemporaryDirectory() as directory:
            with patch.object(release.shared, 'run', side_effect=lambda command, **kwargs: NEW if 'rev-parse' in command else ''), \
                    patch.object(release, 'read_private', return_value=snapshot), \
                    patch.object(release, 'impact', return_value=decision) as impact, \
                    patch.object(release, 'new_client', return_value=object()), \
                    patch.object(release.readiness, 'resolve_readiness', return_value={'target': {'sha': NEW, 'worker': WORKER}}), \
                    patch.object(release, 'merged_target', return_value=TARGET), \
                    patch.object(release.fleet, 'verify_fleet', side_effect=verify_fleet), \
                    patch.object(release, 'migration_changes', return_value=False), \
                    patch.object(release.shared, 'github_integration_preflight', return_value={'configurationMatched': True}), \
                    patch.object(release.shared, 'monitor_gate', return_value={'readiness': 'ready'}), \
                    patch.object(release, 'prepull', return_value={'hosts': []}), \
                    patch.object(release.catalog, 'catalog_additions', return_value=[]), \
                    patch.object(release.git, 'prepare', side_effect=prepare):
                output = Path(directory) / 'release-out'
                result = release.create_plan(NEW, output, baseline_path=Path(directory) / 'baseline.json', baseline_sha='0' * 64,
                                             retire_settings=['CRAWL_REVIEW_MODEL', 'ABCLLM_API_KEY'])
            plan = release.read_private(Path(result['plan']), result['planSha256'])
        retired = ('ABCLLM_API_KEY', 'CRAWL_REVIEW_MODEL')
        self.assertEqual(impact.call_args.args, (snapshot, NEW, retired))
        presence = {short: {'savedEnv': ['ABCLLM_API_KEY'], 'liveSpec': ['ABCLLM_API_KEY']} for short in ('text-mini', 'text-m3')}
        self.assertEqual((plan['retiredSettings'], plan['retiredSettingsFound']), (list(retired), presence))
        self.assertEqual((result['retiredSettings'], result['retiredSettingsFound'], result['selectedApps']),
                         (list(retired), presence, ['text-mini', 'text-m3']))
        self.assertNotIn(SECRET, json.dumps(result)); self.assertNotIn(SECRET, json.dumps(plan['retiredSettingsFound']))
        self.assertEqual((prepared['retired_settings'], prepared['selected']), (retired, ['text-mini', 'text-m3']))
        # The baseline is reproved as it is; retirement only applies to what the run writes.
        self.assertEqual(verified, [([], {})])
        self.assertEqual(plan['observerSourcePreflight']['checkedFiles'], list(release.load(
            'observer_files_for_plan', 'release_observer.py').SOURCE_FILES))
        self.assertNotIn(str(release.ROOT), json.dumps(plan['observerSourcePreflight']))
        self.assertNotIn(SECRET, json.dumps(plan['observerSourcePreflight']))
        self.assertEqual(release.plan_retired_settings(plan), retired)
        for corrupt in ({'retiredSettings': ['CRAWL_REVIEW_MODEL', 'ABCLLM_API_KEY']}, {'retiredSettings': 'ABCLLM_API_KEY'},
                        {'retiredSettings': ['ABCLLM_API_KEY', 'ABCLLM_API_KEY']}, {'retiredSettings': ['RELEASE_TAG']},
                        {'retiredSettings': ['abc']}):
            with self.subTest(plan=corrupt), self.assertRaises(ValueError):
                release.plan_retired_settings({**plan, **corrupt})
        self.assertEqual(release.plan_retired_settings({'schemaVersion': 1}), ())

    def test_run_refuses_a_plan_whose_retired_list_breaks_the_rules_before_credentials_or_the_execution_directory(self):
        for retired in ('ABCLLM_API_KEY', ['RELEASE_TAG'], ['b', 'A'], ['ABCLLM_API_KEY', 'ABCLLM_API_KEY']):
            with self.subTest(retired=retired), tempfile.TemporaryDirectory() as directory, \
                    patch.object(release, 'new_client', side_effect=AssertionError('credential accessed')):
                with self.assertRaises(ValueError):
                    release.run_release({'schemaVersion': 1, 'scope': {'selectedApps': ['web-mini', 'web-m3']}, 'retiredSettings': retired,
                                         'target': {'sha': NEW}, 'toolSources': release.execution_source_hashes()},
                                        Path(directory) / 'execution')
                self.assertFalse((Path(directory) / 'execution').exists())


class ReleaseFlowTests(unittest.TestCase):
    def test_model_owner_replacement_requires_explicit_drain_and_physical_completion(self):
        client = unittest.mock.Mock()
        client.app.return_value = {'appName': 'crawler-service'}
        for observation in ({'replica': False, 'mode': 'open', 'active': 0},
                            {'replica': False, 'mode': 'draining', 'active': 1},
                            {'replica': True, 'mode': 'draining', 'active': 0},
                            {'replica': False, 'mode': 'draining', 'active': False}, {}):
            with self.subTest(observation=observation), patch.object(release.shared, 'ssh_python',
                    return_value=json.dumps(observation)):
                with self.assertRaisesRegex(ValueError, 'explicit_drain_and_zero_active_calls'):
                    release.model_replacement_gate(client, ['text-mini', 'reviewer-m3'])
        client.request.assert_not_called()

    def test_model_replacement_reads_primary_without_changing_capacity(self):
        client = unittest.mock.Mock()
        client.app.return_value = {'appName': 'crawler-service'}
        with patch.object(release.shared, 'ssh_python', return_value=json.dumps(
                {'replica': False, 'mode': 'draining', 'active': 0})) as remote:
            receipt = release.model_replacement_gate(client, ['ai2-consumer-m3', 'text-m3'])
        self.assertEqual(receipt['owners'], ['ai2-consumer-m3', 'text-m3'])
        self.assertEqual(receipt['active'], 0)
        self.assertEqual(remote.call_args.kwargs['input_text'], release.MODEL_REPLACEMENT_SCRIPT)
        client.request.assert_not_called()

    def test_scheduler_monitor_or_noop_does_not_require_model_drain(self):
        client = unittest.mock.Mock()
        with patch.object(release.shared, 'ssh_python', side_effect=AssertionError('unexpected remote read')):
            for selected in ([], ['scheduler-m3', 'monitor-m3', 'connect-agent-m3']):
                self.assertEqual(release.model_replacement_gate(client, selected), {'required': False})

    def test_web_only_updates_two_webs_serially_and_never_monitor(self):
        self.assertEqual(release.execution_steps(['web-mini', 'web-m3']),
                         [('deploy', ('web-mini',)), ('deploy', ('web-m3',)), ('public', ())])

    def test_parent_role_precedes_consumer_and_monitor_is_last(self):
        steps = release.execution_steps(['reviewer-mini', 'reviewer-m3', 'ai2-consumer-m3', 'monitor-m3'])
        self.assertEqual(steps, [('deploy', ('reviewer-mini',)), ('deploy', ('reviewer-m3',)),
                                ('deploy', ('ai2-consumer-m3',)), ('gate', ('reviewer',)),
                                ('deploy', ('monitor-m3',))])

    def test_noop_uses_no_credentials_or_remote_calls(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(release, 'new_client', side_effect=AssertionError('credential accessed')):
            result = release.run_release({'schemaVersion': 1, 'scope': {'selectedApps': []},
                                          'target': {'sha': 'a' * 40}}, Path(directory) / 'execution')
        self.assertEqual(result['status'], 'no-runtime-changes')
        self.assertEqual(result['productionMutations'], 0)

    def test_used_once_marker_blocks_before_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'execution'; destination.mkdir()
            with patch.object(release, 'new_client', side_effect=AssertionError('credential accessed')):
                with self.assertRaisesRegex(ValueError, 'already_attempted'):
                    release.run_release({'schemaVersion': 1, 'scope': {'selectedApps': ['web-mini', 'web-m3']},
                                         'target': {'sha': 'a' * 40}}, destination)

    def test_missing_execution_source_proof_blocks_before_credentials(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(release, 'new_client',
                side_effect=AssertionError('credential accessed')):
            with self.assertRaisesRegex(ValueError, 'execution_sources_changed'):
                release.run_release({'schemaVersion': 1, 'scope': {'selectedApps': ['web-mini', 'web-m3']},
                                     'target': {'sha': 'a' * 40}}, Path(directory) / 'execution')

    def test_changed_execution_source_proof_blocks_before_credentials(self):
        original = {name: 'a' * 64 for name in release.TOOL_FILES}
        changed = {**original, 'deploy_release.py': 'b' * 64}
        with tempfile.TemporaryDirectory() as directory, patch.object(release, 'new_client',
                side_effect=AssertionError('credential accessed')), patch.object(release, 'execution_source_hashes', return_value=changed):
            with self.assertRaisesRegex(ValueError, 'execution_sources_changed'):
                release.run_release({'schemaVersion': 1, 'scope': {'selectedApps': ['web-mini', 'web-m3']},
                                     'target': {'sha': 'a' * 40}, 'toolSources': original}, Path(directory) / 'execution')

    def test_private_plan_requires_exact_digest_and_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'plan.json'
            digest = release.write_private(path, {'schemaVersion': 1})
            self.assertEqual(release.read_private(path, digest), {'schemaVersion': 1})
            with self.assertRaisesRegex(ValueError, 'digest_mismatch'):
                release.read_private(path, '0' * 64)
            path.chmod(0o644)
            with self.assertRaisesRegex(ValueError, 'private_file_required'):
                release.read_private(path, digest)

    def test_generic_batch_collects_started_peers_then_stops(self):
        with tempfile.TemporaryDirectory() as directory:
            finished = []
            def one(short):
                finished.append(short)
                if short == 'reviewer-mini':
                    raise RuntimeError('failure')
                return {'deploymentId': 'new'}
            with self.assertRaisesRegex(RuntimeError, 'batch_failed'):
                release.run_batch(('publisher-mini', 'reviewer-mini'), one, Path(directory))
            self.assertEqual(set(finished), {'publisher-mini', 'reviewer-mini'})
            self.assertTrue((Path(directory) / 'publisher-mini.verified.json').exists())
            self.assertTrue((Path(directory) / 'reviewer-mini.failed.json').exists())

    def test_rollback_image_pin_is_checked_and_receipted_before_service_writes(self):
        image = 'sha256:' + 'a' * 64
        snapshot = {'apps': {'text-mini': {'sourceType': 'github', 'appName': 'nomorevibe-text-mini'}},
                    'baseline': {'text-mini': {'release': 'b' * 40}},
                    'runtime': {'text-mini': {'containers': [{'image': image}]}}}
        with tempfile.TemporaryDirectory() as directory, patch.object(release.shared, 'ssh_python',
                return_value=json.dumps({'image': image, 'retained': True})) as remote:
            release.preserve_git_images(snapshot, ['text-mini'], Path(directory))
            self.assertEqual(remote.call_count, 1)
            self.assertTrue((Path(directory) / 'text-mini.rollback-image.attempted.json').exists())
            self.assertTrue((Path(directory) / 'text-mini.rollback-image.completed.json').exists())
        with tempfile.TemporaryDirectory() as directory, patch.object(release.shared, 'ssh_python',
                return_value=json.dumps({'image': 'sha256:' + 'c' * 64, 'retained': True})):
            with self.assertRaisesRegex(ValueError, 'rollback_image_not_retained'):
                release.preserve_git_images(snapshot, ['text-mini'], Path(directory))
            self.assertFalse((Path(directory) / 'text-mini.rollback-image.completed.json').exists())

    def test_migration_source_proof_ignores_local_git_replacement_refs(self):
        command = subprocess.run
        with tempfile.TemporaryDirectory() as directory:
            def local(*arguments):
                return command(['git', '-C', directory, *arguments], capture_output=True, text=True, check=True).stdout.strip()
            local('init', '-q'); local('config', 'user.name', 'Proof'); local('config', 'user.email', 'proof@example.invalid')
            path = Path(directory) / 'migration.sql'; path.write_bytes(b'ALTER TABLE real;\n')
            local('add', '.'); local('commit', '-qm', 'original'); original = local('rev-parse', 'HEAD')
            original_tree = local('rev-parse', 'HEAD^{tree}')
            path.write_bytes(b'-- replacement hides migration\n')
            local('add', '.'); local('commit', '-qm', 'replacement'); replacement = local('rev-parse', 'HEAD')
            local('replace', original, replacement)
            def in_repo(arguments, **kwargs):
                return command(arguments, cwd=directory, **kwargs)
            with patch.object(release.shared.subprocess, 'run', side_effect=in_repo):
                self.assertEqual(release.shared.git_blob(original, 'migration.sql'), b'ALTER TABLE real;\n')
                self.assertEqual(release.fleet.git_tree(directory, original), original_tree)

if __name__ == '__main__':
    unittest.main()
