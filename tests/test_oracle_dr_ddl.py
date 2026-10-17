"""Fixed PG17 exported-DDL comparison; offline fixtures are not native proof."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/ops/oracle-dr'))
import ddl_verification as ddl


VAR = ('{VAR :varno 1 :varattno 1 :vartype 23 :vartypmod -1 :varcollid 0 '
       ':varnullingrels (b) :varlevelsup 0 :varnosyn 1 :varattnosyn 1 :location 12}')
CONST = ('{CONST :consttype 23 :consttypmod -1 :constcollid 0 :constlen 4 '
         ':constbyval true :constisnull false :location 20 :constvalue 4 [ 1 0 0 0 0 0 0 0 ]}')
TREE = ('{OPEXPR :opno 521 :opfuncid 147 :opresulttype 16 :opretset false '
        ':opcollid 0 :inputcollid 0 :args (' + VAR + ' ' + CONST + ') :location 15}')


def context():
    return {
        'version': 170011,
        'types': [{'oid': 16, 'namespace': 'pg_catalog', 'name': 'bool', 'kind': 'b', 'base': 0,
                   'element': 0, 'length': 1, 'byValue': True},
                  {'oid': 23, 'namespace': 'pg_catalog', 'name': 'int4', 'kind': 'b', 'base': 0,
                   'element': 0, 'length': 4, 'byValue': True}],
        'operators': [{'oid': 521, 'namespace': 'pg_catalog', 'name': '>', 'left': 23,
                       'right': 23, 'result': 16, 'function': 147}],
        'functions': [{'oid': 147, 'namespace': 'pg_catalog', 'name': 'int4gt', 'args': [23, 23],
                       'result': 16, 'volatility': 'i', 'definition': 'builtin', 'config': None,
                       'owner': 'nomorevibe', 'language': 'internal', 'strict': True,
                       'returnsSet': False, 'securityDefiner': False, 'parallel': 's', 'leakproof': True}],
        'casts': [], 'collations': [],
        'columns': [{'number': 1, 'name': 'value', 'type': 23, 'typmod': -1,
                     'collation': 0, 'notNull': False}],
    }


class NativeComparisonTests(unittest.TestCase):
    def test_locations_only_change_does_not_change_fixed_native_structure(self):
        changed = TREE.replace(':location 12', ':location -1').replace(':location 15', ':location 500')
        result = ddl.compare_native_pair(TREE, changed, context())
        self.assertEqual(result['status'], 'exported_ddl_structural_match')
        self.assertNotEqual(result['locations']['source'], result['locations']['target'])
        self.assertIs(result['historicalEquivalenceProved'], False)

    def test_missing_context_is_unknown_even_for_identical_text(self):
        self.assertEqual(ddl.compare_native_pair(TREE, TREE, None)['status'], 'unknown')

    def test_wrong_minor_is_unknown_even_for_identical_text(self):
        self.assertEqual(ddl.compare_native_pair(TREE, TREE, {**context(), 'version': 170010})['status'], 'unknown')


class SemanticSensitivityTests(unittest.TestCase):
    def test_leaf_order_and_multiplicity_are_not_sorted_or_folded(self):
        other = TREE.replace('4 [ 1 ', '4 [ 2 ')
        source = '{BOOLEXPR :boolop and :args (' + TREE + ' ' + other + ') :location 1}'
        reordered = '{BOOLEXPR :boolop and :args (' + other + ' ' + TREE + ') :location 1}'
        repeated = '{BOOLEXPR :boolop and :args (' + TREE + ' ' + other + ' ' + TREE + ') :location 1}'
        for changed in [reordered, repeated, source.replace(':boolop and', ':boolop or')]:
            with self.subTest(changed=changed[-30:]):
                self.assertEqual(ddl.compare_native_pair(source, changed, context())['status'], 'mismatch')

    def test_literal_bytes_and_null_semantics_are_preserved(self):
        for changed in [TREE.replace('4 [ 1 ', '4 [ 2 '),
                        TREE.replace(':constisnull false', ':constisnull true').replace('4 [ 1 0 0 0 0 0 0 0 ]', '<>')]:
            self.assertEqual(ddl.compare_native_pair(TREE, changed, context())['status'], 'mismatch')
        source = '{NULLTEST :arg ' + VAR + ' :nulltesttype 0 :argisrow false :location 0}'
        self.assertEqual(ddl.compare_native_pair(source, source.replace('nulltesttype 0', 'nulltesttype 1'), context())['status'], 'mismatch')

    def test_old_new_and_operator_kind_are_preserved(self):
        changed = TREE.replace(':varno 1', ':varno 2').replace(':varnosyn 1', ':varnosyn 2')
        self.assertEqual(ddl.compare_native_pair(TREE, changed, context())['status'], 'mismatch')
        self.assertEqual(ddl.compare_native_pair(TREE, TREE.replace('{OPEXPR', '{DISTINCTEXPR'), context())['status'], 'mismatch')

    def test_unknown_tag_field_missing_field_or_trailing_input_is_unknown(self):
        for changed in [TREE.replace('{OPEXPR', '{FUTUREEXPR'), TREE.replace(':opretset', ':newfield'),
                        TREE.replace(' :opretset false', ''), TREE + TREE,
                        TREE.replace(' :location 15}', ' :location 15 :added 1}')]:
            self.assertEqual(ddl.compare_native_pair(changed, changed, context())['status'], 'unknown')

    def test_unknown_oid_column_type_typmod_or_cast_is_unknown(self):
        for changed in [TREE.replace(':opno 521', ':opno 555'), TREE.replace(':vartype 23', ':vartype 25'),
                        TREE.replace(':vartypmod -1', ':vartypmod 5'), TREE.replace(':varattno 1', ':varattno 2'),
                        '{RELABELTYPE :arg ' + VAR + ' :resulttype 16 :resulttypmod -1 :resultcollid 0 :relabelformat 1 :location 0}']:
            self.assertEqual(ddl.compare_native_pair(changed, changed, context())['status'], 'unknown')

    def test_non_system_or_volatile_function_binding_is_unknown(self):
        for change in [{'namespace': 'public'}, {'volatility': 'v'}]:
            changed = copy.deepcopy(context()); changed['functions'][0].update(change)
            self.assertEqual(ddl.compare_native_pair(TREE, TREE, changed)['status'], 'unknown')

    def test_malformed_function_descriptor_is_unknown(self):
        changed = copy.deepcopy(context()); changed['functions'][0]['definition'] = None
        self.assertEqual(ddl.compare_native_pair(TREE, TREE, changed)['status'], 'unknown')

    def test_duplicate_context_and_boolean_oid_are_unknown(self):
        changed = copy.deepcopy(context()); changed['types'].append(changed['types'][0])
        self.assertEqual(ddl.compare_native_pair(TREE, TREE, changed)['status'], 'unknown')
        changed = copy.deepcopy(context()); changed['types'][0]['oid'] = True
        self.assertEqual(ddl.compare_native_pair(TREE, TREE, changed)['status'], 'unknown')

    def test_native_reader_bounds_are_enforced(self):
        for changed in [' ' * (ddl.MAX_TREE_BYTES + 1), '{BOOLEXPR :boolop and :args (' * 100 + TREE]:
            self.assertEqual(ddl.compare_native_pair(changed, changed, context())['status'], 'unknown')


def historical():
    left = {'database': {'version': 170011}, 'catalog': {'databaseSettings': [
        {'database': 'nomorevibe_test', 'role': 'all', 'config': ['jit=off']}],
        'constraints': [], 'indexes': [], 'triggers': []}, 'data': {}}
    right = copy.deepcopy(left); right['catalog']['databaseSettings'] = []
    for entry in ddl.fixed_objects():
        left['catalog'][entry['kind']].append(entry['source'])
        right['catalog'][entry['kind']].append(entry['target'])
    return left, right


class HistoricalEvidenceTests(unittest.TestCase):
    def test_original46_and_jit_unsupported_are_kept_without_native_context(self):
        left, right = historical(); before = copy.deepcopy((left, right))
        result = ddl.assess_historical(left, right)
        self.assertEqual(result['databaseSettingsAssessment']['status'], 'unsupported')
        self.assertEqual(result['rawDifferenceCount'], 46)
        self.assertEqual(result['ddlCounts'], {'constraints': 37, 'indexes': 7, 'triggers': 1})
        self.assertEqual(result['historicalContext'], 'unknown')
        self.assertIs(result['strictRestoreVerified'], False)
        self.assertIs(result['automaticDrAllowed'], False)
        self.assertEqual((left, right), before)


def probe_frames():
    ctx = context()
    ctx['database'] = {'encoding': 'UTF8', 'provider': 'c', 'locale': None,
                       'collate': 'C', 'ctype': 'C', 'icuRules': None, 'version': None, 'actualVersion': None}
    trusted = next(t for t in ddl.TRUSTED_FUNCTIONS if t[1] == 'invalidate_product_search_profile')
    ctx['functions'].append({**ctx['functions'][0], 'oid': 9000, 'namespace': 'public', 'name': trusted[1],
                             'args': [], 'result': 2279, 'volatility': 'v', 'definition': trusted[2],
                             'language': 'plpgsql', 'strict': False, 'leakproof': False})
    columns = ctx.pop('columns')
    frames = [{'frame': 'identity', 'value': {'version': 170011, 'database': 'nomorevibe_test',
               'user': 'nomorevibe', 'backendPid': 1234, 'transactionId': '12345'}},
              {'frame': 'context', 'value': ctx}]
    relations = {}
    for obj in ddl.fixed_objects():
        rel_oid = relations.setdefault(obj['relation'], 20000 + len(relations))
        metadata = {'type': 'c', 'validated': False, 'deferrable': False, 'deferred': False, 'noInherit': False}
        if obj['kind'] == 'indexes':
            metadata = {'indnatts': 1, 'indnkeyatts': 1, 'indisunique': obj['source']['definition'].startswith('CREATE UNIQUE'),
                        'indnullsnotdistinct': False, 'indisprimary': False, 'indisexclusion': False,
                        'indimmediate': True, 'indisvalid': True, 'indisready': True, 'indislive': True,
                        'indisreplident': False, 'indkey': '1', 'indcollation': '0', 'indclass': '1978', 'indoption': '0',
                        'opclasses': [{'oid': 1978, 'namespace': 'pg_catalog', 'name': 'int4_ops', 'method': 'btree',
                                       'family': 1976, 'type': 23, 'keyType': 0, 'default': True}]}
        elif obj['kind'] == 'triggers':
            metadata = {'type': 17, 'enabled': 'O', 'function': 9000, 'attributes': '1', 'nargs': 0, 'args': '',
                        'deferrable': False, 'deferred': False, 'oldTable': None, 'newTable': None, 'parent': 0, 'constraint': 0}
        native = {'tree': TREE, 'aux': None, 'aliasRelationOid': rel_oid, 'metadata': metadata}
        frames.append({'frame': 'pair', 'key': [obj['kind'], obj['schema'], obj['relation'], obj['name']],
                       'sourceHash': ddl.hashlib.sha256(obj['source']['definition'].encode()).hexdigest(),
                       'targetHash': ddl.hashlib.sha256(obj['target']['definition'].encode()).hexdigest(),
                       'columns': copy.deepcopy(columns), 'source': copy.deepcopy(native), 'target': copy.deepcopy(native)})
    return frames + [{'frame': 'end', 'probeRelations': 0, 'transactionIdle': True}]


class ProbeAssessmentTests(unittest.TestCase):
    def test_fixed45_probe_artifact_is_local_structure_only(self):
        left, right = historical()
        result = ddl.assess_probe(probe_frames(), left, right)
        self.assertEqual(result['status'], 'exported_ddl_structural_match')
        self.assertEqual(result['matched'], 45)
        self.assertEqual(result['historicalContext'], 'unknown')
        self.assertIs(result['strictRestoreVerified'], False)
        self.assertIs(result['automaticDrAllowed'], False)
        self.assertEqual(result['evidenceProvenance'], 'artifact_readback_only')

    def test_missing_duplicate_wrong_hash_or_open_transaction_is_unknown(self):
        left, right = historical()
        variants = []
        frames = probe_frames(); del frames[3]; variants.append(frames)
        frames = probe_frames(); frames[3] = copy.deepcopy(frames[2]); variants.append(frames)
        frames = probe_frames(); frames[2]['sourceHash'] = 'a' * 64; variants.append(frames)
        frames = probe_frames(); frames[-1]['probeRelations'] = 1; variants.append(frames)
        frames = probe_frames(); frames[-1]['transactionIdle'] = False; variants.append(frames)
        for frames in variants:
            self.assertEqual(ddl.assess_probe(frames, left, right)['status'], 'unknown')

    def test_index_unique_null_order_and_trigger_metadata_change_cannot_match(self):
        left, right = historical()
        for kind, field, value in [('indexes', 'indisunique', True), ('indexes', 'indnullsnotdistinct', True),
                                   ('indexes', 'indoption', '1'), ('triggers', 'enabled', 'D'),
                                   ('triggers', 'type', 19), ('triggers', 'function', 9001)]:
            frames = probe_frames(); pair = next(p for p in frames if p['frame'] == 'pair' and p['key'][0] == kind)
            pair['target']['metadata'][field] = value
            self.assertNotEqual(ddl.assess_probe(frames, left, right)['status'], 'exported_ddl_structural_match')

    def test_historical_key_or_other_raw_change_cannot_be_whitelisted(self):
        for field in ['name', 'definition', 'validated']:
            left, right = historical(); right['catalog']['constraints'][0][field] = 'tampered'
            self.assertEqual(ddl.assess_historical(left, right)['status'], 'unknown')
        left, right = historical(); right['data']['foreign'] = {'count': 1}
        self.assertEqual(ddl.assess_historical(left, right)['status'], 'unknown')


class ContextAndCliTests(unittest.TestCase):
    def test_verified_sql_snapshot_is_the_exact_child_input_after_info_file_change(self):
        import restore_contract as contract
        import restore_rehearsal as rehearsal
        left, right = historical()
        approved = ddl.SQL_PATH.read_bytes()
        sent = []
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            sql_path = folder / 'fixed.sql'
            sql_path.write_bytes(approved)
            identity = {'id': 'a' * 64, 'name': 'nomorevibe-logical-restore-ddl-verifier-offline',
                        'volume': 'nomorevibe-logical-restore-ddl-verifier-offline-data',
                        'scope': 'pipeline-local-logical-restore-ddl-verifier-offline',
                        'port': 55500, 'memoryBytes': 805306368, 'image': contract.PINNED_IMAGE,
                        'state': 'created', 'sourceHead': 'a' * 40}
            (folder / 'identity.json').write_text(json.dumps(identity))

            def child(argv, output, *, limit, input_bytes):
                if output.name == 'info.json':
                    sql_path.write_bytes(b'-- replaced during the INFO boundary\n')
                    output.write_text(json.dumps({'database': 'nomorevibe_test', 'user': 'nomorevibe',
                        'owner': 'nomorevibe', 'version': 170011, 'recovery': False, 'clients': 0}))
                elif output.name == 'probe.jsonl':
                    sent.append(input_bytes)
                    output.write_text(''.join(json.dumps(frame) + '\n' for frame in probe_frames()))
                elif output.name == 'backends.json':
                    output.write_text('{"pending":0}')
                else:
                    raise AssertionError('unexpected_child')
                return {'exit': 0, 'elapsedSeconds': 0}

            with patch.object(ddl, 'SQL_PATH', sql_path), \
                    patch.object(rehearsal, 'inspect_identity'), \
                    patch.object(rehearsal, '_run_child', side_effect=child):
                with self.assertRaises(ddl.DdlUnknown) as caught:
                    ddl.run_local_probe(folder / 'identity.json', left, right, folder / 'probe')
            self.assertEqual(str(caught.exception), 'fixed_sql_changed')
            self.assertEqual(sent, [approved])

    def test_error_report_write_failure_keeps_sql_and_observer_error_identities(self):
        import restore_contract as contract
        import restore_rehearsal as rehearsal
        left, right = historical()
        original, observer, write_error = RuntimeError('sql_failed'), RuntimeError('observer_failed'), OSError('write_failed')
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            identity = {'id': 'a' * 64, 'name': 'nomorevibe-logical-restore-ddl-verifier-offline',
                        'volume': 'nomorevibe-logical-restore-ddl-verifier-offline-data',
                        'scope': 'pipeline-local-logical-restore-ddl-verifier-offline',
                        'port': 55500, 'memoryBytes': 805306368, 'image': contract.PINNED_IMAGE,
                        'state': 'created', 'sourceHead': 'a' * 40}
            (folder / 'identity.json').write_text(json.dumps(identity))

            def child(argv, output, *, limit, input_bytes):
                if output.name == 'info.json':
                    output.write_text(json.dumps({'database': 'nomorevibe_test', 'user': 'nomorevibe',
                        'owner': 'nomorevibe', 'version': 170011, 'recovery': False, 'clients': 0}))
                    return {'exit': 0, 'elapsedSeconds': 0}
                if output.name == 'probe.jsonl':
                    raise original
                if output.name == 'backends.json':
                    raise observer
                raise AssertionError('unexpected_child')

            with patch.object(rehearsal, 'inspect_identity'), \
                    patch.object(rehearsal, '_run_child', side_effect=child), \
                    patch.object(rehearsal, '_json_file', side_effect=write_error):
                with self.assertRaises(BaseException) as caught:
                    ddl.run_local_probe(folder / 'identity.json', left, right, folder / 'probe')

            def leaves(error):
                return [part for child_error in error.exceptions for part in leaves(child_error)] if isinstance(error, BaseExceptionGroup) else [error]

            self.assertEqual(leaves(caught.exception), [original, observer, write_error])

    def test_native_oid_decimal_strings_are_not_silently_coerced(self):
        for group, field in [('types', 'oid'), ('types', 'base'), ('types', 'element'),
                             ('operators', 'oid'), ('operators', 'left'), ('operators', 'right'),
                             ('operators', 'result'), ('operators', 'function'),
                             ('functions', 'oid'), ('functions', 'result'),
                             ('columns', 'type'), ('columns', 'collation')]:
            with self.subTest(group=group, field=field):
                changed = copy.deepcopy(context())
                changed[group][0][field] = str(changed[group][0][field])
                self.assertEqual(ddl.compare_native_pair(TREE, TREE, changed)['status'], 'unknown')
        changed = copy.deepcopy(context())
        changed['functions'][0]['args'][0] = '23'
        self.assertEqual(ddl.compare_native_pair(TREE, TREE, changed)['status'], 'unknown')

    def test_failed_container_guard_cannot_issue_even_cleanup_sql(self):
        import restore_contract as contract
        import restore_rehearsal as rehearsal
        left, right = historical()
        original = ddl.DdlUnknown('container_identity_mismatch')
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            identity = {'id': 'a' * 64, 'name': 'nomorevibe-logical-restore-ddl-verifier-offline',
                        'volume': 'nomorevibe-logical-restore-ddl-verifier-offline-data',
                        'scope': 'pipeline-local-logical-restore-ddl-verifier-offline',
                        'port': 55500, 'memoryBytes': 805306368, 'image': contract.PINNED_IMAGE,
                        'state': 'created', 'sourceHead': 'a' * 40}
            (folder / 'identity.json').write_text(json.dumps(identity))
            with patch.object(rehearsal, 'inspect_identity', side_effect=original), \
                    patch.object(rehearsal, '_run_child', side_effect=AssertionError('sql_after_failed_guard')) as child:
                try:
                    ddl.run_local_probe(folder / 'identity.json', left, right, folder / 'probe')
                except BaseException as error:
                    caught = error
                self.assertEqual(child.call_count, 0)
                self.assertIs(caught, original)

    def test_collation_version_provider_and_database_context_are_required(self):
        ctx = context()
        ctx['database'] = probe_frames()[1]['value']['database']
        ctx['types'].append({'oid': 25, 'namespace': 'pg_catalog', 'name': 'text', 'kind': 'b',
                             'base': 0, 'element': 0, 'length': -1, 'byValue': False})
        ctx['columns'][0].update(type=25, collation=100)
        ctx['collations'] = [{'oid': 100, 'namespace': 'pg_catalog', 'name': 'default', 'provider': 'd',
                              'deterministic': True, 'encoding': -1, 'collate': None, 'ctype': None,
                              'locale': None, 'icuRules': None, 'version': None, 'actualVersion': None}]
        var = VAR.replace(':vartype 23', ':vartype 25').replace(':varcollid 0', ':varcollid 100')
        self.assertEqual(ddl.compare_native_pair(var, var, ctx)['status'], 'exported_ddl_structural_match')
        for mutation in ['missing_database', 'provider', 'version']:
            bad = copy.deepcopy(ctx)
            if mutation == 'missing_database': del bad['database']
            elif mutation == 'provider': bad['collations'][0]['provider'] = 'future'
            else: bad['collations'][0].update(version='old', actualVersion='new')
            self.assertEqual(ddl.compare_native_pair(var, var, bad)['status'], 'unknown')

    def test_native_cast_node_is_retained_and_unknown_cast_rejected(self):
        ctx = context()
        ctx['types'].extend([{'oid': oid, 'namespace': 'pg_catalog', 'name': name, 'kind': 'b',
                              'base': 0, 'element': 0, 'length': -1, 'byValue': False}
                             for oid, name in [(25, 'text'), (1043, 'varchar')]])
        ctx['columns'][0].update(type=1043)
        ctx['casts'] = [{'source': 1043, 'target': 25, 'method': 'b', 'context': 'i', 'function': 0}]
        var = VAR.replace(':vartype 23', ':vartype 1043')
        cast = '{RELABELTYPE :arg ' + var + ' :resulttype 25 :resulttypmod -1 :resultcollid 0 :relabelformat 1 :location 0}'
        self.assertEqual(ddl.compare_native_pair(cast, cast, ctx)['status'], 'exported_ddl_structural_match')
        self.assertEqual(ddl.compare_native_pair(cast, var, ctx)['status'], 'mismatch')
        ctx['casts'][0]['method'] = 'i'
        self.assertEqual(ddl.compare_native_pair(cast, cast, ctx)['status'], 'unknown')

    def test_fixed_sql_is_temp_rollback_only_and_not_a_parameterized_engine(self):
        raw = ddl.SQL_PATH.read_text()
        self.assertEqual(ddl.hashlib.sha256(raw.encode()).hexdigest(), ddl.SQL_SHA256)
        self.assertEqual(raw.count('CREATE TEMP TABLE '), 20)
        self.assertEqual(raw.count('-- pr14c-object '), 45)
        self.assertEqual(raw.count('ROLLBACK;'), 1)
        for forbidden in ['COMMIT;', 'ALTER DATABASE', 'CREATE FUNCTION', '\\gexec', '\\i ', 'DROP ', 'DELETE FROM', 'INSERT INTO']:
            # Function source comments/literals are fixed evidence, not emitted statements.
            self.assertFalse(any(line.startswith(forbidden) for line in raw.splitlines()))
        self.assertIn("server_version_num')::int <> 170011", raw)

    def test_real_offline_cli_ignores_db_environment_and_refuses_overwrite(self):
        left, right = historical()
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            for side, value in [('source', left), ('target', right)]:
                frames = [{'frame': 'database', 'value': value['database']},
                          {'frame': 'catalog', 'value': value['catalog']}, {'frame': 'end'}]
                (folder / side).write_text(''.join(json.dumps(frame) + '\n' for frame in frames))
            report = folder / 'report.json'
            argv = [sys.executable, '-B', str(ROOT / 'scripts/ops/oracle-dr/ddl_verification.py'),
                    '--source', str(folder / 'source'), '--target', str(folder / 'target'), '--report', str(report)]
            env = {'PATH': os.environ.get('PATH', ''), 'DATABASE_URL': 'postgres://unreachable-canary.invalid/no-database'}
            first = subprocess.run(argv, capture_output=True, timeout=5, env=env)
            self.assertEqual(first.returncode, 0, first.stdout)
            self.assertEqual(first.stderr, b'')
            value = json.loads(report.read_text())
            self.assertEqual(value['historicalAssessment']['rawDifferenceCount'], 46)
            self.assertEqual(value['exportedDdlAssessment']['status'], 'unknown')
            self.assertEqual(value['historicalAssessment']['databaseSettingsAssessment']['status'], 'unsupported')
            self.assertIs(value['automaticDrAllowed'], False)
            original = report.read_bytes()
            second = subprocess.run(argv, capture_output=True, timeout=5, env=env)
            self.assertEqual(second.returncode, 1)
            self.assertEqual(report.read_bytes(), original)
            self.assertNotIn(b'canary', first.stdout + second.stdout + first.stderr + second.stderr)
            self.assertEqual(report.stat().st_mode & 0o777, 0o600)

    def test_probe_directory_without_identity_is_rejected_before_reading_input(self):
        process = subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/ops/oracle-dr/ddl_verification.py'),
                                  '--source', '/absent', '--target', '/absent', '--report', '/absent',
                                  '--probe-directory', '/absent'], capture_output=True, timeout=5)
        self.assertEqual(process.returncode, 1)
        self.assertIn(b'probe_directory_contract', process.stdout)


if __name__ == '__main__':
    unittest.main()
