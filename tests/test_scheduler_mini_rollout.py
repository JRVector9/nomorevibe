"""Offline cross-host scheduler deployment contracts; never opens a production client."""

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'scripts/ops' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


shared = load('mini_scheduler_shared', 'deploy_shared_images.py')
git = load('mini_scheduler_git', 'deploy_git_apps.py')
scope = load('mini_scheduler_scope', 'deployment_scope.py')
release = load('mini_scheduler_release', 'deploy_release.py')
runtime = load('mini_scheduler_runtime', 'release_runtime.py')


class MiniSchedulerContracts(unittest.TestCase):
    def test_scheduler_replica_counts_are_host_specific_and_unknown_apps_are_refused(self):
        self.assertEqual(shared.scheduler_replicas('scheduler-m3'), 2)
        self.assertEqual(shared.scheduler_replicas('scheduler-mini'), 1)
        with self.assertRaisesRegex(ValueError, 'unknown_scheduler_app'):
            shared.scheduler_replicas('scheduler-oracle')

    def test_scheduler_rollout_finishes_mini_before_starting_m3(self):
        self.assertEqual(git.waves(('scheduler-mini', 'scheduler-m3')),
                         (('scheduler-mini',), ('scheduler-m3',)))
        for selected in [('scheduler-mini',), ('scheduler-m3',)]:
            with self.subTest(selected=selected), self.assertRaisesRegex(ValueError, 'scheduler_.*required'):
                git.waves(selected)

    def test_both_release_contracts_accept_mini_one_and_m3_two_and_refuse_swapped_counts(self):
        for short, replicas, host in [('scheduler-mini', 1, shared.MINI), ('scheduler-m3', 2, shared.M3)]:
            app = {'applicationId': 'synthetic-id', 'name': 'synthetic-name', 'serverId': host[0],
                   'appName': 'synthetic-service', 'applicationStatus': 'done', 'autoDeploy': False,
                   'sourceType': 'docker', 'dockerImage': shared.IMAGE_PREFIX['worker'] + 'sha256:' + 'c' * 64,
                   'dockerBuildStage': 'worker', 'replicas': replicas,
                   'command': '/sbin/tini -- node --import tsx scripts/worker-supervisor.ts --role=scheduler',
                   'env': 'RELEASE_TAG=' + 'a' * 40 + '\nWORKER_ROLE=scheduler\n'}
            for module in [git, runtime]:
                with self.subTest(app=short, validator=module.__name__), patch.object(
                        module.shared, 'app_metadata', return_value=('synthetic-id', 'synthetic-name', host, 'scheduler')):
                    def validate():
                        if module is git:
                            return git.validate_contract(short, app, mode='shared-worker')
                        return runtime._api_ready(short, app, {'status': 'done', 'deploymentId': 'synthetic-deployment'})
                    validate()
                    app['replicas'] = 3 - replicas
                    with self.assertRaisesRegex(ValueError, 'replicas_mismatch'):
                        validate()
                    app['replicas'] = replicas

    def test_scheduler_entrypoint_selects_both_registered_hosts(self):
        # A synthetic registration proves scope rules independently of production provisioning.
        known = {}
        for name, metadata in shared.KNOWN_APPS.items():
            if name == 'scheduler-m3':
                known['scheduler-mini'] = ('synthetic-mini-scheduler', 'synthetic-mini-scheduler', shared.MINI, 'scheduler')
            if name != 'scheduler-mini':
                known[name] = metadata
        result = scope.classify_changes([{'status': 'M', 'paths': ['scripts/scheduler.ts']}],
                                        known_apps=known, consumer_apps=shared.CONSUMER_APPS)
        self.assertEqual(result['selectedApps'], ['scheduler-mini', 'scheduler-m3'])

    def test_catalog_additions_require_both_scheduler_hosts(self):
        old = {'baseline': {'scheduler-mini': {'release': 'a' * 40}, 'scheduler-m3': {'release': 'a' * 40}}}
        release.validate_catalog_scope([], ['web-mini', 'web-m3'], old, 'b' * 40)
        release.validate_catalog_scope(['new-job'], ['scheduler-mini', 'scheduler-m3'], old, 'b' * 40)
        for selected in [[], ['scheduler-m3'], ['scheduler-mini']]:
            with self.subTest(selected=selected), self.assertRaisesRegex(ValueError, 'new_catalog_requires_scheduler'):
                release.validate_catalog_scope(['new-job'], selected, old, 'b' * 40)

    def test_catalog_additions_accept_schedulers_already_at_target(self):
        # A stopped release continued by a fresh plan: both schedulers already run the target, so they are retained.
        at_target = {'baseline': {'scheduler-mini': {'release': 'b' * 40}, 'scheduler-m3': {'release': 'b' * 40}}}
        release.validate_catalog_scope(['new-job'], ['web-mini', 'web-m3'], at_target, 'b' * 40)
        half = {'baseline': {'scheduler-mini': {'release': 'b' * 40}, 'scheduler-m3': {'release': 'a' * 40}}}
        with self.assertRaisesRegex(ValueError, 'new_catalog_requires_scheduler'):
            release.validate_catalog_scope(['new-job'], ['scheduler-mini'], half, 'b' * 40)


if __name__ == '__main__':
    unittest.main()
