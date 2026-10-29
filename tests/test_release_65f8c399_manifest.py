"""Synthetic manifest builder tests. No SSH, DB, systemd or device access."""
import ast
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import unittest

ADAPTER = Path('scripts/ops/admin-models-boundary-adapter.py')


def load():
    spec = importlib.util.spec_from_file_location('build_manifest', Path('scripts/ops/release-65f8c399/build-manifest.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def nested(tree, name):
    return next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == name)


def container(service, index):
    return {'serviceId': 's%d' % index, 'serviceName': service, 'serviceVersion': 7 + index, 'replicas': 1, 'hostBootId': 'boot-%d' % index,
            'tasks': [{'ID': 't%d' % index, 'DesiredState': 'Running', 'CurrentState': 'Running'}],
            'containers': [{'id': 'c' * 63 + str(index), 'startedAt': '2026-10-29T06:40:00.123456789Z' if index else '2026-10-29T06:40:00.5Z', 'hostPid': 400 + index,
                            'privileged': False, 'pidMode': '', 'taskId': 't%d' % index,
                            'inside': {'pid1': {'pid': 1, 'ppid': 0, 'startTicks': 999, 'pidNamespace': 'pid:[402653%d]' % index},
                                       'cgroupNamespace': 'cgroup:[4]', 'cgroupRelativePath': '0::/', 'processes': [
                                           {'pid': 7, 'owner': {'instanceId': 'm3-reviewer', 'bootId': 'b'}}]}}]}


SUPA = {'operatorUid': 1000, 'unit': 'vllm.service', 'unitConfigurationSha256': 'a' * 64, 'hostBootId': 'supa-boot',
        'unitProperties': {'ControlGroup': '/system.slice/vllm.service', 'MainPID': '3093912', 'InvocationID': 'edda7c6159bb4c1c97926d575b3c3961',
                           'ExecMainStartTimestamp': 'Wed 2026-10-29 06:00:01 UTC'},
        'processes': [{'pid': 3093912, 'startTicks': 123, 'pidNamespace': 'pid:[4026531836]'}]}
JOB = '2c7f0a8e-5b1d-4f3a-9c2e-7d6b5a4c3b21'


class BuildManifestTests(unittest.TestCase):
    def setUp(self):
        self.m = load()
        self.inputs = {'owner': ('jr@m3Ultra', container('app-copy-primary-hard-drive-b5fhzd', 0)),
                       'gateway-m3': ('jr@m3Ultra', container('app-reboot-optical-matrix-3bl2a4', 1)),
                       'gateway-mini': ('jr@9mini', container('app-hack-optical-monitor-v1ioak', 2)), 'provider': ('jr@supa', SUPA)}

    def test_identity_function_is_the_adapter_function(self):
        adapter = nested(ast.parse(ADAPTER.read_text()), 'linux_identity')
        ours = nested(ast.parse(Path('scripts/ops/release-65f8c399/build-manifest.py').read_text()), 'linux_identity')
        self.assertEqual([ast.dump(node) for node in adapter.body], [ast.dump(node) for node in ours.body])
        namespace = {'datetime': datetime, 're': re}
        exec(compile(ast.Module(body=[adapter], type_ignores=[]), 'adapter', 'exec'), namespace)
        for key, (host, expected) in self.inputs.items():
            kind = 'systemd' if key == 'provider' else 'container'
            target = {'kind': kind, 'expected': expected, 'identity': {'host': 'supa' if kind == 'systemd' else host.split('@')[1]}}
            self.assertEqual(namespace['linux_identity'](target), self.m.linux_identity(target))

    def test_manifest_and_profile_bind_each_other_and_the_reviewed_sources(self):
        with tempfile.TemporaryDirectory() as parent:
            out = str(Path(parent) / JOB)
            raw, profile, warnings = self.m.build(JOB, out, str(ADAPTER.resolve()), 'supa', '/Users/jr/.nmv-admin-models-progress', self.inputs)
        manifest, profile = json.loads(raw), json.loads(profile)
        self.assertEqual([t['role'] for t in manifest['targets']], ['owner', 'gateway', 'gateway', 'provider'])
        provider = manifest['targets'][3]
        self.assertTrue(provider['rootHandoff'])
        self.assertEqual((provider['identity']['host'], provider['progressRoot']), ('supa', '/var/lib/nmv-admin-models-root/progress'))
        self.assertEqual(provider['identity']['startedAt'], '2026-10-29T06:00:01.000Z')
        self.assertEqual(manifest['targets'][1]['identity']['startedAt'], '2026-10-29T06:40:00.123Z')
        helpers = ADAPTER.resolve().parent / 'admin_models_helpers'
        self.assertEqual(manifest['sourceHashes']['systemd_handoff.py'], hashlib.sha256((helpers / 'systemd_handoff.py').read_bytes()).hexdigest())
        self.assertEqual(len(manifest['sourceHashes']), 8)
        self.assertEqual(profile['material']['sha256'], hashlib.sha256(raw).hexdigest())
        self.assertEqual((profile['artifactDirectory'], manifest['stateDirectory']), (out, out))
        self.assertEqual(profile['affectedGroups'], ['supa'])
        self.assertEqual(profile['adapter']['sha256'], hashlib.sha256(ADAPTER.read_bytes()).hexdigest())
        self.assertNotIn('finalAdmission', profile)
        self.assertEqual(warnings, [])

    def test_final_admission_handoff_is_explicit_and_draining_only(self):
        out = '/private/' + JOB
        _, profile, _ = self.m.build(JOB, out, str(ADAPTER.resolve()), 'supa', '/p', self.inputs, 'draining')
        self.assertEqual(json.loads(profile)['finalAdmission'], 'draining')
        with self.assertRaises(SystemExit):
            self.m.build(JOB, out, str(ADAPTER.resolve()), 'supa', '/p', self.inputs, 'open')

    def test_refuses_unnamed_directory_and_multiple_containers(self):
        with self.assertRaises(SystemExit):
            self.m.build(JOB, '/private/other', str(ADAPTER.resolve()), 'supa', '/p', self.inputs)
        two = dict(self.inputs)
        doubled = container('app-reboot-optical-matrix-3bl2a4', 1)
        doubled['containers'].append(doubled['containers'][0])
        two['gateway-m3'] = ('jr@m3Ultra', doubled)
        with self.assertRaises(SystemExit):
            self.m.build(JOB, '/private/' + JOB, str(ADAPTER.resolve()), 'supa', '/p', two)


if __name__ == '__main__':
    unittest.main()
