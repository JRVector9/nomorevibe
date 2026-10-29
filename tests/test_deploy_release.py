import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/ops/deploy_release.py'
spec = importlib.util.spec_from_file_location('release_under_test', SOURCE)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


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
