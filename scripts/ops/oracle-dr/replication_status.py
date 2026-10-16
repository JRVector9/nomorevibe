#!/usr/bin/env python3
"""PR14d: 논리 복제 상태를 양쪽에서 읽기 전용으로 수집하고 offline으로 대조한다. 승격·수정 권한이 없다."""
import hashlib
import json

import replication_common as common
import replication_plan
import report_contract as contract

KIND = 'nomorevibe-oracle-dr-replication-capture'
SETTINGS = ('wal_level', 'max_wal_senders', 'max_replication_slots', 'max_slot_wal_keep_size', 'wal_keep_size',
            'max_wal_size', 'logical_decoding_work_mem', 'max_logical_replication_workers',
            'max_sync_workers_per_subscription', 'max_connections')
SAMPLE_PERCENT = 1
SAMPLE_SEED = 14
TABLES_SQL = """SELECT pg_catalog.jsonb_build_object('frame', 'tables', 'tables', coalesce((SELECT pg_catalog.jsonb_agg(
  pg_catalog.jsonb_build_object('relation', pg_catalog.jsonb_build_array(n.nspname, c.relname),
  'columns', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', a.attname,
     'type', pg_catalog.format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull, 'hasDefault', a.atthasdef,
     'generated', a.attgenerated <> '', 'identity', a.attidentity <> '') ORDER BY a.attname)
     FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::jsonb))
  ORDER BY n.nspname, c.relname) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p') AND c.relpersistence = 'p' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass
      AND d.objid = c.oid AND d.deptype = 'e')), '[]'::jsonb),
  'sequences', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(n.nspname, c.relname) ORDER BY n.nspname, c.relname)
     FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'S' AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'), '[]'::jsonb),
  'largeObjects', (SELECT count(*) FROM pg_catalog.pg_largeobject_metadata));
"""


def _clock(extra=''):
    return f"pg_catalog.jsonb_build_object('at', {common.DB_CLOCK}{extra})"


CURRENT_LSN = "CASE WHEN pg_catalog.pg_is_in_recovery() THEN NULL ELSE pg_catalog.pg_current_wal_lsn()::text END"
RETAINED = ("CASE WHEN pg_catalog.pg_is_in_recovery() OR s.restart_lsn IS NULL THEN NULL "
            "ELSE pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), s.restart_lsn)::bigint END")
LAG_MS = "(EXTRACT(EPOCH FROM {0}) * 1000)::bigint"


def publisher_catalog_sql(plan, timeout):
    pub = common.literal(plan['names']['publication'])
    settings = ', '.join(common.literal(s) for s in SETTINGS)
    return ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n' + common.SESSION_SQL.format(timeout=timeout) + f"""
SELECT pg_catalog.jsonb_build_object('frame', 'start', 'at', {common.DB_CLOCK}, 'database', {common.DATABASE_SQL}, 'currentLsn', {CURRENT_LSN},
  'readAllStats', pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'USAGE'));
SELECT pg_catalog.jsonb_build_object('frame', 'settings', 'settings', (SELECT pg_catalog.jsonb_object_agg(name,
  pg_catalog.jsonb_build_object('setting', setting, 'unit', unit)) FROM pg_catalog.pg_settings WHERE name IN ({settings})));
SELECT pg_catalog.jsonb_build_object('frame', 'slots', 'slots', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'name', s.slot_name, 'plugin', s.plugin, 'type', s.slot_type, 'database', s.database, 'temporary', s.temporary,
  'active', s.active, 'activePid', s.active_pid, 'restartLsn', s.restart_lsn::text, 'confirmedFlushLsn', s.confirmed_flush_lsn::text,
  'walStatus', s.wal_status, 'safeWalSize', s.safe_wal_size, 'retainedBytes', {RETAINED}, 'failover', s.failover,
  'invalidationReason', s.invalidation_reason) ORDER BY s.slot_name) FROM pg_catalog.pg_replication_slots s), '[]'::jsonb));
SELECT pg_catalog.jsonb_build_object('frame', 'senders', 'senders', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'pid', r.pid, 'applicationName', r.application_name, 'state', r.state, 'sentLsn', r.sent_lsn::text, 'writeLsn', r.write_lsn::text,
  'flushLsn', r.flush_lsn::text, 'replayLsn', r.replay_lsn::text, 'writeLagMs', {LAG_MS.format('r.write_lag')},
  'flushLagMs', {LAG_MS.format('r.flush_lag')}, 'replayLagMs', {LAG_MS.format('r.replay_lag')}) ORDER BY r.pid)
  FROM pg_catalog.pg_stat_replication r), '[]'::jsonb));
SELECT pg_catalog.jsonb_build_object('frame', 'slotStats', 'slotStats', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'name', slot_name, 'spillBytes', spill_bytes, 'streamBytes', stream_bytes, 'totalBytes', total_bytes) ORDER BY slot_name)
  FROM pg_catalog.pg_stat_replication_slots), '[]'::jsonb));
SELECT pg_catalog.jsonb_build_object('frame', 'publication', 'publication', (SELECT pg_catalog.jsonb_build_object(
  'allTables', p.puballtables, 'insert', p.pubinsert, 'update', p.pubupdate, 'delete', p.pubdelete, 'truncate', p.pubtruncate,
  'viaRoot', p.pubviaroot, 'tables', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('relation',
     pg_catalog.jsonb_build_array(t.schemaname, t.tablename), 'columns', pg_catalog.to_jsonb(t.attnames), 'rowFilter', t.rowfilter IS NOT NULL)
     ORDER BY t.schemaname, t.tablename) FROM pg_catalog.pg_publication_tables t WHERE t.pubname = p.pubname), '[]'::jsonb))
  FROM pg_catalog.pg_publication p WHERE p.pubname = {pub}));
{TABLES_SQL}SELECT pg_catalog.jsonb_build_object('frame', 'end', 'at', {common.DB_CLOCK}, 'currentLsn', {CURRENT_LSN});
ROLLBACK;
""")


def subscriber_catalog_sql(plan, timeout):
    sub = common.literal(plan['names']['subscription'])
    this_db = "(SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())"
    return ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n' + common.SESSION_SQL.format(timeout=timeout) + f"""
SELECT pg_catalog.jsonb_build_object('frame', 'start', 'at', {common.DB_CLOCK}, 'database', {common.DATABASE_SQL});
SELECT pg_catalog.jsonb_build_object('frame', 'subscription', 'subscription', (SELECT pg_catalog.jsonb_build_object(
  'enabled', s.subenabled, 'slot', s.subslotname, 'publications', pg_catalog.to_jsonb(s.subpublications), 'streaming', s.substream,
  'disableOnError', s.subdisableonerr, 'failover', s.subfailover, 'binary', s.subbinary)
  FROM pg_catalog.pg_subscription s WHERE s.subname = {sub} AND s.subdbid = {this_db}),
  'workers', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('type', w.worker_type, 'running', w.pid IS NOT NULL,
     'relation', CASE WHEN w.relid IS NULL THEN NULL ELSE (SELECT pg_catalog.jsonb_build_array(n.nspname, c.relname)
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = w.relid) END,
     'receivedLsn', w.received_lsn::text, 'latestEndLsn', w.latest_end_lsn::text) ORDER BY w.worker_type, w.relid)
     FROM pg_catalog.pg_stat_subscription w WHERE w.subname = {sub}), '[]'::jsonb),
  'stats', (SELECT pg_catalog.jsonb_build_object('applyErrors', st.apply_error_count, 'syncErrors', st.sync_error_count)
     FROM pg_catalog.pg_stat_subscription_stats st WHERE st.subname = {sub}),
  'relations', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('relation', pg_catalog.jsonb_build_array(n.nspname, c.relname),
     'state', r.srsubstate) ORDER BY n.nspname, c.relname) FROM pg_catalog.pg_subscription_rel r
     JOIN pg_catalog.pg_subscription s ON s.oid = r.srsubid JOIN pg_catalog.pg_class c ON c.oid = r.srrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE s.subname = {sub} AND s.subdbid = {this_db}), '[]'::jsonb),
  'originRemoteLsn', (SELECT o.remote_lsn::text FROM pg_catalog.pg_replication_origin_status o JOIN pg_catalog.pg_subscription s
     ON o.external_id = 'pg_' || s.oid::text WHERE s.subname = {sub} AND s.subdbid = {this_db}),
  'otherClientBackends', (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE datname = pg_catalog.current_database()
     AND pid <> pg_catalog.pg_backend_pid() AND backend_type = 'client backend'));
{TABLES_SQL}SELECT pg_catalog.jsonb_build_object('frame', 'end', 'at', {common.DB_CLOCK});
ROLLBACK;
""")


def _key_expression(table, alias='t'):
    return 'pg_catalog.jsonb_build_array(' + ', '.join(f'{alias}.{common.ident(k["name"])}' for k in table['key']) + ')'


def _order(table, direction=''):
    return ', '.join(f't.{common.ident(k["name"])}{direction}' for k in table['key'])


def data_sql(plan, side, catalog, timeout, *, row_counts, sample_rows, sample_keys=None):
    """catalog(1단계)에 있는 계획 표·시퀀스만 읽는다. 없는 객체는 1단계 결과로 finding이 된다."""
    present_tables = {tuple(t['relation']): t for t in catalog['tables']}
    present_sequences = {tuple(s) for s in catalog['sequences']}
    statements = []
    sequences = [s for s in plan['sequences'] if tuple(s['relation']) in present_sequences]
    if sequences:
        parts = [f"(SELECT pg_catalog.jsonb_build_object('relation', pg_catalog.jsonb_build_array({common.literal(s['relation'][0])}, "
                 f"{common.literal(s['relation'][1])}), 'lastValue', last_value::text, 'isCalled', is_called) "
                 f"FROM {common.qualified(*s['relation'])})" for s in sequences]
        statements.append("SELECT pg_catalog.jsonb_build_object('frame', 'sequences', 'sequences', pg_catalog.jsonb_build_array("
                          + ', '.join(parts) + '));')
    for table in plan['tables']:
        relation = (table['schema'], table['name'])
        if relation not in present_tables:
            continue
        columns = {c['name'] for c in present_tables[relation]['columns']}
        name = common.qualified(*relation)
        label = f"pg_catalog.jsonb_build_array({common.literal(relation[0])}, {common.literal(relation[1])})"
        if row_counts:
            statements.append(f"SELECT pg_catalog.jsonb_build_object('frame', 'rowCount', 'relation', {label}, "
                              f"'count', (SELECT count(*) FROM ONLY {name}));")
        if not sample_rows or not all(k['name'] in columns for k in table['key']):
            continue
        row = f'{_key_expression(table)} AS k, pg_catalog.md5(pg_catalog.to_jsonb(t)::text) AS h'
        if side == 'publisher':
            source = (f'(SELECT {row} FROM ONLY {name} AS t ORDER BY {_order(table)} LIMIT {sample_rows}) UNION ALL '
                      f'(SELECT {row} FROM ONLY {name} AS t ORDER BY {_order(table, " DESC")} LIMIT {sample_rows}) UNION ALL '
                      f'(SELECT {row} FROM ONLY {name} AS t TABLESAMPLE SYSTEM ({SAMPLE_PERCENT}) REPEATABLE ({SAMPLE_SEED}) '
                      f'LIMIT {sample_rows})')
        else:
            keys = sample_keys.get(relation, [])
            casts = ', '.join(f"(e->>{i})::{common.qualified(k['typeSchema'], k['typeName'])}" for i, k in enumerate(table['key']))
            tuple_expr = '(' + ', '.join(f't.{common.ident(k["name"])}' for k in table['key']) + ')'
            source = (f"SELECT {row} FROM ONLY {name} AS t WHERE {tuple_expr} IN (SELECT {casts} FROM "
                      f"pg_catalog.jsonb_array_elements({common.literal(json.dumps(keys, separators=(',', ':')))}::jsonb) e)")
        statements.append(f"SELECT pg_catalog.jsonb_build_object('frame', 'sample', 'relation', {label}, 'rows', coalesce(("
                          f"SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(x.k, x.h) ORDER BY x.k) FROM ("
                          f"SELECT DISTINCT ON (y.k) y.k, y.h FROM ({source}) y ORDER BY y.k) x), '[]'::jsonb));")
    end_extra = f", 'currentLsn', {CURRENT_LSN}" if side == 'publisher' else ''
    return ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n' + common.SESSION_SQL.format(timeout=timeout)
            + f"SELECT pg_catalog.jsonb_build_object('frame', 'start', 'at', {common.DB_CLOCK}{end_extra});\n"
            + '\n'.join(statements) + '\n'
            + f"SELECT pg_catalog.jsonb_build_object('frame', 'end', 'at', {common.DB_CLOCK}{end_extra});\nROLLBACK;\n")


# ---- strict parsing ----
def _nullable(value, check):
    if value is not None:
        check(value)


def _relation(value):
    contract.require(type(value) is list and len(value) == 2)
    for part in value:
        contract.text(part)
    return tuple(value)


def _int(value):
    contract.integer(value, -(2 ** 63), 2 ** 63 - 1)


def _tables_frame(frame):
    contract.exact(frame, ('frame', 'tables', 'sequences', 'largeObjects'))
    tables = []
    for row in frame['tables']:
        contract.exact(row, ('relation', 'columns'))
        _relation(row['relation'])
        for column in row['columns']:
            contract.exact(column, ('name', 'type', 'notNull', 'hasDefault', 'generated', 'identity'))
            contract.text(column['name'])
            contract.text(column['type'])
            contract.boolean_fields(column, ('notNull', 'hasDefault', 'generated', 'identity'))
        tables.append(row)
    for row in frame['sequences']:
        _relation(row)
    common.nonnegative(frame['largeObjects'])
    return {'tables': tables, 'sequences': frame['sequences'], 'largeObjects': frame['largeObjects']}


def parse_catalog(side, frames):
    if side == 'publisher':
        names = {k: 'one' for k in ('start', 'settings', 'slots', 'senders', 'slotStats', 'publication', 'tables', 'end')}
    else:
        names = {k: 'one' for k in ('start', 'subscription', 'tables', 'end')}
    found = common.frames_by_name(frames, names)
    contract.require([f['frame'] for f in frames] == list(names))
    start, end = found['start'], found['end']
    contract.timestamp(start['at'])
    contract.timestamp(end['at'])
    contract.require(start['at'] <= end['at'])
    result = {'at': start['at'], 'endAt': end['at'], **_tables_frame(found['tables'])}
    if side == 'publisher':
        contract.exact(start, ('frame', 'at', 'database', 'currentLsn', 'readAllStats'))
        contract.exact(end, ('frame', 'at', 'currentLsn'))
        contract.boolean_fields(start, ('readAllStats',))
        result.update(database=common.database(start['database']), currentLsn=start['currentLsn'],
                      endLsn=end['currentLsn'], readAllStats=start['readAllStats'])
        _nullable(start['currentLsn'], common.lsn)
        _nullable(end['currentLsn'], common.lsn)
        settings = found['settings']['settings']
        contract.require(type(settings) is dict and set(settings) == set(SETTINGS))
        for value in settings.values():
            contract.exact(value, ('setting', 'unit'))
            contract.require(type(value['setting']) is str)
            _nullable(value['unit'], contract.text)
        result['settings'] = settings
        for slot in found['slots']['slots']:
            contract.exact(slot, ('name', 'plugin', 'type', 'database', 'temporary', 'active', 'activePid', 'restartLsn',
                                  'confirmedFlushLsn', 'walStatus', 'safeWalSize', 'retainedBytes', 'failover',
                                  'invalidationReason'))
            contract.text(slot['name'])
            contract.require(slot['type'] in ('physical', 'logical'))
            contract.boolean_fields(slot, ('temporary', 'active', 'failover'))
            for key in ('restartLsn', 'confirmedFlushLsn'):
                _nullable(slot[key], common.lsn)
            for key in ('safeWalSize', 'retainedBytes', 'activePid'):
                _nullable(slot[key], _int)
            _nullable(slot['walStatus'], contract.text)
        result['slots'] = found['slots']['slots']
        for sender in found['senders']['senders']:
            contract.exact(sender, ('pid', 'applicationName', 'state', 'sentLsn', 'writeLsn', 'flushLsn', 'replayLsn',
                                    'writeLagMs', 'flushLagMs', 'replayLagMs'))
            _int(sender['pid'])
            for key in ('writeLagMs', 'flushLagMs', 'replayLagMs'):
                _nullable(sender[key], _int)
        result['senders'] = found['senders']['senders']
        for row in found['slotStats']['slotStats']:
            contract.exact(row, ('name', 'spillBytes', 'streamBytes', 'totalBytes'))
            for key in ('spillBytes', 'streamBytes', 'totalBytes'):
                common.nonnegative(row[key])
        result['slotStats'] = found['slotStats']['slotStats']
        publication = found['publication']['publication']
        if publication is not None:
            contract.exact(publication, ('allTables', 'insert', 'update', 'delete', 'truncate', 'viaRoot', 'tables'))
            contract.boolean_fields(publication, ('allTables', 'insert', 'update', 'delete', 'truncate', 'viaRoot'))
            for row in publication['tables']:
                contract.exact(row, ('relation', 'columns', 'rowFilter'))
                _relation(row['relation'])
                contract.require(type(row['columns']) is list and all(type(c) is str for c in row['columns']))
        result['publication'] = publication
    else:
        contract.exact(start, ('frame', 'at', 'database'))
        contract.exact(end, ('frame', 'at'))
        result['database'] = common.database(start['database'])
        frame = found['subscription']
        contract.exact(frame, ('frame', 'subscription', 'workers', 'stats', 'relations', 'originRemoteLsn', 'otherClientBackends'))
        if frame['subscription'] is not None:
            contract.exact(frame['subscription'], ('enabled', 'slot', 'publications', 'streaming', 'disableOnError', 'failover', 'binary'))
        for worker in frame['workers']:
            contract.exact(worker, ('type', 'running', 'relation', 'receivedLsn', 'latestEndLsn'))
            # worker가 없으면 pg_stat_subscription은 type/pid가 NULL인 행 하나를 남긴다(오류로 멈춘 경우 등).
            contract.require(worker['type'] in ('apply', 'parallel apply', 'table synchronization')
                             or worker['type'] is None and not worker['running'])
            _nullable(worker['relation'], _relation)
        _nullable(frame['stats'], lambda s: contract.exact(s, ('applyErrors', 'syncErrors')))
        for row in frame['relations']:
            contract.exact(row, ('relation', 'state'))
            _relation(row['relation'])
            contract.require(row['state'] in ('i', 'd', 'f', 's', 'r'))
        _nullable(frame['originRemoteLsn'], common.lsn)
        common.nonnegative(frame['otherClientBackends'])
        result.update({k: frame[k] for k in ('subscription', 'workers', 'stats', 'relations', 'originRemoteLsn',
                                             'otherClientBackends')})
    return result


def parse_data(side, frames):
    names = {'start': 'one', 'sequences': 'optional', 'rowCount': 'many', 'sample': 'many', 'end': 'one'}
    found = common.frames_by_name(frames, names)
    contract.require(frames[0]['frame'] == 'start' and frames[-1]['frame'] == 'end')
    keys = ('frame', 'at', 'currentLsn') if side == 'publisher' else ('frame', 'at')
    contract.exact(found['start'], keys)
    contract.exact(found['end'], keys)
    sequences = []
    if 'sequences' in found:
        contract.exact(found['sequences'], ('frame', 'sequences'))
        for row in found['sequences']['sequences']:
            contract.exact(row, ('relation', 'lastValue', 'isCalled'))
            _relation(row['relation'])
            contract.require(type(row['lastValue']) is str and -(2 ** 63) <= int(row['lastValue']) < 2 ** 63)
            contract.boolean_fields(row, ('isCalled',))
            sequences.append(row)
    counts, samples = {}, {}
    for frame in found.get('rowCount', []):
        contract.exact(frame, ('frame', 'relation', 'count'))
        relation = _relation(frame['relation'])
        contract.require(relation not in counts)
        counts[relation] = common.nonnegative(frame['count'])
    for frame in found.get('sample', []):
        contract.exact(frame, ('frame', 'relation', 'rows'))
        relation = _relation(frame['relation'])
        contract.require(relation not in samples)
        rows = {}
        for row in frame['rows']:
            contract.require(type(row) is list and len(row) == 2 and type(row[0]) is list and type(row[1]) is str)
            key = json.dumps(row[0], sort_keys=True, separators=(',', ':'))
            contract.require(key not in rows)
            rows[key] = row[1]
        samples[relation] = rows
    return {'at': found['start']['at'], 'endAt': found['end']['at'],
            'currentLsn': found['start'].get('currentLsn'), 'endLsn': found['end'].get('currentLsn'),
            'sequences': sequences, 'rowCounts': counts, 'samples': samples}


def sample_keys(publisher_capture):
    data = parse_data('publisher', publisher_capture['dataFrames'])
    return {relation: [json.loads(key) for key in rows] for relation, rows in data['samples'].items()}


def sample_digest(publisher_capture):
    return hashlib.sha256(json.dumps(publisher_capture['dataFrames'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def capture(plan, database_url, *, side, label, expected_database, expected_user, psql, timeout, row_counts,
            sample_rows, publisher_capture=None):
    replication_plan.validate_plan(plan)
    contract.require(side in ('publisher', 'subscriber'))
    contract.text(label)
    timeout = common.checked_timeout(timeout)
    contract.integer(sample_rows, 0, 1000)
    contract.require(type(row_counts) is bool)
    contract.require((publisher_capture is None) == (side == 'publisher' or not sample_rows))
    keys = None
    if publisher_capture is not None:
        validate_capture(publisher_capture, plan, 'publisher')
        keys = sample_keys(publisher_capture)
    run = dict(expected_database=expected_database, expected_user=expected_user, psql=psql,
               app='nomorevibe-oracle-dr-replication-status', read_only=True, timeout=timeout + 15)
    client_started = common.utc_now()
    catalog_sql = publisher_catalog_sql(plan, timeout) if side == 'publisher' else subscriber_catalog_sql(plan, timeout)
    catalog_frames = common.run_psql(database_url, catalog_sql, **run)
    catalog = parse_catalog(side, catalog_frames)
    common.database(catalog['database'], expected_database, expected_user)
    data_frames = common.run_psql(database_url, data_sql(plan, side, catalog, timeout, row_counts=row_counts,
                                                         sample_rows=sample_rows, sample_keys=keys), **run)
    parse_data(side, data_frames)
    value = {'kind': KIND, 'version': 1, 'side': side, 'label': label, 'planHash': replication_plan.plan_hash(plan),
             'clientStartedAt': client_started, 'clientFinishedAt': common.utc_now(), 'capturedAt': catalog['at'],
             'rowCounts': row_counts, 'sampleRows': sample_rows,
             'samplesFrom': sample_digest(publisher_capture) if publisher_capture is not None else None,
             'catalogFrames': catalog_frames, 'dataFrames': data_frames, 'readiness': 'unknown', 'automaticDrAllowed': False}
    return validate_capture(value, plan, side)


def validate_capture(value, plan, side):
    contract.exact(value, ('kind', 'version', 'side', 'label', 'planHash', 'clientStartedAt', 'clientFinishedAt', 'capturedAt',
                           'rowCounts', 'sampleRows', 'samplesFrom', 'catalogFrames', 'dataFrames', 'readiness',
                           'automaticDrAllowed'))
    contract.require(value['kind'] == KIND and value['version'] == 1 and value['side'] == side
                     and value['planHash'] == replication_plan.plan_hash(plan) and value['readiness'] == 'unknown'
                     and value['automaticDrAllowed'] is False)
    catalog = parse_catalog(side, value['catalogFrames'])
    data = parse_data(side, value['dataFrames'])
    contract.require(value['capturedAt'] == catalog['at'] and catalog['endAt'] <= data['at'])
    return value


def evaluate(plan, publisher_capture, subscriber_capture, *, max_lag_bytes, max_retained_wal_bytes):
    replication_plan.validate_plan(plan)
    validate_capture(publisher_capture, plan, 'publisher')
    validate_capture(subscriber_capture, plan, 'subscriber')
    common.nonnegative(max_lag_bytes)
    common.nonnegative(max_retained_wal_bytes)
    pub = parse_catalog('publisher', publisher_capture['catalogFrames'])
    sub = parse_catalog('subscriber', subscriber_capture['catalogFrames'])
    pub_data = parse_data('publisher', publisher_capture['dataFrames'])
    sub_data = parse_data('subscriber', subscriber_capture['dataFrames'])
    names = plan['names']
    findings = []

    def add(severity, code, **extra):
        findings.append({'severity': severity, 'code': code, **extra})
    planned = [(t['schema'], t['name']) for t in plan['tables']]
    excluded = {tuple(e['relation']) for e in plan['excluded']}
    if pub['database']['inRecovery'] or pub['currentLsn'] is None:
        add('blocking', 'publisher_capture_in_recovery')
    # PR14a inventory에는 system identifier가 없어 이름·oid만 대조한다.
    if any(pub['database'][k] != plan['source']['database'][k] for k in ('name', 'oid')):
        add('blocking', 'publisher_database_differs_from_plan_source')
    if common.same_database(pub['database'], sub['database']):
        add('blocking', 'publisher_and_subscriber_are_same_database')
    if subscriber_capture['samplesFrom'] not in (None, sample_digest(publisher_capture)):
        add('blocking', 'sample_keys_from_other_publisher_capture')
    settings = pub['settings']
    if settings['wal_level']['setting'] != 'logical':
        add('blocking', 'wal_level_not_logical')
    keep = common.setting_bytes(settings['max_slot_wal_keep_size'])
    if keep < 0:
        add('attention', 'slot_wal_unbounded', detail='max_slot_wal_keep_size=-1: 보존은 primary 디스크로만 제한된다')
    slots = {s['name']: s for s in pub['slots']}
    slot = slots.get(names['slot'])
    observations = {'publisherCapturedAt': pub['at'], 'subscriberCapturedAt': sub['at'],
                    'clocks': 'each_database_own_clock_not_combined', 'maxLagBytes': max_lag_bytes,
                    'maxRetainedWalBytes': max_retained_wal_bytes, 'slotMaxWalKeepBytes': keep}
    if slot is None:
        add('blocking', 'slot_missing', slot=names['slot'])
    else:
        if slot['type'] != 'logical' or slot['plugin'] != 'pgoutput' or slot['database'] != pub['database']['name']:
            add('blocking', 'slot_shape_differs')
        if not slot['active']:
            add('blocking', 'slot_inactive')
        if slot['walStatus'] == 'lost' or slot['invalidationReason'] is not None:
            add('blocking', 'slot_lost_reseed_required', reason=slot['invalidationReason'])
        elif slot['walStatus'] not in ('reserved', 'extended'):
            add('blocking', 'slot_wal_at_risk', walStatus=slot['walStatus'])
        lag = None if pub['currentLsn'] is None or slot['confirmedFlushLsn'] is None else \
            common.lsn(pub['currentLsn']) - common.lsn(slot['confirmedFlushLsn'])
        observations.update(lagBytes=lag, retainedBytes=slot['retainedBytes'], safeWalSize=slot['safeWalSize'],
                            walStatus=slot['walStatus'], slotFailover=slot['failover'])
        if lag is None or lag > max_lag_bytes:
            add('blocking', 'lag_over_threshold_or_unknown', lagBytes=lag)
        if slot['retainedBytes'] is None or slot['retainedBytes'] > max_retained_wal_bytes:
            add('blocking', 'retained_wal_over_threshold_or_unknown', retainedBytes=slot['retainedBytes'])
        sender = next((s for s in pub['senders'] if s['pid'] == slot['activePid']), None)
        if not slot['active']:
            pass  # walsender가 없다(slot_inactive가 이미 blocking이다)
        elif sender is None or sender['replayLagMs'] is None and sender['replayLsn'] is None:
            add('attention', 'sender_stats_not_visible', readAllStats=pub['readAllStats'])
        else:
            observations['senderLagMs'] = {k: sender[k] for k in ('writeLagMs', 'flushLagMs', 'replayLagMs')}
        stats = next((s for s in pub['slotStats'] if s['name'] == names['slot']), None)
        if stats and stats['spillBytes']:
            add('attention', 'publisher_spill_observed', spillBytes=stats['spillBytes'])
    for other in pub['slots']:
        if other['name'] != names['slot'] and not other['active'] and not other['temporary']:
            add('attention', 'other_inactive_slot_retaining_wal', slot=other['name'], retainedBytes=other['retainedBytes'])
    publication = pub['publication']
    published = []
    if publication is None:
        add('blocking', 'publication_missing')
    else:
        published = [tuple(t['relation']) for t in publication['tables']]
        if {k: publication[k] for k in ('allTables', 'insert', 'update', 'delete', 'truncate', 'viaRoot')} != \
                {'allTables': False, 'insert': True, 'update': True, 'delete': True, 'truncate': True, 'viaRoot': False}:
            add('blocking', 'publication_options_differ')
        if published != planned:
            add('blocking', 'publication_tables_differ_from_plan', missing=[list(t) for t in planned if t not in published],
                extra=[list(t) for t in published if t not in planned])
        if any(t['rowFilter'] for t in publication['tables']):
            add('blocking', 'publication_row_filter_present')
    unpublished = sorted(tuple(t['relation']) for t in pub['tables']
                         if tuple(t['relation']) not in set(published) | excluded)
    if unpublished:
        add('blocking', 'unpublished_table', relations=[list(t) for t in unpublished])
    if pub['largeObjects'] or sub['largeObjects']:
        add('blocking', 'large_objects_present', publisher=pub['largeObjects'], subscriber=sub['largeObjects'])
    subscription = sub['subscription']
    if subscription is None:
        add('blocking', 'subscription_missing')
    else:
        if not subscription['enabled']:
            add('blocking', 'subscription_disabled')
        if subscription['slot'] != names['slot'] or subscription['publications'] != [names['publication']]:
            add('blocking', 'subscription_target_differs')
        if not any(w['type'] == 'apply' and w['running'] for w in sub['workers']):
            add('blocking', 'apply_worker_not_running')
    stats = sub['stats']
    if stats and (stats['applyErrors'] or stats['syncErrors']):
        add('blocking', 'subscription_errors_observed', applyErrors=stats['applyErrors'], syncErrors=stats['syncErrors'],
            detail='오류 원문은 R 서버 로그에만 있다')
    states = {tuple(r['relation']): r['state'] for r in sub['relations']}
    not_ready = sorted([list(t), states[t]] for t in states if states[t] != 'r')
    if not_ready:
        add('blocking', 'table_sync_incomplete', relations=not_ready)
    missing_rel = [list(t) for t in published if t not in states]
    if subscription is not None and missing_rel:
        add('blocking', 'subscription_refresh_required', relations=missing_rel)
    sub_tables = {tuple(t['relation']): {c['name']: c for c in t['columns']} for t in sub['tables']}
    pub_tables = {tuple(t['relation']): {c['name']: c for c in t['columns']} for t in pub['tables']}
    drift = {'subscriber_table_missing': [], 'subscriber_column_missing': [], 'subscriber_extra_required_column': [],
             'column_type_differs': []}
    for table in (publication['tables'] if publication else []):
        relation = tuple(table['relation'])
        if relation not in sub_tables:
            drift['subscriber_table_missing'].append(list(relation))
            continue
        target, source = sub_tables[relation], pub_tables.get(relation, {})
        drift['subscriber_column_missing'] += [[*relation, c] for c in table['columns'] if c not in target]
        drift['column_type_differs'] += [[*relation, c] for c in table['columns']
                                         if c in target and c in source and target[c]['type'] != source[c]['type']]
        drift['subscriber_extra_required_column'] += [
            [*relation, n] for n, c in sorted(target.items()) if n not in table['columns'] and n not in source
            and c['notNull'] and not (c['hasDefault'] or c['generated'] or c['identity'])]
    for code, rows in drift.items():
        if rows:
            add('blocking', code, items=rows)
    if sub['otherClientBackends']:
        add('blocking', 'subscriber_other_clients', count=sub['otherClientBackends'])
    pub_sequences = {tuple(s['relation']): s for s in pub_data['sequences']}
    sub_sequences = {tuple(s['relation']): s for s in sub_data['sequences']}
    behind = [list(r) for r, s in sorted(pub_sequences.items())
              if r in sub_sequences and int(sub_sequences[r]['lastValue']) < int(s['lastValue'])]
    missing_seq = [s['relation'] for s in plan['sequences'] if tuple(s['relation']) not in pub_sequences
                   or tuple(s['relation']) not in sub_sequences]
    if behind:
        add('attention', 'sequence_resync_required', relations=behind, detail='논리 복제는 시퀀스를 옮기지 않는다. cutover에서 sequence-sync')
    if missing_seq:
        add('blocking', 'sequence_missing', relations=missing_seq)
    if publisher_capture['rowCounts'] and subscriber_capture['rowCounts']:
        differs = [[*r, n, sub_data['rowCounts'].get(r)] for r, n in sorted(pub_data['rowCounts'].items())
                   if sub_data['rowCounts'].get(r) != n]
        if differs:
            add('blocking', 'row_count_differs', items=differs[:50], total=len(differs))
    sample_summary = {'tables': 0, 'rows': 0, 'matched': 0, 'differs': 0, 'missingOnSubscriber': 0}
    if subscriber_capture['samplesFrom'] is not None:
        differs, missing = [], []
        for relation, rows in sorted(pub_data['samples'].items()):
            target = sub_data['samples'].get(relation, {})
            sample_summary['tables'] += 1
            for key, digest in sorted(rows.items()):
                sample_summary['rows'] += 1
                if key not in target:
                    missing.append([*relation, json.loads(key)])
                elif target[key] != digest:
                    differs.append([*relation, json.loads(key)])
                else:
                    sample_summary['matched'] += 1
        sample_summary.update(differs=len(differs), missingOnSubscriber=len(missing))
        if differs:
            add('blocking', 'sample_row_differs', items=differs[:20], total=len(differs))
        if missing:
            add('blocking', 'sample_row_missing_on_subscriber', items=missing[:20], total=len(missing))
    observations.update(
        originRemoteLsn=sub['originRemoteLsn'],
        # origin 0/0은 초기 COPY 뒤 아직 적용한 TX가 없다는 뜻이다. 차이로 읽지 않는다.
        approxBytesBehindAcrossCaptures=None if sub['originRemoteLsn'] in (None, '0/0') or pub['currentLsn'] is None
        else common.lsn(pub['currentLsn']) - common.lsn(sub['originRemoteLsn']),
        samples=sample_summary, rowCountsCompared=publisher_capture['rowCounts'] and subscriber_capture['rowCounts'])
    seal = {'subscriptionDropped': subscription is None, 'noReplicationWorkers': not any(w['running'] for w in sub['workers'])}
    seal['satisfied'] = all(seal.values())
    return {'kind': 'nomorevibe-oracle-dr-replication-evaluation', 'version': 1, 'planHash': replication_plan.plan_hash(plan),
            'publisherLabel': publisher_capture['label'], 'subscriberLabel': subscriber_capture['label'],
            'publisherDatabase': pub['database'], 'subscriberDatabase': sub['database'],
            'findings': findings, 'blockingFindings': sum(f['severity'] == 'blocking' for f in findings),
            'observations': observations, 'sealPrecondition': seal,
            'notes': ['운영 중 표본/행 수 차이는 진행 중 쓰기일 수 있다. cutover 증거는 쓰기 0·lag 0에서만 쓴다.',
                      'lag 시간은 publisher clock, 바이트는 각 capture 시점 LSN 차이다. 두 서버 clock을 합치지 않는다.',
                      'senderLagMs가 null이면 최근 측정할 활동이 없었다는 뜻이며 0으로 읽지 않는다.'],
            'readiness': 'unknown', 'automaticDrAllowed': False, 'unknowns': common.UNKNOWN}


def main(argv=None):
    def run(arguments):
        parser = common.Parser(description=__doc__)
        commands = parser.add_subparsers(dest='command', required=True, parser_class=common.Parser)
        cap = commands.add_parser('capture')
        cap.add_argument('--plan', required=True)
        cap.add_argument('--side', required=True, choices=('publisher', 'subscriber'))
        cap.add_argument('--label', required=True)
        cap.add_argument('--row-counts', action='store_true', help='모든 계획 표 count(*) (전체 scan)')
        cap.add_argument('--sample-rows', type=int, default=0, help='표마다 PK 앞/뒤/SYSTEM 표본 각 N행')
        cap.add_argument('--sample-from', help='subscriber: 같은 키를 읽을 publisher capture')
        common.connection_arguments(cap)
        ev = commands.add_parser('evaluate')
        ev.add_argument('--plan', required=True)
        ev.add_argument('--publisher', required=True)
        ev.add_argument('--subscriber', required=True)
        ev.add_argument('--max-lag-bytes', required=True, type=int)
        ev.add_argument('--max-retained-wal-bytes', required=True, type=int)
        args = parser.parse_args(arguments)
        plan = common.load_file(args.plan)
        if args.command == 'capture':
            source = common.load_file(args.sample_from) if args.sample_from else None
            return capture(plan, common.read_url(), side=args.side, label=args.label, expected_database=args.expect_database,
                           expected_user=args.expect_user, psql=args.psql, timeout=args.timeout_seconds,
                           row_counts=args.row_counts, sample_rows=args.sample_rows, publisher_capture=source)
        result = evaluate(plan, common.load_file(args.publisher), common.load_file(args.subscriber),
                          max_lag_bytes=args.max_lag_bytes, max_retained_wal_bytes=args.max_retained_wal_bytes)
        return result, 3 if result['blockingFindings'] else 0
    return common.cli(run, argv)


if __name__ == '__main__':
    raise SystemExit(main())
