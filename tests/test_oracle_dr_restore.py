"""Only isolated local fixtures; actual class needs explicitly allocated identities."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/ops/oracle-dr'))
import restore_contract as contract
import restore_rehearsal as rehearsal


def identity(side='source'):
    return {'id': ('a' if side == 'source' else 'b') * 64,
            'name': f'nomorevibe-logical-restore-{side}-a-20261016',
            'volume': f'nomorevibe-logical-restore-{side}-a-20261016-data',
            'port': 55553 if side == 'source' else 55554,
            'scope': f'pipeline-local-logical-restore-{side}-20261016',
            'image': contract.PINNED_IMAGE, 'state': 'created',
            'sourceHead': 'a' * 40, 'memoryBytes': 805306368}


def snapshot():
    return {'database': {'name': 'nomorevibe_test', 'user': 'nomorevibe',
                         'version': 170011, 'encoding': 'UTF8', 'collation': 'C',
                         'ctype': 'C', 'recovery': False},
            'catalog': {'relations': [{'schema': 'public', 'name': 'human', 'kind': 'r'}],
                        'sequences': [{'schema': 'public', 'name': 's', 'last': '9007199254740993', 'called': False}],
                        'largeObjects': [{'oid': '9123', 'pages': '00ff'}],
                        'extensions': [{'name': 'vector', 'version': '0.8.6'}]},
            'data': {'public.human': {'count': 2, 'sha256': 'a' * 64}}}


class OfflineContractTests(unittest.TestCase):
    def test_valid_local_identity_control(self):
        self.assertEqual(contract.parse_identity(identity()), identity())

    def test_rejects_same_source_target(self):
        with self.assertRaises(contract.RestoreError):
            contract.check_pair(identity(), identity())

    def test_identity_is_strict_and_positive(self):
        for field, value in [('port', True), ('memoryBytes', 0), ('id', 'abc'),
                             ('scope', 'production'), ('image', 'latest')]:
            with self.subTest(field=field), self.assertRaises(contract.RestoreError):
                contract.parse_identity({**identity(), field: value})

    def test_nonempty_target_rejected(self):
        with self.assertRaisesRegex(contract.RestoreError, 'target_not_empty'):
            contract.assert_empty({'objects': 1})

    def test_exact_full_snapshot_control(self):
        report = contract.compare_snapshots(snapshot(), copy.deepcopy(snapshot()))
        self.assertEqual(report['outcome'], 'local_restore_verified')
        self.assertEqual(report['readiness'], 'unknown')
        self.assertIs(report['automaticDrAllowed'], False)

    def test_each_logical_mismatch_is_rejected(self):
        for path, value in [(('catalog', 'sequences', 0, 'called'), True),
                            (('catalog', 'largeObjects', 0, 'pages'), '00fe'),
                            (('catalog', 'extensions', 0, 'version'), '0.8.5'),
                            (('catalog', 'relations', 0, 'kind'), 'p'),
                            (('data', 'public.human', 'sha256'), 'b' * 64)]:
            changed = copy.deepcopy(snapshot())
            node = changed
            for key in path[:-1]:
                node = node[key]
            node[path[-1]] = value
            with self.subTest(path=path), self.assertRaisesRegex(contract.RestoreError, 'restore_mismatch'):
                contract.compare_snapshots(snapshot(), changed)

    def test_archive_tamper_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            archive = Path(folder) / 'dump'
            archive.write_bytes(b'PGDMPtest')
            receipt = contract.archive_receipt(archive)
            archive.write_bytes(b'PGDMPtamp')
            with self.assertRaisesRegex(contract.RestoreError, 'archive_changed'):
                contract.verify_archive(archive, receipt)

    def test_original_and_cleanup_objects_are_preserved(self):
        first = RuntimeError('dsn-canary')
        second = OSError('private-stderr-canary')
        with self.assertRaises(BaseExceptionGroup) as raised:
            rehearsal.finish_errors(first, [second])
        self.assertIs(raised.exception.exceptions[0], first)
        self.assertIs(raised.exception.exceptions[1], second)
        self.assertNotIn('canary', json.dumps(rehearsal.safe_error(raised.exception)))


class OfflineChildTests(unittest.TestCase):
    def test_real_child_drains_both_pipes_and_settles(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / 'out'
            result = rehearsal._run_child([sys.executable, '-I', '-S', '-c',
                'import sys; sys.stderr.buffer.write(b"e"*200000); sys.stdout.buffer.write(b"x"*200000)'],
                out, limit=300000)
            self.assertEqual(result['exit'], 0)
            self.assertEqual(out.stat().st_size, 200000)
            self.assertEqual(Path(str(out) + '.stderr').stat().st_size, 200000)
            self.assertEqual(rehearsal.ACTIVE_CHILDREN, set())

    def test_archive_cap_settles_flooding_child(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(contract.RestoreError, 'stdout_limit'):
                rehearsal._run_child([sys.executable, '-I', '-S', '-c',
                    'import sys;\nwhile True: sys.stdout.buffer.write(b"x"*65536); sys.stdout.buffer.flush()'],
                    Path(folder) / 'out', limit=100)
            self.assertEqual(rehearsal.ACTIVE_CHILDREN, set())

    def test_timeout_settles_real_child(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(rehearsal, 'CHILD_SECONDS', .05):
            with self.assertRaisesRegex(contract.RestoreError, 'child_timeout'):
                rehearsal._run_child([sys.executable, '-I', '-S', '-c', 'import time; time.sleep(30)'],
                                     Path(folder) / 'out', limit=100)
            self.assertEqual(rehearsal.ACTIVE_CHILDREN, set())

    def test_no_overwrite_or_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            out = Path(folder) / 'out'
            out.write_bytes(b'original')
            with self.assertRaises(OSError):
                rehearsal._private_file(out)
            link = Path(folder) / 'link'
            link.symlink_to(out)
            with self.assertRaises(OSError):
                rehearsal._private_file(link)
            self.assertEqual(out.read_bytes(), b'original')

    def test_short_writes_are_completed(self):
        class ShortWriter:
            def __init__(self):
                self.data = bytearray()
            def write(self, value):
                self.data.extend(value[:2])
                return min(2, len(value))
        stream = ShortWriter()
        rehearsal._write_all(stream, b'abcdefg')
        self.assertEqual(stream.data, b'abcdefg')

    def test_enospc_original_object_survives_child_settlement(self):
        failure = OSError(28, 'private-canary')
        original = rehearsal._write_all
        def fail(stream, value):
            if value.startswith(b'payload'):
                raise failure
            return original(stream, value)
        with tempfile.TemporaryDirectory() as folder, patch.object(rehearsal, '_write_all', fail):
            with self.assertRaises(OSError) as raised:
                rehearsal._run_child([sys.executable, '-I', '-S', '-c', 'print("payload")'],
                                     Path(folder) / 'out', limit=100)
            self.assertIs(raised.exception, failure)
            self.assertEqual(rehearsal.ACTIVE_CHILDREN, set())

    def test_input_symlink_rejected_before_starting_child(self):
        with tempfile.TemporaryDirectory() as folder:
            real, link = Path(folder) / 'real', Path(folder) / 'link'
            real.write_bytes(b'private-data')
            link.symlink_to(real)
            with self.assertRaises(OSError):
                rehearsal._run_child([sys.executable, '-I', '-S', '-c',
                    'import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())'],
                    Path(folder) / 'out', input_path=link, limit=100)
            self.assertEqual(rehearsal.ACTIVE_CHILDREN, set())

    def test_fixed_cli_error_does_not_echo_arguments(self):
        result = subprocess.run([sys.executable, '-I', '-S',
            str(Path(rehearsal.__file__)), 'run', '--source-identity', 'postgres://secret-canary'],
            capture_output=True)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(b'canary', result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)['readiness'], 'unknown')


class OfflineInventoryTests(unittest.TestCase):
    def test_pg_numeric_text_and_duplicate_rows_are_hashed_without_float_conversion(self):
        row = '{"big": 9007199254740993, "decimal": 0.123456789012345678901, "at": "2026-10-16T01:02:03.123456"}'
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'inventory'
            frames = [{'frame': 'database', 'value': {}}, {'frame': 'catalog', 'value': {}},
                      {'frame': 'rows', 'key': ['a.b', 'c'], 'value': row},
                      {'frame': 'rows', 'key': ['a.b', 'c'], 'value': row}, {'frame': 'end'}]
            path.write_text('\n'.join(json.dumps(frame) for frame in frames))
            actual = contract.parse_inventory(path)
            expected = hashlib.sha256()
            for _ in range(2):
                expected.update(len(row.encode()).to_bytes(8, 'big'))
                expected.update(row.encode())
            self.assertEqual(list(actual['data'].values()), [{'count': 2, 'sha256': expected.hexdigest()}])
            path.write_text('\n'.join(json.dumps(frame) for frame in frames[:-1]))
            with self.assertRaisesRegex(contract.RestoreError, 'incomplete_inventory'):
                contract.parse_inventory(path)

    def test_duplicate_json_and_metadata_symlink_rejected(self):
        with self.assertRaises(contract.RestoreError):
            contract.load_json('{"a":1,"a":2}')
        with tempfile.TemporaryDirectory() as folder:
            real, link = Path(folder) / 'real', Path(folder) / 'link'
            real.write_text(json.dumps(identity()))
            link.symlink_to(real)
            with self.assertRaisesRegex(contract.RestoreError, 'unsafe_identity_file'):
                contract.read_identity(link)

    def test_invalid_pair_and_bound_reject_before_any_child(self):
        with patch.object(rehearsal, '_run_child') as child:
            with self.assertRaises(contract.RestoreError):
                rehearsal.run(identity(), identity(), '/tmp/not-created-pr14b', max_source_bytes=1,
                              max_archive_bytes=1, minimum_free_bytes=1)
            with self.assertRaises(contract.RestoreError):
                rehearsal.run(identity(), identity('target'), '/tmp/not-created-pr14b', max_source_bytes=True,
                              max_archive_bytes=1, minimum_free_bytes=1)
            child.assert_not_called()

    def test_stderr_cap_and_nonzero_child_are_settled(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(contract.RestoreError, 'stderr_limit'):
                rehearsal._run_child([sys.executable, '-I', '-S', '-c',
                    'import sys; sys.stderr.buffer.write(b"e"*2000000)'], Path(folder) / 'flood', limit=100)
            with self.assertRaises(contract.RestoreError) as raised:
                rehearsal._run_child([sys.executable, '-I', '-S', '-c', 'raise SystemExit(7)'],
                                     Path(folder) / 'nonzero', limit=100)
            self.assertEqual(raised.exception.process_exit, 7)
            self.assertEqual(rehearsal.ACTIVE_CHILDREN, set())

    def test_existing_output_is_not_adopted(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(rehearsal, '_run_child') as child, self.assertRaises(FileExistsError):
                rehearsal.run(identity(), identity('target'), folder, max_source_bytes=1,
                              max_archive_bytes=1, minimum_free_bytes=1)
            child.assert_not_called()


@unittest.skipUnless(all(os.environ.get(key) for key in
    ('PR14B_COLLATION_IDENTITY', 'PR14B_COLLATION_OUTPUT')),
    'Requires one expressly allocated local container with the guarded collation fixture')
class LocalUserCollationGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.identity = contract.read_identity(os.environ['PR14B_COLLATION_IDENTITY'])
        cls.output = Path(os.environ['PR14B_COLLATION_OUTPUT'])
        cls.output.mkdir(mode=0o700)
        rehearsal.inspect_identity(cls.identity, cls.output / 'identity.json')
        rehearsal._info(cls.identity, 'nvrb-collation-guard', cls.output / 'info.json')
        actual = rehearsal._psql(cls.identity, 'nvrb-collation-guard', """
            SELECT jsonb_build_object('collations',coalesce(jsonb_agg(jsonb_build_object(
              'schema',n.nspname,'name',c.collname,'owner',pg_get_userbyid(c.collowner))
              ORDER BY n.nspname,c.collname),'[]'::jsonb))
            FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace
            WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema';""",
            cls.output / 'fixture.json')
        if actual != {'collations': [{'schema': 'public', 'name': 'pr14b_extra', 'owner': rehearsal.USER}]}:
            raise contract.RestoreError('collation_fixture_mismatch')

    def test_user_collation_rejects_empty_target(self):
        actual = rehearsal._psql(self.identity, 'nvrb-collation-guard', rehearsal.EMPTY_SQL,
                                  self.output / 'empty.json')
        with self.assertRaisesRegex(contract.RestoreError, 'target_not_empty'):
            contract.assert_empty(actual)

    def test_user_collation_rejects_unsupported_source(self):
        actual = rehearsal._capture(self.identity, 'nvrb-collation-guard',
                                      self.output / 'inventory.jsonl')
        with self.assertRaisesRegex(contract.RestoreError, 'unsupported_source_objects'):
            rehearsal._supported(actual)

    @classmethod
    def tearDownClass(cls):
        errors = []
        try:
            rehearsal._info(cls.identity, 'nvrb-collation-guard', cls.output / 'final-info.json')
        except BaseException as error:
            errors.append(error)
        try:
            rehearsal._backends(cls.identity, 'nvrb-collation-guard', cls.output / 'backends.json')
        except BaseException as error:
            errors.append(error)
        if rehearsal.ACTIVE_CHILDREN:
            errors.append(contract.RestoreError('child_settlement_unconfirmed'))
        rehearsal.finish_errors(None, errors)


@unittest.skipUnless(all(os.environ.get(key) for key in
    ('PR14B_SOURCE_IDENTITY', 'PR14B_TARGET_IDENTITY', 'PR14B_OUTPUT_ROOT')),
    'Requires two newly allocated isolated local PG17 containers; no automatic discovery')
class LocalLogicalRoundTripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = contract.read_identity(os.environ['PR14B_SOURCE_IDENTITY'])
        cls.target = contract.read_identity(os.environ['PR14B_TARGET_IDENTITY'])
        contract.check_pair(cls.source, cls.target)
        cls.root = Path(os.environ['PR14B_OUTPUT_ROOT'])
        cls.fixture = Path(str(cls.root) + '-fixture')
        cls.fixture.mkdir(mode=0o700)
        for side, own in (('source', cls.source), ('target', cls.target)):
            rehearsal.inspect_identity(own, cls.fixture / (side + '-identity.json'))
            rehearsal._info(own, 'nvrb-fixture', cls.fixture / (side + '-info.json'))
        guard = rehearsal._psql(cls.source, 'nvrb-fixture', """
            SELECT jsonb_build_object('schemaFree',NOT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='pr14b_fixture'),
              'productFree',NOT EXISTS(SELECT 1 FROM public.products WHERE slug='pr14b-fixture-human'),
              'loFree',NOT EXISTS(SELECT 1 FROM pg_largeobject_metadata),
              'journal', (SELECT count(*) FROM drizzle.__drizzle_migrations));""", cls.fixture / 'vacancy.json')
        if guard != {'schemaFree': True, 'productFree': True, 'loFree': True, 'journal': 82}:
            raise contract.RestoreError('fixture_vacancy_or_migration_mismatch')
        # Root-authorized new source only. Complete setup precedes all roundtrip baselines.
        sql = """
        BEGIN;
        CREATE SCHEMA pr14b_fixture;
        CREATE TABLE pr14b_fixture.duplicates (n numeric, payload bytea, at timestamp);
        INSERT INTO pr14b_fixture.duplicates VALUES
          (9007199254740993.1234567890123456789,decode('0001ff','hex'),'2026-10-16 01:02:03.123456'),
          (9007199254740993.1234567890123456789,decode('0001ff','hex'),'2026-10-16 01:02:03.123456');
        CREATE TABLE pr14b_fixture.partitioned(n bigint, label text) PARTITION BY RANGE(n);
        CREATE TABLE pr14b_fixture.leaf PARTITION OF pr14b_fixture.partitioned FOR VALUES FROM (0) TO (100);
        INSERT INTO pr14b_fixture.partitioned VALUES (42,'partition');
        CREATE VIEW pr14b_fixture.v AS SELECT n,at FROM pr14b_fixture.duplicates;
        CREATE MATERIALIZED VIEW pr14b_fixture.mv AS SELECT n,at FROM pr14b_fixture.duplicates;
        CREATE TABLE pr14b_fixture.identity_row(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, payload text);
        INSERT INTO pr14b_fixture.identity_row(payload) VALUES ('identity');
        ALTER SEQUENCE pr14b_fixture.identity_row_id_seq RESTART WITH 9007199254740999;
        CREATE SEQUENCE pr14b_fixture.uncalled AS bigint START WITH 9007199254740993;
        CREATE SEQUENCE pr14b_fixture.called AS bigint;
        DO $$ BEGIN
          PERFORM setval('pr14b_fixture.called',9007199254740997,true);
          PERFORM lo_create(987654321);
          PERFORM lo_put(987654321,0,decode(repeat('0001feff',1500),'hex'));
        END $$;
        CREATE TABLE pr14b_fixture.lo_reference(id int PRIMARY KEY, payload oid);
        INSERT INTO pr14b_fixture.lo_reference VALUES (1,987654321);
        CREATE TABLE pr14b_fixture.embedding(id int PRIMARY KEY, embedding public.vector(3));
        INSERT INTO pr14b_fixture.embedding VALUES(1,'[1,2,3]');
        INSERT INTO public.products(slug,url,name,tagline,description,category,status,verify_token,edit_token_hash,created_at,updated_at)
          VALUES('pr14b-fixture-human','https://pr14b.invalid/fixture','PR14b','Human fixture','Preserved banned decision','tools','banned','pr14b',repeat('a',64),'2026-10-16 01:02:03.123456','2026-10-16 01:02:03.654321');
        INSERT INTO public.product_refresh_requests(product_id,slug,requested_version,completed_version,active_version,force,active_force,progress,actor,requested_at,updated_at)
          SELECT id,slug,7,2,6,true,true,'{"completedKeys":["documentation"],"retryAfterByKey":{"canonical_site":"2026-10-17T01:02:03.123456Z"}}','pr14b-admin','2026-10-16 01:02:03.123456','2026-10-16 01:02:03.654321' FROM public.products WHERE slug='pr14b-fixture-human';
        INSERT INTO public.jobs(name,requested_version,processed_version,cursor,not_before,updated_at)
          VALUES('pr14b-recovery',9007199254740993,2,'{"after":9007199254740993}','2026-10-17 01:02:03.123456','2026-10-16 01:02:03.654321');
        INSERT INTO public.crawl_frontier(repo,signal,state,attempts,next_attempt_at,updated_at)
          VALUES('pr14b/fixture','manual','pending',2,'2026-10-17 01:02:03.123456','2026-10-16 01:02:03.654321');
        INSERT INTO public.crawl_candidates(repo,state,reason,decided_by,decided_at,updated_at)
          VALUES('pr14b/fixture','rejected','not_a_product','admin','2026-10-16 01:02:03.123456','2026-10-16 01:02:03.654321');
        INSERT INTO public.second_reviews(candidate_id,repo,trigger,first_decision,input_hash,status,resolved_by,resolution,resolved_at)
          SELECT id,repo,'ai_held','hold',repeat('b',64),'resolved','pr14b-human','kept','2026-10-16 01:02:03.123456' FROM public.crawl_candidates WHERE repo='pr14b/fixture';
        INSERT INTO public.operations_audit(actor,action,target,detail,created_at)
          VALUES('pr14b-human','fixture.decision','pr14b/fixture','{"decision":"keep","source":"explicit-fixture"}','2026-10-16 01:02:03.123456');
        COMMIT;
        SELECT jsonb_build_object('fixture','complete');
        """
        cls.fixture_attempted = True  # Commit ack loss must not erase the ownership record.
        result = rehearsal._psql(cls.source, 'nvrb-fixture', sql, cls.fixture / 'setup.json')
        if result != {'fixture': 'complete'}:
            raise contract.RestoreError('fixture_setup_unconfirmed')
        cls.before = rehearsal._capture(cls.source, 'nvrb-fixture', cls.fixture / 'source-complete.jsonl')
        rehearsal._supported(cls.before)
        rehearsal._json_file(cls.fixture / 'source-complete-summary.json', cls.before)
        cls.empty = rehearsal._capture(cls.target, 'nvrb-fixture', cls.fixture / 'target-empty.jsonl')
        rehearsal._json_file(cls.fixture / 'target-empty-summary.json', cls.empty)

    def test_01_actual_source_dump_restore_roundtrip(self):
        report = rehearsal.run(self.source, self.target, self.root,
            max_source_bytes=268435456, max_archive_bytes=67108864, minimum_free_bytes=268435456)
        self.assertEqual(report['outcome'], 'local_restore_verified')
        self.assertEqual(report['readiness'], 'unknown')
        self.assertIs(report['automaticDrAllowed'], False)
        source_after = rehearsal._capture(self.source, 'nvrb-test', self.fixture / 'source-roundtrip-after.jsonl')
        target_after = rehearsal._capture(self.target, 'nvrb-test', self.fixture / 'target-roundtrip-after.jsonl')
        self.assertEqual(self.before, source_after)
        self.assertEqual(self.before, target_after)
        self.assertNotEqual(self.empty, target_after)  # Intended restore delta, never called raw baseline equality.
        self.assertEqual(len(target_after['catalog']['largeObjects']), 1)
        self.assertTrue(any(row['last'] == '9007199254740993' and row['called'] is False
                            for row in target_after['catalog']['sequenceValues']))
        self.assertEqual(rehearsal.ACTIVE_CHILDREN, set())
        self.__class__.roundtrip_verified = True

    def test_02_nonempty_target_rejects_without_dump_or_restore(self):
        # The guard is independent of strict semantic verification. Require the first actual
        # restore's private checkpoint/receipt and current exact identities, never reseed/retry.
        checkpoint = contract.load_json((self.root / 'target-after-summary.json').read_bytes())
        source_checkpoint = contract.load_json((self.root / 'source-after-summary.json').read_bytes())
        self.assertTrue(checkpoint['catalog']['relations'])
        self.assertEqual(checkpoint['database']['name'], rehearsal.DATABASE)
        contract.verify_archive(self.root / 'archive.dump',
                                contract.load_json((self.root / 'archive-receipt.json').read_bytes()))
        source_before = rehearsal._capture(self.source, 'nvrb-test', self.fixture / 'source-negative-before.jsonl')
        target_before = rehearsal._capture(self.target, 'nvrb-test', self.fixture / 'target-negative-before.jsonl')
        self.assertEqual(source_before, source_checkpoint)
        self.assertEqual(target_before, checkpoint)
        output = Path(str(self.root) + '-nonempty')
        with self.assertRaisesRegex(contract.RestoreError, 'target_not_empty'):
            rehearsal.run(self.source, self.target, output,
                max_source_bytes=268435456, max_archive_bytes=67108864, minimum_free_bytes=268435456)
        self.assertFalse((output / 'archive.partial').exists())
        self.assertFalse((output / 'restore.stdout').exists())
        source_after = rehearsal._capture(self.source, 'nvrb-test', self.fixture / 'source-negative-after.jsonl')
        target_after = rehearsal._capture(self.target, 'nvrb-test', self.fixture / 'target-negative-after.jsonl')
        self.assertEqual(source_before, source_after)
        self.assertEqual(target_before, target_after)
        self.assertEqual(rehearsal.ACTIVE_CHILDREN, set())

    @classmethod
    def tearDownClass(cls):
        errors = []
        # Keep complete source fixture/intentional restored target for independent root readback.
        for side, own in (('source', cls.source), ('target', cls.target)):
            try:
                state = rehearsal._capture(own, 'nvrb-final', cls.fixture / (side + '-final.jsonl'))
                rehearsal._json_file(cls.fixture / (side + '-final-summary.json'), state)
                rehearsal._info(own, 'nvrb-final', cls.fixture / (side + '-final-info.json'))
                rehearsal._backends(own, 'nvrb-final', cls.fixture / (side + '-final-backends.json'))
            except BaseException as error:
                errors.append(error)
        rehearsal.finish_errors(None, errors)
