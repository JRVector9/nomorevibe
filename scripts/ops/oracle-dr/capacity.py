#!/usr/bin/env python3
"""PR14d: DB 크기·증가율·WAL 생성률을 읽기 전용으로 표본 수집하고, 명시한 디스크 여유와 offline 비교한다.
9GiB DB나 Oracle 여유 20GiB 같은 값을 기본값으로 가정하지 않는다. 결과는 'within_observed_bounds'가 최선이며 준비 완료가 아니다."""
from datetime import datetime

import replication_common as common
import report_contract as contract

KIND = 'nomorevibe-oracle-dr-capacity-capture'
SETTINGS = ('wal_level', 'max_wal_size', 'min_wal_size', 'wal_keep_size', 'max_slot_wal_keep_size', 'max_replication_slots',
            'max_wal_senders', 'max_connections', 'logical_decoding_work_mem', 'checkpoint_timeout', 'archive_mode',
            'max_sync_workers_per_subscription', 'max_logical_replication_workers', 'wal_segment_size')
TABLE_KEYS = ('relation', 'totalBytes', 'heapBytes', 'indexBytes', 'toastBytes', 'liveTuples', 'deadTuples', 'inserts',
              'updates', 'deletes')
CURRENT_LSN = "CASE WHEN pg_catalog.pg_is_in_recovery() THEN NULL ELSE pg_catalog.pg_current_wal_lsn()::text END"


def capture_sql(timeout):
    settings = ', '.join(common.literal(s) for s in SETTINGS)
    return ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\n' + common.SESSION_SQL.format(timeout=timeout) + f"""
SELECT pg_catalog.jsonb_build_object('frame', 'start', 'at', {common.DB_CLOCK}, 'database', {common.DATABASE_SQL},
  'currentLsn', {CURRENT_LSN}, 'databaseBytes', pg_catalog.pg_database_size(pg_catalog.current_database()));
SELECT pg_catalog.jsonb_build_object('frame', 'settings', 'settings', (SELECT pg_catalog.jsonb_object_agg(name,
  pg_catalog.jsonb_build_object('setting', setting, 'unit', unit)) FROM pg_catalog.pg_settings WHERE name IN ({settings})));
SELECT pg_catalog.jsonb_build_object('frame', 'cluster',
  'databases', (SELECT count(*) FROM pg_catalog.pg_database WHERE NOT datistemplate),
  'clientBackends', (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE backend_type = 'client backend'),
  'walSenders', (SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE backend_type = 'walsender'),
  'walBytes', (SELECT wal_bytes::bigint FROM pg_catalog.pg_stat_wal),
  'walStatsReset', (SELECT pg_catalog.to_char(stats_reset AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM pg_catalog.pg_stat_wal),
  'slots', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name', s.slot_name, 'type', s.slot_type,
     'database', s.database, 'temporary', s.temporary, 'active', s.active, 'walStatus', s.wal_status,
     'retainedBytes', CASE WHEN pg_catalog.pg_is_in_recovery() OR s.restart_lsn IS NULL THEN NULL
        ELSE pg_catalog.pg_wal_lsn_diff(pg_catalog.pg_current_wal_lsn(), s.restart_lsn)::bigint END) ORDER BY s.slot_name)
     FROM pg_catalog.pg_replication_slots s), '[]'::jsonb));
SELECT pg_catalog.jsonb_build_object('frame', 'tables', 'tables', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'relation', pg_catalog.jsonb_build_array(n.nspname, c.relname), 'totalBytes', pg_catalog.pg_total_relation_size(c.oid),
  'heapBytes', pg_catalog.pg_relation_size(c.oid), 'indexBytes', pg_catalog.pg_indexes_size(c.oid),
  'toastBytes', CASE WHEN c.reltoastrelid = 0 THEN 0 ELSE pg_catalog.pg_total_relation_size(c.reltoastrelid) END,
  'liveTuples', s.n_live_tup, 'deadTuples', s.n_dead_tup, 'inserts', s.n_tup_ins, 'updates', s.n_tup_upd, 'deletes', s.n_tup_del)
  ORDER BY n.nspname, c.relname) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_catalog.pg_stat_all_tables s ON s.relid = c.oid
  WHERE c.relkind IN ('r', 'm') AND n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'), '[]'::jsonb));
SELECT pg_catalog.jsonb_build_object('frame', 'end', 'at', {common.DB_CLOCK}, 'currentLsn', {CURRENT_LSN});
ROLLBACK;
""")


def _count(value):
    return common.nonnegative(value)


def parse_frames(frames):
    names = {k: 'one' for k in ('start', 'settings', 'cluster', 'tables', 'end')}
    found = common.frames_by_name(frames, names)
    contract.require([f['frame'] for f in frames] == list(names))
    start, end = found['start'], found['end']
    contract.exact(start, ('frame', 'at', 'database', 'currentLsn', 'databaseBytes'))
    contract.exact(end, ('frame', 'at', 'currentLsn'))
    for frame in (start, end):
        contract.timestamp(frame['at'])
        if frame['currentLsn'] is not None:
            common.lsn(frame['currentLsn'])
    contract.require(start['at'] <= end['at'])
    settings = found['settings']['settings']
    contract.require(type(settings) is dict and set(settings) == set(SETTINGS))
    for value in settings.values():
        contract.exact(value, ('setting', 'unit'))
        contract.require(type(value['setting']) is str)
    cluster = found['cluster']
    contract.exact(cluster, ('frame', 'databases', 'clientBackends', 'walSenders', 'walBytes', 'walStatsReset', 'slots'))
    for key in ('databases', 'clientBackends', 'walSenders', 'walBytes'):
        _count(cluster[key])
    if cluster['walStatsReset'] is not None:
        contract.timestamp(cluster['walStatsReset'])
    for slot in cluster['slots']:
        contract.exact(slot, ('name', 'type', 'database', 'temporary', 'active', 'walStatus', 'retainedBytes'))
        contract.text(slot['name'])
        contract.boolean_fields(slot, ('temporary', 'active'))
        if slot['retainedBytes'] is not None:
            contract.integer(slot['retainedBytes'], -(2 ** 63), 2 ** 63 - 1)
    tables = {}
    for row in found['tables']['tables']:
        contract.exact(row, TABLE_KEYS)
        relation = tuple(row['relation'])
        contract.require(len(relation) == 2 and relation not in tables)
        for key in TABLE_KEYS[1:]:
            if row[key] is not None or key in ('totalBytes', 'heapBytes', 'indexBytes', 'toastBytes'):
                _count(row[key])
        tables[relation] = row
    return {'at': start['at'], 'database': common.database(start['database']), 'currentLsn': start['currentLsn'],
            'databaseBytes': _count(start['databaseBytes']), 'settings': settings, 'cluster': cluster, 'tables': tables}


def capture(database_url, *, label, expected_database, expected_user, psql, timeout):
    contract.text(label)
    timeout = common.checked_timeout(timeout)
    started = common.utc_now()
    frames = common.run_psql(database_url, capture_sql(timeout), expected_database=expected_database,
                             expected_user=expected_user, psql=psql, app='nomorevibe-oracle-dr-capacity',
                             read_only=True, timeout=timeout + 15)
    parsed = parse_frames(frames)
    common.database(parsed['database'], expected_database, expected_user)
    return validate_capture({'kind': KIND, 'version': 1, 'label': label, 'clientStartedAt': started,
                             'clientFinishedAt': common.utc_now(), 'capturedAt': parsed['at'], 'frames': frames,
                             'readiness': 'unknown', 'automaticDrAllowed': False})


def validate_capture(value):
    contract.exact(value, ('kind', 'version', 'label', 'clientStartedAt', 'clientFinishedAt', 'capturedAt', 'frames',
                           'readiness', 'automaticDrAllowed'))
    contract.require(value['kind'] == KIND and value['version'] == 1 and value['readiness'] == 'unknown'
                     and value['automaticDrAllowed'] is False)
    contract.require(parse_frames(value['frames'])['at'] == value['capturedAt'])
    return value


def _hours(a, b):
    parse = lambda value: datetime.strptime(value, '%Y-%m-%dT%H:%M:%S.%fZ')
    return (parse(b) - parse(a)).total_seconds() / 3600


def evaluate(captures, *, target_free_bytes, target_wal_reserve_bytes, publisher_wal_free_bytes, horizon_days,
             outage_hours, seed_hours, archive_bytes=0, subscriber_capture=None):
    """모든 디스크·시간 값은 운영자가 관측해 명시한다. 증가율은 표본 구간 중 최대(보수) 비율을 쓴다."""
    for value in (target_free_bytes, target_wal_reserve_bytes, publisher_wal_free_bytes, archive_bytes):
        common.nonnegative(value)
    for value in (horizon_days, outage_hours, seed_hours):
        contract.require(type(value) in (int, float) and 0 <= value <= 3650 * 24)
    contract.require(type(captures) is list and captures)
    parsed = [parse_frames(validate_capture(c)['frames']) for c in captures]
    parsed.sort(key=lambda p: p['at'])
    first = parsed[0]
    contract.require(all(common.same_database(p['database'], first['database']) for p in parsed))
    contract.require(all(a['at'] < b['at'] for a, b in zip(parsed, parsed[1:])))
    findings = []

    def add(severity, code, **extra):
        findings.append({'severity': severity, 'code': code, **extra})
    intervals, unknown_rate = [], None
    for a, b in zip(parsed, parsed[1:]):
        hours = _hours(a['at'], b['at'])
        if a['currentLsn'] is None or b['currentLsn'] is None:
            unknown_rate = 'capture_in_recovery'
            continue
        wal = common.lsn(b['currentLsn']) - common.lsn(a['currentLsn'])
        if wal < 0:
            unknown_rate = 'lsn_regressed_failover_or_timeline'
            continue
        tables = {}
        for relation, row in b['tables'].items():
            before = a['tables'].get(relation)
            if before is None:
                continue
            inserts = None if before['inserts'] is None or row['inserts'] is None or row['inserts'] < before['inserts'] \
                else (row['inserts'] - before['inserts']) / hours * 24
            tables[relation] = {'growthPerDay': (row['totalBytes'] - before['totalBytes']) / hours * 24, 'insertsPerDay': inserts}
        intervals.append({'from': a['at'], 'to': b['at'], 'hours': hours, 'walBytesPerHour': wal / hours,
                          'databaseGrowthPerDay': (b['databaseBytes'] - a['databaseBytes']) / hours * 24, 'tables': tables})
    latest = parsed[-1]
    window = _hours(first['at'], latest['at'])
    if unknown_rate:
        add('blocking', 'rate_unknown', reason=unknown_rate)
    if not intervals:
        add('blocking', 'growth_unknown_needs_two_primary_captures')
    elif window < 24:
        add('attention', 'observation_window_short', hours=round(window, 3), detail='일/주 주기 부하가 표본에 없을 수 있다')
    wal_rate = max((i['walBytesPerHour'] for i in intervals), default=None) if not unknown_rate else None
    growth = max((max(0.0, i['databaseGrowthPerDay']) for i in intervals), default=None) if not unknown_rate else None
    if intervals and any(i['databaseGrowthPerDay'] < 0 for i in intervals):
        add('attention', 'negative_growth_interval_ignored', detail='삭제·vacuum full 등. 투영에는 0으로 쓴다')
    # R 디스크: 현재 크기만으로도 모자라면 증가율과 무관하게 insufficient다.
    base_required = latest['databaseBytes'] + target_wal_reserve_bytes + archive_bytes
    projected = None if growth is None else latest['databaseBytes'] + growth * horizon_days
    required = None if projected is None else projected + target_wal_reserve_bytes + archive_bytes
    if base_required > target_free_bytes or (required is not None and required > target_free_bytes):
        target_verdict = 'insufficient'
        add('blocking', 'target_disk_insufficient', requiredBytes=round(required or base_required), freeBytes=target_free_bytes)
    else:
        target_verdict = 'unknown' if required is None else 'within_observed_bounds'
    settings = latest['settings']
    keep = common.setting_bytes(settings['max_slot_wal_keep_size'])
    retention = None if wal_rate is None else wal_rate * max(outage_hours, seed_hours)
    existing = max((s['retainedBytes'] or 0 for s in latest['cluster']['slots']), default=0)
    if retention is None:
        wal_verdict = 'unknown'
    elif retention > publisher_wal_free_bytes:
        wal_verdict = 'insufficient'
        add('blocking', 'publisher_wal_disk_insufficient', retentionBytes=round(retention), freeBytes=publisher_wal_free_bytes)
    else:
        wal_verdict = 'within_observed_bounds'
    if keep < 0:
        add('attention', 'slot_wal_unbounded', detail='max_slot_wal_keep_size=-1: 정지한 slot은 primary 디스크(20개 DB 공용)를 채울 때까지 WAL을 붙잡는다')
    else:
        if keep > publisher_wal_free_bytes:
            add('blocking', 'slot_cap_exceeds_publisher_free', capBytes=keep, freeBytes=publisher_wal_free_bytes)
        if retention is not None and retention > keep:
            add('attention', 'slot_invalidated_within_outage_budget', capBytes=keep, retentionBytes=round(retention),
                detail='outage/seed 시간 안에 slot이 lost되어 재시드가 필요해진다')
    if settings['wal_level']['setting'] != 'logical':
        add('blocking', 'wal_level_change_requires_cluster_restart', current=settings['wal_level']['setting'],
            databases=latest['cluster']['databases'])
    sync_workers = None
    if subscriber_capture is not None:
        sync_workers = int(parse_frames(validate_capture(subscriber_capture)['frames'])['settings']
                           ['max_sync_workers_per_subscription']['setting'])
    need = None if sync_workers is None else 1 + sync_workers
    free_slots = int(settings['max_replication_slots']['setting']) - len(latest['cluster']['slots'])
    free_senders = int(settings['max_wal_senders']['setting']) - latest['cluster']['walSenders']
    if need is None:
        add('attention', 'sync_worker_count_unknown', detail='R capacity capture를 --subscriber-capture로 주면 필요 수를 계산한다')
    elif free_slots < need or free_senders < need:
        add('blocking', 'replication_headroom_insufficient', need=need, freeSlots=free_slots, freeSenders=free_senders)
    tables = []
    for relation, row in sorted(latest['tables'].items(), key=lambda item: (-item[1]['totalBytes'], item[0])):
        rates = [i['tables'][relation] for i in intervals if relation in i['tables']]
        tables.append({'relation': list(relation), 'totalBytes': row['totalBytes'], 'heapBytes': row['heapBytes'],
                       'indexBytes': row['indexBytes'], 'toastBytes': row['toastBytes'], 'liveTuplesEstimate': row['liveTuples'],
                       'growthBytesPerDay': max((r['growthPerDay'] for r in rates), default=None),
                       'insertsPerDay': max((r['insertsPerDay'] for r in rates if r['insertsPerDay'] is not None), default=None)})
    return {'kind': 'nomorevibe-oracle-dr-capacity-evaluation', 'version': 1,
            'inputs': {'targetFreeBytes': target_free_bytes, 'targetWalReserveBytes': target_wal_reserve_bytes,
                       'publisherWalFreeBytes': publisher_wal_free_bytes, 'horizonDays': horizon_days,
                       'outageHours': outage_hours, 'seedHours': seed_hours, 'archiveBytes': archive_bytes,
                       'captureLabels': [c['label'] for c in captures]},
            'database': latest['database'], 'observationWindowHours': window, 'intervals': len(intervals),
            'latest': {'at': latest['at'], 'databaseBytes': latest['databaseBytes'],
                       'otherDatabasesInCluster': latest['cluster']['databases'] - 1,
                       'clientBackendsAllDatabases': latest['cluster']['clientBackends'],
                       'maxConnections': int(settings['max_connections']['setting']),
                       'existingSlots': len(latest['cluster']['slots']), 'existingMaxRetainedBytes': existing},
            'rates': {'clusterWalBytesPerHour': wal_rate, 'databaseGrowthBytesPerDay': growth,
                      'note': 'WAL 생성률은 cluster 전체(다른 DB 포함)다. 논리 slot은 이 전체를 보존한다.'},
            'target': {'verdict': target_verdict, 'baseRequiredBytes': base_required, 'projectedDatabaseBytes': projected,
                       'requiredBytes': required, 'headroomBytes': None if required is None else target_free_bytes - required},
            'publisherWal': {'verdict': wal_verdict, 'slotRetentionBytes': retention, 'slotMaxWalKeepBytes': keep},
            'replicationHeadroom': {'need': need, 'freeSlots': free_slots, 'freeSenders': free_senders},
            'tables': tables, 'findings': findings, 'blockingFindings': sum(f['severity'] == 'blocking' for f in findings),
            'assumptionsRejected': ['DB 크기·Oracle 여유·증가율·outage 시간 기본값 없음', 'within_observed_bounds는 표본 구간 기준이며 충분 증명이 아니다'],
            'readiness': 'unknown', 'automaticDrAllowed': False}


def main(argv=None):
    def run(arguments):
        parser = common.Parser(description=__doc__)
        commands = parser.add_subparsers(dest='command', required=True, parser_class=common.Parser)
        cap = commands.add_parser('capture')
        cap.add_argument('--label', required=True)
        common.connection_arguments(cap)
        ev = commands.add_parser('evaluate')
        ev.add_argument('--capture', action='append', required=True)
        ev.add_argument('--subscriber-capture')
        for option, text in (('--target-free-bytes', 'R PGDATA 파일시스템의 seed 전 여유(운영자 df 관측)'),
                             ('--target-wal-reserve-bytes', 'R의 max_wal_size+checkpoint 여유(운영자 결정)'),
                             ('--publisher-wal-free-bytes', 'V9-Primary pg_wal 파일시스템의 현재 여유(운영자 df 관측)')):
            ev.add_argument(option, required=True, type=int, help=text)
        for option, text in (('--horizon-days', '성장 투영 기간'), ('--outage-hours', 'R 중단을 사람이 처리하기까지 최대 시간'),
                             ('--seed-hours', '초기 COPY 또는 dump→restore 예상 시간')):
            ev.add_argument(option, required=True, type=float, help=text)
        ev.add_argument('--archive-bytes', type=int, default=0, help='dump seed archive를 R 파일시스템에 둘 때 그 크기')
        args = parser.parse_args(arguments)
        if args.command == 'capture':
            return capture(common.read_url(), label=args.label, expected_database=args.expect_database,
                           expected_user=args.expect_user, psql=args.psql, timeout=args.timeout_seconds)
        result = evaluate([common.load_file(p) for p in args.capture], target_free_bytes=args.target_free_bytes,
                          target_wal_reserve_bytes=args.target_wal_reserve_bytes,
                          publisher_wal_free_bytes=args.publisher_wal_free_bytes, horizon_days=args.horizon_days,
                          outage_hours=args.outage_hours, seed_hours=args.seed_hours, archive_bytes=args.archive_bytes,
                          subscriber_capture=common.load_file(args.subscriber_capture) if args.subscriber_capture else None)
        return result, 3 if result['blockingFindings'] else 0
    return common.cli(run, argv)


if __name__ == '__main__':
    raise SystemExit(main())
