"""Full-fleet runtime proofs; fixtures contain intentionally synthetic secrets only."""
import copy
import hashlib
import importlib.util
import io
import json
import threading
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('release_runtime', ROOT / 'scripts/ops/release_runtime.py')
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
OLD, NEW = 'a' * 40, 'b' * 40
OLD_TREE, NEW_TREE = 'c' * 40, 'd' * 40
IMAGE_ID = 'sha256:' + 'e' * 64
NEW_ID = 'sha256:' + 'f' * 64
TARGET = {'sha': NEW, 'worker': runtime.shared.IMAGE_PREFIX['worker'] + NEW_ID,
          'web': runtime.shared.IMAGE_PREFIX['web'] + NEW_ID}
MANIFEST = {sha: {'package-lock.json': hashlib.sha256(sha.encode()).hexdigest()} for sha in (OLD, NEW)}
WEB_HEALTH = {'Test': ['CMD-SHELL', 'node -e "fetch(\'http://\'+(process.env.HOSTNAME||\'127.0.0.1\')+\':3000/api/live\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
              'Interval': 30000000000, 'Timeout': 5000000000, 'StartPeriod': 60000000000, 'Retries': 3}


def fixture():
    apps, rows, latest = {}, {}, {}
    for short in runtime.registered_apps():
        identity, name, host, kind = runtime.shared.app_metadata(short)
        role = runtime.shared.app_role(short)
        if kind == 'web':
            command = None
            entry, cmd = ['docker-entrypoint.sh'], ['./scripts/entrypoint.sh']
        elif kind == 'connect-agent':
            command = None
            entry, cmd = ['/sbin/tini', '--'], ['node', '--import', 'tsx', 'scripts/connect-agent.ts']
        elif kind == 'monitor':
            entry = ['/sbin/tini', '--', 'node', '--import', 'tsx', 'scripts/watch-failover-readiness.ts']
            command, cmd = ' '.join(entry), None
        else:
            argv = ['node', '--import', 'tsx', 'scripts/worker-supervisor.ts', '--role=' + role]
            if '-consumer-' in short:
                argv += ['--consumer=' + short.rsplit('-consumer-', 1)[0]]
            elif role in ('text', 'maintenance'):
                argv[3] = 'scripts/role-worker.ts'
                argv += ['--kind=' + ('standby' if short.endswith('-mini') else 'primary')]
            entry, cmd = ['/sbin/tini', '--', *argv], None
            command = ' '.join(entry)
        github = short in runtime.git_rollout.ORDER
        stage = 'runner' if kind == 'web' else kind if kind in ('monitor', 'connect-agent') else 'worker'
        env = ['RELEASE_TAG=' + OLD, 'SECRET=synthetic-secret', 'CUSTOM_FLAG=16', 'AI2_GRACE_MS=11000']
        if kind != 'web': env += ['WORKER_ROLE=' + role]
        if kind == 'web': env += ['NEXT_DEPLOYMENT_ID=' + OLD, 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=synthetic-key']
        image = runtime.shared.IMAGE_PREFIX['web' if kind == 'web' else 'worker'] + IMAGE_ID
        app = {'applicationId': identity, 'name': name, 'serverId': host[0], 'appName': 'service-' + short,
               'sourceType': 'github' if github else 'docker', 'dockerImage': None if github else image,
               'dockerBuildStage': stage, 'applicationStatus': 'done', 'autoDeploy': False,
               'replicas': 2 if short == 'scheduler-m3' else 1, 'command': command,
               'env': '\n'.join(env) + '\n', 'buildArgs': 'NEXT_DEPLOYMENT_ID=' + OLD + '\n' if kind == 'web' else '',
               'buildSecrets': 'NEXT_SERVER_ACTIONS_ENCRYPTION_KEY=synthetic-key\n' if kind == 'web' else '',
               'owner': 'JRVector9', 'repository': 'nomorevibe', 'branch': 'main', 'buildType': 'dockerfile',
               'dockerfile': 'Dockerfile', 'buildPath': '/', 'mounts': [{'source': '/private/data', 'target': '/state'}]}
        service_image = app['dockerImage'] or app['appName'] + ':latest'
        health = None if kind == 'web' else {'Test': ['CMD-SHELL', 'node --import tsx scripts/' + (
            'monitor-healthcheck.ts' if kind == 'monitor' else 'worker-healthcheck.ts')]}
        if kind == 'connect-agent': health = {'Test': ['CMD-SHELL', 'fetch http://127.0.0.1:3020/rpc status 401']}
        image_config = {'Env': ['NODE_ENV=production'], 'Entrypoint': ['/sbin/tini', '--'] if kind != 'web' else entry,
                        'Cmd': ['node', '--import', 'tsx', 'scripts/connect-agent.ts'] if kind == 'connect-agent' else cmd,
                        'Healthcheck': health, 'Labels': {'org.opencontainers.image.revision': OLD, 'dev.nomorevibe.tree': OLD_TREE}}
        spec = {'Name': app['appName'], 'Mode': {'Replicated': {'Replicas': app['replicas']}},
                'TaskTemplate': {'ContainerSpec': {'Image': service_image, 'Env': env,
                    'Mounts': [{'Type': 'bind', 'Source': '/private/data', 'Target': '/state', 'ReadOnly': False}]},
                    'ForceUpdate': 0, 'Resources': {'Limits': {'MemoryBytes': 134217728}}},
                'UpdateConfig': {'Parallelism': 1}}
        containers = []
        for index in range(app['replicas']):
            row = {'id': short + '-' + str(index), 'image': IMAGE_ID,
                   'config': {'Env': ['NODE_ENV=production', *env], 'Image': service_image,
                       'Entrypoint': entry, 'Cmd': cmd, 'Healthcheck': health, 'User': 'worker', 'WorkingDir': '/app',
                       'Labels': {**image_config['Labels'], 'com.docker.swarm.service.name': app['appName']}},
                   'mounts': [{'Type': 'bind', 'Source': '/private/data', 'Destination': '/state', 'RW': True}],
                   'state': {'Running': True, 'Health': {'Status': 'healthy'}}}
            if kind == 'web': row['directHealth'] = {'status': 200, 'body': {'status': 'ok', 'db': 'ok', 'release': OLD}}
            else: row['codeHashes'] = copy.deepcopy(MANIFEST[OLD])
            containers.append(row)
        rows[short] = {'serviceId': short, 'version': {'Index': 1}, 'updateStatus': {'State': 'completed'},
                       'serviceSpec': spec, 'specHash': runtime.git_rollout.spec_hash(spec),
                       'containers': containers, 'images': [{'Id': IMAGE_ID, 'RepoDigests': [service_image] if not github else [],
                                                            'Config': image_config}]}
        apps[short], latest[short] = app, {'status': 'done', 'deploymentId': 'old-' + short}
    return apps, rows, latest


class Client:
    def __init__(self): self.apps, self.rows, self.deployments = fixture()
    def app(self, short): return copy.deepcopy(self.apps[short])
    def latest(self, short): return copy.deepcopy(self.deployments[short])


class RuntimeProofTests(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.inspect = patch.object(runtime.git_rollout, 'inspect_runtime', side_effect=lambda short, app, **_: copy.deepcopy(self.client.rows[short]))
        self.manifest = patch.object(runtime.git_rollout, 'source_manifest', side_effect=lambda sha, **_: MANIFEST[sha])
        self.tree = patch.object(runtime, 'git_tree', side_effect=lambda repo, sha: OLD_TREE if sha == OLD else NEW_TREE)
        self.inspect.start(); self.manifest.start(); self.tree.start()
        self.addCleanup(self.inspect.stop); self.addCleanup(self.manifest.stop); self.addCleanup(self.tree.stop)

    def collect(self): return runtime.collect_baseline(self.client, ROOT)

    def select(self, selected):
        receipts = {}
        for short in selected:
            app = self.client.apps[short]
            kind = runtime.shared.app_metadata(short)[3]
            app['env'] = app['env'].replace('RELEASE_TAG=' + OLD, 'RELEASE_TAG=' + NEW)
            if kind == 'web':
                app['env'] = app['env'].replace('NEXT_DEPLOYMENT_ID=' + OLD, 'NEXT_DEPLOYMENT_ID=' + NEW)
                app['buildArgs'] = app['buildArgs'].replace(OLD, NEW)
            if kind != 'connect-agent': app.update(sourceType='docker', dockerImage=TARGET['web' if kind == 'web' else 'worker'])
            else: app['buildArgs'] += 'NMV_SOURCE_SHA=' + NEW + '\n'
            row = self.client.rows[short]
            spec = row['serviceSpec']; spec['TaskTemplate']['ForceUpdate'] += 1
            cs = spec['TaskTemplate']['ContainerSpec']
            cs['Env'] = [value.replace(OLD, NEW) if value.startswith(('RELEASE_TAG=', 'NEXT_DEPLOYMENT_ID=')) else value for value in cs['Env']]
            cs['Image'] = app['dockerImage'] or app['appName'] + ':new'
            row['version']['Index'] += 1
            row['specHash'] = runtime.git_rollout.spec_hash(spec)
            row['images'][0]['Id'] = NEW_ID
            row['images'][0]['RepoDigests'] = [cs['Image']] if app['sourceType'] == 'docker' else []
            row['images'][0]['Config']['Labels'].update({'org.opencontainers.image.revision': NEW, 'dev.nomorevibe.tree': NEW_TREE})
            for container in row['containers']:
                container['image'] = NEW_ID; container['config']['Image'] = cs['Image']
                container['config']['Env'] = ['NODE_ENV=production', *cs['Env']]
                container['config']['Labels'].update({'org.opencontainers.image.revision': NEW, 'dev.nomorevibe.tree': NEW_TREE})
                if kind == 'web': container['directHealth']['body']['release'] = NEW
                else: container['codeHashes'] = copy.deepcopy(MANIFEST[NEW])
            self.client.deployments[short]['deploymentId'] = 'new-' + short
            receipts[short] = {'deploymentId': 'new-' + short}
        return receipts

    def test_collect_proves_all_18_without_printing_or_mutating_private_originals(self):
        before = copy.deepcopy(self.client.apps)
        output = io.StringIO()
        with redirect_stdout(output): result = self.collect()
        self.assertEqual(output.getvalue(), '')
        self.assertEqual(len(result['baseline']), 18)
        self.assertEqual(result['apps'], before)
        self.assertEqual(self.client.apps, before)
        self.assertEqual(result['baseline']['connect-agent-m3']['image'], IMAGE_ID)
        self.assertEqual(result['baseline']['scheduler-m3']['release'], OLD)
        self.assertEqual(result['baseline']['scheduler-mini']['release'], OLD)

    def test_baseline_refuses_unknown_status_replica_release_source_health_command_and_mount(self):
        mutations = [lambda: self.client.apps['scheduler-m3'].update(replicas=1),
            lambda: self.client.apps['scheduler-mini'].update(replicas=2),
            lambda: self.client.apps['text-mini'].update(autoDeploy=True),
            lambda: self.client.deployments['text-mini'].update(status='running'),
            lambda: self.client.rows['text-mini']['containers'][0]['codeHashes'].update({'package-lock.json': '0' * 64}),
            lambda: self.client.rows['text-mini']['containers'][0]['config'].update(Entrypoint=['true']),
            lambda: self.client.rows['text-mini']['containers'][0]['mounts'][0].update(Source='/another'),
            lambda: self.client.rows['web-mini']['containers'][0]['directHealth'].update(status=503),
            lambda: self.client.rows['web-mini']['images'][0]['Config']['Labels'].update({'org.opencontainers.image.revision': NEW}),
            lambda: self.client.rows['web-mini']['containers'][0]['config']['Env'].append('RELEASE_TAG=' + NEW)]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                self.client = Client(); mutate()
                with self.assertRaises(ValueError): self.collect()

    def test_collect_refuses_runtime_drift_across_the_inventory_window(self):
        count = 0
        def moving(short, app, **_):
            nonlocal count
            count += 1
            row = copy.deepcopy(self.client.rows[short])
            if count > len(self.client.apps): row['version']['Index'] += 1
            return row
        with patch.object(runtime.git_rollout, 'inspect_runtime', side_effect=moving):
            with self.assertRaisesRegex(ValueError, 'changed_during_collection'): self.collect()

    def test_final_proves_scoped_and_retained_apps_at_their_own_versions(self):
        baseline = self.collect(); baseline['target'] = TARGET
        selected = ['web-mini', 'web-m3', 'text-mini', 'text-m3', 'scheduler-m3', 'connect-agent-m3', 'monitor-m3']
        receipts = self.select(selected)
        before = copy.deepcopy(baseline)
        observed = runtime.verify_fleet(self.client, baseline, TARGET, selected, receipts, ROOT)
        self.assertEqual(observed['web-mini']['release'], NEW)
        self.assertEqual(observed['reviewer-m3'], baseline['baseline']['reviewer-m3'])
        self.assertEqual(observed['connect-agent-m3']['image'], NEW_ID)
        self.assertEqual(baseline, before)
        self.assertNotIn('synthetic-secret', json.dumps(observed))

    def web_health_transition(self):
        baseline = self.collect(); baseline['target'] = TARGET
        receipts = self.select(['web-mini', 'web-m3'])
        for short in ('web-mini', 'web-m3'):
            row = self.client.rows[short]
            row['images'][0]['Config']['Healthcheck'] = copy.deepcopy(WEB_HEALTH)
            for container in row['containers']: container['config']['Healthcheck'] = copy.deepcopy(WEB_HEALTH)
        return baseline, receipts

    def test_selected_web_may_inherit_health_only_from_the_verified_target_image(self):
        baseline, receipts = self.web_health_transition()
        before = copy.deepcopy(baseline)
        observed = runtime.verify_fleet(self.client, baseline, TARGET, ['web-mini', 'web-m3'], receipts, ROOT)
        self.assertEqual(observed['web-mini']['release'], NEW)
        self.assertEqual(baseline, before)
        old, new = baseline['runtime']['web-mini'], self.client.rows['web-mini']
        self.assertFalse(runtime.git_rollout.runtime_contract_matches(old, new, NEW, deployment_id=NEW))
        self.assertFalse(runtime._preserves_containers(old, new, NEW, 'web'))

    def test_inherited_web_health_rejects_overrides_forged_images_missing_health_and_other_drift(self):
        baseline, _ = self.web_health_transition()
        original, current = baseline['runtime']['web-mini'], self.client.rows['web-mini']
        def service(row): return row['serviceSpec']['TaskTemplate']['ContainerSpec']
        def config(row): return row['containers'][0]['config']
        def image(row): return row['images'][0]
        mutations = [
            ('service override', lambda old, new: service(new).update(Healthcheck=WEB_HEALTH)),
            ('unchanged explicit null override', lambda old, new: (service(old).update(Healthcheck=None), service(new).update(Healthcheck=None))),
            ('old image already had health', lambda old, new: image(old)['Config'].update(Healthcheck=WEB_HEALTH)),
            ('arbitrary actual health', lambda old, new: config(new).update(Healthcheck={'Test': ['CMD', 'true']})),
            ('missing image health', lambda old, new: image(new)['Config'].pop('Healthcheck')),
            ('disabled image health', lambda old, new: (image(new)['Config'].update(Healthcheck={'Test': ['NONE']}), config(new).update(Healthcheck={'Test': ['NONE']}))),
            ('wrong target reference', lambda old, new: (service(new).update(Image=TARGET['worker']), config(new).update(Image=TARGET['worker']), image(new).update(RepoDigests=[TARGET['worker']]))),
            ('forged config image', lambda old, new: config(new).update(Image=service(old)['Image'])),
            ('unlinked image id', lambda old, new: image(new).update(Id=IMAGE_ID)),
            ('unlinked image digest', lambda old, new: image(new).update(RepoDigests=[service(old)['Image']])),
            ('unlinked old image digest', lambda old, new: image(old).update(RepoDigests=[])),
            ('duplicate image metadata', lambda old, new: new['images'].append(copy.deepcopy(image(new)))),
            ('wrong image revision', lambda old, new: image(new)['Config']['Labels'].update({'org.opencontainers.image.revision': OLD})),
            ('wrong old image revision', lambda old, new: image(old)['Config']['Labels'].update({'org.opencontainers.image.revision': NEW})),
            ('missing image tree', lambda old, new: image(new)['Config']['Labels'].pop('dev.nomorevibe.tree')),
            ('forged container revision', lambda old, new: config(new)['Labels'].update({'org.opencontainers.image.revision': OLD})),
            ('command drift', lambda old, new: config(new).update(Cmd=['true'])),
            ('entrypoint drift', lambda old, new: config(new).update(Entrypoint=['true'])),
            ('user drift', lambda old, new: config(new).update(User='root'))]
        for name, mutate in mutations:
            old, new = copy.deepcopy(original), copy.deepcopy(current); mutate(old, new)
            with self.subTest(name=name):
                self.assertFalse(runtime.git_rollout.runtime_contract_matches(old, new, NEW, deployment_id=NEW, web_image=TARGET['web']))
                self.assertFalse(runtime._preserves_containers(old, new, NEW, 'web', web_image=TARGET['web']))
        for field, value in (('Env', ['RELEASE_TAG=' + NEW]), ('Mounts', []), ('Args', ['true'])):
            old, new = copy.deepcopy(original), copy.deepcopy(current); service(new)[field] = value
            with self.subTest(service_field=field):
                self.assertFalse(runtime.git_rollout.runtime_contract_matches(old, new, NEW, deployment_id=NEW, web_image=TARGET['web']))
        for mutate in (lambda row: config(row)['Env'].append('UNAPPROVED=1'),
                       lambda row: row['containers'][0]['mounts'][0].update(Source='/elsewhere'),
                       lambda row: config(row).update(Volumes={'/elsewhere': {}})):
            new = copy.deepcopy(current); mutate(new)
            with self.subTest(container_drift=mutate):
                self.assertFalse(runtime._preserves_containers(original, new, NEW, 'web', web_image=TARGET['web']))
        self.assertFalse(runtime._preserves_containers(original, current, NEW, 'connect-agent', web_image=TARGET['web']))

    def test_final_checks_effective_web_health_against_its_actual_image_and_docker_health(self):
        mutations = [lambda old, new: old['containers'][0]['config'].update(Healthcheck=WEB_HEALTH),
            lambda old, new: new['containers'][0]['config'].pop('Healthcheck'),
            lambda old, new: new['containers'][0]['state'].pop('Health'),
            lambda old, new: new['containers'][0]['state']['Health'].update(Status='unhealthy'),
            lambda old, new: (new['images'][0]['Config']['Labels'].update({'dev.nomorevibe.tree': OLD_TREE}),
                             new['containers'][0]['config']['Labels'].update({'dev.nomorevibe.tree': OLD_TREE}))]
        for mutate in mutations:
            self.client = Client(); baseline, receipts = self.web_health_transition()
            mutate(baseline['runtime']['web-mini'], self.client.rows['web-mini'])
            with self.subTest(mutation=mutate), self.assertRaisesRegex(ValueError, 'web_provenance_or_health_mismatch'):
                runtime.verify_fleet(self.client, baseline, TARGET, ['web-mini', 'web-m3'], receipts, ROOT)

    def test_final_refuses_retained_drift_and_unapproved_selected_changes(self):
        mutations = [lambda: self.client.apps['publisher-mini'].update(command='true'),
            lambda: self.client.deployments['publisher-mini'].update(deploymentId='unexpected'),
            lambda: self.client.rows['publisher-mini']['serviceSpec']['TaskTemplate'].update(ForceUpdate=1),
            lambda: self.client.rows['web-mini']['serviceSpec']['TaskTemplate']['Resources']['Limits'].update(MemoryBytes=1),
            lambda: self.client.rows['web-mini']['containers'][0]['config']['Env'].append('NEW_SECRET=hidden'),
            lambda: self.client.rows['web-mini']['containers'][0]['mounts'][0].update(Source='/elsewhere'),
            lambda: self.client.rows['web-mini']['containers'][0]['config'].update(Cmd=['true'])]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                self.client = Client(); baseline = self.collect(); baseline['target'] = TARGET
                receipts = self.select(['web-mini', 'web-m3']); mutate()
                # Keep hash internally consistent: the proof must inspect the contract, not trust a hash alone.
                for row in self.client.rows.values(): row['specHash'] = runtime.git_rollout.spec_hash(row['serviceSpec'])
                with self.assertRaises(ValueError): runtime.verify_fleet(self.client, baseline, TARGET, ['web-mini', 'web-m3'], receipts, ROOT)

    def test_selected_connect_requires_new_image_revision_even_when_source_bytes_match(self):
        baseline = self.collect(); baseline['target'] = TARGET
        receipts = self.select(['connect-agent-m3'])
        self.client.rows['connect-agent-m3']['images'][0]['Config']['Labels']['org.opencontainers.image.revision'] = OLD
        with self.assertRaisesRegex(ValueError, 'image_revision'):
            runtime.verify_fleet(self.client, baseline, TARGET, ['connect-agent-m3'], receipts, ROOT)

    def test_final_snapshot_is_private_and_reusable_for_exact_retained_observation(self):
        baseline = self.collect(); baseline['target'] = TARGET
        receipts = self.select(['web-mini', 'web-m3'])
        final = {}
        observed = runtime.verify_fleet(self.client, baseline, TARGET, ['web-mini', 'web-m3'], receipts, ROOT, output_snapshot=final)
        self.assertEqual(final['baseline'], observed)
        self.assertEqual(final['apps'], self.client.apps)
        self.assertEqual(runtime.verify_fleet(self.client, final, TARGET, [], {}, ROOT), observed)
        final['apps']['web-mini']['env'] = 'changed'
        self.assertNotEqual(final['apps']['web-mini']['env'], self.client.apps['web-mini']['env'])

    def test_collection_bounds_parallel_reads_and_hashes_each_remote_source_only_once(self):
        lock = threading.Lock(); active = maximum = source_reads = 0
        def inspection(short, app, *, manifest=None):
            nonlocal active, maximum, source_reads
            with lock:
                active += 1; maximum = max(maximum, active); source_reads += bool(manifest)
            time.sleep(0.005)
            row = copy.deepcopy(self.client.rows[short])
            with lock: active -= 1
            return row
        with patch.object(runtime.git_rollout, 'inspect_runtime', side_effect=inspection): self.collect()
        self.assertGreater(maximum, 1)
        self.assertLessEqual(maximum, 4)
        self.assertEqual(source_reads, 16)

    def test_final_rejects_tampered_selected_baseline_hash(self):
        baseline = self.collect(); baseline['target'] = TARGET
        receipts = self.select(['web-mini', 'web-m3'])
        baseline['baseline']['web-mini']['specHash'] = '0' * 64
        with self.assertRaisesRegex(ValueError, 'baseline_evidence_mismatch'):
            runtime.verify_fleet(self.client, baseline, TARGET, ['web-mini', 'web-m3'], receipts, ROOT)

    def test_multiline_and_literal_environment_values_survive_selected_rollout(self):
        # API dotenv and rendered Docker env are separate originals: do not
        # reinterpret either, and never split Docker values on embedded newlines.
        for short in ('text-mini', 'text-m3'):
            self.client.apps[short]['env'] += 'GA_LITERAL=sample # literal\n'
            row = self.client.rows[short]
            value = 'PRIVATE_KEY=line-one\nline-two\nline-three'
            row['serviceSpec']['TaskTemplate']['ContainerSpec']['Env'] += [value, 'GA_LITERAL=sample # literal']
            row['specHash'] = runtime.git_rollout.spec_hash(row['serviceSpec'])
            row['containers'][0]['config']['Env'] += [value, 'GA_LITERAL=sample # literal']
        baseline = self.collect(); baseline['target'] = TARGET
        receipts = self.select(['text-mini', 'text-m3'])
        observed = runtime.verify_fleet(self.client, baseline, TARGET, ['text-mini', 'text-m3'], receipts, ROOT)
        self.assertEqual(observed['text-mini']['release'], NEW)

    def test_final_requires_every_selected_completion_receipt_and_new_deployment(self):
        baseline = self.collect(); baseline['target'] = TARGET
        receipts = self.select(['web-mini', 'web-m3'])
        for corrupt in [{}, {**receipts, 'web-mini': {'deploymentId': 'old-web-mini'}}, {**receipts, 'monitor-m3': {'deploymentId': 'wrong'}}]:
            with self.subTest(receipts=corrupt), self.assertRaises(ValueError):
                runtime.verify_fleet(self.client, baseline, TARGET, ['web-mini', 'web-m3'], corrupt, ROOT)


if __name__ == '__main__': unittest.main()
