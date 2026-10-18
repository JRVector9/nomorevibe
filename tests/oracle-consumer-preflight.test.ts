import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const io = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn(), replay: vi.fn(), readiness: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { transaction: io.transaction }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: io.replay }));

const { inspectOracleConsumer, oracleRoleTimeZone, oracleTimeZoneCheck, readOracleConsumerPreflight, ORACLE_CONSUMER_READINESS } =
  await import('@/lib/runtime/oracle-consumer-preflight');
const { ORACLE_CONSUMER_DB_PROFILES } = await import('@/lib/runtime/oracle-db-profile');
const release = 'a'.repeat(40), instanceId = 'ai1-consumer-oracle';
// 시험용 consumer: 등록부의 ai1(부모 reviewer) 이름을 빌리지만 프로필·준비 확인은 여기서만 준다
const db = { principal: 'nomorevibe_oracle_fixture_scan', profile: { statementTimeout: '10s' as const, sequences: [],
  tables: { crawl_settings: { select: true as const } } } };
const spec = { consumer: 'ai1', role: 'reviewer' as const, db, readiness: io.readiness };
const catalog = [{ schema: 'public', table: 'crawl_settings', select: true, insert: false, update: false, delete: false,
  columns: [{ name: 'id', select: true, insert: false, update: false }] }];
const roleSettings = [{ database: false, config: ['statement_timeout=10s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=60s', 'TimeZone=UTC'] }];
let session: Record<string, unknown>;
const tx = { execute: io.execute };
beforeEach(() => {
  vi.clearAllMocks();
  for (const [key, value] of Object.entries({ PHYSICAL_HOST: 'oracle-osaka-smoke', SERVICE_INSTANCE_ID: instanceId, RELEASE_TAG: release,
    DB_POOLER_MODE: 'pgbouncer', WORKER_ROLE: 'reviewer', TZ: 'UTC' })) vi.stubEnv(key, value);
  io.replay.mockReturnValue(undefined);
  session = { at: '2026-10-19 00:00:00+00', principal: db.principal, sessionPrincipal: db.principal, unsafe: false, readOnly: false, replica: false,
    statementMs: 10000, lockMs: 5000, idleMs: 60000, timeZone: 'UTC', privileges: catalog, roleSettings };
  io.transaction.mockImplementation(async (load, options) => { expect(options).toEqual({ isolationLevel: 'repeatable read' }); return load(tx); });
  io.execute.mockImplementation(async () => [session]);
  io.readiness.mockResolvedValue({ status: 'verified', reason: 'fixture_ready' });
});
afterEach(() => vi.unstubAllEnvs());

it('verifies identity, exact profile, timeouts, UTC and readiness without batch, canary or role admission', async () => {
  const report = await inspectOracleConsumer(spec);
  expect(report).toMatchObject({ kind: 'nomorevibe-oracle-consumer-preflight', version: 1, consumer: 'ai1', role: 'reviewer',
    instanceId, releaseSha: release, ready: false, activationAllowed: false, workload: { ready: true, reason: 'ready' } });
  expect(Object.keys(report.checks).sort()).toEqual(['admission', 'batch', 'budget', 'consumer', 'database', 'host', 'identity', 'model',
    'release', 'runtime', 'timeouts', 'timezone']);
  for (const name of ['identity', 'database', 'timeouts', 'timezone', 'consumer'] as const) expect(report.checks[name].status, name).toBe('verified');
  for (const name of ['batch', 'model', 'admission'] as const) expect(report.checks[name].status, name).toBe('not_applicable');
  expect(report.checks.timeouts.reason).toBe('role_server_timeouts_bounded');
  expect(report.checks.database.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(io.readiness).toHaveBeenCalledExactlyOnceWith(tx, { consumer: 'ai1', instanceId, principal: db.principal });
  // 한 번의 읽기(세션·권한·계정 설정)뿐이다 — job_batch_control·후보 행·관측을 읽지 않는다
  expect(io.execute).toHaveBeenCalledOnce();
});
it.each([
  ['SERVICE_INSTANCE_ID', 'ai2-consumer-oracle'], ['SERVICE_INSTANCE_ID', 'ai1-consumer-'], ['SERVICE_INSTANCE_ID', 'reviewer-oracle'],
  ['RELEASE_TAG', 'main'], ['PHYSICAL_HOST', 'm3'], ['WORKER_ROLE', 'crawler'],
])('keeps identity unknown before any database work when %s is %s', async (key, value) => {
  vi.stubEnv(key, value);
  const report = await inspectOracleConsumer(spec);
  expect(report.checks.identity.status).toBe('unknown'); expect(report.workload).toEqual({ ready: false, reason: 'identity_unknown' });
  expect(io.transaction).not.toHaveBeenCalled(); expect(io.readiness).not.toHaveBeenCalled();
});
it.each([
  ['process', () => vi.stubEnv('TZ', 'Asia/Tokyo'), { status: 'rejected', reason: 'process_timezone_not_utc' }],
  ['role default', () => { session.roleSettings = [{ database: false, config: ['statement_timeout=10s', 'lock_timeout=5s',
    'idle_in_transaction_session_timeout=60s', 'TimeZone=Asia/Tokyo'] }]; }, { status: 'rejected', reason: 'role_timezone_not_utc' }],
  ['database override', () => { session.roleSettings = [...roleSettings, { database: true, config: ['timezone=Asia/Seoul'] }]; },
    { status: 'rejected', reason: 'role_timezone_not_utc' }],
  ['session', () => { session.timeZone = 'Asia/Tokyo'; }, { status: 'rejected', reason: 'session_timezone_not_utc' }],
] as const)('rejects a non-UTC %s timezone and never runs readiness', async (_, change, expected) => {
  change();
  const report = await inspectOracleConsumer(spec);
  expect(report.checks.timezone).toEqual(expected);
  expect(report.workload).toEqual({ ready: false, reason: 'timezone_rejected' }); expect(io.readiness).not.toHaveBeenCalled();
});
it('keeps timezone unknown without a role default even when the session happens to be UTC', async () => {
  session.roleSettings = [{ database: false, config: ['statement_timeout=10s', 'lock_timeout=5s', 'idle_in_transaction_session_timeout=60s'] }];
  const report = await inspectOracleConsumer(spec);
  expect(report.checks.timezone).toEqual({ status: 'unknown', reason: 'role_timezone_unverified' });
  expect(report.workload).toEqual({ ready: false, reason: 'timezone_unknown' });
});
it('closes the workload on a profile drift, unsafe authority, unbounded timeouts or unknown readiness', async () => {
  session.privileges = [...catalog, { ...catalog[0], table: 'jobs' }];
  expect((await inspectOracleConsumer(spec)).workload).toEqual({ ready: false, reason: 'database_unknown' });
  session.privileges = catalog; session.unsafe = true;
  const unsafe = await inspectOracleConsumer(spec);
  expect(unsafe.checks.database.status).toBe('rejected'); expect(unsafe.workload.reason).toBe('database_rejected');
  session.unsafe = false; session.statementMs = 0;
  vi.stubEnv('DB_POOLER_MODE', 'direct');
  expect((await inspectOracleConsumer(spec)).workload).toEqual({ ready: false, reason: 'timeouts_rejected' });
  session.statementMs = 10000; io.readiness.mockResolvedValue({ status: 'unknown', reason: 'control_row_missing' });
  const waiting = await inspectOracleConsumer(spec);
  expect(waiting.checks.consumer).toEqual({ status: 'unknown', reason: 'control_row_missing' });
  expect(waiting.workload).toEqual({ ready: false, reason: 'consumer_unknown' });
});
it('refuses a replay scope and unregistered consumers before database work', async () => {
  io.replay.mockReturnValue({});
  expect((await inspectOracleConsumer(spec)).workload.reason).toBe('replay_unsupported');
  // 등록부·DB 프로필·준비 확인 셋이 다 있어야 한다. 실제로 셋 다 등록된 것은 agent-scan(E5)·uptime(U2)이다 — 입력을 받아 들이고 replay 에서는 DB 전에 닫힌다
  for (const consumer of ['ai1', 'unregistered-scan', 'crawler']) await expect(readOracleConsumerPreflight({ consumer })).rejects.toThrow('invalid_oracle_preflight_input');
  for (const consumer of ['agent-scan', 'uptime']) expect((await readOracleConsumerPreflight({ consumer })).workload.reason).toBe('replay_unsupported');
  await expect(readOracleConsumerPreflight({ consumer: 'ai1', ready: true })).rejects.toThrow('invalid_oracle_preflight_input');
  ORACLE_CONSUMER_DB_PROFILES.ai1 = db; ORACLE_CONSUMER_READINESS.ai1 = io.readiness;
  try {
    io.replay.mockReturnValue(undefined);
    expect((await readOracleConsumerPreflight({ consumer: 'ai1' })).workload).toEqual({ ready: true, reason: 'ready' });
  } finally { delete ORACLE_CONSUMER_DB_PROFILES.ai1; delete ORACLE_CONSUMER_READINESS.ai1; }
  expect(io.transaction).toHaveBeenCalledOnce();
});
it('reads the role timezone database-specific first and treats malformed settings as unknown', () => {
  expect(oracleRoleTimeZone([{ database: false, config: ['TimeZone=UTC'] }, { database: true, config: ['timezone=Etc/UTC'] }])).toBe('Etc/UTC');
  expect(oracleRoleTimeZone([{ database: false, config: ['statement_timeout=10s'] }])).toBeNull();
  expect(oracleRoleTimeZone('x')).toBeUndefined(); expect(oracleRoleTimeZone([{ database: 'no', config: [] }])).toBeUndefined();
  expect(oracleTimeZoneCheck('Etc/UTC', [{ database: false, config: ['TimeZone=UTC'] }], 'Etc/UTC')).toEqual({ status: 'verified', reason: 'process_role_session_utc' });
});
it('the native preflight CLI accepts --consumer and still fails closed for an unregistered name', async () => {
  const { spawnSync } = await import('node:child_process');
  const { resolve } = await import('node:path');
  const child = spawnSync(process.execPath, ['--import', resolve('node_modules/tsx/dist/loader.mjs'),
    resolve('scripts/worker-oracle-preflight.ts'), '--consumer=unregistered-scan'], {
    cwd: process.cwd(), env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV }, encoding: 'utf8', timeout: 5000,
  });
  expect(child.error).toBeUndefined(); expect(child.status).toBe(78);
  expect(child.stdout).toBe(''); expect(child.stderr).toBe('{"code":"oracle_runtime_preflight_failed"}\n');
});
