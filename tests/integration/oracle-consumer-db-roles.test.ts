import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { consumerSpec, type ConsumerParentRole } from '@/lib/runtime/consumer-registry';
import { ORACLE_CONSUMER_DB_PROFILES, oracleConsumerGrantStatements, type OracleConsumerDbProfile } from '@/lib/runtime/oracle-db-profile';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// B0: Oracle consumer principals on real PostgreSQL. Each one is created only from the generated grant statements and the actual
// consumer preflight must find exactly its declared profile, bounded timeouts and UTC. Every registered consumer profile (added by
// each consumer PR) runs through the same checks next to a fixture profile. Nothing outside the fixture roles is written.
// Separate from oracle-db-roles.test.ts on purpose: that file skips when an earlier file leaves a live lease.
const password = randomUUID(), release = createHash('sha1').update(password).digest('hex');
const FIXTURE: OracleConsumerDbProfile = { principal: 'nomorevibe_oracle_fixture_consumer', profile: { statementTimeout: '10s',
  sequences: ['dr_process_group_events_id_seq'], tables: { dr_writer_fence: { select: true, update: ['id'] }, crawl_settings: { select: true },
    operations_observations: { select: true, insert: true, update: ['value', 'observed_at'] }, dr_process_group_events: { select: true, insert: true } } } };
type Target = { consumer: string; role: ConsumerParentRole; db: OracleConsumerDbProfile; fixture: boolean };
const targets: Target[] = [{ consumer: 'fixture-scan', role: 'crawler', db: FIXTURE, fixture: true },
  ...Object.entries(ORACLE_CONSUMER_DB_PROFILES).map(([consumer, db]) => ({ consumer, role: consumerSpec(consumer)!.role, db: db!, fixture: false }))];
const admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {}, connection: { application_name: 'b0-consumer-admin' } });
// No consumer principal may hold role lease, batch, job or AI item authority, nor rewrite products or create objects.
const DENIED = ['UPDATE public.jobs SET cursor=cursor WHERE false', "INSERT INTO public.role_leases(role) SELECT 'x' WHERE false",
  'UPDATE public.job_batch_control SET mode=mode WHERE false', 'SELECT 1 FROM public.job_batch_candidates LIMIT 1',
  'SELECT 1 FROM public.pipeline_item_leases LIMIT 1', 'UPDATE public.products SET status=status WHERE false',
  'UPDATE public.operations_observations SET key=key WHERE false', 'CREATE TABLE public.oracle_negative_probe(id integer)'];

function principalUrl(target: Target) {
  const url = new URL(TEST_DATABASE_URL); url.username = target.db.principal; url.password = password; return url.toString();
}
const roles = () => admin`SELECT rolname FROM pg_roles WHERE rolname = ANY(${targets.map(target => target.db.principal)}) ORDER BY rolname`;
function child(target: Target, negatives: string[], extraEnv: Record<string, string> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const process_ = spawn(process.execPath, ['--import', 'tsx', 'tests/fixtures/oracle-consumer-preflight-driver.ts'], {
      cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV ?? 'test', LOG_LEVEL: 'error', DATABASE_URL: principalUrl(target),
        DB_POOL_MAX: '2', WORKER_ROLE: target.role, SERVICE_INSTANCE_ID: `${target.consumer}-consumer-b0`, RELEASE_TAG: release,
        PHYSICAL_HOST: 'oracle-osaka-smoke', TZ: 'UTC', DB_POOLER_MODE: 'direct',
        // direct 모드의 세션 timeout 은 클라이언트 pool 값이다. 부모 역할 기본(maintenance 120초)은 preflight 가 거절하므로 계정 값(10초)에 맞춘다
        DB_STATEMENT_TIMEOUT_MS: '10000',
        ORACLE_DRIVER_INPUT: JSON.stringify({ consumer: target.consumer, role: target.role, ...(target.fixture ? { profile: target.db } : {}), negatives }),
        ...extraEnv },
    });
    let stdout = '', stderr = '';
    process_.stdout.on('data', data => { stdout += String(data); });
    process_.stderr.on('data', data => { stderr += String(data); });
    process_.once('error', reject);
    process_.once('exit', () => {
      try { resolve(JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')); }
      catch { reject(new Error(`driver_output_invalid:${stdout.slice(-500)}:${stderr.slice(-2000)}`)); }
    });
  });
}
type Report = { checks: Record<string, { status: string; reason: string }>; workload: { ready: boolean; reason: string } };
const preflightOf = (output: Record<string, unknown>) => {
  if ('error' in output) throw new Error(`driver_failed:${JSON.stringify(output)}`);
  return output.preflight as Report;
};

beforeAll(async () => {
  ensureSchema();
  expect(await roles()).toEqual([]);
  for (const target of targets) {
    for (const statement of oracleConsumerGrantStatements(target.db, { connectionLimit: 4 })) await admin.unsafe(statement);
    await admin.unsafe(`ALTER ROLE ${target.db.principal} PASSWORD '${password}'`);
  }
}, 120_000);

afterAll(async () => {
  try {
    for (const target of targets) {
      if ((await admin`SELECT 1 FROM pg_roles WHERE rolname=${target.db.principal}`).length) {
        await admin.unsafe(`DROP OWNED BY ${target.db.principal}`); await admin.unsafe(`DROP ROLE ${target.db.principal}`);
      }
    }
    expect(await roles()).toEqual([]);
  } finally { await admin.end({ timeout: 5 }); }
}, 60_000);

it('creates each consumer principal only from the generated SQL with exactly its profile, bounded timeouts and UTC', async () => {
  for (const target of targets) {
    const [role] = await admin`SELECT r.rolcanlogin, r.rolsuper, r.rolinherit, r.rolconnlimit, s.setconfig FROM pg_roles r
      LEFT JOIN pg_db_role_setting s ON s.setrole=r.oid AND s.setdatabase=0 WHERE r.rolname=${target.db.principal}`;
    expect(role).toMatchObject({ rolcanlogin: true, rolsuper: false, rolinherit: false, rolconnlimit: 4 });
    expect(role.setconfig).toEqual(expect.arrayContaining(['TimeZone=UTC', `statement_timeout=${target.db.profile.statementTimeout}`]));
    const allowed = target.fixture ? ['SELECT 1 FROM public.crawl_settings LIMIT 1'] : [];
    const output = await child(target, [...DENIED, ...allowed]);
    const report = preflightOf(output);
    expect(output.principal).toBe(target.db.principal);
    expect(report.checks.identity.status, target.consumer).toBe('verified');
    expect(report.checks.database, target.consumer).toMatchObject({ status: 'verified', reason: 'approved_privilege_profile_matches' });
    expect(report.checks.timeouts, target.consumer).toEqual({ status: 'verified', reason: 'effective_session_timeouts_bounded' });
    expect(report.checks.timezone, target.consumer).toEqual({ status: 'verified', reason: 'process_role_session_utc' });
    if (target.fixture) {
      expect(report.checks.consumer).toEqual({ status: 'verified', reason: 'fixture_ready' });
      expect(report.workload).toEqual({ ready: true, reason: 'ready' });
    }
    expect(output.negatives, target.consumer).toEqual({ ...Object.fromEntries(DENIED.map(statement => [statement, '42501'])),
      ...Object.fromEntries(allowed.map(statement => [statement, 'allowed'])) });
  }
}, 120_000);

it('verifies PgBouncer-mode timeouts and timezone only from the role defaults', async () => {
  const report = preflightOf(await child(targets[0], [], { DB_POOLER_MODE: 'pgbouncer' }));
  expect(report.checks.timeouts).toEqual({ status: 'verified', reason: 'role_server_timeouts_bounded' });
  expect(report.checks.timezone).toEqual({ status: 'verified', reason: 'process_role_session_utc' });
}, 60_000);

it('closes on a non-UTC process, a non-UTC database override and any privilege drift, then reopens when restored', async () => {
  const target = targets[0], principal = target.db.principal;
  const process_ = preflightOf(await child(target, [], { TZ: 'Asia/Tokyo' }));
  expect(process_.checks.timezone).toEqual({ status: 'rejected', reason: 'process_timezone_not_utc' });
  expect(process_.workload).toEqual({ ready: false, reason: 'timezone_rejected' });
  const [{ name }] = await admin`SELECT current_database() AS name`;
  await admin.unsafe(`ALTER ROLE ${principal} IN DATABASE "${name}" SET timezone = 'Asia/Tokyo'`);
  try {
    const role = preflightOf(await child(target, []));
    expect(role.checks.timezone).toEqual({ status: 'rejected', reason: 'role_timezone_not_utc' });
  } finally { await admin.unsafe(`ALTER ROLE ${principal} IN DATABASE "${name}" RESET timezone`); }
  await admin.unsafe(`GRANT UPDATE ON TABLE public.jobs TO ${principal}`);
  try {
    const drift = preflightOf(await child(target, []));
    expect(drift.checks.database.status).toBe('unknown'); expect(drift.workload).toEqual({ ready: false, reason: 'database_unknown' });
  } finally { await admin.unsafe(`REVOKE UPDATE ON TABLE public.jobs FROM ${principal}`); }
  expect(preflightOf(await child(target, [])).workload).toEqual({ ready: true, reason: 'ready' });
}, 120_000);
