import { sql } from 'drizzle-orm';

/**
 * Approved least-privilege PostgreSQL profiles for Oracle osaka-smoke services.
 *
 * The same table renders deploy/oracle/least-privilege.sql and verifies a session's effective privileges, so the
 * operator SQL and the runtime check cannot drift. Lock-only tables get UPDATE on their primary key column because
 * PostgreSQL requires UPDATE on at least one column for FOR UPDATE/SHARE; no other column of those tables is writable.
 * Workers can update only candidate identity columns: capability/result_evidence updates belong to the attest principal.
 */
export type OracleDbService = 'translation' | 'product-health' | 'site-evidence' | 'official-news' | 'scheduler' | 'attest';
export const ORACLE_DB_PRINCIPALS: Record<OracleDbService, string> = {
  translation: 'nomorevibe_oracle_translation', 'product-health': 'nomorevibe_oracle_product_health',
  'site-evidence': 'nomorevibe_oracle_site_evidence', 'official-news': 'nomorevibe_oracle_official_news',
  scheduler: 'nomorevibe_oracle_scheduler', attest: 'nomorevibe_oracle_attest',
};
type Columns = readonly string[];
type TableGrant = { select?: true; insert?: true | Columns; update?: true | Columns; delete?: true };
type Profile = { tables: Record<string, TableGrant>; sequences: readonly string[]; statementTimeout: '10s' | '60s' };
const read: TableGrant = { select: true }, write: TableGrant = { select: true, insert: true, update: true };
const lock = (key: string): TableGrant => ({ select: true, update: [key] });
const CANDIDATE_IDENTITY = ['host', 'boot_id', 'release', 'policy_hash', 'observed_at'] as const;
// dr_writer_fence: 역할·HTTP permit 관문의 첫 SHARE lock. dr_process_group_events: role-worker 의 D11 기록(append-only, UPDATE 없음).
const RUNTIME: Record<string, TableGrant> = {
  job_batch_control: lock('id'), jobs: write, operations_observations: write, role_leases: write,
  dr_writer_fence: lock('id'), dr_process_group_events: { select: true, insert: true },
  // Drizzle names every column (DEFAULT) on INSERT, so INSERT cannot be column-limited; UPDATE (the heartbeat upsert) is.
  // Migration 0098's BEFORE INSERT trigger keeps that INSERT evidence-free: non-NULL capability/result_evidence needs UPDATE on that column.
  job_batch_candidates: { select: true, insert: true, update: CANDIDATE_IDENTITY },
};
const HTTP: Record<string, TableGrant> = { http_origin_control: lock('id'), http_origin_hops: write, http_origin_events: { insert: true } };
// `seed` elects the job's legacy parent role through tryAcquireRole, whose DR writer-fence gate reads this row FOR SHARE.
// site-evidence has no legacy parent (it uses the versioned bootstrap), so it does not get this lock.
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
  translation: { statementTimeout: '60s', sequences: ['model_capacity_events_id_seq', 'model_capacity_requests_queue_ordinal_seq', 'dr_process_group_events_id_seq'],
    tables: { ...RUNTIME, ...LEGACY_SEED, crawl_settings: read, crawl_review_attempts: read, second_reviews: read, text_translations: write,
      product_korean_taglines: write, product_translations: { select: true, update: true }, products: lock('id'), product_health: read,
      product_intro_checks: lock('product_id'), takedown_requests: lock('slug'), uptime_control: read, uptime_gates: read,
      uptime_observations: read, model_capacity_control: { select: true, update: ['cursor', 'updated_at'] },
      model_capacity_requests: write, model_capacity_events: { insert: true } } },
  // requestDueJobs의 첫 lock(DR writer fence SHARE). fenced DB의 scheduler는 정기 요청을 만들지 않는다.
  // PR11g: 후보 행은 다른 worker 와 같은 권한(boot 기록·preflight 읽기, 증거 열 쓰기 없음). http_origin_control 은
  // HOST_BUDGET_ENFORCEMENT 장부 갱신이 읽기만 한다(scheduler 는 HTTP 를 보내지 않는다).
  scheduler: { statementTimeout: '10s', sequences: [],
    tables: { dr_writer_fence: lock('id'), job_batch_control: lock('id'), jobs: write, operations_observations: write,
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

export type ConnectionLimit = number | `:${string}`;
/** Ordered statements for one service. Passwords are never part of this output. */
export function oracleDbGrantStatements(service: OracleDbService | 'refresh', options: { connectionLimit: ConnectionLimit }): string[] {
  const name = service === 'refresh' ? ORACLE_REFRESH_PRINCIPAL : ORACLE_DB_PRINCIPALS[service];
  const profile = service === 'refresh' ? ORACLE_REFRESH_PROFILE : ORACLE_DB_PROFILES[service];
  const limit = options.connectionLimit;
  if (typeof limit === 'number' ? !Number.isSafeInteger(limit) || limit < 1 || limit > 64 : !/^:[a-z_]+$/.test(limit)) throw new Error('invalid_connection_limit');
  const statements = [`CREATE ROLE ${name} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${limit}`,
    `ALTER ROLE ${name} SET statement_timeout = '${profile.statementTimeout}'`, `ALTER ROLE ${name} SET lock_timeout = '5s'`,
    `ALTER ROLE ${name} SET idle_in_transaction_session_timeout = '60s'`, `GRANT USAGE ON SCHEMA public TO ${name}`];
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
      { connectionLimit: `:${service.replace('-', '_')}_connections` }).map(statement => `${statement};`)]), '', 'COMMIT;', ''].join('\n');
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
  if (principal !== ORACLE_DB_PRINCIPALS[service]) return ['principal'];
  if (!Array.isArray(value)) return ['catalog'];
  const profile = ORACLE_DB_PROFILES[service], seen = new Set<string>(), mismatches: string[] = [];
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
