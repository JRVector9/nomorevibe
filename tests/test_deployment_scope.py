"""Local, fail-closed deployment scope and per-app expectation contracts."""

import copy
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


scope = load('deployment_scope', 'scripts/ops/deployment_scope.py')
release = load('deployment_scope_metadata', 'scripts/ops/deploy_shared_images.py')
METADATA = {'known_apps': release.KNOWN_APPS, 'consumer_apps': release.CONSUMER_APPS}
OLD = 'a' * 40
NEW = 'b' * 40
OLD_IMAGE = 'ghcr.io/example/runtime@sha256:' + 'c' * 64
NEW_IMAGE = 'ghcr.io/example/runtime@sha256:' + 'd' * 64


def change(path, status='M', *other_paths):
    return {'status': status, 'paths': [path, *other_paths]}


def baseline(apps, release_sha=OLD):
    return {app: {'release': release_sha, 'image': OLD_IMAGE, 'specHash': 'e' * 64}
            for app in apps}


class DeploymentClassificationTests(unittest.TestCase):
    def setUp(self):
        self.apps = scope.registered_apps(**METADATA)

    def classify(self, *changes, **options):
        return scope.classify_changes(list(changes), **METADATA, **options)

    def test_inventory_is_the_actual_18_and_excludes_unregistered_ai1(self):
        self.assertEqual(len(self.apps), 18)
        self.assertIn('scheduler-mini', self.apps)
        self.assertIn('ai2-consumer-m3', self.apps)
        self.assertIn('agent-scan-consumer-m3', self.apps)
        self.assertNotIn('ai1-consumer-m3', self.apps)
        self.assertNotIn('translation-m3', self.apps)

    def test_runtime_metadata_is_validated_instead_of_guessing_an_app(self):
        known = dict(release.KNOWN_APPS)
        known['web-mini'] = ('', *known['web-mini'][1:])
        with self.assertRaisesRegex(ValueError, 'registered_app_metadata'):
            scope.registered_apps(known, release.CONSUMER_APPS)
        consumers = dict(release.CONSUMER_APPS)
        consumers['ai2-consumer-m3'] = ('id', '', release.M3, 'worker')
        with self.assertRaisesRegex(ValueError, 'registered_app_metadata'):
            scope.registered_apps(release.KNOWN_APPS, consumers)

    def test_documentation_tests_and_explicit_operator_python_have_no_runtime_apps(self):
        result = self.classify(change('README.md'), change('PENDING.md'),
            change('docs/operations/release.md'), change('tests/test_deployment_scope.py'),
            change('scripts/ops/deployment_scope.py'), change('scripts/ops/deploy_shared_images.py'))
        self.assertEqual(result['selectedApps'], [])
        self.assertEqual(result['retainedApps'], list(self.apps))
        self.assertEqual(result['mode'], 'none')

    def test_reviewed_operator_workflow_and_ci_entrypoints_have_no_runtime_apps(self):
        paths = ('scripts/ops/deploy_release.py', 'scripts/ops/deploy_git_apps.py', 'scripts/ops/release_runtime.py',
                 'scripts/ops/release_readiness.py', 'scripts/ops/incident_notifications.py',
                 'scripts/ops/release_observer.py', '.claude/prod.sh',
                 'scripts/ci-scope.mjs', 'scripts/ci-reuse.mjs', 'scripts/ci-check.mjs',
                 'scripts/ci-scope.node-test.mjs', 'scripts/ci-reuse.node-test.mjs',
                 'scripts/ci-check.node-test.mjs')
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(self.classify(change(path))['mode'], 'none')
        for path in ('scripts/ci-unknown.mjs', '.github/workflows/new-runtime.yml',
                     'scripts/ci-promote-image.sh', '.github/workflows/ci.yml',
                     'scripts/ci-image-receipt.mjs',
                     'scripts/ops/new-runtime.py'):
            with self.subTest(path=path):
                self.assertEqual(self.classify(change(path))['mode'], 'full')

    def test_empty_proven_diff_means_no_runtime_deployment(self):
        self.assertEqual(self.classify()['selectedApps'], [])

    def test_explicit_web_styles_messages_and_passive_assets_select_only_the_web_pair(self):
        for path in ('app/globals.css', 'components/home/card.css', 'styles/theme.css',
                     'messages/ko/common.ts', 'messages/zh-Hant/browse.ts',
                     'public/brand/logo.svg', 'public/fonts/body.woff2', 'app/icon.svg'):
            with self.subTest(path=path):
                result = self.classify(change(path))
                self.assertEqual(result['selectedApps'], ['web-mini', 'web-m3'])
                self.assertEqual(result['mode'], 'scoped')

    def test_shared_email_messages_do_not_take_the_web_only_shortcut(self):
        for path in ('messages/ko/me.ts', 'messages/en/labels.ts', 'messages/en/unknown.ts'):
            with self.subTest(path=path):
                self.assertEqual(self.classify(change(path))['selectedApps'], list(self.apps))

    def test_unknown_server_shared_db_dependencies_workflow_and_runtime_tools_fall_back_to_all(self):
        paths = ('app/api/health/route.ts', 'components/auth/client.tsx', 'lib/db/schema.ts',
                 'lib/crawl/jobs/second-review.ts', 'lib/jobs/catalog.ts', 'package.json',
                 'package-lock.json', 'Dockerfile', '.github/workflows/new.yml',
                 'scripts/ci-unknown.mjs', 'scripts/ops/screen-render.sh', 'scripts/new-worker.ts',
                 'drizzle/0100.sql', 'next.config.ts')
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(self.classify(change(path))['selectedApps'], list(self.apps))

    def test_proven_independent_entrypoints_select_their_real_apps(self):
        cases = {'scripts/scheduler.ts': ['scheduler-mini', 'scheduler-m3'],
                 'scripts/scheduler.sh': ['scheduler-mini', 'scheduler-m3'],
                 'scripts/connect-agent.ts': ['connect-agent-m3'],
                 'scripts/watch-failover-readiness.ts': ['monitor-m3'],
                 'scripts/monitor-healthcheck.ts': ['monitor-m3']}
        for path, apps in cases.items():
            with self.subTest(path=path):
                self.assertEqual(self.classify(change(path))['selectedApps'], apps)

    def test_role_selection_keeps_standby_primary_and_registered_consumers(self):
        self.assertEqual(scope.apps_for_role('reviewer', **METADATA),
                         ('reviewer-mini', 'reviewer-m3', 'ai2-consumer-m3'))
        self.assertEqual(scope.apps_for_role('crawler', **METADATA),
                         ('crawler-mini', 'crawler-m3', 'agent-scan-consumer-m3'))
        self.assertEqual(scope.apps_for_role('text', **METADATA), ('text-mini', 'text-m3'))
        with self.assertRaisesRegex(ValueError, 'unknown_role'):
            scope.apps_for_role('translation', **METADATA)

    def test_mixed_changes_union_and_an_unknown_always_wins(self):
        result = self.classify(change('README.md'), change('app/globals.css'),
                               change('scripts/scheduler.ts'))
        self.assertEqual(set(result['selectedApps']), {'web-mini', 'web-m3', 'scheduler-mini', 'scheduler-m3'})
        self.assertEqual(self.classify(change('app/globals.css'), change('lib/net/fetch.ts'))['mode'], 'full')

    def test_rename_and_copy_account_for_old_and_new_path_and_deletion_for_old_path(self):
        self.assertEqual(self.classify(change('app/globals.css', 'D'))['selectedApps'], ['web-mini', 'web-m3'])
        for status in ('R100', 'R075', 'C100'):
            with self.subTest(status=status):
                result = self.classify(change('lib/db/schema.ts', status, 'docs/old-schema.md'))
                self.assertEqual(result['mode'], 'full')
        self.assertEqual(self.classify(change('docs/old.md', 'R100', 'docs/new.md'))['mode'], 'none')

    def test_invalid_status_or_unsafe_path_is_full_instead_of_ignored(self):
        cases = [change('../docs/escape.md'), change('/docs/absolute.md'), change('docs/a\nb.md'),
                 change('docs\\a.md'), change('docs//a.md'), change('docs/./a.md'),
                 change('docs/a.md', '?'), change('docs/a.md', 'R100'),
                 {'status': 'M', 'paths': []}, {'status': 'M', 'paths': ['docs/a.md', 'README.md']}]
        for item in cases:
            with self.subTest(item=item):
                self.assertEqual(self.classify(item)['mode'], 'full')

    def test_explicit_apps_can_expand_but_never_omit_inferred_targets(self):
        with self.assertRaisesRegex(ValueError, 'apps_cannot_shrink_scope'):
            self.classify(change('app/globals.css'), requested_apps=['web-m3'])
        result = self.classify(change('app/globals.css'),
                               requested_apps=['web-m3', 'web-mini', 'scheduler-m3'])
        self.assertEqual(set(result['selectedApps']), {'web-m3', 'web-mini', 'scheduler-mini', 'scheduler-m3'})
        with self.assertRaisesRegex(ValueError, 'unknown_requested_app'):
            self.classify(change('README.md'), requested_apps=['ai1-consumer-m3'])
        with self.assertRaisesRegex(ValueError, 'apps_cannot_shrink_scope'):
            self.classify(change('Dockerfile'), requested_apps=['web-mini', 'web-m3'])

    def test_explicit_app_expansion_keeps_role_pairs_and_consumers_together(self):
        result = self.classify(change('README.md'), requested_apps=['reviewer-m3'])
        self.assertEqual(result['selectedApps'], ['reviewer-mini', 'reviewer-m3', 'ai2-consumer-m3'])


class GitDeploymentScopeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Scope test')
        self.git('config', 'user.email', 'scope@example.invalid')
        self.write('README.md', 'base\n')
        self.before = self.commit('base')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True,
                              text=True, capture_output=True).stdout.strip()

    def write(self, name, content):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def commit(self, message):
        self.git('add', '.')
        self.git('commit', '-m', message)
        return self.git('rev-parse', 'HEAD')

    def plan(self, before, after):
        return scope.plan_deployment(self.repo, before, after, **METADATA)

    def test_actual_local_commits_need_no_remote_and_docs_are_none(self):
        self.write('docs/readme.md', 'docs\n')
        after = self.commit('docs')
        result = self.plan(self.before, after)
        self.assertEqual(result['mode'], 'none')
        self.assertTrue(result['git']['trusted'])
        self.assertEqual(result['git']['before'], self.before)
        self.assertEqual(result['git']['after'], after)

    def test_unknown_malformed_missing_or_nonancestor_base_is_full(self):
        self.write('app/globals.css', 'body {}\n')
        after = self.commit('web')
        for before in ('f' * 40, '', '--help', 'main', after + '\n'):
            with self.subTest(before=before):
                self.assertEqual(self.plan(before, after)['mode'], 'full')
        self.assertEqual(self.plan(after, self.before)['mode'], 'full')

    def test_replaced_path_cannot_hide_behind_a_rename_to_docs(self):
        self.write('lib/shared.ts', 'export const x = 1;\n')
        before = self.commit('shared')
        (self.repo / 'docs').mkdir()
        self.git('mv', 'lib/shared.ts', 'docs/shared.ts')
        after = self.commit('move runtime to docs')
        result = self.plan(before, after)
        self.assertEqual(result['mode'], 'full')
        self.assertTrue(any(row['status'].startswith('R') for row in result['git']['changes']))

    def test_deleted_runtime_source_is_still_full(self):
        self.write('lib/shared.ts', 'export {};\n')
        before = self.commit('shared')
        self.git('rm', 'lib/shared.ts')
        after = self.commit('delete shared')
        self.assertEqual(self.plan(before, after)['mode'], 'full')

    def test_merge_diff_includes_both_sides_without_guessing_three_dot_base(self):
        self.git('switch', '-c', 'feature')
        self.write('lib/shared.ts', 'export {};\n')
        self.commit('feature runtime')
        self.git('switch', 'main')
        self.write('docs/main.md', 'main docs\n')
        self.commit('main docs')
        self.git('merge', '--no-ff', 'feature', '-m', 'merge feature')
        after = self.git('rev-parse', 'HEAD')
        result = self.plan(self.before, after)
        self.assertEqual(result['mode'], 'full')
        self.assertTrue(result['git']['trusted'])

    def test_commits_on_unrelated_branch_do_not_qualify_as_base(self):
        self.git('checkout', '--orphan', 'unrelated')
        self.write('README.md', 'new root\n')
        after = self.commit('unrelated')
        self.assertEqual(self.plan(self.before, after)['mode'], 'full')

    def test_local_replace_refs_cannot_substitute_the_named_commit_tree(self):
        self.write('lib/shared.ts', 'export {};\n')
        after = self.commit('runtime changed')
        replacement = self.git('commit-tree', self.git('rev-parse', after + '^{tree}'), '-m', 'replacement root')
        self.git('replace', self.before, replacement)
        self.assertEqual(self.plan(self.before, after)['mode'], 'full')
        self.assertTrue(self.plan(self.before, after)['git']['trusted'])

    def test_nul_diff_parser_preserves_names_and_refuses_truncation(self):
        rows = scope.parse_name_status(b'M\0app/globals.css\0R100\0lib/shared.ts\0docs/shared.ts\0')
        self.assertEqual(rows, [change('app/globals.css'), change('lib/shared.ts', 'R100', 'docs/shared.ts')])
        for raw in (b'M\0app/globals.css', b'R100\0old\0', b'Z\0docs/x\0', b'\xff\0'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                scope.parse_name_status(raw)


class AppExpectationTests(unittest.TestCase):
    def setUp(self):
        self.apps = scope.registered_apps(**METADATA)
        self.plan = scope.classify_changes([change('app/globals.css')], **METADATA)
        self.baseline = baseline(self.apps)
        self.targets = {app: {'release': NEW, 'image': NEW_IMAGE, 'specHash': 'f' * 64}
                        for app in self.plan['selectedApps']}

    def test_target_and_retained_expectations_are_per_app_and_do_not_mutate_inputs(self):
        self.baseline['monitor-m3']['release'] = '1' * 40
        before = copy.deepcopy(self.baseline)
        expected = scope.build_expected_apps(self.plan, self.baseline, self.targets)
        self.assertEqual(expected['web-mini']['previous'], before['web-mini'])
        self.assertEqual(expected['web-mini']['expected'], self.targets['web-mini'])
        self.assertEqual(expected['web-mini']['mode'], 'target')
        self.assertEqual(expected['monitor-m3']['expected'], before['monitor-m3'])
        self.assertEqual(expected['monitor-m3']['mode'], 'retained')
        expected['monitor-m3']['expected']['release'] = NEW
        self.assertEqual(self.baseline, before)

    def test_missing_extra_or_malformed_baselines_and_targets_are_rejected(self):
        for field, value in (('release', 'main'), ('release', 'unknown'),
                             ('image', 'runtime:latest'), ('image', ''), ('specHash', 'bad')):
            state = copy.deepcopy(self.baseline)
            state['web-mini'][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, 'invalid_app_state'):
                scope.build_expected_apps(self.plan, state, self.targets)
        for mutation in ('missing_baseline', 'extra_baseline', 'missing_target', 'extra_target'):
            state, targets = copy.deepcopy(self.baseline), copy.deepcopy(self.targets)
            if mutation == 'missing_baseline':
                state.pop('monitor-m3')
            elif mutation == 'extra_baseline':
                state['ai1-consumer-m3'] = state['web-mini']
            elif mutation == 'missing_target':
                targets.pop('web-mini')
            else:
                targets['monitor-m3'] = targets['web-mini']
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                scope.build_expected_apps(self.plan, state, targets)

    def test_expected_app_map_is_validated_against_both_retained_and_selected_apps(self):
        expected = scope.build_expected_apps(self.plan, self.baseline, self.targets)
        observed = {app: dict(row['expected']) for app, row in expected.items()}
        self.assertEqual(scope.validate_observed_apps(expected, observed), [])
        observed['monitor-m3']['specHash'] = '0' * 64
        observed['web-m3']['release'] = OLD
        self.assertEqual(scope.validate_observed_apps(expected, observed),
                         ['monitor-m3:specHash_mismatch', 'web-m3:release_mismatch'])

    def test_git_build_target_needs_a_proven_revision_and_observed_immutable_image(self):
        plan = scope.classify_changes([change('scripts/connect-agent.ts')], **METADATA)
        target = {'release': NEW, 'image': None, 'specHash': 'f' * 64,
                  'sourceType': 'github', 'sourceRevision': NEW}
        expected = scope.build_expected_apps(plan, self.baseline, {'connect-agent-m3': target})
        observed = {app: dict(row['expected']) for app, row in expected.items()}
        self.assertEqual(scope.validate_observed_apps(expected, observed), ['connect-agent-m3:invalid_app_state'])
        observed['connect-agent-m3']['image'] = NEW_IMAGE
        self.assertEqual(scope.validate_observed_apps(expected, observed), [])
        observed['connect-agent-m3'].pop('sourceRevision')
        self.assertEqual(scope.validate_observed_apps(expected, observed), ['connect-agent-m3:sourceRevision_mismatch'])
        for invalid in ({**target, 'sourceType': 'docker'}, {**target, 'sourceRevision': OLD}):
            with self.subTest(invalid=invalid), self.assertRaisesRegex(ValueError, 'invalid_app_state'):
                scope.build_expected_apps(plan, self.baseline, {'connect-agent-m3': invalid})

    def test_selected_targets_must_share_the_proven_target_commit(self):
        plan = copy.deepcopy(self.plan)
        plan['after'] = NEW
        targets = copy.deepcopy(self.targets)
        targets['web-mini']['release'] = OLD
        with self.assertRaisesRegex(ValueError, 'target_release_mismatch'):
            scope.build_expected_apps(plan, self.baseline, targets)

    def test_state_schema_rejects_unrecognized_payload_or_source_type(self):
        for extra in ({'env': 'not-state'}, {'sourceType': 'ftp'}):
            states = copy.deepcopy(self.baseline)
            states['web-mini'].update(extra)
            with self.subTest(extra=extra), self.assertRaisesRegex(ValueError, 'invalid_app_state'):
                scope.build_expected_apps(self.plan, states, self.targets)

    def test_forged_scope_partition_is_not_accepted(self):
        for mutation in ('overlap', 'duplicate', 'missing', 'wrong_version'):
            plan = copy.deepcopy(self.plan)
            if mutation == 'overlap':
                plan['retainedApps'].append('web-mini')
            elif mutation == 'duplicate':
                plan['selectedApps'].append('web-mini')
            elif mutation == 'missing':
                plan['retainedApps'].pop()
            else:
                plan['schemaVersion'] = 99
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                scope.build_expected_apps(plan, self.baseline, self.targets)

    def test_final_validation_rejects_empty_or_forged_retained_contract(self):
        with self.assertRaisesRegex(ValueError, 'invalid_expected_apps'):
            scope.validate_observed_apps({}, {})
        expected = scope.build_expected_apps(self.plan, self.baseline, self.targets)
        expected['monitor-m3']['expected']['release'] = NEW
        observed = {app: dict(row['expected']) for app, row in expected.items()}
        with self.assertRaisesRegex(ValueError, 'invalid_expected_apps'):
            scope.validate_observed_apps(expected, observed)


class MixedBaselinePlanningTests(GitDeploymentScopeTests):
    def test_older_retained_app_cannot_skip_a_change_before_the_last_release(self):
        apps = scope.registered_apps(**METADATA)
        self.write('app/globals.css', 'body { color: red; }\n')
        web_release = self.commit('web changed')
        self.write('docs/release.md', 'docs\n')
        after = self.commit('docs changed')
        states = baseline(apps, web_release)
        states['web-mini']['release'] = self.before
        result = scope.plan_for_baselines(self.repo, after, states, **METADATA)
        # The role pair is one deployment unit even if just one host is behind.
        self.assertEqual(result['selectedApps'], ['web-mini', 'web-m3'])

    def test_missing_or_unknown_baseline_release_cannot_narrow_the_plan(self):
        states = baseline(scope.registered_apps(**METADATA), self.before)
        states['monitor-m3']['release'] = 'f' * 40
        result = scope.plan_for_baselines(self.repo, self.before, states, **METADATA)
        self.assertEqual(result['mode'], 'full')
        states.pop('monitor-m3')
        with self.assertRaisesRegex(ValueError, 'baseline_apps_mismatch'):
            scope.plan_for_baselines(self.repo, self.before, states, **METADATA)


if __name__ == '__main__':
    unittest.main()
