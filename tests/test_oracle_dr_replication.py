"""PR14d scoped tests. Offline fixtures are not PostgreSQL evidence; actual classes need two assigned local PG17."""
import copy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

SOURCE = Path(__file__).resolve().parents[1] / 'scripts/ops/oracle-dr'
sys.path.insert(0, str(SOURCE))
import capacity  # noqa: E402
import preflight  # noqa: E402
import replication_common as common  # noqa: E402
import replication_plan  # noqa: E402
import replication_status  # noqa: E402
import report_contract as contract  # noqa: E402

DB = {'name': 'nomorevibe_test', 'oid': 16384, 'user': 'nomorevibe', 'serverVersionNum': 170011, 'encoding': 'UTF8',
      'inRecovery': False, 'readOnly': True, 'isolation': 'repeatable read'}
ODD = 'we"ird'


def relation(oid, schema, name, kind='r'):
    return {'oid': oid, 'schema': schema, 'name': name, 'kind': kind, 'persistence': 'p', 'replicaIdentity': 'd',
            'isPartition': False, 'parents': [], 'extension': None, 'rowSecurity': False, 'forceRowSecurity': False,
            'schemaUsage': True, 'select': True}


def column(oid, number, name, type_name, not_null=True):
    return {'relationOid': oid, 'number': number, 'name': name, 'typeSchema': 'pg_catalog', 'typeName': type_name,
            'typeModifier': -1, 'notNull': not_null, 'identity': '', 'generated': '', 'collationSchema': None,
            'collationName': None}


def pkey(oid, table, numbers):
    return {'oid': oid, 'relationOid': table, 'primary': True, 'replicaIdentity': False, 'unique': True, 'valid': True,
            'ready': True, 'live': True, 'immediate': True, 'predicatePresent': False, 'keyAttributeNumbers': numbers}


def sequence(oid, table):
    return {'oid': oid, 'typeSchema': 'pg_catalog', 'typeName': 'int8', 'start': '1', 'increment': '1', 'minimum': '1',
            'maximum': '9223372036854775807', 'cache': '1', 'cycle': False,
            'ownedBy': [{'relationOid': table, 'columnNumber': 1, 'dependency': 'a'}]}


def inventory(no_pk=True, large_objects=0):
    relations = [relation(20001, 'public', 'items'), relation(20002, 'public', 'items_id_seq', 'S'),
                 relation(20003, 'public', ODD), relation(20005, 'drizzle', '__drizzle_migrations'),
                 relation(20006, 'drizzle', '__drizzle_migrations_id_seq', 'S'), relation(20007, 'public', 'only_view', 'v')]
    columns = [column(20001, 1, 'id', 'int8'), column(20001, 2, 'body', 'text', False), column(20003, 1, 'k', 'text'),
               column(20005, 1, 'id', 'int4'), column(20005, 2, 'hash', 'text'), column(20007, 1, 'id', 'int8', False)]
    if no_pk:
        relations.append(relation(20004, 'public', 'no_pk'))
        columns.append(column(20004, 1, 'x', 'int4', False))
    raw = {'database': DB, 'startedAt': '2026-10-17T00:00:00.000001Z', 'finishedAt': '2026-10-17T00:00:00.000002Z',
           'relations': relations, 'columns': columns,
           'indexes': [pkey(21001, 20001, [1]), pkey(21003, 20003, [1]), pkey(21005, 20005, [1])],
           'sequences': [sequence(20002, 20001), sequence(20006, 20005)],
           'extensions': [{'name': 'plpgsql', 'version': '1.0', 'schema': 'pg_catalog'}], 'largeObjectCount': large_objects}
    return contract.build_report(raw, side='source', label='offline-source', client_started_at='2026-10-17T00:00:00.000000Z',
                                 client_finished_at='2026-10-17T00:00:00.000003Z')


def plan():
    return replication_plan.build_plan(inventory(), publication='nmv_dr', subscription='nmv_dr', replication_role='nmv_dr_role',
                                       exclusions=['public.no_pk=offline fixture without key'])


SETTINGS = {name: {'setting': '10', 'unit': None} for name in replication_status.SETTINGS}
SETTINGS.update(wal_level={'setting': 'logical', 'unit': None}, max_slot_wal_keep_size={'setting': '-1', 'unit': 'MB'},
                wal_keep_size={'setting': '0', 'unit': 'MB'}, max_wal_size={'setting': '1024', 'unit': 'MB'},
                logical_decoding_work_mem={'setting': '65536', 'unit': 'kB'})
COLUMNS = {('public', 'items'): [('body', 'text', False), ('id', 'bigint', True)], ('public', ODD): [('k', 'text', True)],
           ('public', 'no_pk'): [('x', 'integer', False)], ('drizzle', '__drizzle_migrations'): [('hash', 'text', True), ('id', 'integer', True)]}


def tables_frame(columns=None, extra=()):
    columns = copy.deepcopy(COLUMNS if columns is None else columns)
    for name in extra:
        columns[name] = [('id', 'integer', True)]
    return {'frame': 'tables', 'tables': [{'relation': list(r), 'columns': [
        {'name': n, 'type': t, 'notNull': nn, 'hasDefault': False, 'generated': False, 'identity': False} for n, t, nn in cols]}
        for r, cols in sorted(columns.items())],
        'sequences': [['drizzle', '__drizzle_migrations_id_seq'], ['public', 'items_id_seq']], 'largeObjects': 0}


def at(second):
    return f'2026-10-17T00:00:{second:02d}.000000Z'


def publisher_capture(the_plan, *, slot=True, active=True, lag=0, retained=256, samples=None, counts=None, sequences=None, extra_tables=()):
    current = 0x3000000
    slots = [{'name': 'nmv_dr', 'plugin': 'pgoutput', 'type': 'logical', 'database': 'nomorevibe_test', 'temporary': False,
              'active': active, 'activePid': 100 if active else None, 'restartLsn': '0/2FFFF00', 'confirmedFlushLsn': f'0/{current - lag:X}',
              'walStatus': 'reserved', 'safeWalSize': None, 'retainedBytes': retained, 'failover': False,
              'invalidationReason': None}] if slot else []
    publication = {'allTables': False, 'insert': True, 'update': True, 'delete': True, 'truncate': True, 'viaRoot': False,
                   'tables': [{'relation': ['public', 'items'], 'columns': ['id', 'body'], 'rowFilter': False},
                              {'relation': ['public', ODD], 'columns': ['k'], 'rowFilter': False}]}
    catalog = [{'frame': 'start', 'at': at(1), 'database': {**{k: DB[k] for k in ('name', 'oid', 'user', 'serverVersionNum', 'inRecovery', 'readOnly')},
                                                             'systemIdentifier': '7000000000000000001'},
                'currentLsn': f'0/{current:X}', 'readAllStats': True},
               {'frame': 'settings', 'settings': SETTINGS}, {'frame': 'slots', 'slots': slots},
               {'frame': 'senders', 'senders': [{'pid': 100, 'applicationName': 'nmv_dr', 'state': 'streaming', 'sentLsn': '0/3000000',
                                                 'writeLsn': '0/3000000', 'flushLsn': '0/3000000', 'replayLsn': '0/3000000',
                                                 'writeLagMs': 1, 'flushLagMs': 2, 'replayLagMs': 3}]},
               {'frame': 'slotStats', 'slotStats': [{'name': 'nmv_dr', 'spillBytes': 0, 'streamBytes': 0, 'totalBytes': 9}]},
               {'frame': 'publication', 'publication': publication}, tables_frame(extra=extra_tables),
               {'frame': 'end', 'at': at(2), 'currentLsn': f'0/{current:X}'}]
    data = data_frames('publisher', samples, counts, sequences)
    value = {'kind': replication_status.KIND, 'version': 1, 'side': 'publisher', 'label': 'offline-pub',
             'planHash': replication_plan.plan_hash(the_plan), 'clientStartedAt': at(0), 'clientFinishedAt': at(9),
             'capturedAt': at(1), 'rowCounts': counts is not None, 'sampleRows': 5 if samples is not None else 0,
             'samplesFrom': None, 'catalogFrames': catalog, 'dataFrames': data, 'readiness': 'unknown', 'automaticDrAllowed': False}
    return replication_status.validate_capture(value, the_plan, 'publisher')


def data_frames(side, samples, counts, sequences):
    extra = {'currentLsn': '0/3000000'} if side == 'publisher' else {}
    first = 3 if side == 'publisher' else 7
    frames = [{'frame': 'start', 'at': at(first), **extra}]
    frames.append({'frame': 'sequences', 'sequences': [{'relation': ['public', 'items_id_seq'], 'lastValue': str(v), 'isCalled': True}
                                                       for v in [sequences if sequences is not None else 10]]})
    for name, count in sorted((counts or {}).items()):
        frames.append({'frame': 'rowCount', 'relation': list(name), 'count': count})
    for name, rows in sorted((samples or {}).items()):
        frames.append({'frame': 'sample', 'relation': list(name), 'rows': rows})
    frames.append({'frame': 'end', 'at': at(first + 1), **extra})
    return frames


def subscriber_capture(the_plan, pub, *, subscription=True, enabled=True, errors=0, states=None, columns=None,
                       samples=None, counts=None, sequences=None, workers=True):
    sub_frame = {'frame': 'subscription', 'subscription': {'enabled': enabled, 'slot': 'nmv_dr', 'publications': ['nmv_dr'],
                                                         'streaming': 't', 'disableOnError': True, 'failover': False,
                                                         'binary': False} if subscription else None,
                 'workers': [{'type': 'apply', 'running': True, 'relation': None, 'receivedLsn': '0/3000000',
                              'latestEndLsn': '0/3000000'}] if workers else [],
                 'stats': {'applyErrors': errors, 'syncErrors': 0} if subscription else None,
                 'relations': [{'relation': list(r), 'state': (states or {}).get(r, 'r')} for r in [('public', 'items'), ('public', ODD)]]
                 if subscription else [],
                 'originRemoteLsn': '0/2FFFFF0' if subscription else None, 'otherClientBackends': 0}
    catalog = [{'frame': 'start', 'at': at(5), 'database': {**{k: DB[k] for k in ('name', 'user', 'serverVersionNum', 'readOnly')},
                                                            'oid': 17000, 'inRecovery': False, 'systemIdentifier': '7000000000000000002'}},
               sub_frame, tables_frame(columns), {'frame': 'end', 'at': at(6)}]
    value = {'kind': replication_status.KIND, 'version': 1, 'side': 'subscriber', 'label': 'offline-sub',
             'planHash': replication_plan.plan_hash(the_plan), 'clientStartedAt': at(4), 'clientFinishedAt': at(9),
             'capturedAt': at(5), 'rowCounts': counts is not None, 'sampleRows': 5 if samples is not None else 0,
             'samplesFrom': replication_status.sample_digest(pub) if samples is not None else None,
             'catalogFrames': catalog, 'dataFrames': data_frames('subscriber', samples, counts, sequences),
             'readiness': 'unknown', 'automaticDrAllowed': False}
    return replication_status.validate_capture(value, the_plan, 'subscriber')


def codes(result, severity=None):
    return {f['code'] for f in result['findings'] if severity is None or f['severity'] == severity}


class ReplicationPlanOfflineTests(unittest.TestCase):
    def test_plan_lists_tables_exclusions_and_never_grants_readiness(self):
        value = plan()
        self.assertEqual([(t['schema'], t['name']) for t in value['tables']], [('public', 'items'), ('public', ODD)])
        self.assertIn({'relation': ['drizzle', '__drizzle_migrations'], 'reason': 'migration_journal_applied_per_side'}, value['excluded'])
        self.assertIn({'relation': ['public', 'no_pk'], 'reason': 'offline fixture without key'}, value['excluded'])
        self.assertEqual([s['relation'] for s in value['sequences']], [['public', 'items_id_seq']])
        self.assertEqual(value['nonTables'], [{'relation': ['public', 'only_view'], 'kind': 'v', 'handling': 'ddl_only'}])
        self.assertEqual((value['readiness'], value['automaticDrAllowed'], value['blockers']), ('unknown', False, []))
        self.assertIn('FOR TABLE "public"."items", "public"."we""ird" WITH', value['sql']['publisher'][0])
        self.assertIn("CONNECTION :'publisher_conninfo'", value['sql']['subscriberCopySeed'][0])
        self.assertNotIn('PASSWORD', json.dumps(value['sql']))
        self.assertTrue(all(step['approval'] in ('user', 'none') for step in value['procedure']))

    def test_table_without_identity_blocks_plan_and_sql_until_explicit_exclusion(self):
        value = replication_plan.build_plan(inventory(), publication='nmv_dr', subscription='nmv_dr', replication_role='nmv_dr_role')
        self.assertIn({'code': 'update_delete_identity_missing', 'relation': ['public', 'no_pk']}, value['blockers'])
        self.assertIsNone(value['sql'])
        self.assertEqual(value['procedure'], [])
        with self.assertRaises(ValueError):
            replication_plan.validate_plan(value)

    def test_large_objects_and_unobserved_exclusion_block(self):
        value = replication_plan.build_plan(inventory(no_pk=False, large_objects=2), publication='a', subscription='a',
                                            replication_role='r', exclusions=['public.ghost=gone'])
        self.assertIn({'code': 'large_objects_present', 'count': 2}, value['blockers'])
        self.assertIn({'code': 'excluded_relation_not_observed', 'relation': ['public', 'ghost']}, value['blockers'])

    def test_edited_plan_sql_or_ready_flag_is_rejected(self):
        for key, mutate in [('sql', lambda p: p['sql']['publisher'].__setitem__(0, 'CREATE PUBLICATION x FOR ALL TABLES')),
                            ('ready', lambda p: p.__setitem__('automaticDrAllowed', True)),
                            ('tables', lambda p: p['tables'].pop())]:
            value = plan()
            mutate(value)
            with self.subTest(key=key), self.assertRaises(ValueError):
                replication_plan.validate_plan(value)

    def test_invalid_names_are_rejected(self):
        for bad in ('Upper', 'with space', 'x' * 64, '1abc'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                replication_plan.build_plan(inventory(no_pk=False), publication=bad, subscription='ok', replication_role='ok')

    def test_sequence_sync_never_lowers_and_falls_back_to_data_max(self):
        the_plan = plan()
        pub = publisher_capture(the_plan, sequences=41)
        from_capture = replication_plan.sequence_sync_sql(the_plan, margin=1000, publisher_capture=pub)
        self.assertEqual(from_capture['sql'], ["SELECT pg_catalog.setval('\"public\".\"items_id_seq\"'::regclass, "
                                               "GREATEST(1041, (SELECT last_value FROM \"public\".\"items_id_seq\")), true)"])
        from_data = replication_plan.sequence_sync_sql(the_plan, margin=5)
        self.assertIn('(SELECT COALESCE(max("id"), 0) FROM ONLY "public"."items") + 5', from_data['sql'][0])
        self.assertEqual((from_data['source'], from_data['automaticDrAllowed']), ('subscriber_data_max', False))
        with self.assertRaises(ValueError):
            replication_plan.sequence_sync_sql(the_plan, margin=0)

    def test_cli_blocked_plan_exits_3_and_bad_input_exits_2_without_echo(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'inventory.json'
            path.write_text(json.dumps(inventory()))
            run = lambda *a: subprocess.run([sys.executable, str(SOURCE / 'replication_plan.py'), *a], capture_output=True,
                                            text=True, timeout=30)
            blocked = run('plan', '--inventory', str(path))
            self.assertEqual(blocked.returncode, 3, blocked.stdout)
            self.assertTrue(json.loads(blocked.stdout)['blockers'])
            ok = run('plan', '--inventory', str(path), '--exclude', 'public.no_pk=fixture')
            self.assertEqual(ok.returncode, 0, ok.stdout)
            bad = run('plan', '--inventory', str(path), '--publication', 'secret-like value')
            self.assertEqual((bad.returncode, json.loads(bad.stdout)['code']), (2, 'invalid_input_or_observation'))
            self.assertNotIn('secret-like', bad.stdout + bad.stderr)


class ReplicationStatusOfflineTests(unittest.TestCase):
    def setUp(self):
        self.plan = plan()

    def evaluate(self, pub, sub, lag=1024, retained=4096):
        return replication_status.evaluate(self.plan, pub, sub, max_lag_bytes=lag, max_retained_wal_bytes=retained)

    def test_healthy_observation_is_still_not_readiness(self):
        rows = {('public', 'items'): [[[1], 'a'], [[2], 'b']]}
        pub = publisher_capture(self.plan, samples=rows, counts={('public', 'items'): 2})
        sub = subscriber_capture(self.plan, pub, samples=rows, counts={('public', 'items'): 2})
        result = self.evaluate(pub, sub)
        self.assertEqual(result['blockingFindings'], 0, result['findings'])
        self.assertEqual(result['observations']['samples'], {'tables': 1, 'rows': 2, 'matched': 2, 'differs': 0, 'missingOnSubscriber': 0})
        self.assertEqual((result['readiness'], result['automaticDrAllowed']), ('unknown', False))
        self.assertIn('slot_wal_unbounded', codes(result, 'attention'))
        self.assertFalse(result['sealPrecondition']['satisfied'])

    def test_lag_retention_slot_and_subscription_failures_are_blocking(self):
        pub = publisher_capture(self.plan, lag=5000, retained=10_000)
        result = self.evaluate(pub, subscriber_capture(self.plan, pub, enabled=False, errors=2, workers=False,
                                                       states={('public', ODD): 'd'}))
        self.assertTrue({'lag_over_threshold_or_unknown', 'retained_wal_over_threshold_or_unknown', 'subscription_disabled',
                         'subscription_errors_observed', 'apply_worker_not_running', 'table_sync_incomplete'}
                        <= codes(result, 'blocking'))
        missing = publisher_capture(self.plan, slot=False)
        self.assertIn('slot_missing', codes(self.evaluate(missing, subscriber_capture(self.plan, missing)), 'blocking'))
        inactive = publisher_capture(self.plan, active=False)
        result = self.evaluate(inactive, subscriber_capture(self.plan, inactive))
        self.assertIn('slot_inactive', codes(result, 'blocking'))
        self.assertNotIn('sender_stats_not_visible', codes(result))

    def test_ddl_drift_and_unpublished_table_are_reported(self):
        columns = copy.deepcopy(COLUMNS)
        columns[('public', 'items')] = [('id', 'bigint', True), ('extra', 'text', True)]
        pub = publisher_capture(self.plan, extra_tables=[('public', 'late')])
        result = self.evaluate(pub, subscriber_capture(self.plan, pub, columns=columns))
        blocking = {f['code']: f for f in result['findings'] if f['severity'] == 'blocking'}
        self.assertEqual(blocking['unpublished_table']['relations'], [['public', 'late']])
        self.assertEqual(blocking['subscriber_column_missing']['items'], [['public', 'items', 'body']])
        self.assertEqual(blocking['subscriber_extra_required_column']['items'], [['public', 'items', 'extra']])

    def test_sample_and_count_differences_and_sequence_lag(self):
        pub = publisher_capture(self.plan, samples={('public', 'items'): [[[1], 'a'], [[2], 'b']]},
                                counts={('public', 'items'): 2}, sequences=50)
        sub = subscriber_capture(self.plan, pub, samples={('public', 'items'): [[[1], 'changed']]},
                                 counts={('public', 'items'): 1}, sequences=7)
        result = self.evaluate(pub, sub)
        self.assertTrue({'sample_row_differs', 'sample_row_missing_on_subscriber', 'row_count_differs'} <= codes(result, 'blocking'))
        self.assertIn('sequence_resync_required', codes(result, 'attention'))

    def test_subscriber_samples_must_come_from_the_same_publisher_capture(self):
        rows = {('public', 'items'): [[[1], 'a']]}
        pub = publisher_capture(self.plan, samples=rows)
        sub = subscriber_capture(self.plan, pub, samples=rows)
        other = publisher_capture(self.plan, samples={('public', 'items'): [[[9], 'z']]})
        self.assertIn('sample_keys_from_other_publisher_capture', codes(self.evaluate(other, sub), 'blocking'))

    def test_seal_precondition_requires_dropped_subscription_without_workers(self):
        pub = publisher_capture(self.plan)
        result = self.evaluate(pub, subscriber_capture(self.plan, pub, subscription=False, workers=False))
        self.assertTrue(result['sealPrecondition']['satisfied'])
        self.assertIn('subscription_missing', codes(result, 'blocking'))

    def test_forged_capture_is_rejected(self):
        pub = publisher_capture(self.plan)
        for mutate in (lambda c: c.__setitem__('automaticDrAllowed', True), lambda c: c.__setitem__('planHash', '0' * 64),
                       lambda c: c['catalogFrames'].pop(2), lambda c: c['catalogFrames'][0].__setitem__('currentLsn', 'zz')):
            value = copy.deepcopy(pub)
            mutate(value)
            with self.assertRaises((ValueError, KeyError, TypeError)):
                replication_status.validate_capture(value, self.plan, 'publisher')

    def test_capture_sql_is_read_only_and_quotes_identifiers(self):
        catalog = replication_status.parse_catalog('publisher', publisher_capture(self.plan)['catalogFrames'])
        sql = replication_status.data_sql(self.plan, 'publisher', catalog, 5, row_counts=True, sample_rows=3)
        self.assertTrue(sql.startswith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;'))
        self.assertTrue(sql.rstrip().endswith('ROLLBACK;'))
        self.assertIn('FROM ONLY "public"."we""ird" AS t TABLESAMPLE SYSTEM (1) REPEATABLE (14)', sql)
        for statement in ('INSERT', 'UPDATE ', 'DELETE', 'CREATE', 'DROP', 'ALTER', 'setval', 'nextval'):
            self.assertNotIn(statement, sql)


def capacity_capture(second, lsn, db_bytes, items_bytes, inserts, *, label='cap', recovery=False, slots=(), system='7000000000000000001',
                     wal_level='logical', keep='-1'):
    settings = {name: {'setting': '10', 'unit': None} for name in capacity.SETTINGS}
    settings.update(wal_level={'setting': wal_level, 'unit': None}, max_slot_wal_keep_size={'setting': keep, 'unit': 'MB'},
                    max_sync_workers_per_subscription={'setting': '2', 'unit': None})
    stamp = (datetime(2026, 10, 17, tzinfo=timezone.utc) + timedelta(seconds=second)).strftime('%Y-%m-%dT%H:%M:%S.%fZ')
    frames = [{'frame': 'start', 'at': stamp, 'database': {'name': 'nomorevibe', 'oid': 16384, 'systemIdentifier': system,
                                                           'user': 'observer', 'serverVersionNum': 170011, 'inRecovery': recovery,
                                                           'readOnly': True},
               'currentLsn': None if recovery else lsn, 'databaseBytes': db_bytes},
              {'frame': 'settings', 'settings': settings},
              {'frame': 'cluster', 'databases': 20, 'clientBackends': 105, 'walSenders': 1, 'walBytes': 1, 'walStatsReset': None,
               'slots': [{'name': n, 'type': 'physical', 'database': None, 'temporary': False, 'active': True, 'walStatus': 'reserved',
                          'retainedBytes': r} for n, r in slots]},
              {'frame': 'tables', 'tables': [{'relation': ['public', 'items'], 'totalBytes': items_bytes, 'heapBytes': items_bytes,
                                              'indexBytes': 0, 'toastBytes': 0, 'liveTuples': 1, 'deadTuples': 0, 'inserts': inserts,
                                              'updates': 0, 'deletes': 0}]},
              {'frame': 'end', 'at': stamp, 'currentLsn': None if recovery else lsn}]
    return capacity.validate_capture({'kind': capacity.KIND, 'version': 1, 'label': label, 'clientStartedAt': stamp,
                                      'clientFinishedAt': stamp, 'capturedAt': stamp, 'frames': frames,
                                      'readiness': 'unknown', 'automaticDrAllowed': False})


GIB = 1024 ** 3


class CapacityOfflineTests(unittest.TestCase):
    def run_eval(self, captures, **overrides):
        args = dict(target_free_bytes=20 * GIB, target_wal_reserve_bytes=2 * GIB, publisher_wal_free_bytes=50 * GIB,
                    horizon_days=30, outage_hours=12, seed_hours=3)
        args.update(overrides)
        return capacity.evaluate(captures, **args)

    def test_two_captures_give_conservative_rates_and_exact_arithmetic(self):
        first = capacity_capture(0, '0/0', 9 * GIB, 100, 10, slots=[('patroni', 4096)])
        second = capacity_capture(7200, '0/40000000', 9 * GIB + 200 * 1024 ** 2, 300, 30)
        result = self.run_eval([second, first])
        wal_per_hour = 0x40000000 / 2
        growth = 200 * 1024 ** 2 / 2 * 24
        self.assertEqual(result['rates']['clusterWalBytesPerHour'], wal_per_hour)
        self.assertEqual(result['rates']['databaseGrowthBytesPerDay'], growth)
        self.assertEqual(result['target']['requiredBytes'], 9 * GIB + 200 * 1024 ** 2 + growth * 30 + 2 * GIB)
        self.assertEqual(result['target']['verdict'], 'insufficient')
        self.assertEqual(result['publisherWal']['slotRetentionBytes'], wal_per_hour * 12)
        self.assertEqual(result['tables'][0]['growthBytesPerDay'], 200 / 2 * 24)
        self.assertEqual(result['tables'][0]['insertsPerDay'], 20 / 2 * 24)
        self.assertIn('slot_wal_unbounded', codes(result, 'attention'))
        self.assertEqual((result['readiness'], result['automaticDrAllowed']), ('unknown', False))

    def test_one_capture_cannot_claim_growth_but_can_prove_insufficient(self):
        only = capacity_capture(0, '0/0', 9 * GIB, 100, 10)
        result = self.run_eval([only])
        self.assertEqual(result['target']['verdict'], 'unknown')
        self.assertIn('growth_unknown_needs_two_primary_captures', codes(result, 'blocking'))
        self.assertEqual(self.run_eval([only], target_free_bytes=GIB)['target']['verdict'], 'insufficient')

    def test_within_bounds_wal_cap_and_restart_findings(self):
        first = capacity_capture(0, '0/0', GIB, 100, 10, wal_level='replica', keep='1024')
        second = capacity_capture(86400, '0/1000000', GIB + 1024, 101, 11, wal_level='replica', keep='1024')
        result = self.run_eval([first, second], publisher_wal_free_bytes=512 * 1024 ** 2)
        self.assertEqual(result['target']['verdict'], 'within_observed_bounds')
        self.assertTrue({'wal_level_change_requires_cluster_restart', 'slot_cap_exceeds_publisher_free'} <= codes(result, 'blocking'))
        self.assertNotIn('observation_window_short', codes(result))

    def test_lsn_regression_recovery_and_mixed_databases_are_not_rates(self):
        first = capacity_capture(0, '0/9000000', GIB, 1, 1)
        regressed = self.run_eval([first, capacity_capture(3600, '0/1000000', GIB, 1, 1)])
        self.assertIsNone(regressed['rates']['clusterWalBytesPerHour'])
        self.assertIn('rate_unknown', codes(regressed, 'blocking'))
        standby = self.run_eval([first, capacity_capture(3600, None, GIB, 1, 1, recovery=True)])
        self.assertEqual(standby['publisherWal']['verdict'], 'unknown')
        with self.assertRaises(ValueError):
            self.run_eval([first, capacity_capture(3600, '0/9000001', GIB, 1, 1, system='7000000000000000009')])
        with self.assertRaises(ValueError):
            self.run_eval([first], target_free_bytes=-1)

    def test_subscriber_capture_gives_sync_worker_need(self):
        first = capacity_capture(0, '0/0', GIB, 1, 1)
        second = capacity_capture(3600, '0/100', GIB, 1, 1)
        target = capacity_capture(10, '0/5', 1, 1, 1, system='7000000000000000002', label='r')
        result = self.run_eval([first, second], subscriber_capture=target)
        self.assertEqual(result['replicationHeadroom'], {'need': 3, 'freeSlots': 10, 'freeSenders': 9})


class ReplicationCliOfflineTests(unittest.TestCase):
    def test_capture_psql_failure_is_fixed_code_without_secret(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'plan.json').write_text(json.dumps(plan()))
            fake = root / 'psql'
            fake.write_text('#!' + sys.executable + '\nimport sys\nsys.stdin.read()\nsys.stderr.write("private-pass raw")\nsys.exit(4)\n')
            fake.chmod(0o755)
            url = 'postgres://nomorevibe:private-pass@127.0.0.1:55999/nomorevibe_test'
            for script, args in (('replication_status.py', ['capture', '--plan', str(root / 'plan.json'), '--side', 'publisher', '--label', 'x']),
                                 ('capacity.py', ['capture', '--label', 'x']),
                                 ('replication_plan.py', ['dry-run', '--plan', str(root / 'plan.json'), '--side', 'publisher'])):
                result = subprocess.run([sys.executable, str(SOURCE / script), *args, '--database-url-stdin', '--expect-database',
                                         'nomorevibe_test', '--expect-user', 'nomorevibe', '--psql', str(fake)], input=url,
                                        capture_output=True, text=True, timeout=30)
                with self.subTest(script=script):
                    self.assertEqual(result.returncode, 2)
                    self.assertEqual(json.loads(result.stdout)['code'], 'psql_failed')
                    self.assertNotIn('private-pass', result.stdout + result.stderr)


# ---------------------------------------------------------------------------------------------------------------------
ACTUAL_KEYS = ('PR14D_PUBLISHER_URL', 'PR14D_SUBSCRIBER_URL', 'PR14D_PUBLISHER_PSQL', 'PR14D_SUBSCRIBER_PSQL',
               'PR14D_PUBLISHER_CONTAINER', 'PR14D_SUBSCRIBER_CONTAINER', 'PR14D_PUBLISHER_REPLICATION_HOST', 'PR14D_OUTPUT')
NAMES = dict(publication='nomorevibe_oracle_dr', subscription='nomorevibe_oracle_dr', replication_role='nomorevibe_oracle_dr_replicator')
PASSWORD = 'pr14d-local-test-only'
FIXTURE_DDL = """CREATE SCHEMA pr14d_fixture;
CREATE TABLE pr14d_fixture.items (id bigserial PRIMARY KEY, body text NOT NULL, payload jsonb, amount numeric(12,3),
  seen_at timestamptz NOT NULL DEFAULT clock_timestamp(), doubled bigint GENERATED ALWAYS AS (id * 2) STORED);
CREATE TABLE pr14d_fixture.composite (a integer, b text, v integer NOT NULL, PRIMARY KEY (a, b));
CREATE TABLE pr14d_fixture.vectors (id integer PRIMARY KEY, emb public.vector(3) NOT NULL, raw bytea);
CREATE TABLE pr14d_fixture."odd ""name" (k text PRIMARY KEY, n double precision);
"""
FIXTURE_DATA = """INSERT INTO pr14d_fixture.items (body, payload, amount) SELECT 'row ' || g, jsonb_build_object('g', g, 's', repeat('x', g % 7)), g * 1.125 FROM generate_series(1, 300) g;
INSERT INTO pr14d_fixture.composite SELECT g % 10, 'k' || g, g FROM generate_series(1, 60) g;
INSERT INTO pr14d_fixture.vectors SELECT g, ('[' || g || ',' || g + 1 || ',' || g + 2 || ']')::public.vector, decode(md5(g::text), 'hex') FROM generate_series(1, 20) g;
INSERT INTO pr14d_fixture."odd ""name" VALUES ('a''b', 0.1), ('ü', 1e-7);
"""
STREAM_CHANGES = """INSERT INTO pr14d_fixture.items (body) SELECT 'stream ' || g FROM generate_series(1, 50) g;
UPDATE pr14d_fixture.items SET body = body || ' updated', amount = amount + 1 WHERE id % 10 = 0;
DELETE FROM pr14d_fixture.items WHERE id % 13 = 0;
UPDATE pr14d_fixture.composite SET v = v * 2 WHERE a = 3;
DELETE FROM pr14d_fixture.composite WHERE a = 4;
UPDATE pr14d_fixture.vectors SET emb = '[9,9,9]' WHERE id = 1;
UPDATE dr_writer_fence SET state = 'fenced', reason = 'operator_fence', fenced_db = '{"systemIdentifier":"1","databaseOid":"1","databaseName":"pr14d"}'::jsonb WHERE id = 1;
INSERT INTO dr_fence_events (lineage_id, from_epoch, to_epoch, from_state, to_state, reason, db_identity, operator)
  SELECT lineage_id, 1, 1, 'active', 'fenced', 'operator_fence', '{"pr14d":1}'::jsonb, 'pr14d-test' FROM dr_writer_fence;
"""


def env(key):
    return os.environ[key]


@unittest.skipUnless(all(os.environ.get(k) for k in ACTUAL_KEYS), 'Actual PR14d needs two assigned local PG17 (wal_level=logical) and adapters')
class ReplicationActualTests(unittest.TestCase):
    """두 전용 컨테이너에서 생성된 SQL을 실제로 실행한다. 운영 DB에는 접속하지 않는다."""
    evidence = {}

    @classmethod
    def setUpClass(cls):
        # 고정 이름 fixture schema가 처음부터 없어야 한다(다른 DB/재사용 방지).
        assert cls.sql('pub', "SELECT count(*) FROM pg_namespace WHERE nspname = 'pr14d_fixture';") == '0'
        assert cls.sql('pub', "SELECT current_setting('wal_level');") == 'logical'
        cls.sql('pub', 'BEGIN;\n' + FIXTURE_DDL + FIXTURE_DATA + 'COMMIT;')

    @classmethod
    def tearDownClass(cls):
        Path(env('PR14D_OUTPUT'), 'actual-evidence.json').write_text(json.dumps(cls.evidence, indent=1, sort_keys=True, default=str))

    @staticmethod
    def sql(side, text, database='nomorevibe_test', check=True):
        container = env('PR14D_PUBLISHER_CONTAINER' if side == 'pub' else 'PR14D_SUBSCRIBER_CONTAINER')
        result = subprocess.run(['/opt/homebrew/bin/docker', 'exec', '-i', '-e', 'PGAPPNAME=nomorevibe-oracle-dr-fixture', container,
                                 'psql', '-U', 'nomorevibe', '-d', database, '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
                                input=text, capture_output=True, text=True, timeout=180)
        if check and result.returncode:
            raise AssertionError(f'fixture_sql_failed:{side}:{result.returncode}:{result.stderr[-400:]}')
        return result.stdout.strip()

    @staticmethod
    def docker(*args, input_bytes=None, timeout=300):
        result = subprocess.run(['/opt/homebrew/bin/docker', *args], input=input_bytes, capture_output=True, timeout=timeout)
        if result.returncode:
            raise AssertionError('docker_failed:' + ' '.join(args[:3]) + ':' + result.stderr.decode()[-400:])
        return result.stdout

    def url(self, side, database='nomorevibe_test'):
        value = env('PR14D_PUBLISHER_URL' if side == 'pub' else 'PR14D_SUBSCRIBER_URL')
        return value.rsplit('/', 1)[0] + '/' + database

    def psql(self, side):
        return env('PR14D_PUBLISHER_PSQL' if side == 'pub' else 'PR14D_SUBSCRIBER_PSQL')

    def inventory(self):
        return preflight.collect(self.url('pub'), side='source', label='pr14d-local-publisher', expected_database='nomorevibe_test',
                                 expected_user='nomorevibe', psql=self.psql('pub'))

    def capture(self, the_plan, side, label, *, database='nomorevibe_test', samples=5, counts=True, source=None):
        return replication_status.capture(the_plan, self.url(side, database), side='publisher' if side == 'pub' else 'subscriber',
                                          label=label, expected_database=database, expected_user='nomorevibe', psql=self.psql(side),
                                          timeout=30, row_counts=counts, sample_rows=samples if side == 'pub' or source else 0,
                                          publisher_capture=source)

    def status(self, the_plan, label, *, database='nomorevibe_test', lag=1024 * 1024, retained=256 * 1024 ** 2):
        pub = self.capture(the_plan, 'pub', label + '-pub')
        sub = self.capture(the_plan, 'sub', label + '-sub', database=database, source=pub)
        result = replication_status.evaluate(the_plan, pub, sub, max_lag_bytes=lag, max_retained_wal_bytes=retained)
        self.last_pair = (pub, sub)
        self.evidence[label] = {'findings': result['findings'], 'observations': result['observations'],
                                'seal': result['sealPrecondition']}
        return pub, sub, result

    def wait(self, side, query, expected, database='nomorevibe_test', seconds=90):
        deadline, value = time.monotonic() + seconds, None
        while time.monotonic() < deadline:
            value = self.sql(side, query, database)
            if value == expected:
                return
            time.sleep(0.5)
        raise AssertionError(f'wait_timeout:{query[:80]}:{value}')

    def wait_caught_up(self, database='nomorevibe_test'):
        self.wait('sub', "SELECT count(*) FROM pg_subscription_rel WHERE srsubstate <> 'r';", '0', database)
        target = self.sql('pub', 'SELECT pg_current_wal_lsn();')
        self.wait('pub', f"SELECT confirmed_flush_lsn >= '{target}'::pg_lsn FROM pg_replication_slots WHERE slot_name = '{NAMES['subscription']}';", 't')

    def run_statements(self, side, statements, database='nomorevibe_test', prefix=''):
        return self.sql(side, prefix + ';\n'.join(statements) + ';\n', database)

    def create_publisher_objects(self, the_plan):
        # 운영 절차는 psql의 \password 입력이다. 대화형 입력을 쓸 수 없는 test만 ALTER ROLE로 대신한다.
        self.run_statements('pub', the_plan['sql']['publisherRole'] + [f"ALTER ROLE {NAMES['replication_role']} PASSWORD '{PASSWORD}'"]
                            + the_plan['sql']['publisher'])

    def create_subscription(self, the_plan, mode, database='nomorevibe_test'):
        conninfo = (f"host={env('PR14D_PUBLISHER_REPLICATION_HOST')} port=5432 dbname=nomorevibe_test "
                    f"user={NAMES['replication_role']} password={PASSWORD}")
        self.run_statements('sub', the_plan['sql']['subscriberCopySeed' if mode == 'copy' else 'subscriberDumpSeed'], database,
                            prefix=f"\\set publisher_conninfo '{conninfo}'\n")

    def emergency_cleanup(self, the_plan, database):
        errors = []
        for side, statements, db in (('sub', the_plan['sql']['rollback']['subscriber'], database),
                                     ('pub', the_plan['sql']['rollback']['publisherSlotForce'], 'nomorevibe_test'),
                                     ('pub', the_plan['sql']['rollback']['publisherSlot'], 'nomorevibe_test'),
                                     ('pub', the_plan['sql']['rollback']['publisherObjects'], 'nomorevibe_test')):
            for statement in statements:
                try:
                    self.sql(side, statement + ';', db)
                except AssertionError as error:
                    errors.append(str(error)[:200])
            time.sleep(0.5)
        return errors

    def assert_clean_publisher(self):
        self.assertEqual(self.sql('pub', "SELECT count(*) FROM pg_replication_slots;"), '0')
        self.assertEqual(self.sql('pub', "SELECT count(*) FROM pg_publication;"), '0')
        self.assertEqual(self.sql('pub', f"SELECT count(*) FROM pg_roles WHERE rolname = '{NAMES['replication_role']}';"), '0')

    def rebuild_subscriber(self, database, *, migrated):
        self.sql('sub', f'DROP DATABASE IF EXISTS {database} WITH (FORCE);', 'postgres')
        self.sql('sub', f'CREATE DATABASE {database};', 'postgres')
        if migrated:
            result = subprocess.run(['node', 'scripts/migrate.mjs'], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True,
                                    env={**os.environ, 'MIGRATION_DATABASE_URL': self.url('sub', database)}, timeout=300)
            self.assertEqual(result.returncode, 0, result.stderr[-400:])
            self.sql('sub', FIXTURE_DDL, database)
            return
        schema = self.docker('exec', env('PR14D_PUBLISHER_CONTAINER'), 'pg_dump', '-U', 'nomorevibe', '-d', 'nomorevibe_test',
                             '--schema-only', '--no-publications', '--no-subscriptions')
        journal = self.docker('exec', env('PR14D_PUBLISHER_CONTAINER'), 'pg_dump', '-U', 'nomorevibe', '-d', 'nomorevibe_test',
                              '--data-only', '--table=drizzle.__drizzle_migrations')
        for script in (schema, journal):
            self.docker('exec', '-i', env('PR14D_SUBSCRIBER_CONTAINER'), 'psql', '-U', 'nomorevibe', '-d', database, '-X', '-q',
                        '-v', 'ON_ERROR_STOP=1', input_bytes=script)

    def seeded_rows_truth(self, the_plan, database):
        parts = [f"SELECT '{t['schema']}.{t['name']}' WHERE EXISTS (SELECT 1 FROM ONLY {common.qualified(t['schema'], t['name'])})"
                 for t in the_plan['tables']]
        return sorted(line for line in self.sql('sub', '\nUNION ALL\n'.join(parts) + ';', database).splitlines() if line)

    def test_actual_copy_seed_lifecycle(self):
        the_plan, errors = None, []
        try:
            inventory = self.inventory()
            the_plan = replication_plan.build_plan(inventory, **NAMES)
            self.assertEqual(the_plan['blockers'], [])
            names = {(t['schema'], t['name']) for t in the_plan['tables']}
            self.assertTrue({('pr14d_fixture', 'items'), ('pr14d_fixture', 'odd "name'), ('public', 'dr_writer_fence')} <= names)
            self.assertNotIn(('drizzle', '__drizzle_migrations'), names)
            self.evidence['plan'] = {'tables': len(the_plan['tables']), 'sequences': len(the_plan['sequences']),
                                     'excluded': the_plan['excluded'], 'hash': replication_plan.plan_hash(the_plan)}
            dry = replication_plan.dry_run(the_plan, self.url('pub'), side='publisher', expected_database='nomorevibe_test',
                                           expected_user='nomorevibe', psql=self.psql('pub'), timeout=10)
            self.assertEqual(dry['findings'], [])
            self.assertEqual(dry['observed']['publishedTables'], len(the_plan['tables']))
            self.assert_clean_publisher()  # BEGIN…ROLLBACK 뒤 publication/role 0
            # RED(실제): migration으로 만든 R은 제어 표 seed 행 때문에 copy seed와 충돌한다.
            self.rebuild_subscriber('nomorevibe_test', migrated=True)
            dry = replication_plan.dry_run(the_plan, self.url('sub'), side='subscriber', expected_database='nomorevibe_test',
                                           expected_user='nomorevibe', psql=self.psql('sub'), timeout=10)
            truth = self.seeded_rows_truth(the_plan, 'nomorevibe_test')
            self.assertIn('public.dr_writer_fence', truth)
            self.assertEqual(dry['findings'], [{'code': 'copy_seed_target_not_empty', 'relations': [x.split('.', 1) for x in truth]}])
            self.evidence['migratedSubscriberDryRun'] = dry['findings']
            self.assertEqual(self.sql('sub', 'SELECT count(*) FROM pg_subscription;'), '0')
            # 절차대로 schema-only + journal 데이터로 다시 만든다.
            self.rebuild_subscriber('nomorevibe_test', migrated=False)
            dry = replication_plan.dry_run(the_plan, self.url('sub'), side='subscriber', expected_database='nomorevibe_test',
                                           expected_user='nomorevibe', psql=self.psql('sub'), timeout=10)
            self.assertEqual(dry['findings'], [])
            self.assertEqual(self.sql('sub', 'SELECT count(*) FROM drizzle.__drizzle_migrations;'),
                             self.sql('pub', 'SELECT count(*) FROM drizzle.__drizzle_migrations;'))
            self.create_publisher_objects(the_plan)
            self.create_subscription(the_plan, 'copy')
            self.wait_caught_up()
            self.sql('pub', STREAM_CHANGES)
            self.wait_caught_up()
            _, _, result = self.status(the_plan, 'copyHealthy')
            self.assertEqual(result['blockingFindings'], 0, result['findings'])
            self.assertGreater(result['observations']['samples']['matched'], 20)
            self.assertEqual(result['observations']['samples']['rows'], result['observations']['samples']['matched'])
            fence = 'SELECT row_to_json(f)::text FROM (SELECT lineage_id, writer_epoch, state, reason, fenced_db FROM dr_writer_fence) f;'
            self.assertEqual(self.sql('sub', fence), self.sql('pub', fence))
            self.assertIn('"state":"fenced"', self.sql('sub', fence))
            # 분기: R에서 직접 고친 행은 표본 hash로 드러난다.
            self.sql('sub', "UPDATE pr14d_fixture.items SET body = 'diverged' WHERE id = 1;")
            _, _, result = self.status(the_plan, 'subscriberDivergence')
            self.assertIn('sample_row_differs', codes(result, 'blocking'))
            self.sql('pub', "UPDATE pr14d_fixture.items SET body = 'repaired from publisher' WHERE id = 1;")
            self.wait_caught_up()
            # apply 충돌: disable_on_error로 구독이 멈추고 slot이 WAL을 붙잡는다.
            self.sql('sub', "INSERT INTO pr14d_fixture.composite VALUES (99, 'conflict', 1);")
            self.sql('pub', "INSERT INTO pr14d_fixture.composite VALUES (99, 'conflict', 2);")
            self.wait('sub', f"SELECT subenabled FROM pg_subscription WHERE subname = '{NAMES['subscription']}';", 'f')
            self.sql('pub', "INSERT INTO pr14d_fixture.items (body, payload) SELECT 'while stopped ' || g, jsonb_build_object('pad', repeat('p', 500)) FROM generate_series(1, 400) g;")
            _, _, result = self.status(the_plan, 'applyConflict', lag=1024, retained=1024)
            self.assertTrue({'subscription_disabled', 'subscription_errors_observed', 'apply_worker_not_running', 'slot_inactive',
                             'lag_over_threshold_or_unknown', 'retained_wal_over_threshold_or_unknown'} <= codes(result, 'blocking'))
            with tempfile.TemporaryDirectory() as temp:
                files = {}
                for key, value in (('plan', the_plan), ('pub', self.last_pair[0]), ('sub', self.last_pair[1])):
                    files[key] = Path(temp, key + '.json')
                    files[key].write_text(json.dumps(value))
                cli = subprocess.run([sys.executable, str(SOURCE / 'replication_status.py'), 'evaluate', '--plan', str(files['plan']),
                                      '--publisher', str(files['pub']), '--subscriber', str(files['sub']), '--max-lag-bytes', '1024',
                                      '--max-retained-wal-bytes', '1024'], capture_output=True, text=True, timeout=60)
                self.assertEqual(cli.returncode, 3, cli.stdout[-300:])
            self.sql('sub', "DELETE FROM pr14d_fixture.composite WHERE a = 99 AND b = 'conflict';")
            self.sql('sub', f"SELECT pg_stat_reset_subscription_stats(oid) FROM pg_subscription WHERE subname = '{NAMES['subscription']}';")
            self.sql('sub', f"ALTER SUBSCRIPTION {NAMES['subscription']} ENABLE;")
            self.wait_caught_up()
            _, _, result = self.status(the_plan, 'afterConflictRepair')
            self.assertEqual(result['blockingFindings'], 0, result['findings'])
            # DDL은 복제되지 않는다: publisher만 열을 추가하면 apply가 멈추고 열 차이가 보인다.
            self.sql('pub', "ALTER TABLE pr14d_fixture.items ADD COLUMN note text NOT NULL DEFAULT 'n';")
            self.sql('pub', "INSERT INTO pr14d_fixture.items (body) VALUES ('after ddl');")
            self.wait('sub', f"SELECT subenabled FROM pg_subscription WHERE subname = '{NAMES['subscription']}';", 'f')
            _, _, result = self.status(the_plan, 'ddlDrift')
            drift = {f['code']: f for f in result['findings']}
            self.assertEqual(drift['subscriber_column_missing']['items'], [['pr14d_fixture', 'items', 'note']])
            self.sql('sub', "ALTER TABLE pr14d_fixture.items ADD COLUMN note text NOT NULL DEFAULT 'n';")
            self.sql('sub', f"SELECT pg_stat_reset_subscription_stats(oid) FROM pg_subscription WHERE subname = '{NAMES['subscription']}';")
            self.sql('sub', f"ALTER SUBSCRIPTION {NAMES['subscription']} ENABLE;")
            self.wait_caught_up()
            _, _, result = self.status(the_plan, 'afterDdlRepair')
            self.assertEqual(result['blockingFindings'], 0, result['findings'])
            # 새 표는 publication에 자동으로 들어가지 않는다(명시 목록).
            self.sql('pub', 'CREATE TABLE pr14d_fixture.late (id integer PRIMARY KEY, v text); INSERT INTO pr14d_fixture.late VALUES (1, \'x\');')
            _, _, result = self.status(the_plan, 'unpublishedTable')
            self.assertEqual({f['code']: f for f in result['findings']}['unpublished_table']['relations'], [['pr14d_fixture', 'late']])
            self.sql('sub', 'CREATE TABLE pr14d_fixture.late (id integer PRIMARY KEY, v text);')
            self.sql('pub', f"ALTER PUBLICATION {NAMES['publication']} ADD TABLE pr14d_fixture.late; GRANT SELECT ON pr14d_fixture.late TO {NAMES['replication_role']};")
            self.sql('sub', f"ALTER SUBSCRIPTION {NAMES['subscription']} REFRESH PUBLICATION;")
            self.wait_caught_up()
            _, _, stale = self.status(the_plan, 'stalePlan')
            self.assertIn('publication_tables_differ_from_plan', codes(stale, 'blocking'))
            the_plan = replication_plan.build_plan(self.inventory(), **NAMES)
            _, _, result = self.status(the_plan, 'refreshedPlan')
            self.assertEqual(result['blockingFindings'], 0, result['findings'])
            self.assertEqual(self.sql('sub', 'SELECT v FROM pr14d_fixture.late;'), 'x')
            self.capacity_flow()
            self.cutover_flow(the_plan)
        except BaseException as error:
            errors.append(error)
        finally:
            # 실패했을 때만 남은 구독/slot/publication/role을 정리한다(원 오류는 보존).
            if errors and the_plan is not None and the_plan.get('sql'):
                self.evidence['copyCleanupErrors'] = self.emergency_cleanup(the_plan, 'nomorevibe_test')
        if errors:
            raise BaseExceptionGroup('copy_seed_lifecycle_failed', errors)
        self.assert_clean_publisher()

    def capacity_flow(self):
        run = dict(expected_database='nomorevibe_test', expected_user='nomorevibe', timeout=30)
        first = capacity.capture(self.url('pub'), label='pr14d-cap-1', psql=self.psql('pub'), **run)
        self.sql('pub', "INSERT INTO pr14d_fixture.items (body, payload) SELECT 'cap ' || g, jsonb_build_object('pad', repeat('c', 1000)) FROM generate_series(1, 3000) g;")
        time.sleep(1)
        second = capacity.capture(self.url('pub'), label='pr14d-cap-2', psql=self.psql('pub'), **run)
        target = capacity.capture(self.url('sub'), label='pr14d-cap-r', psql=self.psql('sub'), **run)
        result = capacity.evaluate([first, second], target_free_bytes=10 * GIB, target_wal_reserve_bytes=GIB,
                                   publisher_wal_free_bytes=5 * GIB, horizon_days=30, outage_hours=24, seed_hours=2,
                                   subscriber_capture=target)
        a, b = (capacity.parse_frames(c['frames']) for c in (first, second))
        hours = capacity._hours(a['at'], b['at'])
        wal = (common.lsn(b['currentLsn']) - common.lsn(a['currentLsn'])) / hours
        self.assertEqual(result['rates']['clusterWalBytesPerHour'], wal)
        self.assertGreater(wal, 0)
        self.assertEqual(result['publisherWal']['slotRetentionBytes'], wal * 24)
        self.assertEqual(result['publisherWal']['verdict'] == 'insufficient', wal * 24 > 5 * GIB)
        self.assertEqual(result['replicationHeadroom']['need'], 3)
        self.assertIn('observation_window_short', codes(result, 'attention'))
        items = next(t for t in result['tables'] if t['relation'] == ['pr14d_fixture', 'items'])
        self.assertGreater(items['growthBytesPerDay'], 0)
        tight = capacity.evaluate([first, second], target_free_bytes=1000, target_wal_reserve_bytes=GIB, publisher_wal_free_bytes=5 * GIB,
                                  horizon_days=30, outage_hours=24, seed_hours=2)
        self.assertEqual(tight['target']['verdict'], 'insufficient')
        self.evidence['capacity'] = {k: result[k] for k in ('rates', 'target', 'publisherWal', 'replicationHeadroom', 'findings', 'latest')}

    def cutover_flow(self, the_plan):
        # 쓰기 0·lag 0에서의 최종 대조만 cutover 증거로 쓴다.
        self.wait_caught_up()
        pub, _, result = self.status(the_plan, 'cutoverFinal')
        self.assertEqual(result['blockingFindings'], 0, result['findings'])
        self.assertIn('sequence_resync_required', codes(result, 'attention'))
        self.run_statements('sub', the_plan['sql']['rollback']['subscriber'])
        _, _, dropped = self.status(the_plan, 'afterSubscriptionDrop')
        self.assertTrue(dropped['sealPrecondition']['satisfied'])
        self.assertTrue({'subscription_missing', 'slot_inactive'} <= codes(dropped, 'blocking'))
        sync = replication_plan.sequence_sync_sql(the_plan, margin=1000, publisher_capture=pub)
        self.assertEqual(sync['manual'], [])
        self.run_statements('sub', sync['sql'])
        pub_items = int(self.sql('pub', 'SELECT last_value FROM pr14d_fixture.items_id_seq;'))
        self.assertEqual(int(self.sql('sub', 'SELECT last_value FROM pr14d_fixture.items_id_seq;')), pub_items + 1000)
        before = self.sql('sub', 'SELECT string_agg(last_value::text, \',\' ORDER BY sequencename) FROM pg_sequences;')
        fallback = replication_plan.sequence_sync_sql(the_plan, margin=1)
        self.run_statements('sub', fallback['sql'])
        after = self.sql('sub', 'SELECT string_agg(last_value::text, \',\' ORDER BY sequencename) FROM pg_sequences;')
        self.assertTrue(all(int(y) >= int(x) for x, y in zip(before.split(','), after.split(','))))
        new_id = int(self.sql('sub', "INSERT INTO pr14d_fixture.items (body) VALUES ('after cutover') RETURNING id;"))
        self.assertGreater(new_id, pub_items + 1000)
        self.run_statements('pub', the_plan['sql']['rollback']['publisherSlot'])
        self.run_statements('pub', the_plan['sql']['rollback']['publisherObjects'])
        self.assert_clean_publisher()
        self.evidence['cutover'] = {'sequenceSync': sync, 'fallbackStatements': len(fallback['sql']), 'newIdOnR': new_id,
                                    'publisherItemsLastValue': pub_items}

    def test_actual_dump_seed_lifecycle(self):
        the_plan, errors, database = None, [], 'nomorevibe_dump'
        try:
            the_plan = replication_plan.build_plan(self.inventory(), **NAMES)
            self.create_publisher_objects(the_plan)  # publication은 slot보다 먼저 있어야 decode가 찾는다
            marker = "SELECT count(*) FROM pr14d_fixture.items WHERE body LIKE 'dump-gap %';"
            session = (the_plan['sql']['dumpSeedReplicationCommand'] + ' \\gset slot_\n'
                       '\\setenv PR14D_SNAPSHOT :slot_snapshot_name\n'
                       "\\! psql -U nomorevibe -d nomorevibe_test -X -q -c \"INSERT INTO pr14d_fixture.items (body) SELECT 'dump-gap ' || g FROM generate_series(1, 25) g\"\n"
                       '\\! pg_dump -U nomorevibe -d nomorevibe_test -Fc --no-publications --no-subscriptions --snapshot="$PR14D_SNAPSHOT" -f /tmp/pr14d-dump-seed.fc\n'
                       '\\echo :slot_snapshot_name\n')
            output = self.docker('exec', '-i', env('PR14D_PUBLISHER_CONTAINER'), 'psql', 'dbname=nomorevibe_test replication=database user=nomorevibe',
                                 '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', input_bytes=session.encode()).decode()
            self.assertRegex(output.strip(), r'^[0-9A-F]{8}-[0-9A-F]{8}-\d+$')
            self.assertEqual(self.sql('pub', marker), '25')
            self.sql('sub', f'DROP DATABASE IF EXISTS {database} WITH (FORCE);', 'postgres')
            self.sql('sub', f'CREATE DATABASE {database};', 'postgres')
            # 절차 prepare_r: dump가 GRANT로 참조하는 role을 R에 먼저 만든다(R에서는 로그인 불가).
            self.sql('sub', f"CREATE ROLE {NAMES['replication_role']} NOLOGIN;", 'postgres')
            archive = self.docker('exec', env('PR14D_PUBLISHER_CONTAINER'), 'cat', '/tmp/pr14d-dump-seed.fc')
            self.docker('exec', '-i', env('PR14D_SUBSCRIBER_CONTAINER'), 'pg_restore', '-U', 'nomorevibe', '-d', database,
                        '--exit-on-error', '--single-transaction', input_bytes=archive)
            # snapshot 뒤에 쓴 행은 dump에 없어야 하고 복제로만 와야 한다(중복·누락 0).
            self.assertEqual(self.sql('sub', marker, database), '0')
            self.sql('pub', "UPDATE pr14d_fixture.items SET body = body || ' after-restore' WHERE id IN (SELECT id FROM pr14d_fixture.items ORDER BY id LIMIT 3);")
            self.create_subscription(the_plan, 'dump', database)
            self.wait_caught_up(database)
            self.assertEqual(self.sql('sub', marker, database), '25')
            _, _, result = self.status(the_plan, 'dumpSeedHealthy', database=database)
            self.assertEqual(result['blockingFindings'], 0, result['findings'])
            self.assertEqual(result['observations']['samples']['rows'], result['observations']['samples']['matched'])
            self.evidence['dumpSeed'] = {'snapshot': output.strip(), 'archiveBytes': len(archive)}
            self.run_statements('sub', the_plan['sql']['rollback']['subscriber'], database)
            self.run_statements('pub', the_plan['sql']['rollback']['publisherSlot'])
            self.run_statements('pub', the_plan['sql']['rollback']['publisherObjects'])
            self.assert_clean_publisher()
        except BaseException as error:
            errors.append(error)
        finally:
            # 실패했을 때만 남은 구독/slot/publication/role을 정리한다(원 오류는 보존).
            if errors and the_plan is not None and the_plan.get('sql'):
                self.evidence['dumpCleanupErrors'] = self.emergency_cleanup(the_plan, database)
            for statement in (f'DROP DATABASE IF EXISTS {database} WITH (FORCE);', f"DROP ROLE IF EXISTS {NAMES['replication_role']};"):
                try:
                    self.sql('sub', statement, 'postgres')
                except AssertionError as error:
                    errors.append(error)
        if errors:
            raise BaseExceptionGroup('dump_seed_lifecycle_failed', errors)


if __name__ == '__main__':
    unittest.main()
