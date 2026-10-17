import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { jobs, roleLeases } from '@/lib/db/schema';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// 실제 role-worker 프로세스. 2026-10-17 M3 장애 경로(선출 실패 원인 없는 로그·무한 대기)와 D11 기록 스위치(기본 꺼짐)를 본다.
beforeAll(() => ensureSchema());
const admin = postgres(TEST_DATABASE_URL, { max: 2, onnotice: () => {} });
const started = new Set<ChildProcess>();
afterAll(async () => {
  // SIGTERM 으로 drain 시켜 child 그룹까지 정리한다(SIGKILL 은 detached child 를 고아로 남긴다). 15초 안에 안 끝나면 그때 SIGKILL.
  await Promise.all([...started].filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise<void>(resolve => {
    const force = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('exit', () => { clearTimeout(force); resolve(); });
    child.kill('SIGTERM');
  })));
  await admin.end({ timeout: 5 });
}, 30_000);

type Started = { child: ChildProcess; output: () => string; events: (name: string) => Record<string, unknown>[]; exited: Promise<number | null> };
function startRoleWorker(instanceId: string, env: Record<string, string>, role = 'crawler'): Started {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/role-worker.ts', `--role=${role}`, '--kind=primary'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DB_POOL_MAX: '2', SERVICE_INSTANCE_ID: instanceId, RELEASE_TAG: 'f4-process-test',
      WORKER_HEALTH_PATH: join('/tmp', `nomorevibe-f4-${instanceId}-${process.pid}.json`),
      ROLE_HEALTH_PATH: join('/tmp', `nomorevibe-f4-${instanceId}-candidate-${process.pid}.json`), ...env },
  });
  started.add(child);
  let output = '';
  child.stdout!.on('data', data => { output = (output + String(data)).slice(-262_144); });
  child.stderr!.on('data', data => { output = (output + String(data)).slice(-262_144); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  const events = (name: string) => output.split('\n').flatMap(line => {
    try { const value = JSON.parse(line) as Record<string, unknown>; return value.event === name ? [value] : []; } catch { return []; }
  });
  return { child, output: () => output, events, exited };
}
async function until<T>(read: () => Promise<T | null> | T | null, timeoutMs: number, what: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timeout: ${what().slice(-4_000)}`);
}
const roleHealth = async (instanceId: string) =>
  JSON.parse(await readFile(join('/tmp', `nomorevibe-f4-${instanceId}-candidate-${process.pid}.json`), 'utf8')) as Record<string, unknown>;

it('pgbouncer mode: a lock held on the role row ends the election with a logged 55P03 and its blockers, then the worker recovers alone', async () => {
  await db.delete(jobs); await db.delete(roleLeases);
  await db.insert(roleLeases).values({ role: 'crawler' });
  // 다른 세션이 역할 행을 쥔 채 남은 TX(오늘 M3 처럼). pgbouncer 모드는 연결 시작 값으로 lock_timeout 을 넘기지 않는다.
  const holder = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {}, connection: { application_name: 'f4-lock-holder' } });
  let unlock!: () => void;
  const unlocked = new Promise<void>(resolve => { unlock = resolve; });
  let locked!: () => void;
  const holding = new Promise<void>(resolve => { locked = resolve; });
  const transaction = holder.begin(async tx => { await tx`SELECT role FROM role_leases WHERE role = 'crawler' FOR UPDATE`; locked(); await unlocked; });
  await holding;
  const worker = startRoleWorker('f4-crawler-lock', { DB_POOLER_MODE: 'pgbouncer' });
  try {
    const failure = await until(() => worker.events('role.acquire_unknown')[0] ?? null, 30_000, worker.output);
    expect(failure).toMatchObject({ role: 'crawler', instanceId: 'f4-crawler-lock', code: '55P03', errorName: 'PostgresError', failures: 1 });
    expect(String(failure.message)).toContain('lock timeout');
    expect(worker.output()).not.toMatch(/Failed query|params:/);
    const blockers = await until(() => worker.events('role.lock_blockers')[0] ?? null, 15_000, worker.output);
    expect(blockers.holders).toEqual(expect.arrayContaining([expect.objectContaining({ applicationName: 'f4-lock-holder',
      state: 'idle in transaction', relations: expect.arrayContaining(['role_leases']) })]));
    const failing = await until(async () => { const health = await roleHealth('f4-crawler-lock').catch(() => null);
      return health && typeof health.dbFailingSince === 'number' ? health : null; }, 15_000, worker.output);
    expect(failing).toMatchObject({ phase: 'standby', epoch: null });
    expect(Number(failing.dbFailures)).toBeGreaterThanOrEqual(1);
    // 한도(5분) 전의 standby 는 여전히 healthy 다
    const check = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/worker-healthcheck.ts'], { cwd: process.cwd(),
      env: { ...process.env, WORKER_ROLE: 'crawler', ROLE_HEALTH_PATH: join('/tmp', `nomorevibe-f4-f4-crawler-lock-candidate-${process.pid}.json`),
        WORKER_HEALTH_PATH: join('/tmp', `nomorevibe-f4-missing-${process.pid}.json`) } });
    expect(check.status).toBe(0);
    unlock(); await transaction;
    await until(async () => { const [row] = await db.select().from(roleLeases).where(eq(roleLeases.role, 'crawler'));
      return row?.ownerInstanceId === 'f4-crawler-lock' ? row : null; }, 30_000, worker.output);
    const recovered = await until(async () => { const health = await roleHealth('f4-crawler-lock').catch(() => null);
      return health && health.phase === 'active' && health.dbFailingSince === null ? health : null; }, 30_000, worker.output);
    expect(recovered.dbFailures).toBe(0);
    worker.child.kill('SIGTERM');
    expect(await worker.exited, worker.output().slice(-4_000)).toBe(0);
  } finally {
    unlock(); await transaction.catch(() => {}); await holder.end({ timeout: 5 });
  }
}, 90_000);

it('logs the connection error code when the database is unreachable', async () => {
  const worker = startRoleWorker('f4-crawler-down', { DATABASE_URL: 'postgres://nomorevibe:nomorevibe@127.0.0.1:9/nomorevibe_test', DB_CONNECT_TIMEOUT_SECONDS: '1' });
  try {
    const failure = await until(() => worker.events('role.acquire_unknown')[1] ?? null, 30_000, worker.output);
    expect(worker.events('role.acquire_unknown')[0]).toMatchObject({ code: 'ECONNREFUSED', failures: 1 });
    expect(failure).toMatchObject({ code: 'ECONNREFUSED', failures: 2 });
    expect(worker.output()).not.toContain('nomorevibe:nomorevibe@');
  } finally {
    worker.child.kill('SIGTERM'); await worker.exited;
  }
}, 60_000);

const groupEvents = (instanceId: string) => admin`SELECT kind, seq FROM dr_process_group_events WHERE owner_instance_id = ${instanceId} ORDER BY id`;
it.each([
  ['off by default: spawns the elected child without touching the D11 table', {}, []],
  ['on: commits the intent before spawn and the observed group exit after drain', { PROCESS_GROUP_RECORDING: '1' },
    [['owner_opened', 0], ['spawn_intent', 1], ['spawned', 1], ['group_exited', 1]]],
] as const)('D11 recording %s', async (_name, env, expected) => {
  await db.delete(jobs); await db.delete(roleLeases);
  const instanceId = `f4-d11-${Object.keys(env).length ? 'on' : 'off'}-${process.pid}`;
  const worker = startRoleWorker(instanceId, { ...env });
  try {
    await until(async () => { try {
      const health = JSON.parse(await readFile(join('/tmp', `nomorevibe-f4-${instanceId}-${process.pid}.json`), 'utf8')) as { status: string; childPid: number | null };
      return health.status === 'running' && health.childPid ? health : null;
    } catch { return null; } }, 40_000, worker.output);
    worker.child.kill('SIGTERM');
    expect(await worker.exited, worker.output().slice(-4_000)).toBe(0);
    expect(Array.from(await groupEvents(instanceId)).map(row => [row.kind, Number(row.seq)])).toEqual(expected);
  } finally {
    if (worker.child.exitCode === null) worker.child.kill('SIGTERM');
  }
}, 60_000);

it('refuses to start the successor probe without recording (it needs this boot\'s owner_opened)', async () => {
  const worker = startRoleWorker(`f4-probe-${process.pid}`, { PROCESS_GROUP_SUCCESSOR_PROBE: '1' });
  expect(await worker.exited).toBe(1);
  expect(worker.output()).toContain('role worker failed');
  expect(Array.from(await groupEvents(`f4-probe-${process.pid}`))).toEqual([]);
}, 30_000);
