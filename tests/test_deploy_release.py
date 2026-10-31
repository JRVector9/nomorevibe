import contextlib
import importlib.util
import io
import json
import os
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
