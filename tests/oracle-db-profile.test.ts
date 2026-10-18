import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ORACLE_DB_PRINCIPALS, ORACLE_DB_PROFILES, oracleDbGrantStatements, oracleDbPrivilegeMismatches, renderOracleDbGrantSql,
  type OracleDbService, type PrivilegeRow, ORACLE_REFRESH_PRINCIPAL, ORACLE_REFRESH_PROFILE, renderOracleRefreshGrantSql,
  ORACLE_CONSUMER_DB_PROFILES, ORACLE_CONSUMER_FORBIDDEN_TABLES, oracleConsumerGrantStatements, oracleConsumerPrivilegeMismatches,
  type OracleConsumerDbProfile, type OracleDbProfile } from '@/lib/runtime/oracle-db-profile';
import { consumerSpec } from '@/lib/runtime/consumer-registry';

const services = Object.keys(ORACLE_DB_PRINCIPALS) as OracleDbService[];
function catalog(service: OracleDbService, extraTable?: string): PrivilegeRow[] {
  const tables = [...Object.keys(ORACLE_DB_PROFILES[service].tables), ...(extraTable ? [extraTable] : [])];
  return tables.map(table => {
    const grant = ORACLE_DB_PROFILES[service].tables[table] ?? {};
    const column = (kind: 'insert' | 'update', name: string) => grant[kind] === true || Array.isArray(grant[kind]) && (grant[kind] as readonly string[]).includes(name);
    const names = ['id', 'slug', 'product_id', 'cursor', 'updated_at', 'progress', 'host', 'boot_id', 'release', 'policy_hash', 'observed_at', 'capability', 'result_evidence', 'mode',
      // F4: column-limited runtime tables (jobs, role_leases, operations_observations)
      'name', 'requested_version', 'processed_version', 'next_scheduled_at', 'not_before', 'lease_token', 'worker_seen_at', 'locked_at', 'last_run_at',
      'last_success_at', 'last_error', 'runs', 'role', 'owner_instance_id', 'owner_boot_id', 'owner_kind', 'owner_release', 'epoch', 'primary_boots',
      'quarantine_until', 'lease_until', 'key', 'value'];
    return { schema: 'public', table, select: Boolean(grant.select), insert: grant.insert === true, update: grant.update === true, delete: Boolean(grant.delete),
      columns: names.map(name => ({ name, select: Boolean(grant.select), insert: column('insert', name), update: column('update', name) })) };
  });
}

it('keeps the checked-in operator SQL byte-identical to the verified profile', () => {
  expect(readFileSync('deploy/oracle/least-privilege.sql', 'utf8')).toBe(renderOracleDbGrantSql());
});

it('accepts only the exact approved catalog for the exact principal', () => {
  for (const service of services) {
    expect(oracleDbPrivilegeMismatches(service, ORACLE_DB_PRINCIPALS[service], catalog(service))).toEqual([]);
    expect(oracleDbPrivilegeMismatches(service, 'nomorevibe', catalog(service))).toEqual(['principal']);
    expect(oracleDbPrivilegeMismatches(service, ORACLE_DB_PRINCIPALS[service], catalog(service, 'crawl_candidates').map(row =>
      row.table === 'crawl_candidates' ? { ...row, insert: true } : row))).toEqual(['public.crawl_candidates']);
    const missing = catalog(service).slice(1);
    expect(oracleDbPrivilegeMismatches(service, ORACLE_DB_PRINCIPALS[service], missing)).toEqual([`public.${catalog(service)[0].table}`]);
  }
  const widened = catalog('official-news').map(row => row.table === 'job_batch_candidates'
    ? { ...row, columns: row.columns.map(column => column.name === 'capability' ? { ...column, update: true } : column) } : row);
  expect(oracleDbPrivilegeMismatches('official-news', ORACLE_DB_PRINCIPALS['official-news'], widened)).toEqual(['public.job_batch_candidates']);
  expect(oracleDbPrivilegeMismatches('scheduler', ORACLE_DB_PRINCIPALS.scheduler, 'not-a-catalog')).toEqual(['catalog']);
});

it('never grants workers evidence updates, deletes or DDL, and keeps the attester away from runtime state', () => {
  for (const service of services.filter(service => service !== 'attest')) {
    const profile = ORACLE_DB_PROFILES[service];
    expect(Object.values(profile.tables).some(grant => grant.delete)).toBe(false);
    const candidate = profile.tables.job_batch_candidates;
    if (candidate) expect(candidate.update).toEqual(['host', 'boot_id', 'release', 'policy_hash', 'observed_at']);
    expect(oracleDbGrantStatements(service, { connectionLimit: 4 }).join('\n')).not.toMatch(/\b(CREATE ON|ALL PRIVILEGES|TRUNCATE|SUPERUSER |CREATEROLE |BYPASSRLS )/);
  }
  const attest = ORACLE_DB_PROFILES.attest.tables;
  expect(attest.job_batch_candidates.update).toEqual(['capability', 'result_evidence']);
  expect(Object.entries(attest).filter(([, grant]) => grant.insert || grant.update === true).map(([table]) => table)).toEqual(['job_batch_candidates']);
  expect(() => oracleDbGrantStatements('translation', { connectionLimit: 0 })).toThrow('invalid_connection_limit');
  expect(() => oracleDbGrantStatements('translation', { connectionLimit: ':x; DROP' as `:${string}` })).toThrow('invalid_connection_limit');
});

it('keeps the optional capability-only refresh principal out of the default SQL and identical to its own file', () => {
  expect(readFileSync('deploy/oracle/refresh-principal.sql', 'utf8')).toBe(renderOracleRefreshGrantSql());
  expect(renderOracleDbGrantSql()).not.toContain(ORACLE_REFRESH_PRINCIPAL);
  expect(ORACLE_REFRESH_PROFILE.tables.job_batch_candidates).toEqual({ select: true, update: ['capability'] });
  expect(Object.entries(ORACLE_REFRESH_PROFILE.tables).filter(([, grant]) => grant.insert || grant.delete || grant.update === true)).toEqual([]);
  expect(Object.keys(ORACLE_REFRESH_PROFILE.tables).sort()).toEqual(['http_origin_control', 'http_origin_hops', 'job_batch_candidates', 'job_batch_control']);
  // The attester gains only a read of the model ledger for translation model-bound readback.
  expect(ORACLE_DB_PROFILES.attest.tables.model_capacity_requests).toEqual({ select: true });
});

it('lets translation read the HTTP control row and never lets a worker rewrite a runtime key column', () => {
  // host 합계 예산 장부 갱신·비상 admission 판정이 읽는다(scheduler 와 같은 SELECT 만)
  expect(ORACLE_DB_PROFILES.translation.tables.http_origin_control).toEqual({ select: true });
  const keys = { jobs: 'name', role_leases: 'role', operations_observations: 'key' } as const;
  for (const service of services.filter(service => service !== 'attest')) {
    for (const [table, key] of Object.entries(keys)) {
      const grant = ORACLE_DB_PROFILES[service].tables[table];
      if (!grant) continue;
      expect(grant.update, `${service}.${table}`).toBeInstanceOf(Array);
      expect(grant.update as readonly string[], `${service}.${table}`).not.toContain(key);
    }
  }
  expect(ORACLE_DB_PROFILES.scheduler.tables.operations_observations).toEqual({ select: true, insert: true, update: ['value', 'observed_at'] });
});

// B0: consumer 계정 틀. 실제 agent-scan·uptime 프로필은 각 consumer PR 이 채운다 — 여기서는 시험용 프로필로 생성·비교 규칙을 본다.
const FIXTURE: OracleConsumerDbProfile = { principal: 'nomorevibe_oracle_fixture_scan', profile: { statementTimeout: '10s',
  sequences: ['dr_process_group_events_id_seq'], tables: { dr_writer_fence: { select: true, update: ['id'] }, crawl_settings: { select: true },
    operations_observations: { select: true, insert: true, update: ['value', 'observed_at'] }, dr_process_group_events: { select: true, insert: true } } } };
function consumerCatalog(profile: OracleDbProfile, extraTable?: string): PrivilegeRow[] {
  return [...Object.keys(profile.tables), ...(extraTable ? [extraTable] : [])].map(table => {
    const grant = profile.tables[table] ?? {};
    const column = (kind: 'insert' | 'update', name: string) => grant[kind] === true || Array.isArray(grant[kind]) && (grant[kind] as readonly string[]).includes(name);
    return { schema: 'public', table, select: Boolean(grant.select), insert: grant.insert === true, update: grant.update === true, delete: Boolean(grant.delete),
      columns: ['id', 'key', 'value', 'observed_at'].map(name => ({ name, select: Boolean(grant.select), insert: column('insert', name), update: column('update', name) })) };
  });
}

it('renders a consumer principal with role timeouts plus a UTC default and no runtime authority', () => {
  expect(oracleConsumerGrantStatements(FIXTURE, { connectionLimit: 3 })).toEqual([
    'CREATE ROLE nomorevibe_oracle_fixture_scan LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3',
    "ALTER ROLE nomorevibe_oracle_fixture_scan SET statement_timeout = '10s'", "ALTER ROLE nomorevibe_oracle_fixture_scan SET lock_timeout = '5s'",
    "ALTER ROLE nomorevibe_oracle_fixture_scan SET idle_in_transaction_session_timeout = '60s'",
    "ALTER ROLE nomorevibe_oracle_fixture_scan SET timezone = 'UTC'",
    'GRANT USAGE ON SCHEMA public TO nomorevibe_oracle_fixture_scan',
    'GRANT SELECT ON TABLE public.crawl_settings TO nomorevibe_oracle_fixture_scan',
    'GRANT SELECT, INSERT ON TABLE public.dr_process_group_events TO nomorevibe_oracle_fixture_scan',
    'GRANT SELECT ON TABLE public.dr_writer_fence TO nomorevibe_oracle_fixture_scan',
    'GRANT UPDATE (id) ON TABLE public.dr_writer_fence TO nomorevibe_oracle_fixture_scan',
    'GRANT SELECT, INSERT ON TABLE public.operations_observations TO nomorevibe_oracle_fixture_scan',
    'GRANT UPDATE (value, observed_at) ON TABLE public.operations_observations TO nomorevibe_oracle_fixture_scan',
    'GRANT USAGE ON SEQUENCE public.dr_process_group_events_id_seq TO nomorevibe_oracle_fixture_scan']);
  // 역할 서비스 SQL 에는 timezone 줄이 없다(기존 계정 문장은 그대로다)
  expect(services.flatMap(service => oracleDbGrantStatements(service, { connectionLimit: 2 })).some(line => line.includes('timezone'))).toBe(false);
  for (const principal of ['nomorevibe', ORACLE_DB_PRINCIPALS.translation, ORACLE_DB_PRINCIPALS.attest, ORACLE_REFRESH_PRINCIPAL,
    'nomorevibe_oracle_x; DROP ROLE y', 'nomorevibe_oracle_Upper', 'nomorevibe_oracle_'])
    expect(() => oracleConsumerGrantStatements({ ...FIXTURE, principal }, { connectionLimit: 3 })).toThrow('invalid_consumer_principal');
  for (const table of ORACLE_CONSUMER_FORBIDDEN_TABLES) {
    const profile = { ...FIXTURE.profile, tables: { ...FIXTURE.profile.tables, [table]: { select: true as const } } };
    expect(() => oracleConsumerGrantStatements({ ...FIXTURE, profile }, { connectionLimit: 3 })).toThrow('consumer_runtime_authority_forbidden');
  }
  expect(() => oracleConsumerGrantStatements(FIXTURE, { connectionLimit: 0 })).toThrow('invalid_connection_limit');
});

it('accepts only the exact consumer catalog for the exact consumer principal', () => {
  expect(oracleConsumerPrivilegeMismatches(FIXTURE, FIXTURE.principal, consumerCatalog(FIXTURE.profile))).toEqual([]);
  expect(oracleConsumerPrivilegeMismatches(FIXTURE, ORACLE_DB_PRINCIPALS.scheduler, consumerCatalog(FIXTURE.profile))).toEqual(['principal']);
  expect(oracleConsumerPrivilegeMismatches(FIXTURE, FIXTURE.principal, consumerCatalog(FIXTURE.profile, 'jobs').map(row =>
    row.table === 'jobs' ? { ...row, select: true } : row))).toEqual(['public.jobs']);
  expect(oracleConsumerPrivilegeMismatches(FIXTURE, FIXTURE.principal, consumerCatalog(FIXTURE.profile).slice(1))).toEqual(['public.dr_writer_fence']);
  const widened = consumerCatalog(FIXTURE.profile).map(row => row.table === 'operations_observations'
    ? { ...row, columns: row.columns.map(column => column.name === 'key' ? { ...column, update: true } : column) } : row);
  expect(oracleConsumerPrivilegeMismatches(FIXTURE, FIXTURE.principal, widened)).toEqual(['public.operations_observations']);
  expect(oracleConsumerPrivilegeMismatches(FIXTURE, FIXTURE.principal, null)).toEqual(['catalog']);
});

it('appends registered consumer sections to the operator SQL and keeps every registered profile within the consumer rules', () => {
  const base = renderOracleDbGrantSql();
  ORACLE_CONSUMER_DB_PROFILES['fixture-scan'] = FIXTURE;
  try {
    const rendered = renderOracleDbGrantSql();
    // 이름 순서 자리에 그 절만 끼워 넣는다 — 역할 절과 이미 등록된 consumer 절은 바이트 그대로다
    const section = `\n${['', '-- consumer fixture-scan', ...oracleConsumerGrantStatements(FIXTURE, { connectionLimit: ':fixture_scan_connections' })
      .map(statement => `${statement};`)].join('\n')}`;
    expect(rendered.split(section)).toHaveLength(2);
    expect(rendered.replace(section, '')).toBe(base);
    expect(rendered).toContain('\n-- consumer fixture-scan\nCREATE ROLE nomorevibe_oracle_fixture_scan LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT :fixture_scan_connections;\n');
    expect(rendered).toContain("ALTER ROLE nomorevibe_oracle_fixture_scan SET timezone = 'UTC';");
    expect(rendered.endsWith('\nCOMMIT;\n')).toBe(true);
  } finally { delete ORACLE_CONSUMER_DB_PROFILES['fixture-scan']; }
  expect(renderOracleDbGrantSql()).toBe(base);
  // 각 consumer PR 이 더한 실제 프로필: 등록부의 consumer 이고, 계정은 서로·역할 계정과 겹치지 않고, 역할 lease·batch 권한이 없다
  const registered = Object.entries(ORACLE_CONSUMER_DB_PROFILES);
  const principals = registered.map(([, profile]) => profile!.principal);
  expect(new Set(principals).size).toBe(principals.length);
  for (const [name, profile] of registered) {
    expect(consumerSpec(name), name).toBeDefined();
    expect(Object.values(ORACLE_DB_PRINCIPALS)).not.toContain(profile!.principal);
    expect(oracleConsumerGrantStatements(profile!, { connectionLimit: 4 }).join('\n')).not.toMatch(/\b(CREATE ON|ALL PRIVILEGES|TRUNCATE|SUPERUSER |CREATEROLE |BYPASSRLS )/);
  }
});

it('lets the uptime consumer read only the products columns its claim needs (no verify_token or edit_token_hash)', () => {
  const uptime = ORACLE_CONSUMER_DB_PROFILES.uptime!;
  const statements = oracleConsumerGrantStatements(uptime, { connectionLimit: 4 });
  expect(statements).toContain('GRANT SELECT (id, slug, url, status, access_mode) ON TABLE public.products TO nomorevibe_oracle_uptime');
  expect(statements.filter(line => / ON TABLE public\.products /.test(line))).toHaveLength(1);
  // 실제 카탈로그 모양: 표 단위 SELECT 없음, 열 단위로 다섯 열만
  const listed = Object.values(uptime.profile.tables).flatMap(grant => (['select', 'insert', 'update'] as const)
    .flatMap(kind => Array.isArray(grant[kind]) ? grant[kind] as readonly string[] : []));
  const names = [...new Set([...listed, 'verify_token', 'edit_token_hash', 'due_at', 'key'])];
  const exact: PrivilegeRow[] = Object.entries(uptime.profile.tables).map(([table, grant]) => {
    const column = (kind: 'select' | 'insert' | 'update', name: string) => grant[kind] === true || Array.isArray(grant[kind]) && (grant[kind] as readonly string[]).includes(name);
    return { schema: 'public', table, select: grant.select === true, insert: grant.insert === true, update: grant.update === true, delete: Boolean(grant.delete),
      columns: names.map(name => ({ name, select: column('select', name), insert: column('insert', name), update: column('update', name) })) };
  });
  expect(oracleConsumerPrivilegeMismatches(uptime, uptime.principal, exact)).toEqual([]);
  const products = (change: (row: PrivilegeRow) => PrivilegeRow) => exact.map(row => row.table === 'products' ? change(row) : row);
  expect(oracleConsumerPrivilegeMismatches(uptime, uptime.principal, products(row => ({ ...row, select: true })))).toEqual(['public.products']);
  expect(oracleConsumerPrivilegeMismatches(uptime, uptime.principal, products(row => ({ ...row,
    columns: row.columns.map(item => item.name === 'verify_token' ? { ...item, select: true } : item) })))).toEqual(['public.products']);
  // 필요한 열이 카탈로그에 없으면(이름이 바뀜 등) 맞지 않는다
  expect(oracleConsumerPrivilegeMismatches(uptime, uptime.principal, products(row => ({ ...row,
    columns: row.columns.filter(item => item.name !== 'access_mode') })))).toEqual(['public.products']);
});
