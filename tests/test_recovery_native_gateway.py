"""Single-unit Linux recovery boundary; no operational mutations."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'scripts/ops/native_recovery_gateway.py'
UNIT = 'nomorevibe-core-consumer@agent-scan.service'


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NativeGatewayTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SOURCE.exists(), 'fixed-unit native recovery gateway must exist')
        self.g = load('native_test', SOURCE)
        shared = load('native_shared_test', ROOT / 'scripts/ops/recovery_gateway.py')
        self.addCleanup(patch.stopall)
        patch.object(self.g, 'load_shared', return_value=shared).start()
        patch.object(self.g, 'trusted_path', side_effect=lambda value, **_: Path(value)).start()  # Fixture user ownership tested separately.
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.directory = Path(self.tmp.name)
        self.unit_file = self.directory / 'nomorevibe-core-consumer@.service'
        self.unit_file.write_text('[Service]\nUser=nomorevibe-core\nRestart=on-failure\nKillMode=mixed\n')
        self.config = {'state': str(self.directory / 'state.json'), 'unitFile': str(self.unit_file),
                       'unitSha256': hashlib.sha256(self.unit_file.read_bytes()).hexdigest(),
                       'controlGroup': '/nomorevibe.slice/nomorevibe-core.slice/' + UNIT,
                       'user': 'nomorevibe-core', 'group': 'nomorevibe-core',
                       'execStart': '/usr/bin/python3 /opt/nomorevibe-core/current/deploy/oracle/launch.py --consumer=agent-scan',
                       'recoverEnabled': True}
        # Actual readonly systemctl show shape; environment is never requested.
        self.properties = {'Id': UNIT, 'Names': UNIT, 'LoadState': 'loaded', 'UnitFileState': 'enabled',
                           'ActiveState': 'failed', 'SubState': 'failed', 'MainPID': '0',
                           'StateChangeTimestampMonotonic': '100000000', 'FragmentPath': str(self.unit_file),
                           'DropInPaths': '', 'NeedDaemonReload': 'no', 'Transient': 'no',
                           'User': 'nomorevibe-core', 'Group': 'nomorevibe-core',
                           'ExecStart': '{ path=/usr/bin/python3 ; argv[]=' + self.config['execStart'] +
                                        ' ; ignore_errors=no ; start_time=[Sun 2026-10-25 01:00:00 UTC] ; stop_time=[Sun 2026-10-25 01:00:01 UTC] ; pid=123 ; code=exited ; status=1 }',
                           'ControlGroup': self.config['controlGroup'], 'KillMode': 'mixed',
                           'Restart': 'on-failure', 'Result': 'exit-code', 'Slice': 'nomorevibe-core.slice'}
        self.calls = []

    def run_command(self, argv):
        self.calls.append(argv)
        self.assertEqual(argv[0], '/usr/bin/systemctl')
        self.assertEqual(argv[-1], UNIT)
        if argv[1] == 'show':
            return '\n'.join(key + '=' + value for key, value in self.properties.items()) + '\n'
        self.assertIn(argv[1], ('reset-failed', 'start'))
        if argv[1] == 'reset-failed':
            self.properties.update(ActiveState='inactive', SubState='dead', MainPID='0', ControlGroup='',
                                   StateChangeTimestampMonotonic='400000001')
        return ''

    def observe(self):
        return self.g.observe(self.config, run=self.run_command, uptime=400, empty_fn=lambda _: True)

    def recover(self):
        return self.g.recover(self.config, 'agent-scan', 100000000, now=1000,
                              probe_fn=lambda _: {'services': [self.observe()]},
                              start_fn=lambda cfg, version: self.calls.append(['start-fixture', version]) or {'result': 'requested'})

    def test_failed_empty_unit_has_exact_seven_field_report(self):
        self.assertEqual(self.observe(), {'key': 'agent-scan', 'version': 100000000, 'replicas': 1,
                                         'settled': True, 'ok': False, 'recoverable': True,
                                         'reason': 'native_unit_failed'})
        self.assertTrue(all('Environment' not in value for value in self.calls[0]))

    def test_active_inactive_and_warming_states_are_never_recoverable(self):
        for active, sub, pid, reason, ok in [('active', 'running', '123', 'ok', True),
                                           ('inactive', 'dead', '0', 'native_unit_inactive', False),
                                           ('activating', 'start', '123', 'native_unit_unknown', False)]:
            with self.subTest(active=active):
                self.properties.update(ActiveState=active, SubState=sub, MainPID=pid)
                row = self.observe()
                self.assertEqual((row['reason'], row['ok'], row['recoverable']), (reason, ok, False))

    def test_remaining_process_short_age_and_uncertain_cgroup_are_not_recoverable(self):
        self.properties['MainPID'] = '123'
        self.assertFalse(self.observe()['recoverable'])
        self.properties['MainPID'] = '0'
        for stamp in ['399000000', '500000000', '-1', 'NaN', '0']:
            self.properties['StateChangeTimestampMonotonic'] = stamp
            self.assertFalse(self.observe()['recoverable'])
        self.properties['StateChangeTimestampMonotonic'] = '100000000'
        self.assertFalse(self.g.observe(self.config, run=self.run_command, uptime=400, empty_fn=lambda _: False)['recoverable'])

    def test_identity_drift_reload_and_dropin_fail_closed(self):
        for key, value in [('Id', 'other.service'), ('Names', UNIT + ' alias.service'),
                           ('LoadState', 'not-found'), ('FragmentPath', '/tmp/other.service'),
                           ('DropInPaths', '/etc/systemd/system/override.conf'), ('NeedDaemonReload', 'yes'),
                           ('Transient', 'yes'), ('User', 'root'), ('Group', 'root'),
                           ('ExecStart', '{ path=/bin/sh ; argv[]=/bin/sh ; ignore_errors=no ; }'),
                           ('ControlGroup', '/other.slice'), ('Slice', 'other.slice'),
                           ('KillMode', 'process'), ('Restart', 'always')]:
            with self.subTest(key=key):
                old = self.properties[key]
                self.properties[key] = value
                self.assertEqual(self.observe()['reason'], 'native_unit_unknown')
                self.properties[key] = old
        self.unit_file.write_text('changed release or policy')
        self.assertEqual(self.observe()['reason'], 'native_unit_unknown')

    def test_systemd_empty_controlgroup_after_exit_uses_exact_configured_group(self):
        self.properties['ControlGroup'] = ''
        self.assertTrue(self.observe()['recoverable'])
        self.properties.update(ActiveState='inactive', SubState='dead')
        self.assertEqual(self.observe()['reason'], 'native_unit_inactive')
        self.properties.update(ActiveState='active', SubState='running', MainPID='123')
        self.assertEqual(self.observe()['reason'], 'native_unit_unknown')

    def test_private_probe_errors_are_muted(self):
        def fail(_):
            raise ValueError('private-password-and-model-token')
        for kwargs in [{'run': fail, 'empty_fn': lambda _: True}, {'run': self.run_command, 'empty_fn': fail}]:
            row = self.g.observe(self.config, uptime=400, **kwargs)
            self.assertEqual(row['reason'], 'native_unit_unknown')
            self.assertFalse(row['recoverable'])
            self.assertNotIn('private', json.dumps(row))

    def test_reservation_and_cooldown_survive_restart(self):
        self.assertEqual(self.recover(), {'result': 'requested'})
        self.assertEqual(json.loads(Path(self.config['state']).read_text()), {'attempts': {'agent-scan': [1000]}})
        self.assertEqual(Path(self.config['state']).stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.recover(), {'result': 'limited'})
        self.assertEqual(sum(call[0] == 'start-fixture' for call in self.calls), 1)

    def test_corrupt_budget_clock_rollback_and_daily_limit_fail_closed(self):
        for attempts in [[1, 2], [2000], [float('nan')], [True], 'private', None]:
            with self.subTest(attempts=attempts):
                Path(self.config['state']).write_text(json.dumps({'attempts': {'agent-scan': attempts}}))
                self.assertEqual(self.recover(), {'result': 'limited'})
        self.assertFalse(any(call[0] == 'start-fixture' for call in self.calls))

    def test_maintenance_gate_and_changed_generation_refuse_without_reservation(self):
        self.config['recoverEnabled'] = False
        self.assertEqual(self.recover(), {'result': 'refused'})
        self.config['recoverEnabled'] = True
        self.properties['StateChangeTimestampMonotonic'] = '110000000'
        self.assertEqual(self.recover(), {'result': 'refused'})
        self.assertFalse(Path(self.config['state']).exists())

    def test_unknown_mutation_outcome_consumes_budget(self):
        def timeout(*_):
            raise TimeoutError('private-token')
        result = self.g.recover(self.config, 'agent-scan', 100000000, now=1000,
                                probe_fn=lambda _: {'services': [self.observe()]}, start_fn=timeout)
        self.assertEqual(result, {'result': 'unknown'})
        self.assertEqual(self.recover(), {'result': 'limited'})

    def test_two_per_rolling_day_and_fifteen_minute_budget(self):
        results = []
        for now in [1000, 1899, 1900, 2800, 87400]:
            results.append(self.g.recover(self.config, 'agent-scan', 100000000, now=now,
                                          probe_fn=lambda _: {'services': [self.observe()]},
                                          start_fn=lambda *_: {'result': 'requested'})['result'])
        self.assertEqual(results, ['requested', 'limited', 'requested', 'limited', 'requested'])

    def test_private_config_schema_and_maintenance_reload(self):
        path = self.directory / 'config.json'
        path.write_text(json.dumps(self.config))
        loaded = self.g.read_config(path)
        self.assertEqual(loaded, {**self.config, '_configPath': str(path)})
        changed = {**self.config, 'recoverEnabled': False}
        path.write_text(json.dumps(changed))
        self.assertEqual(self.g.start_unit(loaded, 100000000, run=self.run_command,
                                         observe_fn=lambda _: self.observe()), {'result': 'refused'})
        self.assertFalse(self.calls)
        for key, value in [('unitSha256', 'private-token'), ('user', 'root'), ('group', 'root'),
                           ('execStart', '/bin/sh -c private-token'), ('recoverEnabled', 'true'),
                           ('controlGroup', '/nomorevibe.slice/../' + UNIT), ('state', 'relative.json')]:
            with self.subTest(key=key):
                path.write_text(json.dumps({**self.config, key: value}))
                with self.assertRaises(ValueError):
                    self.g.read_config(path)

    def test_start_rechecks_then_only_resets_and_starts_fixed_unit(self):
        self.assertEqual(self.g.start_unit(self.config, 100000000, run=self.run_command,
                                         observe_fn=lambda _: self.observe(), empty_fn=lambda _: True), {'result': 'requested'})
        self.assertEqual([call for call in self.calls if call[1] != 'show'],
                         [['/usr/bin/systemctl', 'reset-failed', UNIT], ['/usr/bin/systemctl', 'start', '--job-mode=fail', UNIT]])
        self.calls.clear()
        self.properties['ActiveState'] = 'inactive'
        self.assertEqual(self.g.start_unit(self.config, 100000000, run=self.run_command,
                                         observe_fn=lambda _: self.observe()), {'result': 'refused'})
        self.assertFalse(any(call[1] in ('reset-failed', 'start') for call in self.calls))

    def test_post_reset_new_process_or_nonempty_cgroup_refuses_start(self):
        for new_process in [True, False]:
            with self.subTest(new_process=new_process):
                self.properties.update(ActiveState='failed', SubState='failed', MainPID='0',
                                       ControlGroup=self.config['controlGroup'], StateChangeTimestampMonotonic='100000000')
                self.calls.clear()
                def run(argv):
                    result = self.run_command(argv)
                    if argv[1] == 'reset-failed' and new_process:
                        self.properties.update(ActiveState='active', SubState='running', MainPID='123',
                                               ControlGroup=self.config['controlGroup'])
                    return result
                result = self.g.start_unit(self.config, 100000000, run=run,
                                           observe_fn=lambda _: self.observe(), empty_fn=lambda _: False)
                self.assertEqual(result, {'result': 'refused'})
                self.assertFalse(any(call[1] == 'start' for call in self.calls))

    def test_fixed_command_parser(self):
        self.assertEqual(self.g.parse_command('probe'), ('probe',))
        self.assertEqual(self.g.parse_command('recover agent-scan 100000000'), ('recover', 'agent-scan', 100000000))
        for value in ['recover text 10', 'recover agent-scan 0', 'recover agent-scan -1', 'recover agent-scan 10;id',
                      'probe extra', 'systemctl restart ' + UNIT, 'recover agent-scan 99999999999999999']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                self.g.parse_command(value)


class NativeCgroupTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SOURCE.exists(), 'fixed-unit native recovery gateway must exist')
        self.g = load('native_cgroup_test', SOURCE)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'cgroup.controllers').write_text('cpu memory pids\n')
        self.group = '/nomorevibe.slice/' + UNIT
        (self.root / 'nomorevibe.slice').mkdir()
        patcher = patch.object(self.g, 'trusted_path', side_effect=lambda value, **_: Path(value))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_recursive_populated_zero_or_exact_group_absence_only(self):
        self.assertTrue(self.g.cgroup_empty(self.group, root=self.root))
        target = self.root / self.group.lstrip('/')
        target.mkdir()
        for content, expected in [('populated 0\nfrozen 0\n', True), ('populated 1\nfrozen 0\n', False)]:
            (target / 'cgroup.events').write_text(content)
            self.assertEqual(self.g.cgroup_empty(self.group, root=self.root), expected)
        for content in ['frozen 0\n', 'populated 0\npopulated 1\n', 'populated NaN\n']:
            (target / 'cgroup.events').write_text(content)
            with self.assertRaises(ValueError):
                self.g.cgroup_empty(self.group, root=self.root)

    def test_empty_cgroup_procs_is_not_recursive_evidence(self):
        target = self.root / self.group.lstrip('/')
        target.mkdir()
        (target / 'cgroup.procs').write_text('')
        child = target / 'delegated-child'
        child.mkdir()
        (child / 'cgroup.procs').write_text('321\n')
        with self.assertRaises(OSError):
            self.g.cgroup_empty(self.group, root=self.root)

    def test_missing_controller_or_parent_never_proves_absence(self):
        # Simulate real trusted_path missing-path behavior while skipping uid only.
        with patch.object(self.g, 'trusted_path', side_effect=lambda value, **_: Path(value).stat() and Path(value)):
            (self.root / 'cgroup.controllers').unlink()
            with self.assertRaises(OSError):
                self.g.cgroup_empty(self.group, root=self.root)


class NativeTrustTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(SOURCE.exists(), 'fixed-unit native recovery gateway must exist')
        self.g = load('native_trust_test', SOURCE)

    def test_user_owned_source_config_and_symlink_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'config.json'
            source.write_text('{}')
            with self.assertRaises(ValueError):
                self.g.read_config(source)
            link = Path(directory) / 'config'
            link.symlink_to('/etc/passwd')
            with self.assertRaises(ValueError):
                self.g.trusted_path(link)

    def test_root_owned_file_with_writable_parent_is_rejected(self):
        from types import SimpleNamespace
        import stat
        good = SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
        leaf = SimpleNamespace(st_uid=0, st_mode=stat.S_IFREG | 0o600)
        for bad in [SimpleNamespace(st_uid=501, st_mode=stat.S_IFDIR | 0o755),
                    SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o775),
                    SimpleNamespace(st_uid=0, st_mode=stat.S_IFLNK | 0o755)]:
            with self.subTest(mode=bad.st_mode), patch.object(Path, 'lstat',
                    autospec=True, side_effect=lambda path: bad if str(path) == '/secure' else leaf if str(path).endswith('.json') else good):
                with self.assertRaises(ValueError):
                    self.g.trusted_path('/secure/config.json', private=True)

    def test_root_owned_private_leaf_and_all_parents_are_checked(self):
        from types import SimpleNamespace
        import stat
        parent = SimpleNamespace(st_uid=0, st_mode=stat.S_IFDIR | 0o755)
        for uid, mode, allowed in [(0, 0o600, True), (0, 0o644, False), (0, 0o620, False), (501, 0o600, False)]:
            leaf = SimpleNamespace(st_uid=uid, st_mode=stat.S_IFREG | mode)
            with self.subTest(uid=uid, mode=mode), patch.object(Path, 'lstat', autospec=True,
                    side_effect=lambda path: leaf if str(path).endswith('.json') else parent):
                if allowed:
                    self.assertEqual(self.g.trusted_path('/secure/config.json', private=True), Path('/secure/config.json'))
                else:
                    with self.assertRaises(ValueError):
                        self.g.trusted_path('/secure/config.json', private=True)

    def test_isolated_python_loads_exact_shared_file_without_sys_path_dependency(self):
        script = """import importlib.util, pathlib, sys
p=pathlib.Path(sys.argv[1]);s=importlib.util.spec_from_file_location('native',p)
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.trusted_path=lambda value,**k:pathlib.Path(value)
shared=m.load_shared()
assert callable(shared.bounded_output) and callable(shared.save)
assert pathlib.Path(shared.__file__)==p.with_name('recovery_gateway.py')
print('isolated-import-ok')
"""
        result = subprocess.run([sys.executable, '-I', '-c', script, str(SOURCE)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr.decode())
        self.assertEqual(result.stdout, b'isolated-import-ok\n')

    def test_isolated_cli_denies_untrusted_install_without_secrets_or_traceback(self):
        result = subprocess.run([sys.executable, '-I', str(SOURCE), '--config', '/tmp/private-token'],
                                capture_output=True, timeout=10, env={**os.environ, 'SSH_ORIGINAL_COMMAND': 'probe'})
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {'error': 'gateway_denied'})
        self.assertEqual(result.stderr, b'')


if __name__ == '__main__':
    unittest.main()
