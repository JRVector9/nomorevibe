#!/usr/bin/env python3
"""PR14d: PR14a source inventory로 논리 복제 구성안을 만든다. 실행하지 않는다(dry-run은 BEGIN…ROLLBACK)."""
import copy
import hashlib
import json

import replication_common as common
import report_contract as contract

KIND = 'nomorevibe-oracle-dr-replication-plan'
# 마이그레이션 journal은 양쪽에 각자 적용한다. 복제하면 R의 migrate가 DDL을 건너뛴다.
DEFAULT_EXCLUSIONS = {('drizzle', '__drizzle_migrations'): 'migration_journal_applied_per_side'}
BLOCKING_FINDINGS = {'update_delete_identity_missing', 'replica_identity_full_requires_review', 'non_permanent_relation',
                     'partition_publication_mapping_unverified', 'row_security_requires_review'}
INTEGER_TYPES = {('pg_catalog', 'int2'), ('pg_catalog', 'int4'), ('pg_catalog', 'int8')}
PUBLISH = 'insert, update, delete, truncate'
# streaming=on: 큰 TX를 공용 primary의 pg_replslot 대신 R 쪽 임시 파일로 보낸다.
# disable_on_error=true: 결정적 apply 오류를 재시도 루프 대신 subenabled=false로 드러낸다(slot은 계속 WAL을 붙잡는다).
SUBSCRIPTION_OPTIONS = "streaming = on, disable_on_error = true, binary = false, failover = false"
UNKNOWN = sorted(set(common.UNKNOWN) | {'sequence_current_values', 'large_object_content', 'complete_ddl'})

RISKS = [
    {'code': 'slot_pins_cluster_wal', 'impact': 'R 중단·지연·apply 오류 동안 slot이 primary WAL을 붙잡는다. WAL은 cluster 공용이라 다른 DB 19개의 쓰기량까지 보존되어 V9-Primary 디스크가 차면 20개 DB가 함께 멈춘다.',
     'control': 'max_slot_wal_keep_size 상한(초과 시 slot lost→재시드)과 replication_status evaluate의 retained/lag 임계, 아래 긴급 롤백.'},
    {'code': 'slot_holds_catalog_xmin', 'impact': '논리 slot의 catalog_xmin은 cluster 전체 catalog vacuum을 붙잡는다. 오래 멈춘 slot은 다른 DB의 catalog bloat를 만든다.',
     'control': 'slot inactive 시간·retained bytes 감시, 장기 중단이면 slot 삭제 후 재시드.'},
    {'code': 'wal_level_logical_restart', 'impact': 'wal_level=logical 전환은 Patroni cluster 재시작이 필요하고 WAL 양이 늘 수 있다(20개 DB 영향).',
     'control': '사용자 승인 창, 전환 전후 capacity capture로 WAL 생성률 비교.'},
    {'code': 'patroni_failover_drops_slot', 'impact': 'PG17 기본 구성에서 logical slot은 leader에만 있다. failover/switchover 뒤 새 leader에 slot이 없어 구독이 멈추고 그 사이 변경은 R에 오지 않는다. Patroni가 설정 밖 slot을 정리할 수 있는지(버전·slots/ignore_slots)는 미확인이다.',
     'control': 'failover 뒤 status evaluate의 slot_missing을 확인하고 롤백 후 재시드. failover slot 동기화(PG17 failover=true+sync_replication_slots)는 별도 결정.'},
    {'code': 'decoding_and_initial_copy_load', 'impact': 'walsender가 cluster 전체 WAL을 decode하고, 초기 COPY는 모든 표(og_images 포함)를 primary에서 읽는다.',
     'control': '저부하 창, R의 max_sync_workers_per_subscription로 동시 COPY 제한, streaming=on.'},
    {'code': 'wal_sender_slot_headroom', 'impact': '구독 1개는 walsender 1+초기 동기화 worker 수만큼의 replication 연결·임시 slot을 쓴다.',
     'control': 'capacity evaluate의 max_wal_senders/max_replication_slots 여유 확인.'},
    {'code': 'ddl_not_replicated', 'impact': 'DDL은 복제되지 않는다. 열 추가/삭제/이름 변경 순서가 어긋나면 apply 오류 또는 열 누락이 생긴다.',
     'control': 'ddlChangeProcedure를 모든 migration에 적용하고 status evaluate의 열 차이 finding을 확인.'},
    {'code': 'sequences_not_replicated', 'impact': '시퀀스 값은 복제되지 않는다. 승격 뒤 동기화 없이 쓰면 PK 충돌이 난다.',
     'control': 'cutover에서 sequence-sync SQL 적용(publisher snapshot 또는 R 데이터 max).'},
    {'code': 'large_objects_not_replicated', 'impact': 'large object는 논리 복제되지 않는다.',
     'control': 'LO가 0이 아니면 plan이 막힌다. status evaluate가 매번 다시 센다.'},
    {'code': 'subscriber_local_writes', 'impact': 'R에 앱/사람이 쓰면 복제 행과 충돌해 apply가 멈춘다.',
     'control': 'R의 앱 role 쓰기 권한 없음/연결 0. status capture의 otherClientBackends 확인.'},
    {'code': 'always_triggers_fire_on_apply', 'impact': 'ENABLE ALWAYS append-only trigger는 R apply에서도 동작한다. primary에서 trigger를 끄고 지우는 정리는 R apply를 깨뜨린다.',
     'control': 'append-only 표의 보존 정리는 R에도 같은 절차를 먼저 적용하거나 구독을 멈춘 뒤 양쪽에서 수행.'},
    {'code': 'origin_triggers_do_not_fire_on_apply', 'impact': '일반(origin) trigger는 apply 중 실행되지 않는다(예: products_cdn_purge). 부수 효과 표도 함께 복제되므로 정상이며 승격 뒤에는 다시 실행된다.',
     'control': '없음(관찰 사항).'},
    {'code': 'writer_fence_row_replicated', 'impact': 'dr_writer_fence도 복제된다. 구독이 살아 있는 채 PR15 seal을 하면 primary의 fence 변경이 R을 덮는다.',
     'control': 'seal 전에 구독 disable→slot_name NONE→drop을 끝내고 status evaluate의 sealPrecondition을 확인.'},
    {'code': 'conninfo_stored_on_subscriber', 'impact': 'pg_subscription.subconninfo에 연결 정보가 저장되며 R 슈퍼유저가 읽을 수 있다.',
     'control': '복제 전용 role, 최소 SELECT 권한, Tailscale 경로, 종료 시 role 삭제.'},
]
HUMAN_DECISIONS = [
    'seed 방식: copy(스키마만 복원+copy_data) 또는 dump(내보낸 snapshot의 pg_dump 복원+copy_data=false)',
    'max_slot_wal_keep_size 값(초과 시 slot lost와 재시드를 감수)과 retained/lag 경보 임계',
    'Patroni 설정: 외부 slot 보존(ignore_slots/permanent slots) 여부, PG17 failover slot 사용 여부',
    'wal_level=logical 전환을 위한 cluster 재시작 창(20개 DB 영향)',
    'Oracle 디스크 여유 실측값과 성장 horizon(capacity evaluate 입력)',
    '제외 표 목록과 사유(제외는 DR 데이터 손실이다)',
    'R 구독 owner(슈퍼유저 또는 pg_create_subscription+표 owner) 와 R 앱 role 쓰기 차단 방식',
    'cutover에서 sequence margin 값',
]


def _relation_key(row):
    return (row['schema'], row['name'])


def _usable_key(catalog, relation):
    indexes = [i for i in catalog['indexes'] if i['relationOid'] == relation['oid']
               and all(i[k] for k in ('valid', 'ready', 'live', 'unique', 'immediate'))
               and not i['predicatePresent'] and all(n > 0 for n in i['keyAttributeNumbers'])]
    wanted = 'primary' if relation['replicaIdentity'] == 'd' else 'replicaIdentity'
    if relation['replicaIdentity'] not in ('d', 'i'):
        return None, None
    chosen = next((i for i in indexes if i[wanted]), None)
    if chosen is None:
        return None, None
    columns = {c['number']: c for c in catalog['columns'] if c['relationOid'] == relation['oid']}
    key = [{'name': columns[n]['name'], 'typeSchema': columns[n]['typeSchema'], 'typeName': columns[n]['typeName']}
           for n in chosen['keyAttributeNumbers']]
    return key, 'primary' if wanted == 'primary' else 'replica_identity_index'


def _exclusions(values):
    result = dict(DEFAULT_EXCLUSIONS)
    for value in values:
        contract.require(type(value) is str and value.count('=') >= 1)
        target, reason = value.split('=', 1)
        contract.require(target.count('.') == 1)
        schema, relation = target.split('.')
        contract.text(schema)
        contract.text(relation)
        contract.text(reason)
        contract.require(len(reason) <= 200 and (schema, relation) not in result)
        result[(schema, relation)] = reason
    return result


def _table_list(tables):
    return ', '.join(common.qualified(t['schema'], t['name']) for t in tables)


def build_plan(inventory, *, publication, subscription, replication_role, exclusions=()):
    report = contract.validate_report(copy.deepcopy(inventory))
    contract.require(report['side'] == 'source')
    names = {'publication': common.name(publication), 'subscription': common.name(subscription),
             'slot': common.name(subscription), 'replicationRole': common.name(replication_role)}
    excluded_map = _exclusions(list(exclusions))
    catalog = report['catalog']
    by_oid = {r['oid']: r for r in catalog['relations']}
    finding_codes = {}
    for finding in report['findings']:
        if 'relation' in finding:
            finding_codes.setdefault(tuple(finding['relation']), set()).add(finding['code'])
    tables, excluded, non_tables, blockers = [], [], [], []
    for row in sorted(catalog['relations'], key=_relation_key):
        key = _relation_key(row)
        if row['kind'] == 'S':
            continue
        if key in excluded_map:
            excluded.append({'relation': list(key), 'reason': excluded_map[key]})
            continue
        if row['extension'] is not None:
            excluded.append({'relation': list(key), 'reason': 'extension_member_recreated_by_extension'})
            continue
        if row['kind'] in ('v', 'm'):
            non_tables.append({'relation': list(key), 'kind': row['kind'],
                               'handling': 'ddl_only' if row['kind'] == 'v' else 'refresh_after_promotion'})
            continue
        if row['kind'] == 'f':
            blockers.append({'code': 'foreign_table_not_publishable', 'relation': list(key)})
            continue
        codes = sorted(finding_codes.get(key, set()) & BLOCKING_FINDINGS)
        blockers.extend({'code': code, 'relation': list(key)} for code in codes)
        if codes:
            continue
        columns, source = _usable_key(catalog, row)
        if columns is None:
            blockers.append({'code': 'update_delete_identity_missing', 'relation': list(key)})
            continue
        tables.append({'schema': row['schema'], 'name': row['name'], 'key': columns, 'keySource': source})
    for key in sorted(set(excluded_map) - {_relation_key(r) for r in catalog['relations']}):
        if key not in DEFAULT_EXCLUSIONS:
            blockers.append({'code': 'excluded_relation_not_observed', 'relation': list(key)})
    if catalog['largeObjectCount']:
        blockers.append({'code': 'large_objects_present', 'count': catalog['largeObjectCount']})
    if not tables:
        blockers.append({'code': 'no_publishable_tables'})
    sequences = []
    columns_by_key = {(c['relationOid'], c['number']): c for c in catalog['columns']}
    published = {(t['schema'], t['name']) for t in tables}
    for sequence in sorted(catalog['sequences'], key=lambda s: _relation_key(by_oid[s['oid']])):
        relation = by_oid[sequence['oid']]
        if relation['extension'] is not None:
            continue
        owners = []
        for owner in sequence['ownedBy']:
            table, column = by_oid[owner['relationOid']], columns_by_key[(owner['relationOid'], owner['columnNumber'])]
            owners.append({'relation': [table['schema'], table['name']], 'column': column['name'],
                           'typeSchema': column['typeSchema'], 'typeName': column['typeName']})
        if int(sequence['increment']) <= 0:
            blockers.append({'code': 'sequence_not_ascending', 'relation': list(_relation_key(relation))})
        if any(tuple(o['relation']) not in published for o in owners):
            continue
        sequences.append({'relation': list(_relation_key(relation)), 'increment': sequence['increment'],
                          'maximum': sequence['maximum'], 'ownedBy': owners})
    plan = {'kind': KIND, 'version': 1, 'names': names,
            'source': {'label': report['label'], 'database': report['database'], 'collectedAt': report['collectedAt']},
            'inventory': report, 'exclusionArguments': sorted(f'{s}.{n}={r}' for (s, n), r in excluded_map.items()
                                                             if (s, n) not in DEFAULT_EXCLUSIONS),
            'tables': tables, 'excluded': excluded, 'nonTables': non_tables, 'sequences': sequences,
            'extensions': catalog['extensions'], 'largeObjectCount': catalog['largeObjectCount'],
            'blockers': blockers, 'readiness': 'unknown', 'automaticDrAllowed': False, 'unknowns': UNKNOWN}
    plan.update(_sql(plan) if not blockers else {'sql': None})
    plan['procedure'] = _procedure(names) if not blockers else []
    plan['risks'] = RISKS
    plan['humanDecisions'] = HUMAN_DECISIONS
    return plan


def _sql(plan):
    names, tables = plan['names'], plan['tables']
    role, publication, subscription = (common.ident(names[k]) for k in ('replicationRole', 'publication', 'subscription'))
    schemas = sorted({t['schema'] for t in tables})
    db = common.ident(plan['source']['database']['name'])
    role_sql = [f'CREATE ROLE {role} WITH LOGIN REPLICATION NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS',
                f'GRANT CONNECT ON DATABASE {db} TO {role}',
                *[f'GRANT USAGE ON SCHEMA {common.ident(s)} TO {role}' for s in schemas],
                f'GRANT SELECT ON TABLE {_table_list(tables)} TO {role}']
    publisher_sql = [f"CREATE PUBLICATION {publication} FOR TABLE {_table_list(tables)} "
                     f"WITH (publish = '{PUBLISH}', publish_via_partition_root = false)"]
    slot = common.literal(names['slot'])

    def create(mode):
        seed = 'create_slot = true, copy_data = true' if mode == 'copy' else 'create_slot = false, copy_data = false'
        return [f"CREATE SUBSCRIPTION {subscription} CONNECTION :'publisher_conninfo' PUBLICATION {publication} "
                f"WITH (slot_name = {slot}, {seed}, enabled = true, {SUBSCRIPTION_OPTIONS})"]
    rollback = {
        'subscriber': [f'ALTER SUBSCRIPTION {subscription} DISABLE', f'ALTER SUBSCRIPTION {subscription} SET (slot_name = NONE)',
                       f'DROP SUBSCRIPTION {subscription}'],
        'publisherSlot': [f"SELECT pg_catalog.pg_drop_replication_slot(slot_name) FROM pg_catalog.pg_replication_slots "
                          f"WHERE slot_name = {slot} AND NOT active"],
        'publisherSlotForce': [f"SELECT pg_catalog.pg_terminate_backend(active_pid) FROM pg_catalog.pg_replication_slots "
                               f"WHERE slot_name = {slot} AND active"],
        'publisherObjects': [f'DROP PUBLICATION {publication}',
                             f'REVOKE SELECT ON TABLE {_table_list(tables)} FROM {role}',
                             *[f'REVOKE USAGE ON SCHEMA {common.ident(s)} FROM {role}' for s in schemas],
                             f'REVOKE CONNECT ON DATABASE {db} FROM {role}', f'DROP ROLE {role}'],
    }
    return {'sql': {'publisherRole': role_sql, 'publisher': publisher_sql,
                    'subscriberCopySeed': create('copy'), 'subscriberDumpSeed': create('dump'),
                    'dumpSeedReplicationCommand': f"CREATE_REPLICATION_SLOT {names['slot']} LOGICAL pgoutput (SNAPSHOT 'export')",
                    'rollback': rollback,
                    'ddlChangeProcedure': [
                        "publisher: status evaluate로 lag 확인 후 SELECT pg_current_wal_lsn() 기록",
                        f"publisher: slot {names['slot']}의 confirmed_flush_lsn이 기록 LSN 이상인지 확인",
                        f'subscriber: ALTER SUBSCRIPTION {subscription} DISABLE',
                        'publisher: migration 적용(기존 migrate 절차)', 'subscriber: 같은 migration 적용(R의 journal로)',
                        f'publisher(새 표가 있으면): ALTER PUBLICATION {publication} ADD TABLE <새 표> + 복제 role GRANT SELECT',
                        f'subscriber: ALTER SUBSCRIPTION {subscription} ENABLE',
                        f'subscriber(새 표가 있으면): ALTER SUBSCRIPTION {subscription} REFRESH PUBLICATION',
                        'replication_plan을 새 inventory로 다시 만들고 status capture/evaluate로 열·표 차이 0 확인']}}


def _procedure(names):
    slot = names['slot']
    steps = [
        ('observe', 'publisher 읽기', 'PR14a inventory와 capacity capture 2회 이상(같은 DB, 다른 시각)을 수집한다.', 'user', '없음(읽기 전용)'),
        ('capacity_gate', 'offline', 'capacity.py evaluate에 Oracle 디스크 여유·outage/seed 시간을 명시하고 insufficient/unknown이면 멈춘다.', 'none', '없음'),
        ('cluster_settings', 'V9-Primary Patroni', 'Patroni 버전·slots/ignore_slots 확인, wal_level=logical(재시작), max_slot_wal_keep_size(reload), slot/walsender 여유 확인.', 'user', 'patronictl로 원값 복구(wal_level은 재시작 필요)'),
        ('prepare_r', 'Oracle R', 'PG17·vector 동일 버전 설치, DB 생성, dump가 owner/GRANT로 참조하는 role(앱 role·복제 role 포함)을 R에 먼저 만든다(role은 cluster 전역이라 pg_dump에 없다; 없으면 restore가 GRANT에서 실패), 앱 role 쓰기 차단. copy seed면 pg_dump --schema-only --no-publications --no-subscriptions 복원 + pg_dump --data-only --table=drizzle.__drizzle_migrations 복원(migration으로 만들면 제어 표 seed 행이 COPY와 PK 충돌). dump seed면 이 단계에서 스키마를 만들지 않는다.', 'user', 'R DB 폐기'),
        ('publisher_role', 'publisher', 'sql.publisherRole 실행 후 psql \\password로 비밀번호 설정, pg_hba에 R 주소만 허용(복제 연결은 DB 이름으로 매칭).', 'user', 'sql.rollback.publisherObjects의 REVOKE/DROP ROLE'),
        ('dry_run', 'publisher·subscriber', 'replication_plan.py dry-run 양쪽(BEGIN…ROLLBACK, 표마다 SHARE UPDATE EXCLUSIVE 1초 대기 한도).', 'user', '없음(ROLLBACK)'),
        ('create_publication', 'publisher', 'sql.publisher 실행.', 'user', 'DROP PUBLICATION'),
        ('seed', 'subscriber(+publisher)', f'copy: sql.subscriberCopySeed(이때 slot {slot}이 생기고 WAL 보존 시작). dump: 복제 연결(replication=database)에서 sql.dumpSeedReplicationCommand로 slot+snapshot을 만들고 그 연결을 연 채 pg_dump -Fc --snapshot=<이름> --no-publications --no-subscriptions 후 R 복원(PR14b와 같은 단일 TX restore), 이어서 sql.subscriberDumpSeed.', 'user', '긴급 롤백'),
        ('monitor', 'publisher·subscriber 읽기', 'replication_status capture 양쪽+evaluate를 주기 실행. retained/lag 임계 초과·slot_missing·apply 오류면 사람이 판단.', 'user', '없음'),
        ('ddl_changes', 'publisher·subscriber', '모든 migration에 sql.ddlChangeProcedure 적용.', 'user', '구독 disable 상태로 원인 수정 후 enable'),
        ('patroni_failover', 'publisher', f'failover/switchover 뒤 새 leader에 slot {slot}이 있는지 status evaluate로 확인. 없으면 긴급 롤백 후 재시드(그 사이 변경은 R에 없다).', 'user', '재시드'),
        ('cutover', 'operator', '자동 승격 없음. 옛 primary fence/격리(PR15 근거)→가능하면 lag 0 확인→쓰기 0 상태에서 row-counts+표본 evaluate→구독 disable·slot_name NONE·drop→sequence-sync→PR15 seal/근거/promote.', 'user', 'PR15 절차(seal은 되돌리지 않고 R을 버린다)'),
        ('emergency_rollback', 'subscriber→publisher', 'sql.rollback.subscriber → publisher에서 slot 비활성 확인 후 sql.rollback.publisherSlot(R에 닿지 않으면 publisherSlotForce 뒤 publisherSlot) → 필요 시 publisherObjects.', 'user', '재시드로만 복구'),
    ]
    return [{'step': s, 'where': w, 'action': a, 'approval': p, 'rollback': r} for s, w, a, p, r in steps]


def plan_hash(plan):
    return hashlib.sha256(json.dumps(plan, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def validate_plan(plan):
    """저장된 plan은 내장 inventory와 인자로 다시 만들어 byte 단위로 같아야 한다. 손으로 고친 SQL은 거절한다."""
    contract.require(type(plan) is dict and plan.get('kind') == KIND and plan.get('version') == 1)
    names = plan['names']
    contract.exact(names, ('publication', 'subscription', 'slot', 'replicationRole'))
    rebuilt = build_plan(plan['inventory'], publication=names['publication'], subscription=names['subscription'],
                         replication_role=names['replicationRole'], exclusions=plan['exclusionArguments'])
    contract.require(rebuilt == plan and not plan['blockers'] and plan['automaticDrAllowed'] is False)
    return plan


def sequence_sync_sql(plan, *, margin, publisher_capture=None):
    """승격 직전 R에서 실행할 setval. 값을 낮추지 않는다. publisher snapshot이 없으면 R 데이터의 max(열)를 쓴다."""
    validate_plan(plan)
    contract.integer(margin, 1, 2 ** 62)
    values = None
    if publisher_capture is not None:
        import replication_status  # 순환 import 회피(status가 plan을 import한다)
        replication_status.validate_capture(publisher_capture, plan, 'publisher')
        values = {tuple(s['relation']): s for s in
                  replication_status.parse_data('publisher', publisher_capture['dataFrames'])['sequences']}
    statements, manual = [], []
    for sequence in plan['sequences']:
        relation = common.qualified(*sequence['relation'])
        regclass = common.literal(relation) + '::regclass'
        current = f'(SELECT last_value FROM {relation})'
        if values is not None:
            observed = values.get(tuple(sequence['relation']))
            if observed is None:
                manual.append({'relation': sequence['relation'], 'reason': 'not_in_publisher_capture'})
                continue
            target = str(int(observed['lastValue']) + margin)
        else:
            owners = [o for o in sequence['ownedBy'] if (o['typeSchema'], o['typeName']) in INTEGER_TYPES]
            if len(owners) != 1:
                manual.append({'relation': sequence['relation'], 'reason': 'no_single_integer_owner_column'})
                continue
            owner = owners[0]
            target = (f"(SELECT COALESCE(max({common.ident(owner['column'])}), 0) FROM ONLY "
                      f"{common.qualified(*owner['relation'])}) + {margin}")
        statements.append(f'SELECT pg_catalog.setval({regclass}, GREATEST({target}, {current}), true)')
    return {'kind': 'nomorevibe-oracle-dr-sequence-sync', 'version': 1, 'planHash': plan_hash(plan),
            'source': 'publisher_capture' if values is not None else 'subscriber_data_max',
            'publisherCapturedAt': publisher_capture['capturedAt'] if publisher_capture else None,
            'margin': margin, 'sql': statements, 'manual': manual,
            'note': '쓰기가 멈춘 뒤(옛 primary fence/격리·구독 drop 뒤) R에서 한 TX로 실행한다.',
            'readiness': 'unknown', 'automaticDrAllowed': False}


def dry_run_sql(plan, side, timeout):
    names = plan['names']
    head = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE;\n' + common.SESSION_SQL.format(timeout=timeout)
    tail = 'ROLLBACK;\n'
    if side == 'publisher':
        body = ';\n'.join(plan['sql']['publisherRole'] + plan['sql']['publisher']) + ';\n'
        role, pub = common.literal(names['replicationRole']), common.literal(names['publication'])
        readback = f"""SELECT pg_catalog.jsonb_build_object('frame', 'publisher',
  'publication', (SELECT pg_catalog.jsonb_build_object('allTables', puballtables, 'insert', pubinsert, 'update', pubupdate,
     'delete', pubdelete, 'truncate', pubtruncate, 'viaRoot', pubviaroot) FROM pg_catalog.pg_publication WHERE pubname = {pub}),
  'tables', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(schemaname, tablename) ORDER BY schemaname, tablename)
     FROM pg_catalog.pg_publication_tables WHERE pubname = {pub}), '[]'::jsonb),
  'role', (SELECT pg_catalog.jsonb_build_object('login', rolcanlogin, 'replication', rolreplication, 'superuser', rolsuper,
     'bypassRls', rolbypassrls) FROM pg_catalog.pg_roles WHERE rolname = {role}),
  'unselectable', coalesce((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(schemaname, tablename) ORDER BY schemaname, tablename)
     FROM pg_catalog.pg_publication_tables WHERE pubname = {pub}
       AND NOT pg_catalog.has_table_privilege({role}, pg_catalog.format('%I.%I', schemaname, tablename), 'SELECT')), '[]'::jsonb));
"""
        return head + body + readback + tail
    statement = (f"CREATE SUBSCRIPTION {common.ident(names['subscription'])} CONNECTION 'dbname=nomorevibe_oracle_dr_dry_run' "
                 f"PUBLICATION {common.ident(names['publication'])} WITH (connect = false, slot_name = "
                 f"{common.literal(names['slot'])}, {SUBSCRIPTION_OPTIONS});\n")
    values = ', '.join(f"({common.literal(t['schema'])}, {common.literal(t['name'])})" for t in plan['tables'])
    sub = common.literal(names['subscription'])
    readback = f"""SELECT pg_catalog.jsonb_build_object('frame', 'subscriber',
  'subscription', (SELECT pg_catalog.jsonb_build_object('enabled', subenabled, 'slot', subslotname, 'publications', subpublications,
     'streaming', substream, 'disableOnError', subdisableonerr, 'binary', subbinary, 'failover', subfailover)
     FROM pg_catalog.pg_subscription WHERE subname = {sub} AND subdbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())),
  'tables', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('relation', pg_catalog.jsonb_build_array(p.s, p.n),
     'present', c.oid IS NOT NULL,
     'nonEmpty', CASE WHEN c.oid IS NULL THEN NULL ELSE (pg_catalog.xpath('/row/e/text()', pg_catalog.query_to_xml(
        pg_catalog.format('SELECT EXISTS (SELECT 1 FROM ONLY %s) AS e', c.oid::regclass), false, true, '')))[1]::text = 'true' END,
     'columns', coalesce((SELECT pg_catalog.jsonb_agg(a.attname ORDER BY a.attname) FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::jsonb)) ORDER BY p.s, p.n)
     FROM (VALUES {values}) p(s, n) LEFT JOIN pg_catalog.pg_namespace ns ON ns.nspname = p.s
     LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = ns.oid AND c.relname = p.n AND c.relkind IN ('r', 'p')));
"""
    return head + statement + readback + tail


def dry_run(plan, database_url, *, side, expected_database, expected_user, psql, timeout):
    validate_plan(plan)
    contract.require(side in ('publisher', 'subscriber'))
    timeout = common.checked_timeout(timeout)
    frames = common.run_psql(database_url, dry_run_sql(plan, side, timeout), expected_database=expected_database,
                             expected_user=expected_user, psql=psql, app='nomorevibe-oracle-dr-replication-dry-run',
                             read_only=False, timeout=timeout + 15)
    contract.require(len(frames) == 1 and frames[0].get('frame') == side)
    frame, findings = frames[0], []
    planned = [[t['schema'], t['name']] for t in plan['tables']]
    if side == 'publisher':
        contract.exact(frame, ('frame', 'publication', 'tables', 'role', 'unselectable'))
        publication = frame['publication']
        if publication != {'allTables': False, 'insert': True, 'update': True, 'delete': True, 'truncate': True, 'viaRoot': False}:
            findings.append({'code': 'publication_options_differ'})
        if frame['tables'] != planned:
            findings.append({'code': 'publication_tables_differ', 'missing': [t for t in planned if t not in frame['tables']],
                             'extra': [t for t in frame['tables'] if t not in planned]})
        if frame['role'] != {'login': True, 'replication': True, 'superuser': False, 'bypassRls': False}:
            findings.append({'code': 'replication_role_attributes_differ'})
        if frame['unselectable']:
            findings.append({'code': 'replication_role_cannot_select', 'relations': frame['unselectable']})
        observed = {'publishedTables': len(frame['tables'])}
    else:
        contract.exact(frame, ('frame', 'subscription', 'tables'))
        expected = {'enabled': False, 'slot': plan['names']['slot'], 'publications': [plan['names']['publication']],
                    'streaming': 't', 'disableOnError': True, 'binary': False, 'failover': False}
        if frame['subscription'] != expected:
            findings.append({'code': 'subscription_options_differ'})
        inventory_columns = _inventory_columns(plan)
        missing, non_empty, column_drift = [], [], []
        for row in frame['tables']:
            relation = tuple(row['relation'])
            if not row['present']:
                missing.append(list(relation))
                continue
            if row['nonEmpty']:
                non_empty.append(list(relation))
            if sorted(inventory_columns[relation]) != row['columns']:
                column_drift.append(list(relation))
        if missing:
            findings.append({'code': 'subscriber_table_missing', 'relations': missing})
        if column_drift:
            findings.append({'code': 'subscriber_columns_differ_from_inventory', 'relations': column_drift})
        if non_empty:
            findings.append({'code': 'copy_seed_target_not_empty', 'relations': non_empty})
        observed = {'plannedTables': len(planned), 'presentTables': len(planned) - len(missing)}
    return {'kind': 'nomorevibe-oracle-dr-replication-dry-run', 'version': 1, 'side': side, 'planHash': plan_hash(plan),
            'committed': False, 'observed': observed, 'findings': findings, 'readiness': 'unknown',
            'automaticDrAllowed': False}


def _inventory_columns(plan):
    catalog = plan['inventory']['catalog']
    oids = {(r['schema'], r['name']): r['oid'] for r in catalog['relations']}
    return {(t['schema'], t['name']): [c['name'] for c in catalog['columns'] if c['relationOid'] == oids[(t['schema'], t['name'])]]
            for t in plan['tables']}


def main(argv=None):
    def run(arguments):
        parser = common.Parser(description=__doc__)
        commands = parser.add_subparsers(dest='command', required=True, parser_class=common.Parser)
        plan = commands.add_parser('plan')
        plan.add_argument('--inventory', required=True)
        plan.add_argument('--publication', default='nomorevibe_oracle_dr')
        plan.add_argument('--subscription', default='nomorevibe_oracle_dr')
        plan.add_argument('--replication-role', default='nomorevibe_oracle_dr_replicator')
        plan.add_argument('--exclude', action='append', default=[], help='schema.table=reason (DR 데이터 제외)')
        dry = commands.add_parser('dry-run')
        dry.add_argument('--plan', required=True)
        dry.add_argument('--side', required=True, choices=('publisher', 'subscriber'))
        common.connection_arguments(dry)
        sequences = commands.add_parser('sequence-sync')
        sequences.add_argument('--plan', required=True)
        sequences.add_argument('--margin', required=True, type=int)
        sequences.add_argument('--publisher-capture', help='replication_status capture(publisher). 없으면 R 데이터 max 사용')
        args = parser.parse_args(arguments)
        if args.command == 'plan':
            value = build_plan(common.load_file(args.inventory), publication=args.publication,
                               subscription=args.subscription, replication_role=args.replication_role,
                               exclusions=args.exclude)
            return value, 3 if value['blockers'] else 0
        if args.command == 'dry-run':
            value = dry_run(common.load_file(args.plan), common.read_url(), side=args.side,
                            expected_database=args.expect_database, expected_user=args.expect_user, psql=args.psql,
                            timeout=args.timeout_seconds)
            return value, 3 if value['findings'] else 0
        plan_value = common.load_file(args.plan)
        capture = common.load_file(args.publisher_capture) if args.publisher_capture else None
        return sequence_sync_sql(plan_value, margin=args.margin, publisher_capture=capture)
    return common.cli(run, argv)


if __name__ == '__main__':
    raise SystemExit(main())
