"""Exercise the real release coordinator with local Git and a stateful fake API.

SSH/health, hosted CI and background process launch are external boundaries. No
production, credential, model or network calls are permitted in these tests.
"""
import contextlib
import copy
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load(name, source):
    spec = importlib.util.spec_from_file_location(name, source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

release = load('release_coordinator_flow', ROOT / 'scripts/ops/deploy_release.py')
fixtures = load('release_coordinator_runtime_fixtures', ROOT / 'tests/test_release_runtime.py')


class StatefulApi:
    def __init__(self, owner, apps, latest):
        self.owner, self.apps, self.deployments = owner, copy.deepcopy(apps), copy.deepcopy(latest)
        self.posts, self.fail_endpoint, self.fail_app = [], None, None

    def app(self, short):
        return copy.deepcopy(self.apps[short])

    def latest(self, short):
        return copy.deepcopy(self.deployments[short])

    def request(self, endpoint, payload):
        self.owner.assertIn('preflight-monitor', self.owner.events)
        short = next(name for name in release.fleet.registered_apps()
                     if release.shared.app_metadata(name)[0] == payload['applicationId'])
        self.posts.append((short, endpoint, copy.deepcopy(payload)))
        self.owner.events.append((short, endpoint))
        if endpoint == self.fail_endpoint and short == self.fail_app:
            raise ConnectionError('synthetic ambiguous transport failure')
        if endpoint == 'application.saveEnvironment':
            self.apps[short].update({key: payload[key] for key in ('env', 'buildArgs', 'buildSecrets', 'createEnvFile')})
        elif endpoint == 'application.saveDockerProvider':
            self.apps[short].update(sourceType='docker', **{key: payload[key] for key in
                ('dockerImage', 'username', 'password', 'registryUrl')})
        elif endpoint == 'application.deploy':
            # A repeated deploy of the same app (the single Swarm start-race redeploy) gets its own new id.
            count = sum(1 for name, path, _ in self.posts if name == short and path == endpoint)
            self.deployments[short] = {'status': 'done', 'deploymentId': 'new-' + short + ('' if count == 1 else '-' + str(count))}
        else:
            raise AssertionError('unexpected API write')


class CoordinatorFlowTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack(); self.addCleanup(self.stack.close)
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.repo = self.directory / 'checkout'; self.repo.mkdir()
        self.git('init', '-q', '-b', 'main'); self.git('config', 'user.email', 'flow@example.invalid'); self.git('config', 'user.name', 'Flow test')
        (self.repo / 'app').mkdir(); (self.repo / 'app/globals.css').write_text('body { color: red; }\n')
        self.git('add', '.'); self.git('commit', '-qm', 'old web'); self.before = self.git('rev-parse', 'HEAD')
        (self.repo / 'app/globals.css').write_text('body { color: blue; }\n')
        self.git('add', '.'); self.git('commit', '-qm', 'new web'); self.after = self.git('rev-parse', 'HEAD')
        apps, raw, latest = fixtures.fixture()
        for app in apps.values():
            app.update(createEnvFile=False, username='preserved-user', password='preserved-registry-secret', registryUrl='ghcr.io')
            app['env'] = app['env'].replace(fixtures.OLD, self.before)
            app['buildArgs'] = app['buildArgs'].replace(fixtures.OLD, self.before)
        baseline = {short: {'release': self.before, 'image': app.get('dockerImage') or fixtures.IMAGE_ID,
                            'specHash': raw[short]['specHash']} for short, app in apps.items()}
        self.events = []
        self.client = StatefulApi(self, apps, latest)
        self.target = {'sha': self.after, 'worker': apps['publisher-m3']['dockerImage'],
                       'web': release.shared.IMAGE_PREFIX['web'] + fixtures.NEW_ID}
        self.snapshot = {'schemaVersion': 1, 'target': self.target, 'apps': copy.deepcopy(apps),
                         'latest': copy.deepcopy(latest), 'baseline': baseline, 'runtime': raw}
        self.proof = {'schemaVersion': 1, 'runId': 101, 'runAttempt': 1, 'profile': 'ui', 'rulesVersion': 'v2',
                      'target': {'sha': self.after, 'web': self.target['web']}, 'checkPassed': True, 'imagesReady': True}
        self.stack.enter_context(patch.object(release, 'ROOT', self.repo))
        self.plan = {'schemaVersion': 1, 'snapshot': self.snapshot, 'target': self.target,
                     'toolSources': release.execution_source_hashes(),
                     'scope': release.impact(self.snapshot, self.after), 'readiness': copy.deepcopy(self.proof),
                     'migrationVerified': False}
        self.assertEqual(self.plan['scope']['selectedApps'], ['web-mini', 'web-m3'])
        self.new_client = self.stack.enter_context(patch.object(release, 'new_client', return_value=self.client))
        self.ready = self.stack.enter_context(patch.object(release.readiness, 'resolve_readiness', side_effect=self.resolve))
        self.main = self.stack.enter_context(patch.object(release.git, 'verify_main', side_effect=lambda target: self.events.append('main-verified')))
        self.registry = self.stack.enter_context(patch.object(release.shared, 'main_sha_and_token',
            side_effect=lambda target: self.record('registry-verified', 'synthetic-token')))
        self.fleet = self.stack.enter_context(patch.object(release.fleet, 'verify_fleet', side_effect=self.verify_fleet))
        self.stack.enter_context(patch.object(release.shared, 'run', side_effect=self.local_transport))
        self.stack.enter_context(patch.object(release.shared, 'ssh_python', side_effect=AssertionError('unexpected SSH')) )
        self.stack.enter_context(patch.object(release.git.shared, 'ssh_python', side_effect=AssertionError('unexpected Git rollout SSH')))
        self.model_drain = self.stack.enter_context(patch.object(release, 'model_replacement_gate',
            return_value={'required': True, 'mode': 'draining', 'active': 0}))
        integration = release.shared.github_integration_preflight
        def actual_integration(client, app_map):
            result = integration(client, app_map); self.events.append('integration-verified'); return result
        self.stack.enter_context(patch.object(release.shared, 'github_integration_preflight', side_effect=actual_integration))
        self.monitor = self.stack.enter_context(patch.object(release.shared, 'monitor_gate', side_effect=self.monitor_gate))
        self.health = self.stack.enter_context(patch.object(release.shared, 'check_app_deployed', side_effect=self.check_health))
        self.public = self.stack.enter_context(patch.object(release.shared, 'public_gate', side_effect=lambda sha: self.record('public-verified', {'release': sha})))
        self.purge = self.stack.enter_context(patch.object(release.shared, 'purge_html', side_effect=lambda: self.record('cache-purged', {'purged': True})))
        self.launch = self.stack.enter_context(patch.object(release, 'load', side_effect=lambda name, filename: SimpleNamespace(launch_observer=self.launch_observer)
            if filename == 'release_observer.py' else (_ for _ in ()).throw(AssertionError('unexpected dynamic module'))))
        self.observations = []
        self.fleet_retired = []
        self.execution = self.directory / 'execution'

    def git(self, *arguments):
        return subprocess.run(['git', '-C', str(self.repo), *arguments], capture_output=True, text=True, check=True).stdout.strip()

    def record(self, event, result):
        self.events.append(event); return result

    def local_transport(self, command, **kwargs):
        # The real migration classifier still runs Git against the local fixture.
        self.assertEqual(command[:4], ['git', '--no-replace-objects', 'diff', '--no-ext-diff'])
        result = subprocess.run(command, cwd=self.repo, capture_output=True, text=True, check=True)
        return result.stdout.strip()

    def resolve(self, sha, **kwargs):
        self.assertEqual(sha, self.after); self.assertEqual(kwargs['required_kinds'], ('web',))
        return self.record('ci-verified', copy.deepcopy(self.proof))

    def monitor_gate(self, client, role, **kwargs):
        self.assertIs(client, self.client)
        self.assertIn('integration-verified', self.events)
        return self.record('preflight-monitor' if not self.client.posts else 'final-monitor', {'ready': True})

    def check_health(self, client, short, target, previous_id, **kwargs):
        self.assertIs(client, self.client); self.assertEqual(target, self.target)
        self.assertEqual(previous_id, self.snapshot['latest'][short]['deploymentId'])
        self.assertEqual(client.latest(short)['deploymentId'], 'new-' + short)
        self.assertEqual(client.app(short)['dockerImage'], self.target['web'])
        return self.record((short, 'runtime-verified'), {'ready': True})

    def verify_fleet(self, client, snapshot, target, selected, receipts, repo, *, output_snapshot=None, retired_settings=()):
        self.assertIs(client, self.client); self.assertEqual(repo, self.repo); self.assertEqual(target, self.target)
        self.fleet_retired.append(tuple(retired_settings))
        if not selected:
            self.assertEqual(client.apps, snapshot['apps'])
            self.assertEqual(receipts, {})
            self.events.append('fleet-baseline-verified')
            return copy.deepcopy(snapshot['baseline'])
        self.assertEqual(selected, ['web-mini', 'web-m3']); self.assertEqual(set(receipts), set(selected))
        observed = copy.deepcopy(snapshot['baseline'])
        for short in release.fleet.registered_apps():
            if short in selected:
                self.assertEqual(receipts[short]['deploymentId'], client.latest(short)['deploymentId'])
                self.assertEqual(release.shared.setting(client.app(short)['env'], 'RELEASE_TAG'), self.after)
                self.assertEqual(release.shared.setting(client.app(short)['env'], 'NEXT_DEPLOYMENT_ID'), self.after)
                self.assertEqual(release.shared.setting(client.app(short)['buildArgs'], 'NEXT_DEPLOYMENT_ID'), self.after)
                self.assertEqual(client.app(short)['dockerImage'], self.target['web'])
                # The real verifier holds the saved env to expected_api(..., retired): the retired lines are gone.
                self.assertEqual(client.app(short)['env'], release.fleet.expected_api(short, snapshot['apps'][short], target, retired_settings)['env'])
                for name in retired_settings:
                    self.assertNotIn(name, release.shared.dotenv_settings(client.app(short)['env']))
                observed[short].update(release=self.after, image=self.target['web'])
            else:
                self.assertEqual(client.app(short), snapshot['apps'][short])
                self.assertEqual(client.latest(short), snapshot['latest'][short])
        self.events.append('fleet-final-verified')
        if output_snapshot is not None:
            output_snapshot.update(schemaVersion=1, target=target, apps=copy.deepcopy(client.apps),
                latest=copy.deepcopy(client.deployments), runtime=copy.deepcopy(snapshot['runtime']), baseline=observed)
        return observed

    def launch_observer(self, path, digest, directory):
        self.assertIn('fleet-final-verified', self.events); self.assertIn('final-monitor', self.events)
        final = release.read_private(path, digest)
        self.assertEqual(final['apps'], self.client.apps)
        self.assertEqual(final['latest'], self.client.deployments)
        self.assertEqual(final['baseline']['web-mini']['release'], self.after)
        self.observations.append((path, digest, directory)); self.events.append('observer-launched')
        return {'status': 'scheduled', 'observationComplete': False}

    def test_real_engine_updates_web_pair_serially_records_each_action_and_launches_observer_last(self):
        result = release.run_release(self.plan, self.execution)
        self.assertEqual(result['status'], 'deployed-and-verified')
        self.assertEqual([list(call.args[1]) for call in self.model_drain.call_args_list],
                         [['web-mini', 'web-m3'], ['web-mini'], ['web-m3']])
        self.assertEqual([(short, endpoint) for short, endpoint, _ in self.client.posts], [
            (short, endpoint) for short in ('web-mini', 'web-m3') for endpoint in
            ('application.saveEnvironment', 'application.saveDockerProvider', 'application.deploy')])
        self.assertEqual(self.health.call_count, 2)
        self.assertLess(self.events.index(('web-mini', 'runtime-verified')), self.events.index(('web-m3', 'application.saveEnvironment')))
        self.assertLess(self.events.index('preflight-monitor'), self.events.index(('web-mini', 'application.saveEnvironment')))
        self.assertEqual(self.events[-1], 'observer-launched')
        self.assertEqual(self.fleet.call_count, 2)
        self.assertEqual(len(result['retainedApps']), 16)
        self.assertEqual(len(self.observations), 1)

        for short in ('web-mini', 'web-m3'):
            for label in ('environment', 'provider', 'deploy'):
                self.assertTrue((self.execution / (short + '.' + label + '.attempted.json')).is_file())
                self.assertTrue((self.execution / (short + '.' + label + '.completed.json')).is_file())
            self.assertTrue((self.execution / (short + '.verified.json')).is_file())
            payload = next(payload for name, endpoint, payload in self.client.posts if name == short and endpoint.endswith('saveDockerProvider'))
            self.assertEqual((payload['username'], payload['password'], payload['registryUrl']),
                ('preserved-user', 'preserved-registry-secret', 'ghcr.io'))
        self.assertFalse(result['observation']['observationComplete'])
        with self.assertRaisesRegex(ValueError, 'already_attempted'):
            release.run_release(self.plan, self.execution)
        self.assertEqual(len(self.client.posts), 6); self.assertEqual(self.new_client.call_count, 1)
        self.assertEqual(len(self.observations), 1)

    def test_private_registry_guard_rejects_before_first_service_write(self):
        self.registry.side_effect = ValueError('web_package_not_private')
        with self.assertRaisesRegex(ValueError, 'web_package_not_private'):
            release.run_release(self.plan, self.execution)
        self.assertEqual(self.client.posts, [])
        self.assertEqual(self.health.call_count, 0)
        self.assertEqual(self.observations, [])

    def test_model_drain_failure_blocks_before_any_application_write(self):
        self.model_drain.side_effect = ValueError('model_replacement_requires_explicit_drain_and_zero_active_calls')
        with self.assertRaisesRegex(ValueError, 'explicit_drain_and_zero_active_calls'):
            release.run_release(self.plan, self.execution)
        self.assertEqual(self.client.posts, [])
        self.assertEqual(self.health.call_count, 0)
        self.assertEqual(self.observations, [])

    def test_image_preparation_checks_private_registry_and_preserves_existing_pull_credentials(self):
        with patch.object(release.shared, 'ssh_python', return_value=json.dumps({
                'pulled': True, 'revision': self.after})) as remote:
            release.prepull(self.snapshot, self.target, ['web-mini', 'web-m3'])
        self.assertEqual(self.registry.call_count, 1)
        self.assertEqual(remote.call_count, 2)
        self.assertTrue(all(call.kwargs['input_text'] == 'preserved-registry-secret' for call in remote.call_args_list))

    def test_role_closure_keeps_exact_target_text_mini_as_retained_without_requiring_a_deployment_receipt(self):
        # Every app already serves the target except text-m3. A shared-code diff
        # affects that old app, and role closure also selects its exact-target peer.
        (self.repo / 'lib').mkdir()
        (self.repo / 'lib/shared.ts').write_text('export const updated = true;\n')
        self.git('add', '.'); self.git('commit', '-qm', 'shared runtime change')
        self.after = self.git('rev-parse', 'HEAD')
        self.target.update(sha=self.after, worker=release.shared.IMAGE_PREFIX['worker'] + fixtures.NEW_ID)
        for short, app in self.client.apps.items():
            revision = self.before if short == 'text-m3' else self.after
            app['env'] = release.shared.replace_setting(app['env'], 'RELEASE_TAG', revision)
            kind = release.shared.app_metadata(short)[3]
            if kind == 'web':
                app['env'] = release.shared.replace_setting(app['env'], 'NEXT_DEPLOYMENT_ID', revision)
                app['buildArgs'] = release.shared.replace_setting(app['buildArgs'], 'NEXT_DEPLOYMENT_ID', revision)
            if short != 'text-m3' and kind != 'connect-agent':
                app.update(sourceType='docker', dockerImage=self.target['web' if kind == 'web' else 'worker'])
            raw = self.snapshot['runtime'][short]
            cs = raw['serviceSpec']['TaskTemplate']['ContainerSpec']
            cs['Env'] = [line.replace(fixtures.OLD, revision) for line in cs['Env']]
            cs['Image'] = app.get('dockerImage') or app['appName'] + ':latest'
            raw['specHash'] = release.git.spec_hash(raw['serviceSpec'])
            self.snapshot['baseline'][short] = {'release': revision,
                'image': app.get('dockerImage') or fixtures.IMAGE_ID, 'specHash': raw['specHash']}
        self.snapshot['apps'] = copy.deepcopy(self.client.apps)
        self.snapshot['target'] = copy.deepcopy(self.target)
        self.plan.update(target=self.target, snapshot=self.snapshot, scope=release.impact(self.snapshot, self.after))
        self.assertEqual(self.plan['scope']['selectedApps'], ['text-mini', 'text-m3'])
        self.proof.update(profile='full', verifiedAt=release.now(), target={'sha': self.after, 'worker': self.target['worker']})
        self.plan['readiness'] = copy.deepcopy(self.proof)
        self.ready.side_effect = lambda sha, **kwargs: self.record('ci-verified', copy.deepcopy(self.proof))
        original_mini = copy.deepcopy(self.client.apps['text-mini'])
        original_mini_latest = copy.deepcopy(self.client.deployments['text-mini'])
        final_calls = []
        def fleet(client, snapshot, target, selected, receipts, repo, *, output_snapshot=None):
            if not selected:
                self.assertEqual(client.apps, snapshot['apps']); self.assertEqual(receipts, {})
                return copy.deepcopy(snapshot['baseline'])
            final_calls.append((list(selected), copy.deepcopy(receipts)))
            self.assertEqual(list(selected), ['text-m3'])
            self.assertEqual(set(receipts), {'text-m3'})
            self.assertEqual(client.apps['text-mini'], original_mini)
            self.assertEqual(client.latest('text-mini'), original_mini_latest)
            observed = copy.deepcopy(snapshot['baseline'])
            observed['text-m3'].update(release=self.after, image=self.target['worker'])
            for short in release.fleet.registered_apps():
                if short != 'text-m3':
                    self.assertEqual(client.app(short), snapshot['apps'][short])
                    self.assertEqual(client.latest(short), snapshot['latest'][short])
            if output_snapshot is not None:
                output_snapshot.update(schemaVersion=1, target=target, apps=copy.deepcopy(client.apps),
                    latest=copy.deepcopy(client.deployments), runtime=copy.deepcopy(snapshot['runtime']), baseline=observed)
            return observed
        self.fleet.side_effect = fleet
        def probe(short, app, sha, **kwargs):
            state = self.snapshot['baseline'][short]
            return {'ready': True, 'updateState': 'completed',
                'image': app.get('dockerImage') or state['image'], 'specHash': state['specHash']}
        def checked(client, short, target, original, previous_id, manifest, **kwargs):
            self.assertEqual(short, 'text-m3')
            self.assertEqual(client.app(short), release.git.expected_config(short, original, target, 'shared-worker'))
            self.assertNotEqual(client.latest(short)['deploymentId'], previous_id)
            return {'app': short, 'deploymentId': client.latest(short)['deploymentId']}
        actual_prepare = release.git.prepare
        prepared_states = []
        def prepare(*args, **kwargs):
            state = actual_prepare(*args, **kwargs); prepared_states.append(state)
            self.assertEqual(state['skipped'], ['text-mini'])
            return state
        def retain_image(host, source, image, tag):
            self.assertEqual(source, release.REMOTE_RETAIN_IMAGE)
            self.assertEqual(tag, 'nomorevibe-rollback/text-m3:' + self.before)
            self.assertEqual(self.client.posts, [])
            return json.dumps({'image': image, 'retained': True})
        with patch.object(release.shared, 'ssh_python', side_effect=retain_image), \
             patch.object(release.git, 'prepare', side_effect=prepare), \
             patch.object(release.git, 'source_manifest', return_value={'package-lock.json': 'a' * 64}), \
             patch.object(release.git, 'probe', side_effect=probe), \
             patch.object(release.git, 'check_deployed', side_effect=checked), \
             patch.object(release.git.shared, 'monitor_gate', side_effect=self.monitor_gate):
            result = release.run_release(self.plan, self.execution, observe=False)
        self.assertEqual(len(prepared_states), 1)
        self.assertEqual(result['status'], 'deployed-and-verified')
        self.assertEqual(result['selectedApps'], ['text-mini', 'text-m3'])
        self.assertEqual(result['deployedApps'], ['text-m3'])
        self.assertEqual(result['skippedApps'], ['text-mini'])
        self.assertIn('text-mini', result['retainedApps'])
        self.assertEqual(len(final_calls), 1)
        self.assertEqual({name for name, _, _ in self.client.posts}, {'text-m3'})
        self.assertFalse((self.execution / 'git/text-mini.verified.json').exists())
        self.assertTrue((self.execution / 'git/text-m3.verified.json').is_file())
        self.assertFalse((self.execution / 'stopped.safe.json').exists())

    def move_fleet_to(self, revision):
        """Every app already serves `revision` (release, image, spec, baseline), so the next commit selects only its own apps."""
        for short, app in self.client.apps.items():
            app['env'] = release.shared.replace_setting(app['env'], 'RELEASE_TAG', revision)
            kind = release.shared.app_metadata(short)[3]
            if kind == 'web':
                app['env'] = release.shared.replace_setting(app['env'], 'NEXT_DEPLOYMENT_ID', revision)
                app['buildArgs'] = release.shared.replace_setting(app['buildArgs'], 'NEXT_DEPLOYMENT_ID', revision)
            if kind != 'connect-agent':
                app.update(sourceType='docker', dockerImage=self.target['web' if kind == 'web' else 'worker'])
            raw = self.snapshot['runtime'][short]
            cs = raw['serviceSpec']['TaskTemplate']['ContainerSpec']
            cs['Env'] = [line.replace(fixtures.OLD, revision) for line in cs['Env']]
            cs['Image'] = app.get('dockerImage') or app['appName'] + ':latest'
            raw['specHash'] = release.git.spec_hash(raw['serviceSpec'])
            self.snapshot['baseline'][short] = {'release': revision,
                'image': app.get('dockerImage') or fixtures.IMAGE_ID, 'specHash': raw['specHash']}
        self.snapshot['apps'] = copy.deepcopy(self.client.apps)

    def arm_monitor_release(self, check_monitor):
        """A monitor entrypoint commit on a fleet already at `after` selects only monitor-m3; the push proof is `check_monitor`'s."""
        previous = self.after
        self.target['worker'] = release.shared.IMAGE_PREFIX['worker'] + fixtures.NEW_ID
        self.move_fleet_to(previous)
        (self.repo / 'scripts').mkdir()
        (self.repo / 'scripts/watch-failover-readiness.ts').write_text('export const watcher = 2;\n')
        self.git('add', '.'); self.git('commit', '-qm', 'monitor entrypoint change')
        self.after = self.git('rev-parse', 'HEAD')
        self.target['sha'] = self.after
        self.snapshot['target'] = copy.deepcopy(self.target)
        self.plan.update(target=self.target, snapshot=self.snapshot, scope=release.impact(self.snapshot, self.after))
        self.assertEqual(self.plan['scope']['selectedApps'], ['monitor-m3'])
        self.proof.update(profile='full', verifiedAt=release.now(), target={'sha': self.after, 'worker': self.target['worker']})
        self.plan['readiness'] = copy.deepcopy(self.proof)
        self.ready.side_effect = lambda sha, **kwargs: self.record('ci-verified', copy.deepcopy(self.proof))
        self.final_receipts = []
        def fleet(client, snapshot, target, selected, receipts, repo, *, output_snapshot=None):
            self.assertIs(client, self.client)
            if not selected:
                self.assertEqual(client.apps, snapshot['apps']); self.assertEqual(receipts, {})
                return self.record('fleet-baseline-verified', copy.deepcopy(snapshot['baseline']))
            self.assertEqual(list(selected), ['monitor-m3']); self.assertEqual(set(receipts), {'monitor-m3'})
            self.assertEqual(receipts['monitor-m3']['deploymentId'], client.latest('monitor-m3')['deploymentId'])
            self.assertEqual(release.shared.setting(client.app('monitor-m3')['env'], 'RELEASE_TAG'), self.after)
            self.final_receipts.append(copy.deepcopy(receipts['monitor-m3']))
            observed = copy.deepcopy(snapshot['baseline'])
            observed['monitor-m3'].update(release=self.after, image=self.target['worker'])
            if output_snapshot is not None:
                output_snapshot.update(schemaVersion=1, target=target, apps=copy.deepcopy(client.apps),
                    latest=copy.deepcopy(client.deployments), runtime=copy.deepcopy(snapshot['runtime']), baseline=observed)
            return self.record('fleet-final-verified', observed)
        self.fleet.side_effect = fleet
        def launch_observer(path, digest, directory):
            self.assertIn('fleet-final-verified', self.events); self.assertIn('final-monitor', self.events)
            final = release.read_private(path, digest)
            self.assertEqual(final['baseline']['monitor-m3']['release'], self.after)
            self.observations.append((path, digest, directory)); self.events.append('observer-launched')
            return {'status': 'scheduled', 'observationComplete': False}
        real_monitor = load('release_monitor_flow', ROOT / 'scripts/ops/release_monitor.py')
        monitor_module = SimpleNamespace(HUMAN_REVIEW=real_monitor.HUMAN_REVIEW, PUSH_FIELDS=real_monitor.PUSH_FIELDS,
                                         MONITOR_VERIFY_TIMEOUT_SECONDS=real_monitor.MONITOR_VERIFY_TIMEOUT_SECONDS,
                                         check_monitor_deployed=check_monitor, human_review_record=real_monitor.human_review_record,
                                         git=real_monitor.git)
        modules = {'release_observer.py': SimpleNamespace(launch_observer=launch_observer), 'release_monitor.py': monitor_module}
        self.launch.side_effect = lambda name, filename: modules[filename]
        report = {'check-failover-readiness.ts': {'overall': 'alarm', 'readiness': {'roles': []}, 'capacityUnknowns': {
                      'status': 'alarm', 'truncated': False, 'count': 0, 'oldestAgeSeconds': None, 'stuckDispatched': 1,
                      'alarmReasons': ['dispatch_stuck'], 'requests': [{'requestId': 'private-request-id'}]}},
                  'check-worker-progress.ts': {'overall': 'ok'}}
        def crawler_report(host, source, service, **kwargs):
            self.assertEqual((host, source, service), (release.shared.M3[1], release.shared.REMOTE_MONITOR, 'service-crawler-m3'))
            return self.record('capacity-summary-read', json.dumps(report))
        self.stack.enter_context(patch.object(real_monitor.git.shared, 'ssh_python', side_effect=crawler_report))
        self.stack.enter_context(patch.object(release.git, 'source_manifest', return_value={'package-lock.json': 'a' * 64}))
        return monitor_module

    def monitor_hand_over(self, client, short, target, original, old_id, manifest, *, expected_runtime, **kwargs):
        """The real verifier's hand-over receipt: deployment proven, latest monitor.push still state=down after the window."""
        self.assertIs(client, self.client); self.assertEqual(short, 'monitor-m3')
        self.assertEqual(kwargs, {}, 'deploy_one must use the monitor verification default timeout')
        self.assertEqual(client.latest(short)['deploymentId'], 'new-monitor-m3'); self.assertEqual(old_id, 'old-monitor-m3')
        self.assertEqual(client.app(short), release.fleet.expected_api(short, original, target))
        self.assertEqual(expected_runtime, self.snapshot['runtime'][short])
        self.events.append(('monitor-m3', 'push-verification-handed-over'))
        return {'app': short, 'deploymentId': 'new-monitor-m3', 'deployment': 'done', 'service': 'healthy',
                'image': target['worker'], 'specHash': 'spec', 'containerId': 'c' * 64, 'source': 'sha256-manifest',
                'pushReceipts': {'verified': False, 'primary': True, 'external': True, 'fresh': True, 'stateUp': False},
                'verification': 'human_review_required', 'reason': 'monitor_push_state_not_up', 'verifyTimeoutSeconds': 300}

    def test_monitor_push_state_down_after_the_window_finishes_the_run_as_human_review_required(self):
        self.arm_monitor_release(self.monitor_hand_over)
        result = release.run_release(self.plan, self.execution)
        self.assertEqual(result['status'], 'deployed-human-review-required')
        self.assertEqual((result['deployedApps'], result['skippedApps']), (['monitor-m3'], []))
        record_path = self.execution / 'monitor-m3.human-review.safe.json'
        self.assertEqual(result['humanReview'], {'apps': ['monitor-m3'], 'reasons': {'monitor-m3': 'monitor_push_state_not_up'},
                                                 'records': [str(record_path)]})
        self.assertEqual([(short, endpoint) for short, endpoint, _ in self.client.posts], [('monitor-m3', endpoint) for endpoint in
            ('application.saveEnvironment', 'application.saveDockerProvider', 'application.deploy')])
        # The run went on to the final fleet verification, the guard and the observer; nothing stopped.
        self.assertLess(self.events.index(('monitor-m3', 'push-verification-handed-over')), self.events.index('capacity-summary-read'))
        self.assertLess(self.events.index('capacity-summary-read'), self.events.index('fleet-final-verified'))
        self.assertEqual(self.events[-1], 'observer-launched'); self.assertIn('final-monitor', self.events)
        self.assertEqual(self.fleet.call_count, 2); self.assertEqual(len(self.observations), 1)
        self.assertEqual(self.final_receipts[0]['verification'], 'human_review_required')
        self.health.assert_not_called()
        self.assertFalse((self.execution / 'stopped.safe.json').exists())
        self.assertTrue((self.execution / 'final.private.json').is_file())
        self.assertEqual(json.loads((self.execution / 'result.safe.json').read_text())['status'], 'deployed-human-review-required')
        verified = json.loads((self.execution / 'monitor-m3.verified.json').read_text())
        self.assertEqual((verified['verification'], verified['reason'], verified['deploymentId']),
                         ('human_review_required', 'monitor_push_state_not_up', 'new-monitor-m3'))
        self.assertEqual(record_path.stat().st_mode & 0o777, 0o600)
        text = record_path.read_text(); record = json.loads(text)
        self.assertEqual((record['status'], record['app'], record['deploymentId'], record['reason'], record['lastPushState']),
                         ('human-review-required', 'monitor-m3', 'new-monitor-m3', 'monitor_push_state_not_up', 'down'))
        self.assertEqual(record['pushReceipts'], {'verified': False, 'primary': True, 'external': True, 'fresh': True, 'stateUp': False})
        self.assertEqual(record['capacityUnknowns'], {'status': 'alarm', 'monitorOverall': 'alarm', 'count': 0, 'stuckDispatched': 1,
                                                      'oldestAgeSeconds': None, 'alarmReasons': ['dispatch_stuck']})
        self.assertEqual(record['operatorChecks'], ['monitor_push_event_state_and_receipts', 'capacity_unknowns_alarm_reasons',
                                                    'kuma_primary_and_external_heartbeat'])
        for leaked in ('private-request-id', 'https://', 'preserved-registry-secret', 'synthetic-secret'):
            self.assertNotIn(leaked, text)
        with self.assertRaisesRegex(ValueError, 'already_attempted'):
            release.run_release(self.plan, self.execution)

    def test_monitor_hand_over_exits_with_its_own_code_and_prints_the_safe_result(self):
        self.arm_monitor_release(self.monitor_hand_over)
        plan_path = self.directory / 'plan-dir' / 'plan.private.json'; plan_path.parent.mkdir()
        digest = release.write_private(plan_path, self.plan)
        self.addCleanup(os.chdir, os.getcwd())
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = release.cli(['run', '--plan', str(plan_path), '--plan-sha', digest])
        self.assertEqual(code, release.HUMAN_REVIEW_EXIT_CODE); self.assertEqual(code, 2)
        printed = json.loads(stdout.getvalue())
        self.assertEqual((printed['status'], printed['humanReview']['reasons']), ('deployed-human-review-required', {'monitor-m3': 'monitor_push_state_not_up'}))
        self.assertTrue((plan_path.parent / 'execution/monitor-m3.human-review.safe.json').is_file())
        self.assertNotIn('preserved-registry-secret', stdout.getvalue())
        # A fully verified run keeps exit 0.
        self.events.clear(); self.observations.clear(); self.client.posts.clear()
        verified_plan = copy.deepcopy(self.plan)
        self.client.deployments['monitor-m3'] = {'status': 'done', 'deploymentId': 'old-monitor-m3'}
        self.client.apps['monitor-m3'] = copy.deepcopy(self.snapshot['apps']['monitor-m3'])
        def verified(client, short, target, original, old_id, manifest, *, expected_runtime, **kwargs):
            self.events.append(('monitor-m3', 'push-verified'))
            return {'app': short, 'deploymentId': 'new-monitor-m3', 'deployment': 'done', 'service': 'healthy',
                    'pushReceipts': {'primary': True, 'external': True}}
        self.launch.side_effect(None, 'release_monitor.py').check_monitor_deployed = verified
        second = self.directory / 'plan-dir-2' / 'plan.private.json'; second.parent.mkdir()
        digest = release.write_private(second, verified_plan)
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            code = release.cli(['run', '--plan', str(second), '--plan-sha', digest])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(stdout.getvalue())['status'], 'deployed-and-verified')
        self.assertNotIn('humanReview', json.loads(stdout.getvalue()))
        self.assertFalse((second.parent / 'execution/monitor-m3.human-review.safe.json').exists())

    def test_monitor_deployment_not_proven_within_the_window_still_stops_the_run(self):
        def timed_out(client, short, target, original, old_id, manifest, *, expected_runtime, **kwargs):
            self.events.append(('monitor-m3', 'push-verification-timed-out'))
            raise TimeoutError('monitor-m3_source_health_or_push_verification_timeout')
        self.arm_monitor_release(timed_out)
        with self.assertRaisesRegex(RuntimeError, 'batch_failed_review_all_started_app_receipts'):
            release.run_release(self.plan, self.execution)
        self.assertEqual(len(self.client.posts), 3)
        self.assertTrue((self.execution / 'monitor-m3.deploy.completed.json').is_file())
        self.assertTrue((self.execution / 'monitor-m3.failed.json').is_file())
        self.assertTrue((self.execution / 'stopped.safe.json').is_file())
        for absent in ('monitor-m3.verified.json', 'monitor-m3.human-review.safe.json', 'result.safe.json', 'final.private.json'):
            self.assertFalse((self.execution / absent).exists(), absent)
        self.assertNotIn('capacity-summary-read', self.events); self.assertNotIn('fleet-final-verified', self.events)
        self.assertEqual(self.observations, []); self.assertEqual(self.fleet.call_count, 1)

    def test_observer_launch_failure_preserves_verified_deployment_and_separate_schedule_failure_receipt(self):
        def fail_launch(*args, **kwargs):
            raise OSError('synthetic process launch failure')
        self.launch.side_effect = lambda name, filename: SimpleNamespace(launch_observer=fail_launch)
        result = release.run_release(self.plan, self.execution)
        self.assertEqual(result['status'], 'deployed-and-verified')
        self.assertEqual(result['observation']['status'], 'schedule-failed')
        saved_result = json.loads((self.execution / 'result.safe.json').read_text())
        saved_observation = json.loads((self.execution / 'observation.safe.json').read_text())
        self.assertEqual(saved_result['status'], 'deployed-and-verified')
        self.assertEqual(saved_observation['status'], 'schedule-failed')
        self.assertNotIn('reason', saved_observation)
        self.assertNotIn('synthetic process launch failure', json.dumps(saved_observation))
        self.assertTrue((self.execution / 'final.private.json').is_file())
        self.assertFalse((self.execution / 'stopped.safe.json').exists())
        self.assertEqual(len(self.client.posts), 6)
        self.assertEqual(self.health.call_count, 2)
        self.assertEqual(self.fleet.call_count, 2)
        self.assertIn('final-monitor', self.events)

    def test_observer_source_failure_records_reason_and_relative_file_without_losing_verified_status(self):
        observer = load('flow_observer_error', ROOT / 'scripts/ops/release_observer.py')

        def fail_launch(*args, **kwargs):
            raise observer.ObserverError('observer_source_group_writable', source='scripts/ops/release_observer.py')

        self.launch.side_effect = lambda name, filename: SimpleNamespace(launch_observer=fail_launch)
        result = release.run_release(self.plan, self.execution)
        self.assertEqual(result['status'], 'deployed-and-verified')
        self.assertEqual(result['observation']['status'], 'schedule-failed')
        self.assertEqual(result['observation']['reason'], 'observer_source_group_writable')
        self.assertEqual(result['observation']['file'], 'scripts/ops/release_observer.py')
        self.assertEqual(result['observation']['errorClass'], 'ObserverError')
        saved_result = json.loads((self.execution / 'result.safe.json').read_text())
        saved_observation = json.loads((self.execution / 'observation.safe.json').read_text())
        self.assertEqual(saved_result['status'], 'deployed-and-verified')
        self.assertNotIn('observation', saved_result)
        self.assertEqual(saved_observation['reason'], 'observer_source_group_writable')
        self.assertEqual(saved_observation['file'], 'scripts/ops/release_observer.py')
        self.assertNotIn(str(self.directory), json.dumps(saved_observation))
        self.assertFalse((self.execution / 'stopped.safe.json').exists())

    def test_ambiguous_provider_failure_stops_before_second_web_and_never_launches_observation(self):
        self.client.fail_app, self.client.fail_endpoint = 'web-mini', 'application.saveDockerProvider'
        with self.assertRaisesRegex(RuntimeError, 'batch_failed'):
            release.run_release(self.plan, self.execution)
        self.assertEqual([(name, endpoint) for name, endpoint, _ in self.client.posts],
            [('web-mini', 'application.saveEnvironment'), ('web-mini', 'application.saveDockerProvider')])
        self.assertEqual(self.client.apps['web-m3'], self.snapshot['apps']['web-m3'])
        self.assertTrue((self.execution / 'web-mini.provider.attempted.json').is_file())
        self.assertFalse((self.execution / 'web-mini.provider.completed.json').exists())
        self.assertTrue((self.execution / 'stopped.safe.json').is_file())
        self.public.assert_not_called(); self.purge.assert_not_called()
        self.assertEqual(self.observations, []); self.assertEqual(self.fleet.call_count, 1)
        with self.assertRaisesRegex(ValueError, 'already_attempted'):
            release.run_release(self.plan, self.execution)
        self.assertEqual(len(self.client.posts), 2)

    def test_runtime_failure_after_accepted_deploy_preserves_receipts_without_second_web_or_observer(self):
        self.health.side_effect = TimeoutError('synthetic runtime readiness not proved')
        with self.assertRaisesRegex(RuntimeError, 'batch_failed'):
            release.run_release(self.plan, self.execution)
        self.assertEqual(len(self.client.posts), 3)
        self.assertEqual({name for name, _, _ in self.client.posts}, {'web-mini'})
        self.assertTrue((self.execution / 'web-mini.deploy.completed.json').is_file())
        self.assertFalse((self.execution / 'web-mini.verified.json').exists())
        self.assertEqual(self.observations, []); self.public.assert_not_called()

    def test_changed_ci_profile_or_image_digest_prevents_every_post(self):
        for change in ('digest', 'profile', 'runAttempt'):
            with self.subTest(change=change):
                self.client.posts.clear(); self.proof = copy.deepcopy(self.plan['readiness'])
                if change == 'digest': self.proof['target']['web'] = release.shared.IMAGE_PREFIX['web'] + 'sha256:' + '0' * 64
                elif change == 'profile': self.proof['profile'] = 'full'
                else: self.proof['runAttempt'] = 2
                with self.assertRaisesRegex(ValueError, 'readiness_changed'):
                    release.run_release(copy.deepcopy(self.plan), self.directory / ('execution-' + change))
                self.assertEqual(self.client.posts, []); self.assertEqual(self.observations, [])
        self.fleet.assert_not_called()

    def test_actual_local_migration_diff_requires_explicit_migration_proof_before_posts(self):
        (self.repo / 'drizzle').mkdir()
        (self.repo / 'drizzle/0100_flow.sql').write_text('select 1;\n')
        self.git('add', '.'); self.git('commit', '-qm', 'database change')
        self.after = self.git('rev-parse', 'HEAD')
        self.target['sha'] = self.after
        self.plan['target'] = self.target
        self.snapshot['target'] = self.target
        self.plan['scope'] = release.impact(self.snapshot, self.after)
        self.assertEqual(self.plan['scope']['mode'], 'full')
        self.proof.update(profile='full', target=copy.deepcopy(self.target))
        self.plan['readiness'] = copy.deepcopy(self.proof)
        self.ready.side_effect = lambda sha, **kwargs: copy.deepcopy(self.proof)
        with self.assertRaisesRegex(ValueError, 'database_changes_require_migration_verified'):
            release.run_release(self.plan, self.execution)
        self.assertEqual(self.client.posts, []); self.assertEqual(self.observations, [])
        self.monitor.assert_not_called()

    def test_changed_scope_rules_fail_real_reclassification_before_posts(self):
        self.plan['scope']['rulesVersion'] = 'different-rules'
        with self.assertRaisesRegex(ValueError, 'deployment_scope_changed'):
            release.run_release(self.plan, self.execution)
        self.assertEqual(self.client.posts, []); self.assertEqual(self.observations, [])
        self.monitor.assert_not_called()

    def test_every_preflight_must_succeed_before_any_post(self):
        stages = [('main', self.main), ('fleet', self.fleet), ('monitor', self.monitor)]
        for name, function in stages:
            with self.subTest(stage=name):
                original = function.side_effect; function.side_effect = ValueError('synthetic preflight refusal')
                try:
                    with self.assertRaises(ValueError):
                        release.run_release(copy.deepcopy(self.plan), self.directory / ('blocked-' + name))
                    self.assertEqual(self.client.posts, []); self.assertEqual(self.observations, [])
                finally: function.side_effect = original
        # This refusal is raised by the actual integration validator, not a stub.
        for data in (self.plan['snapshot']['apps'], self.client.apps):
            data['web-mini']['env'] += 'PUBLIC_USER_AUTH_ENABLED=invalid\n'
        with self.assertRaisesRegex(ValueError, 'PUBLIC_USER_AUTH_ENABLED_invalid'):
            release.run_release(self.plan, self.directory / 'blocked-integration')
        self.assertEqual(self.client.posts, []); self.assertEqual(self.observations, [])

    def carry_retired_setting(self, shorts, line='ABCLLM_API_KEY=synthetic-retired-secret'):
        """Dokploy still saves `line` for these apps and their live specs still render it (no drift)."""
        for short in shorts:
            for data in (self.client.apps, self.snapshot['apps']):
                data[short]['env'] += line + '\n'
            raw = self.snapshot['runtime'][short]
            raw['serviceSpec']['TaskTemplate']['ContainerSpec']['Env'].append(line)
            raw['specHash'] = release.git.spec_hash(raw['serviceSpec'])
            self.snapshot['baseline'][short]['specHash'] = raw['specHash']

    def test_retired_setting_is_deleted_from_the_saved_env_of_each_redeployed_app_and_expected_absent_at_the_end(self):
        retired = ['ABCLLM_API_KEY']
        self.carry_retired_setting(('web-mini', 'web-m3'))
        self.plan.update(retiredSettings=retired, scope=release.impact(self.snapshot, self.after, tuple(retired)))
        self.assertEqual((self.plan['scope']['selectedApps'], self.plan['scope']['retiredSettingCarriers']),
                         (['web-mini', 'web-m3'], ['web-mini', 'web-m3']))
        before = copy.deepcopy(self.snapshot['apps'])
        result = release.run_release(self.plan, self.execution)
        self.assertEqual((result['status'], result['deployedApps'], result['skippedApps'], result['retiredSettings']),
                         ('deployed-and-verified', ['web-mini', 'web-m3'], [], retired))
        self.assertEqual(self.fleet_retired, [(), ('ABCLLM_API_KEY',)])
        for short in ('web-mini', 'web-m3'):
            saved = next(payload for name, endpoint, payload in self.client.posts if name == short and endpoint.endswith('saveEnvironment'))
            self.assertNotIn('ABCLLM_API_KEY', release.shared.dotenv_settings(saved['env']))
            self.assertNotIn('synthetic-retired-secret', saved['env'])
            # Everything but RELEASE_TAG/NEXT_DEPLOYMENT_ID and the retired line is byte-for-byte the original.
            self.assertEqual(saved['env'], release.shared.drop_settings(
                release.fleet.expected_api(short, before[short], self.target)['env'], retired))
            self.assertEqual(saved['buildSecrets'], before[short]['buildSecrets'])
        self.assertEqual(json.loads((self.execution / 'once.json').read_text())['retiredSettings'], retired)
        self.assertEqual(self.events[-1], 'observer-launched')
        # The default plan keeps today's behaviour exactly: no retired kwarg reaches the verifier.
        self.assertEqual(self.fleet_retired[0], ())

    def run_retiring_release_on_carrying_webs(self, retired):
        """The real classifier selects only the two carriers; the run redeploys exactly those and nothing else."""
        self.plan.update(target=self.target, snapshot=self.snapshot, scope=release.impact(self.snapshot, self.after))
        self.assertEqual((self.plan['scope']['selectedApps'], self.plan['scope']['mode']), ([], 'none'))
        self.plan.update(retiredSettings=retired, scope=release.impact(self.snapshot, self.after, tuple(retired)))
        self.assertEqual((self.plan['scope']['selectedApps'], self.plan['scope']['mode']), (['web-mini', 'web-m3'], 'scoped'))
        self.proof.update(target={'sha': self.after, 'web': self.target['web']})
        self.plan['readiness'] = copy.deepcopy(self.proof)
        result = release.run_release(self.plan, self.execution)
        self.assertEqual((result['status'], result['selectedApps'], result['deployedApps'], result['skippedApps']),
                         ('deployed-and-verified', ['web-mini', 'web-m3'], ['web-mini', 'web-m3'], []))
        self.assertEqual([(short, endpoint) for short, endpoint, _ in self.client.posts], [
            (short, endpoint) for short in ('web-mini', 'web-m3') for endpoint in
            ('application.saveEnvironment', 'application.saveDockerProvider', 'application.deploy')])
        for short in ('web-mini', 'web-m3'):
            self.assertNotIn('ABCLLM_API_KEY', release.shared.dotenv_settings(self.client.apps[short]['env']))
            self.assertEqual(release.shared.setting(self.client.apps[short]['env'], 'RELEASE_TAG'), self.after)
        for short in release.fleet.registered_apps():
            if not short.startswith('web-'):
                self.assertEqual(self.client.apps[short], self.snapshot['apps'][short])
        self.assertEqual(self.fleet_retired, [(), tuple(retired)])
        self.assertEqual(len(result['retainedApps']), 16)
        return result

    def test_exact_target_apps_that_still_carry_the_retired_setting_are_redeployed_instead_of_kept(self):
        # Every app already serves the target (a stopped release continued by a fresh plan): the code scope is empty and
        # both webs would be exact-target skips. They still carry ABCLLM_API_KEY, so the retiring release redeploys them.
        self.move_fleet_to(self.after)
        self.snapshot['target'] = copy.deepcopy(self.target)
        self.carry_retired_setting(('web-mini', 'web-m3'))
        retired = ['ABCLLM_API_KEY']
        self.assertEqual(release.already_target(self.snapshot, self.target, ['web-mini', 'web-m3']), ['web-mini', 'web-m3'])
        self.assertEqual(release.already_target(self.snapshot, self.target, ['web-mini', 'web-m3'], tuple(retired)), [])
        self.run_retiring_release_on_carrying_webs(retired)

    def test_docs_only_release_selects_only_the_carriers_and_bumps_their_release_while_retiring(self):
        # The fleet serves the previous commit and the new commit is docs-only, so the code scope is empty. Only the two
        # carriers are selected; they get the new RELEASE_TAG and lose the retired line in one redeploy each.
        self.move_fleet_to(self.after)
        (self.repo / 'docs').mkdir(); (self.repo / 'docs/retire.md').write_text('docs only\n')
        self.git('add', '.'); self.git('commit', '-qm', 'docs only')
        self.after = self.git('rev-parse', 'HEAD')
        self.target['sha'] = self.after
        self.snapshot['target'] = copy.deepcopy(self.target)
        self.carry_retired_setting(('web-mini', 'web-m3'))
        self.run_retiring_release_on_carrying_webs(['ABCLLM_API_KEY'])


    # ---- 2026-11-12: one redeploy after a proven Swarm start race ------------------------------------------------------
    # Dokploy reported the deployment done, the new task failed with "No such container: <service>.<slot>.<task>" and
    # Swarm rolled the service back to the previous spec (reviewer-m3 09-14·11-08·11-10·11-12, monitor-m3 11-12).
    def race(self, short):
        return '?No such container: service-' + short + '.1.ie3yzoot3f934t0g73kqqavak?'

    def arm_rollback_reads(self, short, *, settle=None, proven=True, during_settle=None):
        """Swarm status reads (detection without task errors and the settle wait) and the rolled-back runtime proof."""
        answers = list(settle if settle is not None else
                       [{'updateStatusInspected': True, 'updateState': 'rollback_completed', 'taskErrors': [self.race(short)]}])
        def swarm_status(name, app):
            self.assertEqual((name, app['appName']), (short, 'service-' + short))
            self.events.append((name, 'swarm-status-read'))
            if during_settle: during_settle()
            return copy.deepcopy(answers.pop(0) if len(answers) > 1 else answers[0])
        self.swarm = self.stack.enter_context(patch.object(release.shared, 'swarm_status', side_effect=swarm_status))
        def original(snapshot, name, repo):
            self.assertIs(snapshot, self.plan['snapshot']); self.assertEqual((name, repo), (short, self.repo))
            self.events.append((name, 'rolled-back-runtime-proven' if proven else 'rolled-back-runtime-differs'))
            return proven
        self.original = self.stack.enter_context(patch.object(release.fleet, 'rolled_back_to_original', side_effect=original))
        self.stack.enter_context(patch.object(release.shared.time, 'sleep'))

    def arm_start_race(self, first, *, second=None, before_raise=None, **reads):
        """web-mini's first verification sees a Swarm rollback; the verification after a redeploy passes or sees `second`."""
        self.checks = []
        def check(client, short, target, previous_id, **kwargs):
            self.assertIs(client, self.client); self.assertEqual(target, self.target); self.assertEqual(kwargs, {})
            self.checks.append((short, previous_id, client.latest(short)['deploymentId']))
            attempt = sum(1 for row in self.checks if row[0] == short)
            if short == 'web-mini' and attempt == 1:
                if before_raise: before_raise()
                raise release.shared.SwarmRollback(short, first)
            if short == 'web-mini' and second is not None:
                raise release.shared.SwarmRollback(short, second)
            return self.record((short, 'runtime-verified'), {'ready': True})
        self.health.side_effect = check
        self.arm_rollback_reads('web-mini', **reads)

    def posts_of(self, short):
        return [endpoint for name, endpoint, _ in self.client.posts if name == short]

    def assert_stopped_without_redeploy(self, reason, message, rollback=None):
        with self.assertRaisesRegex(RuntimeError, 'batch_failed_review_all_started_app_receipts') as raised:
            release.run_release(self.plan, self.execution)
        # Exactly today's stop: the original Swarm rollback ends the batch, nothing is requested again.
        self.assertIsInstance(raised.exception.__cause__, rollback or release.shared.SwarmRollback)
        self.assertEqual(str(raised.exception.__cause__), message)
        short = message.split('_swarm_')[0]
        self.assertEqual(self.posts_of(short), ['application.saveEnvironment', 'application.saveDockerProvider', 'application.deploy'])
        self.assertEqual({name for name, _, _ in self.client.posts}, {short})
        record = json.loads((self.execution / (short + '.swarm-rollback.safe.json')).read_text())
        self.assertEqual((record['app'], record['decision'], record['reason']), (short, 'stop', reason))
        for absent in (short + '.redeploy.attempted.json', short + '.verified.json', 'result.safe.json', 'final.private.json'):
            self.assertFalse((self.execution / absent).exists(), absent)
        self.assertTrue((self.execution / (short + '.failed.json')).is_file())
        self.assertEqual(json.loads((self.execution / 'stopped.safe.json').read_text())['swarmRedeploys'], {'count': 0, 'apps': []})
        self.assertEqual(self.observations, []); self.public.assert_not_called()
        return record

    def test_a_proven_swarm_start_race_is_redeployed_once_with_the_same_saved_config_and_verified_again(self):
        race = self.race('web-mini')
        self.arm_start_race({'ready': False, 'updateState': 'rollback_started', 'taskErrors': [race], 'serviceImageMatch': False},
                            settle=[{'updateStatusInspected': True, 'updateState': 'rollback_started', 'taskErrors': [race]},
                                    {'updateStatusInspected': True, 'updateState': 'rollback_completed', 'taskErrors': [race]}])
        result = release.run_release(self.plan, self.execution)
        self.assertEqual(result['status'], 'deployed-and-verified')
        self.assertEqual(result['swarmRedeploys'], {'count': 1, 'apps': ['web-mini']})
        self.assertEqual(self.posts_of('web-mini'), ['application.saveEnvironment', 'application.saveDockerProvider',
                                                     'application.deploy', 'application.deploy'])
        self.assertEqual(self.posts_of('web-m3'), ['application.saveEnvironment', 'application.saveDockerProvider', 'application.deploy'])
        # The same saved config is deployed again: no setting is written between the two deploy requests.
        deploys = [payload for name, endpoint, payload in self.client.posts if name == 'web-mini' and endpoint == 'application.deploy']
        self.assertEqual(deploys[0], deploys[1])
        # The second verification waits for a deployment newer than the rolled-back one.
        self.assertEqual(self.checks, [('web-mini', 'old-web-mini', 'new-web-mini'), ('web-mini', 'new-web-mini', 'new-web-mini-2'),
                                       ('web-m3', 'old-web-m3', 'new-web-m3')])
        redeploy = [index for index, event in enumerate(self.events) if event == ('web-mini', 'application.deploy')][1]
        self.assertEqual(self.events[:redeploy].count(('web-mini', 'swarm-status-read')), 2)  # waited for rollback_completed
        self.assertLess(self.events.index(('web-mini', 'rolled-back-runtime-proven')), redeploy)
        # Model admission is re-read before the redeploy, like before every replacement batch.
        self.assertEqual([list(call.args[1]) for call in self.model_drain.call_args_list],
                         [['web-mini', 'web-m3'], ['web-mini'], ['web-mini'], ['web-m3']])
        record = json.loads((self.execution / 'web-mini.swarm-rollback.safe.json').read_text())
        self.assertEqual((record['decision'], record['reason'], record['rolledBackDeploymentId'], record['maxRedeploys']),
                         ('redeploy_once', 'swarm_start_race', 'new-web-mini', 1))
        self.assertEqual(record['detected'], {'updateState': 'rollback_started', 'taskErrors': [race]})
        self.assertEqual(record['settled'], {'updateState': 'rollback_completed', 'taskErrors': [race]})
        self.assertEqual(record['checks'], {'swarmRolledBack': True, 'startRace': True, 'deploymentDone': True, 'rollbackSettled': True,
                                            'runtimeIsOriginal': True, 'savedConfigIsTarget': True, 'modelDrain': True})
        for name in ('web-mini.redeploy-model-drain.safe.json', 'web-mini.redeploy.attempted.json', 'web-mini.redeploy.completed.json'):
            self.assertTrue((self.execution / name).is_file(), name)
        self.assertEqual(json.loads((self.execution / 'web-mini.redeploy.attempted.json').read_text())['action'], 'application.deploy')
        verified = json.loads((self.execution / 'web-mini.verified.json').read_text())
        self.assertEqual((verified['deploymentId'], verified['swarmRedeploys']), ('new-web-mini-2', 1))
        self.assertEqual(json.loads((self.execution / 'web-m3.verified.json').read_text())['swarmRedeploys'], 0)
        self.assertEqual(json.loads((self.execution / 'result.safe.json').read_text())['swarmRedeploys'],
                         {'count': 1, 'apps': ['web-mini']})
        self.assertFalse((self.execution / 'web-mini.swarm-rollback-repeated.safe.json').exists())
        self.assertEqual(self.events[-1], 'observer-launched')

    def test_a_second_rollback_after_the_single_redeploy_stops_the_release(self):
        race = self.race('web-mini')
        self.arm_start_race({'updateState': 'rollback_completed', 'taskErrors': [race]},
                            second={'updateState': 'rollback_completed', 'taskErrors': [race]})
        with self.assertRaisesRegex(RuntimeError, 'batch_failed_review_all_started_app_receipts') as raised:
            release.run_release(self.plan, self.execution)
        self.assertIsInstance(raised.exception.__cause__, release.shared.ReleaseStopped)
        self.assertEqual(str(raised.exception.__cause__), 'web-mini_swarm_rollback_repeated:task_error=' + race)
        self.assertEqual(self.posts_of('web-mini').count('application.deploy'), 2)
        self.assertEqual({name for name, _, _ in self.client.posts}, {'web-mini'})
        self.assertEqual(len(self.checks), 2)
        repeated = json.loads((self.execution / 'web-mini.swarm-rollback-repeated.safe.json').read_text())
        self.assertEqual((repeated['decision'], repeated['reason'], repeated['detected']),
                         ('stop', 'swarm_rollback_repeated', {'updateState': 'rollback_completed', 'taskErrors': [race]}))
        self.assertEqual(json.loads((self.execution / 'stopped.safe.json').read_text())['swarmRedeploys'],
                         {'count': 1, 'apps': ['web-mini']})
        self.assertTrue((self.execution / 'web-mini.redeploy.completed.json').is_file())
        self.assertTrue((self.execution / 'web-mini.failed.json').is_file())
        for absent in ('web-mini.verified.json', 'result.safe.json'):
            self.assertFalse((self.execution / absent).exists(), absent)
        self.assertEqual(self.observations, []); self.public.assert_not_called()

    def test_a_paused_update_stops_without_waiting_or_a_redeploy(self):
        self.arm_start_race({'updateState': 'paused', 'updateMessage': 'update paused due to failure'})
        self.assert_stopped_without_redeploy('swarm_update_paused', 'web-mini_swarm_paused:message=update paused due to failure')
        self.swarm.assert_not_called(); self.original.assert_not_called()

    def test_a_rollback_that_pauses_while_settling_stops_without_a_redeploy(self):
        race = self.race('web-mini')
        self.arm_start_race({'updateState': 'rollback_started', 'taskErrors': [race]},
                            settle=[{'updateState': 'rollback_started', 'taskErrors': [race]},
                                    {'updateState': 'rollback_paused', 'taskErrors': [race]}])
        record = self.assert_stopped_without_redeploy('rollback_not_settled', 'web-mini_swarm_rollback_started:task_error=' + race)
        self.assertEqual(self.swarm.call_count, 2); self.original.assert_not_called()
        self.assertFalse(record['checks']['rollbackSettled'])

    def test_any_other_task_error_stops_without_a_redeploy(self):
        self.arm_start_race({'updateState': 'rollback_completed', 'taskErrors': ['task: non-zero exit (1)', self.race('web-mini')]})
        record = self.assert_stopped_without_redeploy('task_error_not_start_race',
                                                      'web-mini_swarm_rollback_completed:task_error=task: non-zero exit (1)')
        self.swarm.assert_not_called(); self.original.assert_not_called()
        self.assertFalse(record['checks']['startRace'])

    def test_a_start_race_naming_another_service_or_a_changed_error_after_settling_stops(self):
        race = self.race('web-mini')
        self.arm_start_race({'updateState': 'rollback_started', 'taskErrors': [race]},
                            settle=[{'updateState': 'rollback_completed', 'taskErrors': ['task: non-zero exit (137)', race]}])
        self.assert_stopped_without_redeploy('task_error_not_start_race', 'web-mini_swarm_rollback_started:task_error=' + race)
        self.original.assert_not_called()

    def test_saved_config_drift_during_the_rollback_stops_without_a_redeploy(self):
        race = self.race('web-mini')
        def operator_saved_other_settings():
            self.client.apps['web-mini']['env'] += 'OPERATOR_CHANGE=1\n'
        self.arm_start_race({'updateState': 'rollback_completed', 'taskErrors': [race]}, before_raise=operator_saved_other_settings)
        record = self.assert_stopped_without_redeploy('saved_configuration_not_target',
                                                      'web-mini_swarm_rollback_completed:task_error=' + race)
        self.assertEqual((record['checks']['runtimeIsOriginal'], record['checks']['savedConfigIsTarget']), (True, False))

    def test_a_runtime_not_proven_to_be_the_original_release_stops_without_a_redeploy(self):
        race = self.race('web-mini')
        self.arm_start_race({'updateState': 'rollback_completed', 'taskErrors': [race]}, proven=False)
        record = self.assert_stopped_without_redeploy('runtime_not_original_release',
                                                      'web-mini_swarm_rollback_completed:task_error=' + race)
        self.assertFalse(record['checks']['runtimeIsOriginal'])

    def test_another_deployment_during_the_rollback_stops_without_a_redeploy(self):
        race = self.race('web-mini')
        def operator_deployed():
            self.client.deployments['web-mini'] = {'status': 'done', 'deploymentId': 'operator-web-mini'}
        self.arm_start_race({'updateState': 'rollback_started', 'taskErrors': [race]}, during_settle=operator_deployed)
        self.assert_stopped_without_redeploy('deployment_changed_during_rollback', 'web-mini_swarm_rollback_started:task_error=' + race)

    def test_reopened_model_admission_before_the_redeploy_stops_without_a_redeploy(self):
        race = self.race('web-mini')
        self.model_drain.side_effect = [{'required': True}, {'required': True},
                                        ValueError('model_replacement_requires_explicit_drain_and_zero_active_calls')]
        self.arm_start_race({'updateState': 'rollback_completed', 'taskErrors': [race]})
        record = self.assert_stopped_without_redeploy('model_drain_not_proven', 'web-mini_swarm_rollback_completed:task_error=' + race)
        self.assertEqual((record['checks']['savedConfigIsTarget'], record['checks']['modelDrain']), (True, False))

    def test_a_monitor_start_race_rollback_is_redeployed_once_and_verified_again(self):
        calls = []
        def check(client, short, target, original, old_id, manifest, *, expected_runtime, **kwargs):
            self.assertEqual(kwargs, {}); self.assertEqual(expected_runtime, self.snapshot['runtime'][short])
            calls.append((old_id, client.latest(short)['deploymentId']))
            if len(calls) == 1:
                # The monitor verifier only sees the service UpdateStatus; it reads no task errors itself.
                raise monitor_module.git.shared.SwarmRollback(short, {'updateState': 'rollback_completed'})
            self.events.append(('monitor-m3', 'push-verified'))
            return {'app': short, 'deploymentId': client.latest(short)['deploymentId'], 'deployment': 'done', 'service': 'healthy',
                    'pushReceipts': {'primary': True, 'external': True}}
        monitor_module = self.arm_monitor_release(check)
        self.arm_rollback_reads('monitor-m3')
        result = release.run_release(self.plan, self.execution)
        self.assertEqual((result['status'], result['deployedApps']), ('deployed-and-verified', ['monitor-m3']))
        self.assertEqual(result['swarmRedeploys'], {'count': 1, 'apps': ['monitor-m3']})
        self.assertEqual(self.posts_of('monitor-m3'), ['application.saveEnvironment', 'application.saveDockerProvider',
                                                       'application.deploy', 'application.deploy'])
        self.assertEqual(calls, [('old-monitor-m3', 'new-monitor-m3'), ('new-monitor-m3', 'new-monitor-m3-2')])
        # One read for the task error the verifier lacks, one for the settled rollback; never shared.probe.
        self.assertEqual(self.swarm.call_count, 2)
        record = json.loads((self.execution / 'monitor-m3.swarm-rollback.safe.json').read_text())
        self.assertEqual((record['decision'], record['reason'], record['rolledBackDeploymentId']),
                         ('redeploy_once', 'swarm_start_race', 'new-monitor-m3'))
        self.assertEqual(record['detected'], {'updateState': 'rollback_completed', 'taskErrors': [self.race('monitor-m3')]})
        verified = json.loads((self.execution / 'monitor-m3.verified.json').read_text())
        self.assertEqual((verified['deploymentId'], verified['swarmRedeploys']), ('new-monitor-m3-2', 1))
        self.assertEqual(self.final_receipts[0]['deploymentId'], 'new-monitor-m3-2')
        self.assertTrue((self.execution / 'monitor-m3.redeploy.completed.json').is_file())
        self.assertEqual(self.events[-1], 'observer-launched')

    def test_a_paused_monitor_update_stops_without_a_redeploy(self):
        def check(client, short, target, original, old_id, manifest, *, expected_runtime, **kwargs):
            raise monitor_module.git.shared.SwarmRollback(short, {'updateState': 'paused'})
        monitor_module = self.arm_monitor_release(check)
        self.arm_rollback_reads('monitor-m3')
        self.checks = []
        self.assert_stopped_without_redeploy('swarm_update_paused', 'monitor-m3_swarm_paused',
                                             rollback=monitor_module.git.shared.SwarmRollback)
        self.swarm.assert_not_called(); self.original.assert_not_called()


if __name__ == '__main__': unittest.main()
