"""Exercise the real release coordinator with local Git and a stateful fake API.

SSH/health, hosted CI and background process launch are external boundaries. No
production, credential, model or network calls are permitted in these tests.
"""
import copy
import importlib.util
import json
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
            self.deployments[short] = {'status': 'done', 'deploymentId': 'new-' + short}
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
        self.fleet = self.stack.enter_context(patch.object(release.fleet, 'verify_fleet', side_effect=self.verify_fleet))
        self.stack.enter_context(patch.object(release.shared, 'run', side_effect=self.local_transport))
        self.stack.enter_context(patch.object(release.shared, 'ssh_python', side_effect=AssertionError('unexpected SSH')) )
        self.stack.enter_context(patch.object(release.git.shared, 'ssh_python', side_effect=AssertionError('unexpected Git rollout SSH')))
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

    def verify_fleet(self, client, snapshot, target, selected, receipts, repo, *, output_snapshot=None):
        self.assertIs(client, self.client); self.assertEqual(repo, self.repo); self.assertEqual(target, self.target)
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
        self.assertEqual([(short, endpoint) for short, endpoint, _ in self.client.posts], [
            (short, endpoint) for short in ('web-mini', 'web-m3') for endpoint in
            ('application.saveEnvironment', 'application.saveDockerProvider', 'application.deploy')])
        self.assertEqual(self.health.call_count, 2)
        self.assertLess(self.events.index(('web-mini', 'runtime-verified')), self.events.index(('web-m3', 'application.saveEnvironment')))
        self.assertLess(self.events.index('preflight-monitor'), self.events.index(('web-mini', 'application.saveEnvironment')))
        self.assertEqual(self.events[-1], 'observer-launched')
        self.assertEqual(self.fleet.call_count, 2)
        self.assertEqual(len(result['retainedApps']), 15)
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
        self.assertTrue((self.execution / 'final.private.json').is_file())
        self.assertFalse((self.execution / 'stopped.safe.json').exists())
        self.assertEqual(len(self.client.posts), 6)
        self.assertEqual(self.health.call_count, 2)
        self.assertEqual(self.fleet.call_count, 2)
        self.assertIn('final-monitor', self.events)

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


if __name__ == '__main__': unittest.main()
