"""PR14a scoped tests. Offline fixtures are not actual PostgreSQL evidence."""
import copy
from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import urlsplit


SOURCE = Path(__file__).resolve().parents[1] / 'scripts/ops/oracle-dr'
sys.path.insert(0, str(SOURCE))
import report_contract as contract


def inventory():
    return {
        'database': {'name': 'nomorevibe_test', 'oid': 16384, 'user': 'fixture',
                     'serverVersionNum': 170010, 'encoding': 'UTF8', 'inRecovery': False,
                     'readOnly': True, 'isolation': 'repeatable read'},
        'startedAt': '2026-10-16T00:00:00.000001Z',
        'finishedAt': '2026-10-16T00:00:00.000002Z',
        'relations': [{'oid': 20001, 'schema': 'public', 'name': 'without_identity',
                       'kind': 'r', 'persistence': 'p', 'replicaIdentity': 'd',
                       'isPartition': False, 'parents': [], 'extension': None,
                       'rowSecurity': False, 'forceRowSecurity': False,
                       'schemaUsage': True, 'select': False}],
        'columns': [{'relationOid': 20001, 'number': 1, 'name': 'id',
                     'typeSchema': 'pg_catalog', 'typeName': 'int8', 'typeModifier': -1,
                     'notNull': False, 'identity': '', 'generated': '',
                     'collationSchema': None, 'collationName': None}],
        'indexes': [], 'sequences': [],
        'extensions': [{'name': 'plpgsql', 'version': '1.0', 'schema': 'pg_catalog'}],
        'largeObjectCount': 0,
    }


def report(raw=None, side='source'):
    return contract.build_report(
        inventory() if raw is None else raw, side=side, label='local-' + side,
        client_started_at='2026-10-16T00:00:00.000000Z',
        client_finished_at='2026-10-16T00:00:00.000003Z')


class OracleDrContractTests(unittest.TestCase):
    def test_inventory_never_grants_dr_readiness_or_mutates_original(self):
        raw = inventory()
        before = copy.deepcopy(raw)
        value = report(raw)
        self.assertEqual(value['readiness'], 'unknown')
        self.assertFalse(value['automaticDrAllowed'])
        self.assertEqual(raw, before)
        self.assertEqual(value['catalog']['relations'][0]['select'], False)

    def test_default_without_actual_primary_key_is_explicitly_missing_identity(self):
        value = report()
        self.assertIn({'code': 'update_delete_identity_missing',
                       'relation': ['public', 'without_identity']}, value['findings'])

    def test_offline_compare_reports_extension_difference_with_separate_times(self):
        source = report()
        changed = inventory()
        changed['extensions'][0]['version'] = '2.0'
        changed['startedAt'] = '2026-10-17T00:00:00.000001Z'
        changed['finishedAt'] = '2026-10-17T00:00:00.000002Z'
        target = report(changed, 'target')
        result = contract.compare_reports(source, target)
        self.assertIn({'code': 'extension_version_differs', 'name': 'plpgsql',
                       'source': '1.0', 'target': '2.0'}, result['differences'])
        self.assertEqual(result['sourceCollectedAt'], source['collectedAt'])
        self.assertEqual(result['targetCollectedAt'], target['collectedAt'])
        self.assertFalse(result['automaticDrAllowed'])
        self.assertEqual(result['readiness'], 'unknown')

    def test_valid_primary_key_is_observed_but_not_dr_readiness(self):
        raw = inventory()
        raw['indexes'] = [dict(oid=21001, relationOid=20001, primary=True,
                               replicaIdentity=False, unique=True, valid=True, ready=True,
                               live=True, immediate=True, predicatePresent=False,
                               keyAttributeNumbers=[1])]
        value = report(raw)
        self.assertNotIn('update_delete_identity_missing', [x['code'] for x in value['findings']])
        self.assertEqual(value['readiness'], 'unknown')

    def test_full_and_non_permanent_are_explicit_review_conditions(self):
        raw = inventory()
        raw['relations'][0].update(replicaIdentity='f', persistence='u')
        codes = [x['code'] for x in report(raw)['findings']]
        self.assertIn('replica_identity_full_requires_review', codes)
        self.assertIn('non_permanent_relation', codes)

    def test_unknown_keys_types_and_invalid_calendar_are_rejected(self):
        variants = []
        for key, value in [('extra', 1), ('largeObjectCount', True),
                           ('startedAt', '2026-02-30T00:00:00.000001Z')]:
            raw = inventory()
            raw[key] = value
            variants.append(raw)
        raw = inventory()
        raw['database']['readOnly'] = False
        variants.append(raw)
        raw = inventory()
        raw['relations'][0]['oid'] = True
        variants.append(raw)
        raw = inventory()
        raw['relations'][0]['replicaIdentity'] = 'unknown'
        variants.append(raw)
        for raw in variants:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                report(raw)

    def test_duplicate_logical_names_and_orphan_columns_are_rejected(self):
        duplicate = inventory()
        duplicate['relations'].append({**duplicate['relations'][0], 'oid': 20002})
        orphan = inventory()
        orphan['columns'][0]['relationOid'] = 99999
        for raw in (duplicate, orphan):
            with self.assertRaises(ValueError):
                report(raw)

    def test_complete_uncapped_inventory_preserves_137_relations(self):
        raw = inventory()
        raw['relations'] = [{**raw['relations'][0], 'oid': 20001 + i, 'name': f'table_{i}'}
                            for i in range(137)]
        value = report(raw)
        self.assertEqual(len(value['catalog']['relations']), 137)
        self.assertEqual(value['catalog']['largeObjectCount'], 0)

    def test_cross_cluster_oids_do_not_create_a_false_schema_difference(self):
        source = report()
        raw = inventory()
        raw['database']['oid'] = 12345
        raw['relations'][0]['oid'] = 30001
        raw['columns'][0]['relationOid'] = 30001
        result = contract.compare_reports(source, report(raw, 'target'))
        self.assertEqual(result['differences'], [])
        self.assertEqual(result['readiness'], 'unknown')

    def test_compare_reports_missing_relation_and_column_metadata_difference(self):
        source = report()
        raw = inventory()
        raw['columns'][0]['typeName'] = 'text'
        result = contract.compare_reports(source, report(raw, 'target'))
        self.assertIn({'code': 'column_metadata_differs', 'relation': ['public', 'without_identity']},
                      result['differences'])
        raw['relations'] = []
        raw['columns'] = []
        result = contract.compare_reports(source, report(raw, 'target'))
        self.assertIn({'code': 'relation_missing_on_target',
                       'relation': ['public', 'without_identity']}, result['differences'])

    def test_offline_input_cannot_assert_ready_or_omit_observations(self):
        for key, value in [('automaticDrAllowed', True), ('readiness', 'ready'), ('catalog', {})]:
            forged = report()
            forged[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                contract.compare_reports(forged, report(side='target'))

    def test_sequence_metadata_is_compared_without_reading_current_value(self):
        raw = inventory()
        raw['relations'].append({**raw['relations'][0], 'oid': 20002, 'name': 'id_seq', 'kind': 'S'})
        raw['sequences'] = [{'oid': 20002, 'typeSchema': 'pg_catalog', 'typeName': 'int8',
                             'start': '1', 'increment': '1', 'minimum': '1',
                             'maximum': '9223372036854775807', 'cache': '1', 'cycle': False,
                             'ownedBy': [{'relationOid': 20001, 'columnNumber': 1, 'dependency': 'a'}]}]
        source = report(raw)
        raw['sequences'][0]['increment'] = '2'
        result = contract.compare_reports(source, report(raw, 'target'))
        self.assertIn({'code': 'sequence_metadata_differs', 'relation': ['public', 'id_seq']},
                      result['differences'])
        self.assertIn('sequence_current_values', result['unknowns'])
        self.assertNotIn('last_value', json.dumps(source))

    def test_duplicate_json_keys_and_nonfinite_values_are_rejected(self):
        for text in ('{"version":1,"version":1}', '{"value":NaN}', '{"value":Infinity}'):
            with self.assertRaises(ValueError):
                contract.load_json(text)

    def test_invalid_selected_identity_index_is_not_promoted_to_usable(self):
        raw = inventory()
        raw['relations'][0]['replicaIdentity'] = 'i'
        raw['indexes'] = [dict(oid=21001, relationOid=20001, primary=False,
                               replicaIdentity=True, unique=True, valid=False, ready=True,
                               live=True, immediate=True, predicatePresent=False,
                               keyAttributeNumbers=[1])]
        self.assertIn('update_delete_identity_missing', [x['code'] for x in report(raw)['findings']])

    def test_comparison_keeps_each_database_provenance_and_unresolved_findings(self):
        source, target = report(), report(side='target')
        result = contract.compare_reports(source, target)
        self.assertEqual(result.get('sourceDatabase'), source['database'])
        self.assertEqual(result.get('targetDatabase'), target['database'])
        self.assertEqual(result.get('sourceFindings'), source['findings'])
        self.assertEqual(result.get('targetFindings'), target['findings'])
        self.assertEqual(result.get('sourceLabel'), source['label'])
        self.assertEqual(result.get('targetLabel'), target['label'])


class OracleDrCliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.observed = self.root / 'observed.json'
        self.url = 'postgres://fixture:private-pass@127.0.0.1:55400/nomorevibe_test'
        self.env = {**os.environ, 'PATH': str(self.root) + os.pathsep + os.environ.get('PATH', ''),
                    'DATABASE_URL': 'postgres://must-not-auto-connect', 'PGSERVICE': 'poison'}
        self.addCleanup(self.temp.cleanup)

    def fake_psql(self, *, error=False, raw=None):
        raw = inventory() if raw is None else raw
        start = {'frame': 'start', 'database': raw['database'], 'at': raw['startedAt']}
        catalog = {k: raw[k] for k in contract.CATALOG_KEYS}
        frames = [start, {'frame': 'inventory', 'catalog': catalog},
                  {'frame': 'end', 'at': raw['finishedAt']}]
        source = ('#!' + sys.executable + '\nimport json,os,sys\n'
                  'sql=sys.stdin.read()\n'
                  'observed={"args":sys.argv[1:],"sql":sql,"envKeys":sorted(os.environ),'
                  '"dsnMatches":os.environ.get("PGDATABASE")=='+repr(self.url)+'}\n'
                  'open('+repr(str(self.observed))+',"w").write(json.dumps(observed))\n')
        if error:
            source += 'sys.stderr.write("private-pass secret-raw-stderr");sys.exit(3)\n'
        else:
            source += 'print(' + repr('\n'.join(json.dumps(x) for x in frames)) + ')\n'
        path = self.root / 'psql'
        path.write_text(source)
        path.chmod(0o755)

    def cli(self, *args, input_text=None):
        return subprocess.run([sys.executable, str(SOURCE / 'preflight.py'), *args],
                              input=input_text, capture_output=True, text=True, env=self.env, timeout=20)

    def capture(self, url=None):
        return self.cli('capture', '--side', 'source', '--label', 'local-source',
                        '--expect-database', 'nomorevibe_test', '--expect-user', 'fixture',
                        '--database-url-stdin', input_text=self.url if url is None else url)

    def test_cli_fixed_readonly_psql_capture_and_secret_free_arguments(self):
        self.fake_psql()
        result = self.capture()
        self.assertEqual(result.returncode, 0, result.stdout)
        value = json.loads(result.stdout)
        self.assertEqual(value['kind'], 'nomorevibe-oracle-dr-inventory')
        self.assertFalse(value['automaticDrAllowed'])
        observed = json.loads(self.observed.read_text())
        self.assertTrue(observed['dsnMatches'])
        self.assertIn('-X', observed['args'])
        self.assertIn('ON_ERROR_STOP=1', observed['args'])
        self.assertNotIn('private-pass', json.dumps(observed))
        self.assertNotIn('PGSERVICE', observed['envKeys'])
        self.assertNotIn('DATABASE_URL', observed['envKeys'])
        self.assertIn('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', observed['sql'])
        self.assertIn("statement_timeout = '5s'", observed['sql'])
        self.assertIn("lock_timeout = '1s'", observed['sql'])
        self.assertTrue(observed['sql'].rstrip().endswith('ROLLBACK;'))

    def test_psql_error_is_unknown_not_empty_or_raw_stderr(self):
        self.fake_psql(error=True)
        result = self.capture()
        self.assertEqual(result.returncode, 2)
        value = json.loads(result.stdout)
        self.assertEqual(value['code'], 'psql_failed')
        self.assertEqual(value['processExit'], 3)
        self.assertEqual(value['readiness'], 'unknown')
        self.assertFalse(value['automaticDrAllowed'])
        self.assertNotIn('private-pass', result.stdout + result.stderr)
        self.assertNotIn('secret-raw-stderr', result.stdout + result.stderr)

    def test_explicit_url_required_and_no_environment_fallback(self):
        self.fake_psql()
        result = self.cli('capture', '--side', 'source', '--label', 'local-source',
                          '--expect-database', 'nomorevibe_test', '--expect-user', 'fixture')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.observed.exists())
        result = self.capture('postgres://fixture:private-pass@127.0.0.1:55400/nomorevibe_test?options=bad')
        self.assertEqual(result.returncode, 2)
        self.assertFalse(self.observed.exists())

    def test_wrong_database_or_non_pg17_cannot_yield_complete_report(self):
        for changed in ({'name': 'different'}, {'serverVersionNum': 180000}):
            raw = inventory()
            raw['database'].update(changed)
            self.fake_psql(raw=raw)
            result = self.capture()
            self.assertEqual(result.returncode, 2)
            self.assertEqual(json.loads(result.stdout)['readiness'], 'unknown')

    def test_offline_compare_uses_files_and_never_starts_psql(self):
        self.fake_psql(error=True)
        source, target = self.root / 'source.json', self.root / 'target.json'
        source.write_text(json.dumps(report()))
        target.write_text(json.dumps(report(side='target')))
        result = self.cli('compare', '--source', str(source), '--target', str(target))
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(json.loads(result.stdout)['differences'], [])
        self.assertFalse(self.observed.exists())

    def test_explicit_psql_path_is_used_without_docker_auto_detection(self):
        self.fake_psql()
        adapter = self.root / 'exact-adapter'
        (self.root / 'psql').rename(adapter)
        result = self.cli('capture', '--side', 'source', '--label', 'local-source',
                          '--expect-database', 'nomorevibe_test', '--expect-user', 'fixture',
                          '--database-url-stdin', '--psql', str(adapter), input_text=self.url)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(self.observed.exists())

    def test_timeout_kills_and_reaps_the_actual_local_psql_process(self):
        pid_path = self.root / 'pid'
        path = self.root / 'psql'
        path.write_text('#!' + sys.executable + '\nimport os,time\n'
                        'open(' + repr(str(pid_path)) + ',"w").write(str(os.getpid()))\n'
                        'print("started",flush=True)\n'
                        'time.sleep(30)\n')
        path.chmod(0o755)
        import preflight
        original_popen = subprocess.Popen

        def observe_started(*args, **kwargs):
            process = original_popen(*args, **kwargs)
            try:
                self.assertEqual(process.stdout.readline(), 'started\n')
            except BaseException:
                process.kill()
                process.communicate()
                raise
            return process

        with patch.dict(os.environ, self.env), patch.object(preflight, 'PROCESS_TIMEOUT_SECONDS', 0.1), \
                patch.object(preflight.subprocess, 'Popen', side_effect=observe_started):
            with self.assertRaises(preflight.PreflightError) as raised:
                preflight.collect(self.url, side='source', label='local',
                                  expected_database='nomorevibe_test', expected_user='fixture')
        self.assertEqual(raised.exception.code, 'psql_timeout')
        with self.assertRaises(ProcessLookupError):
            os.kill(int(pid_path.read_text()), 0)


@unittest.skipUnless(os.environ.get('ORACLE_DR_TEST_DATABASE_URL') and os.environ.get('ORACLE_DR_TEST_PSQL'),
                     'Actual PG17 requires a separately assigned local DB and explicit psql adapter')
class OracleDrActualCatalogTests(unittest.TestCase):
    def query(self, sql, adapter=None):
        url = os.environ['ORACLE_DR_TEST_DATABASE_URL']
        parsed = urlsplit(url)
        self.assertEqual(parsed.hostname, '127.0.0.1')
        self.assertGreaterEqual(parsed.port, 55000)
        self.assertEqual(parsed.path, '/nomorevibe_test')
        self.assertEqual(parsed.username, 'nomorevibe')
        result = subprocess.run([adapter or os.environ['ORACLE_DR_TEST_PSQL'],
                                 '-X', '-q', '-A', '-t', '-w', '-v', 'ON_ERROR_STOP=1',
                                 '-v', 'VERBOSITY=sqlstate'], input=sql, text=True,
                                capture_output=True, timeout=20,
                                env={'PATH': os.environ.get('PATH', ''), 'PGDATABASE': url,
                                     'PGAPPNAME': 'nomorevibe-oracle-dr-fixture'})
        if result.returncode:
            raise AssertionError('actual_fixture_query_failed:' + str(result.returncode))
        return result.stdout.strip()

    def fixture_plan(self):
        schema = 'pr14a_fixture'
        tiny = [f'tiny_{i}' for i in range(105)]
        setup = [f'CREATE SCHEMA {schema}',
                 f'CREATE TABLE {schema}.with_pk(id bigserial PRIMARY KEY)',
                 f'CREATE TABLE {schema}.without_pk(id bigint)',
                 f'CREATE TABLE {schema}.full_identity(id bigint)',
                 f'ALTER TABLE {schema}.full_identity REPLICA IDENTITY FULL',
                 f'CREATE TABLE {schema}.partition_root(id bigint) PARTITION BY RANGE(id)',
                 f'CREATE TABLE {schema}.partition_leaf PARTITION OF {schema}.partition_root FOR VALUES FROM(0) TO(10)',
                 f'CREATE VIEW {schema}.only_view AS SELECT id FROM {schema}.with_pk',
                 *[f'CREATE TABLE {schema}.{name}(id integer)' for name in tiny]]
        cleanup = [f'DROP VIEW {schema}.only_view', f'DROP TABLE {schema}.partition_leaf',
                   f'DROP TABLE {schema}.partition_root', f'DROP TABLE {schema}.with_pk',
                   f'DROP TABLE {schema}.without_pk', f'DROP TABLE {schema}.full_identity',
                   *[f'DROP TABLE {schema}.{name}' for name in tiny], f'DROP SCHEMA {schema}']
        expected = sorted([[name, 'r', True] for name in tiny] + [
            ['with_pk', 'r', True], ['with_pk_id_seq', 'S', True], ['with_pk_pkey', 'i', True],
            ['without_pk', 'r', True], ['full_identity', 'r', True], ['partition_root', 'p', True],
            ['partition_leaf', 'r', True], ['only_view', 'v', True]])
        return schema, setup, cleanup, expected

    def cleanup_fixture(self, query):
        schema, _, cleanup, expected = self.fixture_plan()
        raw = query("""SELECT jsonb_build_object(
          'owner',n.nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user),
          'relations',(SELECT coalesce(jsonb_agg(jsonb_build_array(c.relname,c.relkind,
            c.relowner=n.nspowner) ORDER BY c.relname),'[]') FROM pg_class c WHERE c.relnamespace=n.oid),
          'functions',(SELECT count(*) FROM pg_proc WHERE pronamespace=n.oid))
          FROM pg_namespace n WHERE n.nspname='pr14a_fixture';""")
        if not raw:
            return
        current = json.loads(raw)
        self.assertEqual(current, {'owner': True, 'relations': expected, 'functions': 0})
        # The exact initially vacant namespace only; never CASCADE or unknown partial contents.
        query('BEGIN;\n' + ';\n'.join(cleanup) + ';\nCOMMIT;')

    @contextmanager
    def fixture(self, query):
        schema, setup, _, _ = self.fixture_plan()
        self.assertEqual(query("SELECT count(*) FROM pg_namespace WHERE nspname='pr14a_fixture';"), '0')
        attempted = False
        errors = []
        try:
            attempted = True
            query('BEGIN;\n' + ';\n'.join(setup) + ';\nCOMMIT;')
            yield schema
        except BaseException as error:
            errors.append(error)
        finally:
            if attempted:
                try:
                    self.cleanup_fixture(query)
                except BaseException as error:
                    errors.append(error)
        if errors:
            raise BaseExceptionGroup('actual_catalog_or_exact_fixture_cleanup_failed', errors)
        self.assertEqual(query("SELECT count(*) FROM pg_namespace WHERE nspname='pr14a_fixture';"), '0')

    def checkpoint(self):
        tables = json.loads(self.query("SELECT jsonb_agg(tablename ORDER BY tablename) FROM pg_tables WHERE schemaname='public';"))
        statements = ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY']
        for name in tables:
            quoted = '"' + name.replace('"', '""') + '"'
            literal = "'" + name.replace("'", "''") + "'"
            statements.append(f"SELECT jsonb_build_array({literal},coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]')) FROM public.{quoted} t")
        statements.append("""SELECT jsonb_build_array('_catalog',jsonb_build_object(
          'schemas',(SELECT jsonb_agg(to_jsonb(n) ORDER BY n.nspname) FROM pg_namespace n WHERE n.nspname!~'^pg_'),
          'relations',(SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.oid,c.relkind,c.relowner,c.relacl,c.relpersistence,c.relrowsecurity,c.relforcerowsecurity) ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname!~'^pg_' AND n.nspname<>'information_schema'),
          'functions',(SELECT jsonb_agg(jsonb_build_array(p.oid,p.proowner,p.proacl,pg_get_functiondef(p.oid)) ORDER BY p.oid) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prokind='f'),
          'triggers',(SELECT jsonb_agg(to_jsonb(t) ORDER BY t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),
          'database',(SELECT jsonb_build_array(datname,datacl) FROM pg_database WHERE datname=current_database()),
          'journal',(SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM drizzle.__drizzle_migrations m)))""")
        statements.append('ROLLBACK')
        return dict(json.loads(line) for line in self.query(';\n'.join(statements) + ';').splitlines())

    def test_actual_pg17_catalog_matches_independent_truth_without_mutating_data(self):
        import preflight
        url = os.environ['ORACLE_DR_TEST_DATABASE_URL']
        adapter = os.environ['ORACLE_DR_TEST_PSQL']
        query = self.query
        with self.fixture(query) as schema:
            sequence_before = query(f'SELECT last_value,is_called FROM {schema}.with_pk_id_seq;')
            value = preflight.collect(url, side='source', label='assigned-local-pg17',
                                      expected_database='nomorevibe_test', expected_user='nomorevibe', psql=adapter)
            truth = json.loads(query("""SELECT jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.oid::bigint)
              ORDER BY n.nspname,c.relname) FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid
              WHERE left(n.nspname,3)<>'pg_' AND n.nspname<>'information_schema'
                AND c.relkind = ANY(ARRAY['r','p','f','v','m','S']::\"char\"[]);"""))
            actual = [[r['schema'], r['name'], r['oid']] for r in value['catalog']['relations']]
            self.assertEqual(sorted(actual), sorted(truth))
            own = [r for r in value['catalog']['relations'] if r['schema'] == schema]
            self.assertEqual(len(own), 112)
            self.assertGreater(len(actual), 101)
            self.assertTrue(value['database']['readOnly'])
            self.assertEqual(value['database']['isolation'], 'repeatable read')
            codes = {(f['code'], tuple(f.get('relation', ()))) for f in value['findings']}
            self.assertIn(('update_delete_identity_missing', (schema, 'without_pk')), codes)
            self.assertNotIn(('update_delete_identity_missing', (schema, 'with_pk')), codes)
            self.assertIn(('replica_identity_full_requires_review', (schema, 'full_identity')), codes)
            self.assertIn(('partition_publication_mapping_unverified', (schema, 'partition_leaf')), codes)
            self.assertIn(('relation_not_logical_table', (schema, 'only_view')), codes)
            seq_oid = next(r['oid'] for r in own if r['name'] == 'with_pk_id_seq')
            sequence = next(r for r in value['catalog']['sequences'] if r['oid'] == seq_oid)
            pk_oid = next(r['oid'] for r in own if r['name'] == 'with_pk')
            self.assertEqual(sequence['ownedBy'], [{'relationOid': pk_oid, 'columnNumber': 1, 'dependency': 'a'}])
            self.assertNotIn('lastValue', sequence)
            self.assertEqual(query(f'SELECT last_value,is_called FROM {schema}.with_pk_id_seq;'), sequence_before)
            self.assertEqual(value['readiness'], 'unknown')
            self.assertFalse(value['automaticDrAllowed'])
            report_path = os.environ.get('ORACLE_DR_TEST_REPORT_PATH')
            if report_path:
                Path(report_path).write_text(json.dumps({'report': value, 'independentRelations': truth,
                                                         'sequenceBeforeAndAfter': sequence_before}, indent=2))


    def test_setup_commit_ack_failure_preserves_error_and_cleans_exact_fixture(self):
        before = self.checkpoint()
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            marker = root / 'committed.json'
            adapter = root / 'ack-psql'
            adapter.write_text('#!' + sys.executable + '\n' +
                'import json,os,subprocess,sys\n' +
                'sql=sys.stdin.read()\n' +
                'result=subprocess.run([' + repr(os.environ['ORACLE_DR_TEST_PSQL']) +
                ',*sys.argv[1:]],input=sql,text=True,capture_output=True)\n' +
                'sys.stdout.write(result.stdout);sys.stderr.write(result.stderr)\n' +
                'marker=' + repr(str(marker)) + '\n' +
                'if result.returncode==0 and "CREATE SCHEMA pr14a_fixture;" in sql and not os.path.exists(marker):\n' +
                ' open(marker,"w").write(json.dumps({"setupProcessExit":0,"committed":True}))\n' +
                ' sys.exit(86)\n' +
                'sys.exit(result.returncode)\n')
            adapter.chmod(0o755)
            errors = []
            try:
                with self.assertRaises(BaseExceptionGroup) as raised:
                    with self.fixture(lambda sql: self.query(sql, str(adapter))):
                        self.fail('failed setup acknowledgement must not enter the test body')
                self.assertEqual(json.loads(marker.read_text()), {'setupProcessExit': 0, 'committed': True})
                self.assertTrue(any(isinstance(error, AssertionError) and
                                    str(error) == 'actual_fixture_query_failed:86'
                                    for error in raised.exception.exceptions))
                self.assertEqual(self.query("SELECT count(*) FROM pg_namespace WHERE nspname='pr14a_fixture';"), '0')
                self.assertEqual(self.checkpoint(), before)
            except BaseException as error:
                errors.append(error)
            finally:
                # RED-driver recovery is separate from the fixture cleanup assertion above.
                if marker.exists():
                    try:
                        self.cleanup_fixture(self.query)
                    except BaseException as error:
                        errors.append(error)
            if errors:
                raise BaseExceptionGroup('commit_ack_regression_or_exact_recovery_failed', errors)


if __name__ == '__main__':
    unittest.main()
