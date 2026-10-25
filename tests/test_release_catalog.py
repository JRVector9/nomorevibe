"""Offline scheduler registration gate regressions."""
import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('release_catalog', ROOT / 'scripts/ops/release_catalog.py')
catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(catalog)


def source(*names):
    rows = ','.join('{ name: "' + name + '", role: "crawler", intervalMs: 60_000 }' for name in names)
    return 'export const JOB_CATALOG: readonly { name: string; role: string; intervalMs: number | null }[] = [' + rows + '];\n'


class ParseTests(unittest.TestCase):
    def test_actual_catalog_is_completely_parsed(self):
        names = catalog.catalog_names((ROOT / 'lib/jobs/catalog.ts').read_text())
        self.assertGreater(len(names), 40)
        self.assertEqual(len(names), len(set(names)))
        self.assertIn('heartbeat', names)
        self.assertIn('product-site-evidence-refresh', names)
        self.assertIn('product-llm-assist-audit-review', names)

    def test_comments_quotes_arithmetic_and_optional_metadata(self):
        text = """export const JOB_CATALOG = [
          // { name: 'fake-comment' }
          { name: 'real-job', role: 'text', intervalMs: 5 * 60_000, lane: 'main', batchVersion: 1 },
          /* { name: 'fake-block' } */
          { name: "other-job", role: 'scheduler', intervalMs: null },
        ];"""
        self.assertEqual(catalog.catalog_names(text), ['real-job', 'other-job'])

    def test_dynamic_unknown_incomplete_and_duplicate_shapes_fail_closed(self):
        cases = ('export const JOB_CATALOG = makeCatalog();',
                 'export const JOB_CATALOG = [...other];',
                 'export const JOB_CATALOG = [{name: computed,role:"crawler",intervalMs:null}];',
                 'export const JOB_CATALOG = [{name:"safe",role:"crawler",intervalMs:period()}];',
                 'export const JOB_CATALOG = [{name:"safe",role:"crawler"}];',
                 'export const JOB_CATALOG = [{name:"safe",role:"crawler",intervalMs:null,...extra}];',
                 'export const JOB_CATALOG = [{name:"safe",name:"other",role:"crawler",intervalMs:null}];',
                 'export const JOB_CATALOG = [{name:`dynamic`,role:"crawler",intervalMs:null}];',
                 source('same', 'same'), source('unsafe;select'), source('safe') + source('other'),
                 source('safe').replace('];', '].map(transform);'))
        for text in cases:
            with self.subTest(text=text), self.assertRaises(catalog.CatalogError):
                catalog.catalog_names(text)


class GitCatalogTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.repo = Path(self.directory.name)
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Catalog test')
        self.git('config', 'user.email', 'catalog@example.invalid')
        self.write('lib/jobs/catalog.ts', source('existing-job'))
        self.before = self.commit()

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], text=True, capture_output=True, check=True).stdout.strip()

    def write(self, name, text):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self):
        self.git('add', '.')
        self.git('commit', '-m', 'catalog fixture')
        return self.git('rev-parse', 'HEAD')

    def snapshot(self, *releases):
        return {'baseline': {f'app-{index}': {'release': sha} for index, sha in enumerate(releases or (self.before,))}}

    def test_unchanged_catalog_skips_parsing_and_has_no_additions(self):
        self.write('docs/readme.md', 'docs\n')
        after = self.commit()
        with patch.object(catalog, 'catalog_names', side_effect=AssertionError('must not parse')):
            self.assertEqual(catalog.catalog_additions(self.snapshot(), after, self.repo), [])

    def test_new_names_union_across_mixed_actual_baselines(self):
        self.write('lib/jobs/catalog.ts', source('existing-job', 'middle-job'))
        middle = self.commit()
        self.write('lib/jobs/catalog.ts', source('existing-job', 'middle-job', 'new-job'))
        after = self.commit()
        self.assertEqual(catalog.catalog_additions(self.snapshot(self.before, middle), after, self.repo),
                         ['middle-job', 'new-job'])

    def test_metadata_change_or_removal_without_new_names_needs_no_registration(self):
        self.write('lib/jobs/catalog.ts', source('existing-job').replace('60_000', '120_000'))
        after = self.commit()
        self.assertEqual(catalog.catalog_additions(self.snapshot(), after, self.repo), [])

    def test_unknown_nonancestor_deleted_or_dynamic_catalog_blocks(self):
        self.write('lib/jobs/catalog.ts', 'export const JOB_CATALOG = buildDynamic();')
        after = self.commit()
        for before in (self.before, 'f' * 40, 'main', after + '\n'):
            with self.subTest(before=before), self.assertRaises(catalog.CatalogError):
                catalog.catalog_additions(self.snapshot(before), after, self.repo)
        with self.assertRaises(catalog.CatalogError):
            catalog.catalog_additions(self.snapshot(after), self.before, self.repo)
        self.git('rm', 'lib/jobs/catalog.ts')
        removed = self.commit()
        with self.assertRaises(catalog.CatalogError):
            catalog.catalog_additions(self.snapshot(), removed, self.repo)

    def test_replace_refs_cannot_hide_the_actual_added_names(self):
        self.write('lib/jobs/catalog.ts', source('existing-job', 'new-job'))
        after = self.commit()
        replacement = self.git('commit-tree', self.git('rev-parse', after + '^{tree}'), '-m', 'replacement')
        self.git('replace', self.before, replacement)
        self.assertEqual(catalog.catalog_additions(self.snapshot(), after, self.repo), ['new-job'])


class Client:
    def __init__(self): self.calls = []
    def app(self, short):
        self.calls.append(short)
        return {'appName': 'service-publisher-m3'}


class RegistrationTests(unittest.TestCase):
    def setUp(self):
        self.client = Client()
        self.now, self.sleeps = 0.0, []

    def sleep(self, seconds): self.sleeps.append(seconds); self.now += seconds

    def verify(self, names, responses, **options):
        with patch.object(catalog.shared, 'ssh_python', side_effect=responses) as ssh:
            value = catalog.verify_registered(self.client, names, monotonic=lambda: self.now, sleep=self.sleep, **options)
            return value, ssh.call_args_list

    def test_no_additions_never_reads_client_or_ssh(self):
        result, calls = self.verify([], [])
        self.assertTrue(result['registered'])
        self.assertEqual(self.client.calls, [])
        self.assertEqual(calls, [])

    def test_names_are_safe_and_unique_before_any_remote_read(self):
        for names in (['safe', 'safe'], ['bad;sql'], ['../escape'], ['bad\njob'], [1], 'safe'):
            with self.subTest(names=names), self.assertRaises(catalog.CatalogError):
                self.verify(names, [])
        self.assertEqual(self.client.calls, [])

    def test_reads_only_requested_jobs_from_publisher_with_bound_readonly_query(self):
        result, calls = self.verify(['new-job'], ['{"names":["new-job"]}'])
        self.assertEqual(result['requestedCount'], 1)
        self.assertEqual(result['registeredCount'], 1)
        self.assertEqual(result['productionMutations'], 0)
        self.assertEqual(self.client.calls, ['publisher-m3'])
        args = calls[0].args
        self.assertEqual(args[0], catalog.shared.M3[1])
        self.assertEqual(args[1], catalog.shared.REMOTE_MIGRATIONS)
        self.assertEqual(json.loads(args[3]), ['new-job'])
        self.assertIn("begin('read only'", args[4])
        self.assertIn("statement_timeout='5s'", args[4])
        self.assertIn('ANY(${sql.array(names)}::text[])', args[4])
        self.assertNotIn('INSERT', args[4])

    def test_valid_pending_subset_may_poll_until_all_rows_exist(self):
        result, calls = self.verify(['first-job', 'second-job'],
            ['{"names":["first-job"]}', '{"names":["first-job","second-job"]}'])
        self.assertTrue(result['registered'])
        self.assertEqual(len(calls), 2)
        self.assertEqual(self.sleeps, [2])

    def test_missing_registration_times_out_and_unreadable_or_extra_rows_fail_closed(self):
        for response in ('not-json', '{"names":["other-existing-job"]}',
                         '{"names":["new-job","new-job"]}', '{"names":null}',
                         RuntimeError('SECRET=private-transport-error')):
            with self.subTest(response=response), self.assertRaisesRegex(catalog.CatalogError, '^catalog_registration_unknown$'):
                self.verify(['new-job'], [response])
        with self.assertRaisesRegex(catalog.CatalogError, '^catalog_jobs_not_registered$'):
            self.verify(['new-job'], ['{"names":[]}', '{"names":[]}'], timeout=3)
        self.assertEqual(self.now, 3)


if __name__ == '__main__': unittest.main()
