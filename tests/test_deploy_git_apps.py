"""Offline safety checks for the bounded Git-build rollout executor."""

import copy
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import tarfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch


SOURCE = Path(__file__).resolve().parents[1] / 'scripts/ops/deploy_git_apps.py'
if SOURCE.exists():
    SPEC = importlib.util.spec_from_file_location('deploy_git_apps', SOURCE)
    release = importlib.util.module_from_spec(SPEC)
    SPEC.loader.exec_module(release)
else:
    release = None


class GitRolloutTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(release, 'Git rollout executor has not been implemented')
        self.old = 'a' * 40
        self.new = 'b' * 40
        self.target = {'sha': self.new,
                       'worker': release.shared.IMAGE_PREFIX['worker'] + 'sha256:' + 'c' * 64,
                       'web': release.shared.IMAGE_PREFIX['web'] + 'sha256:' + 'd' * 64}
        self.apps = {}
        for short, (app_id, name, (server_id, _), kind) in release.shared.GIT_BUILD_APPS.items():
            role = short.rpartition('-')[0]
            self.apps[short] = {
                'applicationId': app_id, 'name': name, 'serverId': server_id,
                'appName': 'service-' + short, 'sourceType': 'github',
                'owner': 'JRVector9', 'repository': 'nomorevibe', 'branch': 'main',
                'buildPath': '/', 'dockerfile': 'Dockerfile', 'buildType': 'dockerfile',
                'dockerBuildStage': 'connect-agent' if kind == 'connect-agent' else 'worker',
                'env': 'RELEASE_TAG=' + self.old + '\nWORKER_ROLE=' + role + '\nSECRET_TOKEN=private\n',
                'buildArgs': 'UNCHANGED=1\n', 'buildSecrets': 'SECRET=private\n',
                'createEnvFile': False, 'applicationStatus': 'done', 'autoDeploy': False,
                'replicas': 2 if kind == 'scheduler' else 1,
                'command': 'node --import tsx scripts/' + (
                           'connect-agent.ts' if kind == 'connect-agent' else 'worker-supervisor.ts --role=' + role),
            }
        self.client = FakeClient(self.apps)
        self.readiness = {'schemaVersion': 1, 'target': self.target, 'checkPassed': True, 'imagesReady': True,
                          'runId': 123, 'verifiedAt': datetime.now(timezone.utc).isoformat(), 'profile': 'full',
                          'rulesVersion': 'v2'}
        runtime = {short: {'serviceSpec': {'Name': app['appName'], 'TaskTemplate': {'ContainerSpec': {
            'Image': 'sha256:' + 'e' * 64, 'Env': app['env'].splitlines()}},
            'Mode': {'Replicated': {'Replicas': app['replicas']}}}, 'containers': [{'config': {
            'Cmd': app['command'].split(), 'Entrypoint': ['/sbin/tini', '--'], 'Healthcheck': {'Test': ['CMD', 'health']}}}]}
            for short, app in self.apps.items()}
        self.snapshot = {'schemaVersion': 1, 'target': self.target, 'apps': copy.deepcopy(self.apps),
                         'baseline': {short: {'release': self.old, 'image': 'sha256:' + 'e' * 64,
                                              'specHash': hashlib.sha256(json.dumps(runtime[short]['serviceSpec'], ensure_ascii=False,
                                                  sort_keys=True, separators=(',', ':')).encode()).hexdigest()} for short in self.apps},
                         'runtime': runtime,
                         'readiness': copy.deepcopy(self.readiness)}
        self.runtime = patch.object(release, 'probe', side_effect=lambda short, *args, **kwargs: {
            'ready': True, 'updateState': 'completed', 'image': self.snapshot['baseline'][short]['image'],
            'specHash': self.snapshot['baseline'][short]['specHash']})
        self.runtime.start()
        self.addCleanup(self.runtime.stop)
        self.main = patch.object(release, 'verify_main', return_value=None)
        self.main.start()
        self.addCleanup(self.main.stop)
        self.manifest = patch.object(release, 'source_manifest', return_value={'scripts/scheduler.ts': 'e' * 64})
        self.manifest.start()
        self.addCleanup(self.manifest.stop)
        self.gate = patch.object(release.shared, 'monitor_gate', return_value={'readiness': 'ready', 'progress': 'ok'})
        self.gate.start()
        self.addCleanup(self.gate.stop)
        self.provenance = patch.object(release, 'validate_git_source_build', return_value=None)
        self.provenance.start()
        self.addCleanup(self.provenance.stop)

    def prepare(self, selected=None, mode='git-build'):
        return release.prepare(self.client, self.target, tuple(self.apps) if selected is None else selected,
                               self.snapshot, self.readiness, mode=mode)

    def test_wave_plan_preserves_standby_before_primary_and_caps_at_two(self):
        self.assertEqual(release.waves(tuple(self.apps)), (
            ('text-mini', 'maintenance-mini'), ('text-m3', 'maintenance-m3'),
            ('scheduler-m3', 'connect-agent-m3')))
        with self.assertRaisesRegex(ValueError, 'standby_required'):
            release.waves(('text-m3',))
        with self.assertRaisesRegex(ValueError, 'invalid_git_apps'):
            release.waves(('text-mini', 'text-mini'))

    def test_empty_selection_is_zero_deploy_and_needs_no_runtime(self):
        with patch.object(release, 'probe') as probe:
            state = self.prepare(())
            with tempfile.TemporaryDirectory() as directory:
                result = release.deploy(self.client, self.target, state, Path(directory) / 'unused')
        self.assertEqual(result['deployed'], [])
        self.assertEqual(self.client.requests, [])
        probe.assert_not_called()

    def test_already_exact_selected_worker_configuration_causes_zero_deploy(self):
        for short in ('text-mini', 'text-m3'):
            self.apps[short].update(sourceType='docker', dockerImage=self.target['worker'],
                env=release.shared.replace_setting(self.apps[short]['env'], 'RELEASE_TAG', self.new))
            self.snapshot['apps'][short] = copy.deepcopy(self.apps[short])
            spec = self.snapshot['runtime'][short]['serviceSpec']
            spec['TaskTemplate']['ContainerSpec'].update(Image=self.target['worker'], Env=self.apps[short]['env'].splitlines())
            self.snapshot['baseline'][short].update(release=self.new, image=self.target['worker'], specHash=release.spec_hash(spec))
        state = self.prepare(('text-mini', 'text-m3'), mode='shared-worker')
        with tempfile.TemporaryDirectory() as directory:
            result = release.deploy(self.client, self.target, state, Path(directory) / 'receipts')
        self.assertEqual(result['deployed'], [])
        self.assertEqual(self.client.requests, [])

    def test_prepare_refuses_wrong_readiness_or_root_baseline_without_writes(self):
        for field, value in (('checkPassed', False), ('imagesReady', False), ('verifiedAt', '2020-01-01T00:00:00Z')):
            with self.subTest(field=field), patch.dict(self.readiness, {field: value}):
                with self.assertRaisesRegex(ValueError, 'readiness'):
                    self.prepare()
        self.snapshot['apps']['text-mini']['command'] = 'different'
        with self.assertRaisesRegex(ValueError, 'root_baseline'):
            self.prepare()
        self.assertEqual(self.client.requests, [])

    def test_shared_worker_mode_explicitly_converts_five_and_preserves_runtime_contract(self):
        state = self.prepare(mode='shared-worker')
        self.assertEqual(state['conversions'], ['text-mini', 'maintenance-mini', 'text-m3', 'maintenance-m3', 'scheduler-m3'])
        before = copy.deepcopy(self.apps)
        with tempfile.TemporaryDirectory() as directory:
            result = release.deploy(self.client, self.target, state, Path(directory) / 'receipts')
        self.assertEqual(len(result['deployed']), 6)
        for short, original in before.items():
            expected = copy.deepcopy(original)
            expected['env'] = release.shared.replace_setting(expected['env'], 'RELEASE_TAG', self.new)
            if short != 'connect-agent-m3':
                expected.update(sourceType='docker', dockerImage=self.target['worker'])
            else:
                expected['buildArgs'] = release.provenance_build_args(expected['buildArgs'], self.new)
            self.assertEqual(self.apps[short], expected)
        self.assertEqual(sum(path == 'application.saveDockerProvider' for path, _ in self.client.requests), 5)

    def test_existing_docker_workers_are_supported_but_connect_source_is_guarded(self):
        for short in self.apps:
            if short != 'connect-agent-m3':
                self.apps[short].update(sourceType='docker', dockerImage=release.shared.IMAGE_PREFIX['worker'] + 'sha256:' + 'e' * 64)
        self.snapshot['apps'] = copy.deepcopy(self.apps)
        self.assertEqual(self.prepare(mode='shared-worker')['conversions'], [])
        self.apps['connect-agent-m3']['sourceType'] = 'docker'
        self.snapshot['apps'] = copy.deepcopy(self.apps)
        with self.assertRaises(ValueError):
            self.prepare(mode='shared-worker')

    def test_runtime_contract_allows_only_image_release_and_force_update_changes(self):
        original = {'serviceSpec': {'Name': 'svc', 'TaskTemplate': {
            'ForceUpdate': 4, 'ContainerSpec': {'Image': 'old', 'Env': ['RELEASE_TAG=' + self.old, 'SECRET=private'],
                                               'Mounts': [{'Source': '/private', 'Target': '/state'}],
                                               'Healthcheck': {'Test': ['CMD', 'health']}, 'Args': ['node', 'worker']},
            'Resources': {'Limits': {'MemoryBytes': 123}}}, 'Mode': {'Replicated': {'Replicas': 2}}},
            'containers': [{'config': {'Cmd': ['node', 'worker'], 'Entrypoint': ['/sbin/tini', '--'],
                                       'Healthcheck': {'Test': ['CMD', 'health']}}}]}
        current = copy.deepcopy(original)
        current['serviceSpec']['TaskTemplate']['ForceUpdate'] = 5
        current['serviceSpec']['TaskTemplate']['ContainerSpec']['Image'] = 'new'
        current['serviceSpec']['TaskTemplate']['ContainerSpec']['Env'][0] = 'RELEASE_TAG=' + self.new
        self.assertTrue(release.runtime_contract_matches(original, current, self.new))
        for field, value in (('Mounts', []), ('Healthcheck', {'Test': ['CMD', 'true']}), ('Args', ['other'])):
            drift = copy.deepcopy(current)
            drift['serviceSpec']['TaskTemplate']['ContainerSpec'][field] = value
            with self.subTest(field=field):
                self.assertFalse(release.runtime_contract_matches(original, drift, self.new))
        current['containers'][0]['config']['Healthcheck'] = {'Test': ['CMD', 'true']}
        self.assertFalse(release.runtime_contract_matches(original, current, self.new))

    def test_runtime_contract_preserves_multiline_secret_as_one_env_entry(self):
        original = {'serviceSpec': {'TaskTemplate': {'ContainerSpec': {
            'Image': 'old', 'Env': ['RELEASE_TAG=' + self.old, 'KEY=first\nsecond\nthird']}}},
            'containers': [{'config': {'Entrypoint': ['/sbin/tini', '--'], 'Cmd': ['node', 'worker']}}]}
        current = copy.deepcopy(original)
        current['serviceSpec']['TaskTemplate']['ContainerSpec']['Env'][0] = 'RELEASE_TAG=' + self.new
        self.assertTrue(release.runtime_contract_matches(original, current, self.new))

    def test_prepare_requires_private_runtime_contract_and_binds_unselected_image(self):
        # A snapshot with only a claimed spec hash cannot prove command/mount/health preservation.
        del self.snapshot['runtime']['text-mini']
        with self.assertRaisesRegex(ValueError, 'runtime_baseline'):
            self.prepare()

    def test_actual_dokploy_command_shapes_are_accepted_without_changing_commands(self):
        for short, app in self.apps.items():
            actual = copy.deepcopy(app)
            role = short.rpartition('-')[0]
            actual['command'] = (None if short == 'connect-agent-m3' else
                '/sbin/tini -- node --import tsx scripts/worker-supervisor.ts --role=scheduler'
                if short == 'scheduler-m3' else
                '/sbin/tini -- node --import tsx scripts/role-worker.ts --role=' + role +
                (' --kind=standby' if short.endswith('-mini') else ' --kind=primary'))
            with self.subTest(app=short):
                release.validate_contract(short, actual, mode='shared-worker')

    def test_final_gate_rejects_rollback_even_if_every_container_claims_healthy(self):
        state = self.prepare(('text-mini', 'text-m3'))
        def probe(short, app, sha, **kwargs):
            return {'ready': True, 'updateState': 'rollback_completed' if sha == self.new else 'completed',
                    'image': 'sha256:' + 'e' * 64, 'specHash': self.snapshot['baseline'][short]['specHash']}
        with tempfile.TemporaryDirectory() as directory, patch.object(release, 'check_deployed', return_value={
                'deploymentId': 'new', 'deployment': 'done'}), patch.object(release, 'probe', side_effect=probe):
            with self.assertRaises(release.GitRolloutStopped):
                release.deploy(self.client, self.target, state, Path(directory) / 'receipts')

    def test_source_replica_and_role_contract_drift_is_rejected(self):
        for field, value in (('branch', 'other'), ('owner', 'foreign'), ('sourceType', 'docker'),
                             ('replicas', 2), ('dockerBuildStage', 'runner'), ('command', 'node evil.js')):
            with self.subTest(field=field):
                original = copy.deepcopy(self.apps['text-mini'])
                self.apps['text-mini'][field] = value
                self.snapshot['apps']['text-mini'] = copy.deepcopy(self.apps['text-mini'])
                with self.assertRaises(ValueError):
                    self.prepare()
                self.apps['text-mini'] = original
                self.snapshot['apps']['text-mini'] = copy.deepcopy(original)
        self.apps['scheduler-m3']['replicas'] = 1
        self.snapshot['apps']['scheduler-m3']['replicas'] = 1
        with self.assertRaisesRegex(ValueError, 'replicas'):
            self.prepare()
        self.assertEqual(self.client.requests, [])

    def test_only_selected_env_release_changes_and_every_new_deployment_is_verified(self):
        state = self.prepare(('text-mini', 'text-m3'))
        before = copy.deepcopy(self.apps)
        with tempfile.TemporaryDirectory() as directory:
            result = release.deploy(self.client, self.target, state, Path(directory) / 'receipts')
            receipts = list((Path(directory) / 'receipts').glob('*.json'))
            self.assertTrue(any('once' in path.name for path in receipts))
            safe = '\n'.join(path.read_text() for path in receipts)
            self.assertNotIn('private', safe)
        self.assertEqual(result['deployed'], ['text-mini', 'text-m3'])
        self.assertEqual(len(self.client.requests), 4)
        for short in before:
            expected = copy.deepcopy(before[short])
            if short.startswith('text-'):
                expected['env'] = release.shared.replace_setting(expected['env'], 'RELEASE_TAG', self.new)
                expected['buildArgs'] = release.provenance_build_args(expected['buildArgs'], self.new)
            self.assertEqual(self.apps[short], expected)

    def test_connect_source_revision_build_argument_is_explicit_and_preserves_other_build_args(self):
        state = self.prepare(('connect-agent-m3',), mode='shared-worker')
        self.assertEqual(state['buildArgUpdates'], ['connect-agent-m3'])
        with tempfile.TemporaryDirectory() as directory:
            release.deploy(self.client, self.target, state, Path(directory) / 'receipts')
        self.assertEqual(self.apps['connect-agent-m3']['buildArgs'], 'UNCHANGED=1\nNMV_SOURCE_SHA=' + self.new + '\n')
        for value in ('NMV_SOURCE_SHA=bad\n', 'NMV_SOURCE_SHA=' + self.old + '\nNMV_SOURCE_SHA=' + self.old + '\n',
                      'export NMV_SOURCE_SHA=' + self.old + '\n', ' NMV_SOURCE_SHA = ' + self.old + '\n'):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'NMV_SOURCE_SHA'):
                release.provenance_build_args(value, self.new)

    def test_batch_cas_drift_prevents_both_writes(self):
        state = self.prepare()
        self.apps['maintenance-mini']['buildSecrets'] = 'changed'
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, 'changed_since_preflight'):
                release.deploy(self.client, self.target, state, Path(directory) / 'receipts')
        self.assertEqual(self.client.requests, [])

    def test_failure_collects_launched_peer_and_never_starts_next_wave_or_retries(self):
        state = self.prepare()
        barrier = threading.Barrier(2)
        completed = []
        def verify(client, short, target, original, previous_id, manifest, **kwargs):
            barrier.wait(timeout=3)
            completed.append(short)
            if short == 'text-mini':
                raise release.shared.ReleaseStopped('text-mini_verification_failed')
            return {'app': short, 'deployment': 'done', 'service': 'healthy', 'deploymentId': 'new-' + short}
        with patch.object(release, 'check_deployed', side_effect=verify), tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(release.GitRolloutStopped) as caught:
                release.deploy(self.client, self.target, state, Path(directory) / 'receipts')
            summary = json.loads((Path(directory) / 'receipts' / 'summary.json').read_text())
        self.assertEqual(set(completed), {'text-mini', 'maintenance-mini'})
        self.assertEqual(summary['deployed'], ['maintenance-mini'])
        self.assertEqual(summary['failed'], ['text-mini'])
        self.assertEqual(set(caught.exception.summary['touched']), set(completed))
        self.assertEqual(len(self.client.requests), 4)

    def test_durable_once_marker_refuses_a_second_run_even_after_unknown_mutation(self):
        state = self.prepare(('text-mini', 'text-m3'))
        self.client.fail_save = True
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'receipts'
            with self.assertRaises(release.GitRolloutStopped):
                release.deploy(self.client, self.target, state, destination)
            first_count = len(self.client.requests)
            self.client.fail_save = False
            with self.assertRaisesRegex(ValueError, 'already_attempted'):
                release.deploy(self.client, self.target, state, destination)
        self.assertEqual(len(self.client.requests), first_count)

    def test_saved_setting_readback_drift_stops_before_deploy(self):
        state = self.prepare(('text-mini', 'text-m3'))
        self.client.drift_on_save = True
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(release.GitRolloutStopped):
            release.deploy(self.client, self.target, state, Path(directory) / 'receipts')
        self.assertEqual([path for path, _ in self.client.requests], ['application.saveEnvironment'])

    def test_new_id_and_done_are_required_and_swarm_rollback_stops_without_retry(self):
        app = copy.deepcopy(self.apps['text-mini'])
        self.apps['text-mini']['env'] = release.shared.replace_setting(app['env'], 'RELEASE_TAG', self.new)
        self.apps['text-mini']['buildArgs'] = release.provenance_build_args(app['buildArgs'], self.new)
        with self.assertRaisesRegex(TimeoutError, 'verification_timeout'):
            release.check_deployed(self.client, 'text-mini', self.target, app, 'old-text-mini', {}, timeout=.001, pause=0)
        self.client.deployments['text-mini'] = 'new-text-mini'
        with patch.object(release, 'probe', return_value={'ready': False, 'updateState': 'rollback_completed'}):
            with self.assertRaises(release.shared.SwarmRollback):
                release.check_deployed(self.client, 'text-mini', self.target, app, 'old-text-mini', {}, pause=0)
        self.assertEqual(self.client.requests, [])


class FakeClient:
    def __init__(self, apps):
        self.apps = apps
        self.requests = []
        self.deployments = {short: 'old-' + short for short in apps}
        self.lock = threading.Lock()
        self.fail_save = False
        self.drift_on_save = False

    def app(self, short):
        return copy.deepcopy(self.apps[short])

    def latest(self, short):
        return {'deploymentId': self.deployments[short], 'status': 'done'}

    def request(self, path, payload=None):
        with self.lock:
            self.requests.append((path, copy.deepcopy(payload)))
            short = next(short for short, app in self.apps.items() if app['applicationId'] == payload['applicationId'])
            if path == 'application.saveEnvironment':
                if self.fail_save:
                    raise RuntimeError('transport_unknown_private')
                for key in ('env', 'buildArgs', 'buildSecrets', 'createEnvFile'):
                    self.apps[short][key] = payload[key]
                if self.drift_on_save:
                    self.apps[short]['autoDeploy'] = True
            elif path == 'application.saveDockerProvider':
                self.apps[short].update(sourceType='docker', dockerImage=payload['dockerImage'])
            elif path == 'application.deploy':
                self.deployments[short] = 'new-' + short


class RuntimeFixtureTests(unittest.TestCase):
    def replacement_repository(self, directory):
        """Build synthetic Git objects only inside a temporary repository."""
        repo = Path(directory)
        subprocess.run(['git', 'init', '-q', str(repo)], capture_output=True, check=True)
        def git(*args, data=None):
            return subprocess.run(['git', '-C', str(repo), '-c', 'user.name=Fixture',
                '-c', 'user.email=fixture@example.invalid', *args], input=data,
                capture_output=True, check=True).stdout.decode().strip()
        files = {'Dockerfile': (SOURCE.parents[2] / 'Dockerfile').read_bytes(), '.dockerignore': b'scripts/ops\n',
                 'package.json': b'{}\n', 'package-lock.json': b'{"identity":"original"}\n', 'tsconfig.json': b'{}\n',
                 'scripts/worker-supervisor.ts': b'export {};\n', 'scripts/worker-healthcheck.ts': b'export {};\n',
                 'scripts/connect-agent.ts': b'export {};\n', 'lib/fixture.ts': b'export {};\n',
                 'drizzle/fixture.sql': b'SELECT 1;\n', 'messages/fixture.ts': b'export {};\n'}
        def commit(contents):
            tree = {}
            for name, value in contents.items():
                current = tree
                pieces = name.split('/')
                for piece in pieces[:-1]: current = current.setdefault(piece, {})
                current[pieces[-1]] = git('hash-object', '-w', '--stdin', data=value)
            def tree_id(node):
                entries = []
                for name, value in sorted(node.items()):
                    entries.append(('040000 tree ' + tree_id(value) if isinstance(value, dict)
                                    else '100644 blob ' + value) + '\t' + name + '\n')
                return git('mktree', data=''.join(entries).encode())
            return git('commit-tree', tree_id(tree), data=b'fixture\n')
        original = commit(files)
        replacement = commit({**files, 'package-lock.json': b'{"identity":"replacement"}\n'})
        git('update-ref', 'HEAD', original)
        git('read-tree', original)
        for name, value in files.items():
            path = repo / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(value)
        git('replace', original, replacement)
        return repo, original, files['package-lock.json']

    def test_source_manifest_uses_original_git_objects_despite_actual_replace_ref(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, original, lock = self.replacement_repository(directory)
            # Confirm this fixture really changes ordinary Git object resolution.
            altered = subprocess.run(['git', '-C', str(repo), 'show', original + ':package-lock.json'],
                                     capture_output=True, check=True).stdout
            self.assertNotEqual(altered, lock)
            manifest = release.source_manifest(original, repo=repo)
        self.assertEqual(manifest['package-lock.json'], hashlib.sha256(lock).hexdigest())

    def test_verify_main_uses_original_objects_and_rejects_tracked_worktree_edits(self):
        with tempfile.TemporaryDirectory() as directory:
            repo, original, _ = self.replacement_repository(directory)
            def run(command, **kwargs):
                if command[0] == 'gh': return original
                self.assertEqual(command[0], 'git')
                return subprocess.run(command, cwd=repo, capture_output=True, text=True, check=True).stdout.strip()
            with patch.object(release.shared, 'run', side_effect=run):
                release.verify_main({'sha': original})
                (repo / 'package-lock.json').write_text('tracked dirty\n')
                with self.assertRaisesRegex(ValueError, 'clean_target_checkout'):
                    release.verify_main({'sha': original})

    def fixture(self):
        sha = 'a' * 40
        app = {'appName': 'svc', 'replicas': 2,
               'command': '/sbin/tini -- node --import tsx scripts/worker-supervisor.ts --role=scheduler'}
        command = app['command'].split()
        config = {'Entrypoint': command, 'Cmd': None, 'Image': 'local:latest',
                  'Env': ['RELEASE_TAG=' + sha, 'WORKER_ROLE=scheduler'],
                  'Labels': {'com.docker.swarm.service.name': 'svc'},
                  'Healthcheck': {'Test': ['CMD-SHELL', 'node --import tsx scripts/worker-healthcheck.ts']}}
        runtime = {'serviceId': 'service-id', 'version': {'Index': 3}, 'updateStatus': {'State': 'completed'},
                   'serviceSpec': {'Name': 'svc', 'TaskTemplate': {'ContainerSpec': {'Image': 'local:latest'}},
                                   'Mode': {'Replicated': {'Replicas': 2}}},
                   'containers': [{'id': cid, 'image': 'sha256:' + 'b' * 64, 'config': copy.deepcopy(config),
                                   'mounts': [], 'state': {'Running': True, 'Health': {'Status': 'healthy'}}}
                                  for cid in ('c1', 'c2')], 'images': []}
        return sha, app, runtime

    def test_actual_scheduler_two_replica_effective_argv_and_each_health_are_required(self):
        sha, app, runtime = self.fixture()
        self.assertTrue(release.runtime_health('scheduler-m3', app, runtime, sha)['ready'])
        for mutate in (lambda r: r['containers'].pop(),
                       lambda r: r['containers'][1]['state']['Health'].update(Status='unhealthy'),
                       lambda r: r['containers'][1]['config'].update(Entrypoint=['other']),
                       lambda r: r['containers'][1]['config']['Env'].append('RELEASE_TAG=' + sha)):
            drift = copy.deepcopy(runtime)
            mutate(drift)
            self.assertFalse(release.runtime_health('scheduler-m3', app, drift, sha)['ready'])

    def test_git_source_revision_requires_exact_label_on_the_running_image(self):
        sha, app, runtime = self.fixture()
        app.update(replicas=1, command=None)
        runtime['serviceSpec']['Mode']['Replicated']['Replicas'] = 1
        runtime['containers'] = runtime['containers'][:1]
        cfg = runtime['containers'][0]['config']
        cfg.update(Entrypoint=['/sbin/tini', '--'], Cmd=['node', '--import', 'tsx', 'scripts/connect-agent.ts'],
                   Env=['RELEASE_TAG=' + sha, 'WORKER_ROLE=connect-agent'],
                   Healthcheck={'Test': ['CMD-SHELL', 'fetch("http://127.0.0.1:3020/rpc").status===401']})
        self.assertFalse(release.runtime_health('connect-agent-m3', app, runtime, sha, require_revision=True)['ready'])
        runtime['images'] = [{'Id': runtime['containers'][0]['image'], 'Config': {
            'Labels': {'org.opencontainers.image.revision': sha}}}]
        self.assertTrue(release.runtime_health('connect-agent-m3', app, runtime, sha, require_revision=True)['ready'])
        runtime['images'][0]['Config']['Labels']['org.opencontainers.image.revision'] = 'b' * 40
        self.assertFalse(release.runtime_health('connect-agent-m3', app, runtime, sha, require_revision=True)['ready'])

    def test_manifest_includes_exact_lockfile_bytes_and_excludes_dockerignored_ops(self):
        root = SOURCE.parents[2]
        sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
        manifest = release.source_manifest(sha, repo=root)
        lock = subprocess.run(['git', 'show', sha + ':package-lock.json'], cwd=root, capture_output=True, check=True).stdout
        self.assertEqual(manifest['package-lock.json'], hashlib.sha256(lock).hexdigest())
        self.assertFalse(any(path.startswith('scripts/ops/') for path in manifest))
        self.assertIn('drizzle/meta/_journal.json', manifest)
        monitor = release.source_manifest(sha, kind='monitor', repo=root)
        self.assertIn('package-lock.json', monitor)
        self.assertFalse(any(path.startswith(('drizzle/', 'messages/')) for path in monitor))

    def test_source_build_requires_committed_stage_revision_argument_and_label(self):
        dockerfile = (SOURCE.parents[2] / 'Dockerfile').read_bytes()
        with patch.object(release.shared, 'git_blob', return_value=dockerfile):
            release.validate_git_source_build('a' * 40, 'connect-agent')
            with self.assertRaisesRegex(ValueError, 'unsupported_worker'):
                release.validate_git_source_build('a' * 40, 'worker')
        with patch.object(release.shared, 'git_blob', return_value=dockerfile.replace(b'ARG NMV_SOURCE_SHA\n', b'')):
            with self.assertRaisesRegex(ValueError, 'unsupported_connect-agent'):
                release.validate_git_source_build('a' * 40, 'connect-agent')

    def test_manifest_rejects_missing_lockfile_and_unknown_copy_or_ignore_rules(self):
        root = SOURCE.parents[2]
        sha = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=root, capture_output=True, text=True, check=True).stdout.strip()
        actual_run = subprocess.run
        for corruption in ('lockfile', 'copy', 'ignore'):
            def corrupt(command, **kwargs):
                result = actual_run(command, **kwargs)
                if corruption == 'copy' and command[-1].endswith(':Dockerfile'):
                    result.stdout = result.stdout.replace(b'COPY --chown=worker:nodejs lib ./lib',
                        b'COPY --chown=worker:nodejs lib ./lib\nCOPY other ./other', 1)
                elif corruption == 'ignore' and command[-1].endswith(':.dockerignore'):
                    result.stdout += b'\nlib/security\n'
                elif corruption == 'lockfile' and 'archive' in command:
                    archive = io.BytesIO()
                    with tarfile.open(fileobj=io.BytesIO(result.stdout)) as source, tarfile.open(fileobj=archive, mode='w') as target:
                        for entry in source:
                            if entry.name != 'package-lock.json':
                                target.addfile(entry, source.extractfile(entry) if entry.isfile() else None)
                    result.stdout = archive.getvalue()
                return result
            with self.subTest(corruption=corruption), patch.object(release.subprocess, 'run', side_effect=corrupt):
                with self.assertRaisesRegex(ValueError, 'source_manifest'):
                    release.source_manifest(sha, repo=root)

    def test_remote_inspect_executes_real_node_sha256_against_copied_source(self):
        fake = '''import json,os,subprocess,sys
f=json.loads(os.environ['FAKE_DOCKER']);a=sys.argv[1:]
if a[:2]==['service','inspect']: print(json.dumps([f['service']]))
elif a[0]=='ps': print('c1')
elif a[0]=='inspect': print(json.dumps([f['container']]))
elif a[:2]==['image','inspect']: print(json.dumps([{'Id':f['container']['Image']}]))
elif a[0]=='exec':
 script=a[-1].replace("'/app/'",json.dumps(os.environ['FAKE_SOURCE']+'/'))
 result=subprocess.run(['node','-e',script],input=sys.stdin.read(),capture_output=True,text=True)
 sys.stdout.write(result.stdout);sys.exit(result.returncode)
'''
        sha, app, runtime = self.fixture()
        fixture = {'service': {'ID': 'service-id', 'Version': {'Index': 3}, 'Spec': runtime['serviceSpec'],
                               'UpdateStatus': runtime['updateStatus']},
                   'container': {'Image': runtime['containers'][0]['image'], 'Config': runtime['containers'][0]['config'],
                                 'State': runtime['containers'][0]['state'], 'Mounts': []}}
        with tempfile.TemporaryDirectory() as directory:
            docker = Path(directory) / 'docker'
            docker.write_text('#!' + sys.executable + '\n' + fake)
            docker.chmod(0o755)
            source = Path(directory) / 'package-lock.json'
            source.write_bytes(b'{"lockfileVersion":3}\n')
            expected = hashlib.sha256(source.read_bytes()).hexdigest()
            env = {**os.environ, 'PATH': directory + os.pathsep + os.environ['PATH'],
                   'FAKE_DOCKER': json.dumps(fixture), 'FAKE_SOURCE': directory}
            result = subprocess.run([sys.executable, '-c', release.REMOTE_INSPECT, 'svc', 'scheduler'],
                                    input=json.dumps({'package-lock.json': expected}), text=True,
                                    capture_output=True, env=env, timeout=10, check=True)
        raw = json.loads(result.stdout)
        self.assertEqual(raw['containers'][0]['codeHashes'], {'package-lock.json': expected})
        self.assertEqual(raw['serviceId'], 'service-id')
        self.assertEqual(raw['version'], {'Index': 3})
        self.assertEqual(raw['specHash'], release.spec_hash(raw['serviceSpec']))


if __name__ == '__main__':
    unittest.main()
