"""Synthetic root handoff tests. No SSH, DB, systemd, privileges or device changes."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path('scripts/ops/admin_models_helpers') / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RootHandoffTests(unittest.TestCase):
    def setUp(self):
        self.h = load('systemd_handoff')
        self.action = load('systemd_action')
        self.temp = tempfile.TemporaryDirectory(prefix='.supa-root-test-', dir=Path.cwd())
        self.addCleanup(self.temp.cleanup)
        self.h.RESULTS = Path(self.temp.name)
        self.expected = {'hostBootId': 'boot', 'unit': 'vllm.service', 'unitFileSha256': 'b' * 64,
                         'unitConfigurationSha256': 'a' * 64,
                         'unitProperties': {'MainPID': '100', 'InvocationID': 'old', 'KillMode': 'control-group',
                                            'Restart': 'on-failure', 'ControlGroup': '/system.slice/vllm.service'},
                         'processes': [{'pid': 100, 'startTicks': 123, 'pidNamespace': 'pid:[42]'}]}
        self.task = {'version': 1, 'nonce': 'f' * 32, 'targetKey': 'provider',
                     'sourceHashes': {name: 'd' * 64 for name in ('systemd_action.py', 'systemd_reader.py', 'systemd_handoff.py')},
                     'payload': {'requestId': 'ad2b84de-4ddf-4b2e-9dbd-605c64f7d728', 'operationHash': 'c' * 64,
                                 'mode': 'stop', 'service': 'vllm.service', 'progressRoot': self.h.PROGRESS, 'expected': self.expected}}
        self.live = {'activeState': 'inactive', 'mainPid': 0, 'populated': False, 'pids': [],
                     'oldIdentitiesAbsent': True, 'unitUnchanged': True, 'hostBootId': 'boot'}
        self.saved = copy.deepcopy(self.live)
        self.modes = []
        owner = self

        class FakeBackend:
            def __init__(self, value):
                pass

            def stopped(self):
                return copy.deepcopy(owner.live)

            def wait_ready(self):
                return copy.deepcopy(owner.live)

        self.action.NativeBackend = FakeBackend

        def operate(value, backend, root):
            self.modes.append(value['mode'])
            return dict(self.saved, verified=True)

        self.action.operate = operate
        self.h.modules = lambda task: (self.action, '# pinned fixture reader')
        # Real ownership is tested independently below; fixtures need no root installation.
        self.h.trusted_root = lambda path, directory=False: Path(path)

    def record(self, task=None):
        task = task or self.task
        sha = self.h.validate_task(task)
        file = self.h.RESULTS / (sha + '.json')
        file.write_bytes(self.h.canonical({'version': 1, 'taskHash': sha, 'result': dict(self.saved, verified=True)}))
        return file

    def request(self):
        file = self.h.RESULTS / 'input.json'
        file.write_bytes(self.h.canonical(self.task))
        return file, self.h.validate_task(self.task)

    def test_missing_result_is_manual_without_action(self):
        self.assertEqual(self.h.collect(self.task), {'state': 'root_result_missing'})
        self.assertEqual(self.modes, [])

    def test_root_receipt_and_fresh_exit_are_both_required(self):
        self.record()
        self.assertTrue(self.h.collect(self.task)['verified'])
        for key, value in [('mainPid', 101), ('populated', True), ('pids', [111]), ('oldIdentitiesAbsent', False),
                           ('unitUnchanged', False), ('hostBootId', 'reboot'), ('activeState', 'active')]:
            with self.subTest(key=key):
                original = self.live[key]
                self.live[key] = value
                with self.assertRaises(ValueError):
                    self.h.collect(self.task)
                self.live[key] = original
        self.assertEqual(self.modes, [])

    def test_wrong_task_binding_rejects_receipt(self):
        file = self.record()
        value = json.loads(file.read_bytes())
        value['taskHash'] = 'e' * 64
        file.write_bytes(self.h.canonical(value))
        with self.assertRaisesRegex(ValueError, 'binding_invalid'):
            self.h.collect(self.task)

    def test_other_operation_nonce_identity_and_phase_never_reuse_result(self):
        self.record()
        for area, key, value in [(None, 'nonce', 'e' * 32), ('payload', 'requestId', 'bd2b84de-4ddf-4b2e-9dbd-605c64f7d728'),
                                  ('payload', 'mode', 'restore'), ('payload', 'operationHash', 'e' * 64),
                                  ('expected', 'hostBootId', 'another-boot')]:
            task = copy.deepcopy(self.task)
            target = task if area is None else task['payload']['expected'] if area == 'expected' else task[area]
            target[key] = value
            self.assertEqual(self.h.collect(task), {'state': 'root_result_missing'})

    def test_insufficient_root_exit_record_cannot_be_blessed_by_live_exit(self):
        self.saved['oldIdentitiesAbsent'] = False
        self.record()
        with self.assertRaises(ValueError):
            self.h.collect(self.task)

    def test_permission_error_does_not_become_exit(self):
        self.record()
        self.action.NativeBackend.stopped = lambda self: (_ for _ in ()).throw(PermissionError('synthetic'))
        with self.assertRaises(PermissionError):
            self.h.collect(self.task)

    def test_nonroot_execute_is_denied(self):
        file, sha = self.request()
        with patch.object(self.h.os, 'geteuid', return_value=1000):
            with self.assertRaisesRegex(ValueError, 'administrator_root'):
                self.h.execute(file, sha)
        self.assertEqual(self.modes, [])

    def test_task_hash_change_is_denied_before_mutation(self):
        file, sha = self.request()
        with patch.object(self.h.os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(ValueError, 'reviewed_task_changed'):
                self.h.execute(file, 'e' * 64)
        self.assertEqual(self.modes, [])

    def test_success_never_sends_second_mutation(self):
        file, sha = self.request()
        with patch.object(self.h.os, 'geteuid', return_value=0):
            self.assertTrue(self.h.execute(file, sha)['ok'])
            with self.assertRaisesRegex(ValueError, 'result_exists_collect'):
                self.h.execute(file, sha)
        self.assertEqual(self.modes, ['stop'])
        self.assertEqual((self.h.RESULTS / (sha + '.json')).stat().st_mode & 0o777, 0o644)

    def test_lost_stop_and_restore_responses_only_read_durable_progress(self):
        for mode, recovery in [('stop', 'read-stop-progress'), ('restore', 'read-restore-progress')]:
            self.task['payload']['mode'] = mode
            file, sha = self.request()
            (self.h.RESULTS / (sha + '.attempt.json')).write_bytes(self.h.canonical({'taskHash': sha}))
            with patch.object(self.h.os, 'geteuid', return_value=0):
                self.h.execute(file, sha)
            self.assertEqual(self.modes[-1], recovery)
        self.assertEqual(self.modes, ['read-stop-progress', 'read-restore-progress'])

    def test_root_and_current_restored_incarnations_must_match(self):
        self.task['payload']['mode'] = 'restore'
        fresh = copy.deepcopy(self.expected)
        fresh['unitProperties'].update(MainPID='101', InvocationID='new', ActiveState='active')
        self.saved = {'healthStatus': 200, 'restoredIdentity': fresh}
        self.live = copy.deepcopy(self.saved)
        self.record()
        self.assertTrue(self.h.collect(self.task)['verified'])
        self.live['restoredIdentity']['unitProperties']['InvocationID'] = 'another-new'
        with self.assertRaisesRegex(ValueError, 'incarnation_changed'):
            self.h.collect(self.task)

    def test_symlinks_wrong_owner_and_writable_ancestors_are_rejected(self):
        h = load('systemd_handoff')
        file = self.h.RESULTS / 'owned.json'
        file.write_text('{}')
        real_lstat = Path.lstat
        for bad in ['owner', 'write', 'symlink']:
            def fake_lstat(path):
                info = real_lstat(path)
                mode = info.st_mode & ~0o022
                uid = 0
                if path == file.parent:
                    uid = 1000 if bad == 'owner' else 0
                    mode |= 0o020 if bad == 'write' else 0
                    mode = 0o120777 if bad == 'symlink' else mode
                return types.SimpleNamespace(st_uid=uid, st_mode=mode)
            with self.subTest(bad=bad), patch.object(Path, 'lstat', fake_lstat):
                with self.assertRaisesRegex(ValueError, 'root_owned_path_required'):
                    h.trusted_root(file)

    def test_installed_helper_hash_change_is_denied(self):
        h = load('systemd_handoff')
        h.INSTALL = self.h.RESULTS
        h.trusted_root = lambda path, directory=False: Path(path)
        (h.INSTALL / 'systemd_action.py').write_text('# changed')
        with self.assertRaisesRegex(ValueError, 'root_helper_source_changed'):
            h.modules(self.task)

    def test_root_scope_cannot_name_other_service_or_progress_location(self):
        for key, value in [('service', 'other.service'), ('progressRoot', '/tmp/progress'), ('mode', 'shell')]:
            task = copy.deepcopy(self.task)
            task['payload'][key] = value
            with self.assertRaisesRegex(ValueError, 'supa_root_scope_required'):
                self.h.validate_task(task)

    def durable_backend(self, lose_ack=False):
        owner = self

        class Backend:
            changes = []
            first = True

            def read(self):
                return owner.expected

            def activity(self):
                return {'bootId': 'boot', 'invocationId': 'old', 'mainPid': 100,
                        'metrics': 'vllm:num_requests_running{model_name="local-llm",engine="0"} 0\n'
                                   'vllm:num_requests_waiting{model_name="local-llm",engine="0"} 0'}

            def stop(self):
                self.changes.append('stop')
                if lose_ack:
                    raise TimeoutError('synthetic unknown systemctl outcome')

            def wait_stopped(self):
                if self.first:
                    self.first = False
                    raise TimeoutError('synthetic lost post-ACK observation')
                return copy.deepcopy(owner.live)

        return Backend()

    def test_real_durable_helper_recovers_stop_ack_without_second_stop(self):
        module = load('systemd_action')
        backend = self.durable_backend()
        value = self.h.payload(self.task, '# pinned fixture reader')
        root = self.h.RESULTS / 'progress'
        with self.assertRaises(TimeoutError):
            module.operate(value, backend, root, sleep=lambda seconds: None)
        value['mode'] = 'read-stop-progress'
        self.assertTrue(module.operate(value, backend, root)['verified'])
        self.assertEqual(backend.changes, ['stop'])

    def test_real_durable_helper_missing_ack_blocks_without_second_stop(self):
        module = load('systemd_action')
        backend = self.durable_backend(lose_ack=True)
        value = self.h.payload(self.task, '# pinned fixture reader')
        root = self.h.RESULTS / 'progress'
        with self.assertRaises(TimeoutError):
            module.operate(value, backend, root, sleep=lambda seconds: None)
        value['mode'] = 'read-stop-progress'
        with self.assertRaises(FileNotFoundError):
            module.operate(value, backend, root)
        self.assertEqual(backend.changes, ['stop'])


if __name__ == '__main__':
    unittest.main()
