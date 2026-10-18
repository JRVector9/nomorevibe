import { sql } from 'drizzle-orm';

/**
 * Approved least-privilege PostgreSQL profiles for Oracle osaka-smoke services.
 *
 * The same table renders deploy/oracle/least-privilege.sql and verifies a session's effective privileges, so the
 * operator SQL and the runtime check cannot drift. Lock-only tables get UPDATE on their primary key column because
 * PostgreSQL requires UPDATE on at least one column for FOR UPDATE/SHARE; no other column of those tables is writable.
 * That key UPDATE is a residual right (singleton controls have CHECK id=1, but products.id, product_health.slug,
 * takedown_requests.slug, product_intro_checks.product_id and evidence_settings.id could be rewritten); closing it needs a trigger.
 * Workers can update only candidate identity columns: capability/result_evidence updates belong to the attest principal.
 * Runtime tables (jobs, role_leases, operations_observations) are column-limited to the non-key columns the runtime writes;
 * their INSERT stays table-wide because Drizzle names every column.
 */
export type OracleDbService = 'translation' | 'product-health' | 'site-evidence' | 'official-news' | 'scheduler' | 'attest';
export const ORACLE_DB_PRINCIPALS: Record<OracleDbService, string> = {
  translation: 'nomorevibe_oracle_translation', 'product-health': 'nomorevibe_oracle_product_health',
  'site-evidence': 'nomorevibe_oracle_site_evidence', 'official-news': 'nomorevibe_oracle_official_news',
  scheduler: 'nomorevibe_oracle_scheduler', attest: 'nomorevibe_oracle_attest',
};
type Columns = readonly string[];
type TableGrant = { select?: true; insert?: true | Columns; update?: true | Columns; delete?: true };
export type OracleDbProfile = { tables: Record<string, TableGrant>; sequences: readonly string[]; statementTimeout: '10s' | '60s' };
type Profile = OracleDbProfile;
const read: TableGrant = { select: true }, write: TableGrant = { select: true, insert: true, update: true };
const lock = (key: string): TableGrant => ({ select: true, update: [key] });
const CANDIDATE_IDENTITY = ['host', 'boot_id', 'release', 'policy_hash', 'observed_at'] as const;
// Key columns (jobs.name, role_leases.role, operations_observations.key) are never rewritten by the runtime.
const JOB_STATE = ['requested_version', 'processed_version', 'next_scheduled_at', 'not_before', 'lease_token', 'worker_seen_at', 'cursor',
  'locked_at', 'last_run_at', 'last_success_at', 'last_error', 'runs', 'updated_at'] as const;
const ROLE_LEASE_STATE = ['owner_instance_id', 'owner_boot_id', 'owner_kind', 'owner_release', 'epoch', 'primary_boots', 'quarantine_until',
  'lease_until', 'updated_at'] as const;
const jobsWrite: TableGrant = { select: true, insert: true, update: JOB_STATE };
const observationsWrite: TableGrant = { select: true, insert: true, update: ['value', 'observed_at'] };
// dr_writer_fence: 모든 역할 선출·갱신(legacy·versioned)·HTTP permit 관문의 첫 SHARE lock. dr_process_group_events: role-worker 의 D11 기록
// (PROCESS_GROUP_RECORDING=1 일 때만, append-only, UPDATE 없음). 그 INSERT 는 owner 를 제한하지 않는다(다른 instance 의 근거를 쓸 수 있음 — 남은 위험).
const RUNTIME: Record<string, TableGrant> = {
  job_batch_control: lock('id'), jobs: jobsWrite, operations_observations: observationsWrite,
  role_leases: { select: true, insert: true, update: ROLE_LEASE_STATE },
  dr_writer_fence: lock('id'), dr_process_group_events: { select: true, insert: true },
  // Drizzle names every column (DEFAULT) on INSERT, so INSERT cannot be column-limited; UPDATE (the heartbeat upsert) is.
  // Migration 0098's BEFORE INSERT trigger keeps that INSERT evidence-free: non-NULL capability/result_evidence needs UPDATE on that column.
  job_batch_candidates: { select: true, insert: true, update: CANDIDATE_IDENTITY },
};
const HTTP: Record<string, TableGrant> = { http_origin_control: lock('id'), http_origin_hops: write, http_origin_events: { insert: true } };
// `seed` elects the job's legacy parent role through tryAcquireRole, whose DR writer-fence gate reads this row FOR SHARE.
// RUNTIME already grants the same lock to every worker (versioned acquire/renew read the fence too), so this entry only
// documents the seed dependency; site-evidence (no legacy parent) has the identical grant through RUNTIME.
const LEGACY_SEED: Record<string, TableGrant> = { dr_writer_fence: lock('id') };
export const ORACLE_RESULT_READBACK_TABLES = ['news_items', 'uptime_observations', 'product_evidence_sources', 'evidence_source_claims',
  'product_refresh_requests', 'text_translations', 'product_korean_taglines', 'product_translations'] as const;

export const ORACLE_DB_PROFILES: Record<OracleDbService, Profile> = {
  'official-news': { statementTimeout: '60s', sequences: ['http_origin_events_id_seq', 'news_items_id_seq', 'dr_process_group_events_id_seq'],
    tables: { ...RUNTIME, ...LEGACY_SEED, ...HTTP, crawl_settings: read, news_items: { select: true, insert: true } } },
  // Raw-only uptime phase. Authoritative gate writes (auto-ban, health counters) are intentionally not granted.
  'product-health': { statementTimeout: '60s', sequences: ['http_origin_events_id_seq', 'dr_process_group_events_id_seq'],
    tables: { ...RUNTIME, ...LEGACY_SEED, ...HTTP, products: lock('id'), product_health: lock('slug'), uptime_control: lock('id'),
      uptime_gates: write, uptime_observations: { select: true, insert: true } } },
  'site-evidence': { statementTimeout: '60s', sequences: ['http_origin_events_id_seq', 'product_evidence_sources_id_seq', 'dr_process_group_events_id_seq'],
    tables: { ...RUNTIME, ...HTTP, products: lock('id'), evidence_settings: lock('id'), evidence_source_control: { select: true, update: ['cursor'] },
      evidence_source_claims: write, product_evidence_sources: write, product_links: read,
      product_refresh_requests: { select: true, update: ['progress', 'updated_at'] } } },
  // http_origin_control: host 합계 예산(HOST_BUDGET_ENFORCEMENT) 장부 갱신과 비상 admission 판정이 읽기만 한다(번역은 HTTP permit 을 쓰지 않는다).
  translation: { statementTimeout: '60s', sequences: ['model_capacity_events_id_seq', 'model_capacity_requests_queue_ordinal_seq', 'dr_process_group_events_id_seq'],
    tables: { ...RUNTIME, ...LEGACY_SEED, http_origin_control: read, crawl_settings: read, crawl_review_attempts: read, second_reviews: read, text_translations: write,
      product_korean_taglines: write, product_translations: { select: true, update: true }, products: lock('id'), product_health: read,
      product_intro_checks: lock('product_id'), takedown_requests: lock('slug'), uptime_control: read, uptime_gates: read,
      uptime_observations: read, model_capacity_control: { select: true, update: ['cursor', 'updated_at'] },
      model_capacity_requests: write, model_capacity_events: { insert: true } } },
  // requestDueJobs의 첫 lock(DR writer fence SHARE). fenced DB의 scheduler는 정기 요청을 만들지 않는다.
  // PR11g: 후보 행은 다른 worker 와 같은 권한(boot 기록·preflight 읽기, 증거 열 쓰기 없음). http_origin_control 은
  // HOST_BUDGET_ENFORCEMENT 장부 갱신이 읽기만 한다(scheduler 는 HTTP 를 보내지 않는다).
  scheduler: { statementTimeout: '10s', sequences: [],
    tables: { dr_writer_fence: lock('id'), job_batch_control: lock('id'), jobs: jobsWrite, operations_observations: observationsWrite,
      job_batch_candidates: RUNTIME.job_batch_candidates, http_origin_control: read } },
  // Operator evidence writer: never used by a worker process or heartbeat.
  attest: { statementTimeout: '60s', sequences: [],
    tables: { job_batch_control: lock('id'), jobs: read, operations_observations: { select: true, delete: true },
      job_batch_candidates: { select: true, insert: true, update: ['capability', 'result_evidence'] },
      http_origin_control: read, http_origin_hops: read, model_capacity_requests: read,
      ...Object.fromEntries(ORACLE_RESULT_READBACK_TABLES.map(table => [table, read])) } },
};
/**
 * Optional host refresh-timer principal (deploy/oracle/nomorevibe-core-refresh@.*, inactive by default). It may rewrite
 * only the capability column: no result evidence, anchor, ACK, domain or model-ledger access. It is deliberately outside
 * the approved worker/attest set, so least-privilege.sql is unchanged; refresh-principal.sql is applied only after the
 * host-timer policy is approved.
 */
export const ORACLE_REFRESH_PRINCIPAL = 'nomorevibe_oracle_refresh';
export const ORACLE_REFRESH_PROFILE: Profile = { statementTimeout: '10s', sequences: [],
  tables: { job_batch_control: lock('id'), job_batch_candidates: { select: true, update: ['capability'] },
    http_origin_control: read, http_origin_hops: read } };

/**
 * Oracle consumer principals (건 단위 일꾼: claim 으로 같은 큐를 나눠 맡고 역할 lease·batch 를 쓰지 않는다). The key is the consumer
 * name in lib/runtime/consumer-registry.ts; E5(agent-scan)·U2(uptime) add their entries together with the tables they use.
 * A consumer profile never holds ORACLE_CONSUMER_FORBIDDEN_TABLES (role lease, batch, job and AI item authority), and its generated SQL
 * pins the role default timezone to UTC: operational timestamp columns are timezone-less UTC (design R8).
 */
export type OracleConsumerDbProfile = { principal: string; profile: OracleDbProfile };
// split-v1 claim·제출·되돌림(lib/domain/products/uptime-claims.ts)이 쓰는 uptime_claims 열. due·confirm·affinity·충돌·적용 기록은 home 적용기만 쓴다
const UPTIME_CLAIM_WRITE = ['state', 'epoch', 'control_epoch', 'token', 'owner_instance_id', 'owner_boot_id', 'host', 'host_class', 'lease_until',
  'claimed_at', 'claim_slug', 'claim_url', 'origin', 'claim_slot', 'result_started_at', 'result_observed_at', 'result_kind', 'result_status',
  'result_latency_ms', 'submitted_at', 'updated_at'] as const;
// agent_repository_claims 에서 consumer 가 바꾸는 열: claim(소유 묶음·epoch)·기록(결과·시계·실패 묶음)·포기(소유 묶음·retry_after).
// 행 만들기와 priority·requires_daily·state 는 큐 채우기(M3 컨트롤러, job lease) 몫이다 — INSERT 도 그 열 UPDATE 도 없다.
const AGENT_CLAIM_STATE = ['token', 'instance_id', 'boot_id', 'epoch', 'control_epoch', 'binding_hash', 'claimed_at', 'lease_until', 'due_at',
  'retry_after', 'failure_streak', 'first_failure_at', 'last_error_code', 'last_outcome', 'last_finished_at', 'updated_at'] as const;
// 스캔 upsert 의 ON CONFLICT DO UPDATE 가 쓰는 열(lib/domain/evidence/agents/repository.ts writeRepositoryAgentScanIn)
const AGENT_SCAN_STATE = ['coverage', 'state', 'cursor', 'request_count', 'file_count', 'started_at', 'completed_at', 'last_error_code',
  'next_attempt_at'] as const;
export const ORACLE_CONSUMER_DB_PROFILES: Partial<Record<string, OracleConsumerDbProfile>> = {
  // 제작 근거 스캔(E5): claim·스캔 기록·포기와 App 전용 GitHub 수집(설치 토큰·한도 관측·쿨다운)만 한다. 큐 채우기·제품 연결·후보 풀기는
  // M3 컨트롤러가 한다 — products·crawl_candidates·jobs·pipeline_item_leases·개인 토큰 표(github_collector_accounts)·AI·HTTP 권한이 없다.
  'agent-scan': { principal: 'nomorevibe_oracle_agent_scan', profile: { statementTimeout: '10s',
    sequences: ['agent_repository_scans_id_seq', 'agent_repository_observations_id_seq'],
    tables: { dr_writer_fence: lock('id'), pipeline_stage_modes: lock('stage'), agent_scan_control: lock('id'),
      agent_repository_claims: { select: true, update: AGENT_CLAIM_STATE },
      agent_repository_scans: { select: true, insert: true, update: AGENT_SCAN_STATE },
      agent_repository_observations: { select: true, insert: true, delete: true },
      crawl_discovery_evidence: read, crawl_settings: read,
      // 잡 멈춤(agent-evidence-refresh 의 not_before)만 보이는 보기(0105). claim 이 운영자 정지를 따른다 — jobs 권한은 없다
      agent_scan_job_schedule: read,
      // 행은 RLS(0105)가 oracle_principals 에 이 계정이 든 설치로 좁힌다 — 다른 서버 몫 App 개인 키 암호문을 읽지 못한다
      github_collector_apps: { select: true, update: ['core_quota', 'quota_observed_at'] },
      // 행은 RLS(0105)가 GitHub 수집 키(github:quota:·github:auth:)로 좁힌다 — 웹 로그인 제한·IP 키는 읽지도 쓰지도 못한다.
      // GitHub 쿨다운은 INSERT·reset_at 갱신만 한다. 2차 제한 전역 키(github:quota:secondary:global)는 M3 와 함께 쓴다(남은 위험)
      rate_limits: { select: true, insert: true, update: ['reset_at'] },
      operations_observations: observationsWrite } } },
  // Oracle 은 정식 기록(product_health·일일 집계·uptime_observations·내림)을 쓰지 않는다 — 결과를 claim 행에 제출만 한다(design-uptime §7.3)
  uptime: { principal: 'nomorevibe_oracle_uptime', profile: { statementTimeout: '10s', sequences: [],
    tables: { dr_writer_fence: lock('id'), uptime_split_control: lock('id'), uptime_claims: { select: true, update: UPTIME_CLAIM_WRITE },
      uptime_host_breakers: read, products: read, product_health: read, operations_observations: observationsWrite } } },
};
export const ORACLE_CONSUMER_FORBIDDEN_TABLES = ['jobs', 'role_leases', 'job_batch_control', 'job_batch_candidates', 'pipeline_item_leases'] as const;

export type ConnectionLimit = number | `:${string}`;
/** Ordered statements for one service. Passwords are never part of this output. */
export function oracleDbGrantStatements(service: OracleDbService | 'refresh', options: { connectionLimit: ConnectionLimit }): string[] {
  const name = service === 'refresh' ? ORACLE_REFRESH_PRINCIPAL : ORACLE_DB_PRINCIPALS[service];
  const profile = service === 'refresh' ? ORACLE_REFRESH_PROFILE : ORACLE_DB_PROFILES[service];
  return grantStatements(name, profile, options.connectionLimit, []);
}
/** Same statement shape plus `SET timezone = 'UTC'`; the principal must be a new nomorevibe_oracle_* name. */
export function oracleConsumerGrantStatements(consumer: OracleConsumerDbProfile, options: { connectionLimit: ConnectionLimit }): string[] {
  const taken = [...Object.values(ORACLE_DB_PRINCIPALS), ORACLE_REFRESH_PRINCIPAL];
  if (!/^nomorevibe_oracle_[a-z][a-z_]{0,40}$/.test(consumer.principal) || taken.includes(consumer.principal)) throw new Error('invalid_consumer_principal');
  if (ORACLE_CONSUMER_FORBIDDEN_TABLES.some(table => Object.hasOwn(consumer.profile.tables, table))) throw new Error('consumer_runtime_authority_forbidden');
  return grantStatements(consumer.principal, consumer.profile, options.connectionLimit, [`ALTER ROLE ${consumer.principal} SET timezone = 'UTC'`]);
}
function grantStatements(name: string, profile: Profile, limit: ConnectionLimit, settings: string[]): string[] {
  if (typeof limit === 'number' ? !Number.isSafeInteger(limit) || limit < 1 || limit > 64 : !/^:[a-z_]+$/.test(limit)) throw new Error('invalid_connection_limit');
  const statements = [`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${limit}`,
    `ALTER ROLE ${name} SET statement_timeout = '${profile.statementTimeout}'`, `ALTER ROLE ${name} SET lock_timeout = '5s'`,
    `ALTER ROLE ${name} SET idle_in_transaction_session_timeout = '60s'`, ...settings, `GRANT USAGE ON SCHEMA public TO ${name}`];
  for (const [table, grant] of Object.entries(profile.tables).sort(([a], [b]) => a < b ? -1 : 1)) {
    const whole = [grant.select && 'SELECT', grant.insert === true && 'INSERT', grant.update === true && 'UPDATE', grant.delete && 'DELETE'].filter(Boolean);
    if (whole.length) statements.push(`GRANT ${whole.join(', ')} ON TABLE public.${table} TO ${name}`);
    if (Array.isArray(grant.insert)) statements.push(`GRANT INSERT (${grant.insert.join(', ')}) ON TABLE public.${table} TO ${name}`);
    if (Array.isArray(grant.update)) statements.push(`GRANT UPDATE (${grant.update.join(', ')}) ON TABLE public.${table} TO ${name}`);
  }
  for (const sequence of profile.sequences) statements.push(`GRANT USAGE ON SEQUENCE public.${sequence} TO ${name}`);
  return statements;
}

/** The exact deploy/oracle/least-privilege.sql text; connection limits stay psql variables chosen from the host DB budget. */
export function renderOracleDbGrantSql(): string {
  const services = Object.keys(ORACLE_DB_PRINCIPALS) as OracleDbService[];
  return ['-- Generated from lib/runtime/oracle-db-profile.ts; tests fail if this file and the profile differ.',
    '-- Run once by a PostgreSQL administrator on the primary after explicit approval, for example:',
    '--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v translation_connections=N ... -f deploy/oracle/least-privilege.sql',
    '-- Then set each password interactively with \\password <role>. This file contains no secret and grants no migration/DDL right.',
    'BEGIN;', ...services.flatMap(service => ['', `-- ${service}`, ...oracleDbGrantStatements(service,
      { connectionLimit: `:${service.replace('-', '_')}_connections` }).map(statement => `${statement};`)]),
    // Consumer sections follow the role services; with no registered consumer the text is unchanged.
    ...Object.entries(ORACLE_CONSUMER_DB_PROFILES).sort(([a], [b]) => a < b ? -1 : 1).flatMap(([consumer, profile]) => ['', `-- consumer ${consumer}`,
      ...oracleConsumerGrantStatements(profile!, { connectionLimit: `:${consumer.replaceAll('-', '_')}_connections` }).map(statement => `${statement};`)]),
    '', 'COMMIT;', ''].join('\n');
}
/** The exact deploy/oracle/refresh-principal.sql text (optional host refresh timer only). */
export function renderOracleRefreshGrantSql(): string {
  return ['-- Generated from lib/runtime/oracle-db-profile.ts (ORACLE_REFRESH_PROFILE); tests fail if this file and the profile differ.',
    '-- Optional. Apply only after the host capability-refresh timer policy is approved, after least-privilege.sql, for example:',
    '--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -v refresh_connections=1 -f deploy/oracle/refresh-principal.sql',
    '-- Then set the password interactively with \\password nomorevibe_oracle_refresh. It can rewrite only job_batch_candidates.capability.',
    'BEGIN;', '', '-- refresh', ...oracleDbGrantStatements('refresh', { connectionLimit: ':refresh_connections' }).map(statement => `${statement};`),
    '', 'COMMIT;', ''].join('\n');
}

export type PrivilegeRow = { schema: string; table: string; select: boolean; insert: boolean; update: boolean; delete: boolean;
  columns: { name: string; select: boolean; insert: boolean; update: boolean }[] };
/** Exact comparison of the live catalog with the approved profile. Any extra or missing right is a mismatch. */
export function oracleDbPrivilegeMismatches(service: OracleDbService, principal: string, value: unknown): string[] {
  return privilegeMismatches(ORACLE_DB_PRINCIPALS[service], ORACLE_DB_PROFILES[service], principal, value);
}
/** The same exact comparison for a consumer principal. */
export function oracleConsumerPrivilegeMismatches(consumer: OracleConsumerDbProfile, principal: string, value: unknown): string[] {
  return privilegeMismatches(consumer.principal, consumer.profile, principal, value);
}
function privilegeMismatches(expected: string, profile: Profile, principal: string, value: unknown): string[] {
  if (principal !== expected) return ['principal'];
  if (!Array.isArray(value)) return ['catalog'];
  const seen = new Set<string>(), mismatches: string[] = [];
  for (const row of value as PrivilegeRow[]) {
    const grant: TableGrant = row?.schema === 'public' ? profile.tables[row.table] ?? {} : {};
    seen.add(`${row?.schema}.${row?.table}`);
    const column = (kind: 'insert' | 'update', name: string) => grant[kind] === true || Array.isArray(grant[kind]) && (grant[kind] as Columns).includes(name);
    const exact = row && row.select === Boolean(grant.select) && row.insert === (grant.insert === true) && row.update === (grant.update === true)
      && row.delete === Boolean(grant.delete) && Array.isArray(row.columns)
      && row.columns.every(item => item.select === Boolean(grant.select) && item.insert === column('insert', item.name) && item.update === column('update', item.name))
      && (['insert', 'update'] as const).every(kind => !Array.isArray(grant[kind]) || (grant[kind] as Columns).every(name => row.columns.some(item => item.name === name)));
    if (!exact) mismatches.push(`${row?.schema}.${row?.table}`);
  }
  for (const table of Object.keys(profile.tables)) if (!seen.has(`public.${table}`)) mismatches.push(`public.${table}`);
  return mismatches;
}

/** Same catalog shape the runtime preflight hashes; one fragment keeps the two hashes identical. */
export const ORACLE_PRIVILEGE_CATALOG_SQL = sql`(SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,
        'select',has_table_privilege(current_user,c.oid,'SELECT'),'insert',has_table_privilege(current_user,c.oid,'INSERT'),
        'update',has_table_privilege(current_user,c.oid,'UPDATE'),'delete',has_table_privilege(current_user,c.oid,'DELETE'),
        'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
        'columns',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',a.attname,
          'select',has_column_privilege(current_user,c.oid,a.attnum,'SELECT'),
          'insert',has_column_privilege(current_user,c.oid,a.attnum,'INSERT'),
          'update',has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')) ORDER BY a.attnum),'[]'::jsonb)
          FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
        'policies',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.policyname),'[]'::jsonb)
          FROM pg_policies p WHERE p.schemaname=n.nspname AND p.tablename=c.relname)) ORDER BY n.nspname,c.relname),'[]'::jsonb)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m','f'))`;

/** Requires `pg_roles r` for current_user. Any dangerous attribute, membership or CREATE right is unsafe. */
export const ORACLE_UNSAFE_AUTHORITY_SQL = sql`(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
        OR current_user<>session_user OR has_database_privilege(current_user,current_database(),'CREATE')
        OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
          AND has_schema_privilege(current_user,n.oid,'CREATE'))
        OR EXISTS(SELECT 1 FROM pg_roles p WHERE p.oid<>r.oid AND pg_has_role(current_user,p.oid,'MEMBER')
          AND (p.rolsuper OR p.rolcreatedb OR p.rolcreaterole OR p.rolreplication OR p.rolbypassrls)))`;
