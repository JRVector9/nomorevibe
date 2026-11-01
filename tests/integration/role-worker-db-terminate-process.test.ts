import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { releaseRole, renewRole, tryAcquireRole, type RoleLease } from '@/lib/jobs/role-leader';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

/**
 * 2026-11-01 운영 장애: 15:22·15:28Z 에 누군가 pg_terminate_backend 로 DB 연결을 한꺼번에 끊었고(57P01, PgBouncer "server conn crashed?"),
 * M3·mini 의 역할 워커가 exit 1 로 거듭 재시작했다. publisher primary 는 5분 안에 boot 가 3번 바뀌어 15분 격리됐다.
 * 실제 role-worker → supervisor → worker 프로세스로 끊김 한 파도 뒤에도 같은 boot·같은 자식으로 계속 도는지, 그리고 lease 창보다
 * 오래 DB 에 못 닿으면 지금처럼 일을 멈추고 다른 주인과 겹치지 않는지 본다.
 */
beforeAll(() => ensureSchema());
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const started = new Set<ChildProcess>();
afterAll(async () => {
  await Promise.all([...started].filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise<void>(resolve => {
    const force = setTimeout(() => child.kill('SIGKILL'), 15_000);
    child.once('exit', () => { clearTimeout(force); resolve(); });
    child.kill('SIGTERM');
  })));
  // 파도가 이 파일의 db 풀 연결도 끊으므로 정리는 끊기지 않은 확인용 연결로 한다 — 뒤 파일은 살아 있는 역할·잡 lease 가 없다고 가정한다
  await admin`DELETE FROM role_leases`;
  await admin`UPDATE jobs SET lease_token = NULL, locked_at = NULL WHERE lease_token IS NOT NULL`;
  await admin.end({ timeout: 5 });
}, 30_000);

const healthPath = (instanceId: string) => join('/tmp', `nomorevibe-term-${instanceId}-${process.pid}.json`);
const roleHealthPath = (instanceId: string) => join('/tmp', `nomorevibe-term-${instanceId}-candidate-${process.pid}.json`);
function startRoleWorker(instanceId: string, env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/role-worker.ts', '--role=publisher', '--kind=primary'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
    // 운영과 같이 PgBouncer 모드(연결 시작 값으로 statement/lock timeout 을 넘기지 않는다)
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, DB_POOLER_MODE: 'pgbouncer', DB_POOL_MAX: '2', SERVICE_INSTANCE_ID: instanceId,
      RELEASE_TAG: 'terminate-test', WORKER_HEALTH_PATH: healthPath(instanceId), ROLE_HEALTH_PATH: roleHealthPath(instanceId), ...env },
  });
  started.add(child);
  let output = '';
  child.stdout!.on('data', data => { output = (output + String(data)).slice(-524_288); });
  child.stderr!.on('data', data => { output = (output + String(data)).slice(-524_288); });
  let exitCode: number | null | undefined;
  const exited = new Promise<number | null>(resolve => child.once('exit', code => { exitCode = code; resolve(code); }));
  const events = (name: string) => output.split('\n').flatMap(line => {
    try { const value = JSON.parse(line) as Record<string, unknown>; return value.event === name ? [value] : []; } catch { return []; }
  });
  return { child, output: () => output, events, exited, exitCode: () => exitCode };
}
async function until<T>(read: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs: number, what: () => string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timeout: ${what().slice(-6_000)}`);
}
type SupervisorHealth = { status: string; childPid: number | null; lanes?: unknown[] };
const supervisorHealth = async (instanceId: string) => {
  try { return JSON.parse(await readFile(healthPath(instanceId), 'utf8')) as SupervisorHealth; } catch { return null; }
};
const roleHealth = async (instanceId: string) => {
  try { return JSON.parse(await readFile(roleHealthPath(instanceId), 'utf8')) as { phase: string; epoch: number | null }; } catch { return null; }
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
type LeaseRow = { owner_instance_id: string | null; owner_boot_id: string | null; epoch: string; primary_boots: { id: string; at: number }[];
  quarantine_until: Date | null; updated_at: Date };
const leaseRow = async () => (await admin<LeaseRow[]>`SELECT owner_instance_id, owner_boot_id, epoch, primary_boots, quarantine_until, updated_at
  FROM role_leases WHERE role = 'publisher'`)[0];
const lastSuccess = async (name: string) => (await admin<{ last_success_at: Date | null }[]>`SELECT last_success_at FROM jobs WHERE name = ${name}`)[0]?.last_success_at ?? null;
const requestPublisherJobs = () => admin`INSERT INTO jobs (name, requested_version) VALUES ('cdn-purge', 1), ('github-feedback-delivery', 1)
  ON CONFLICT (name) DO UPDATE SET requested_version = jobs.processed_version + 1, not_before = null`;
/** 운영의 파도처럼 이 계정의 클라이언트 연결을 모두 끊는다 — 이 확인용 연결과 except 로 넘긴 pid 만 남긴다 */
const terminateWave = (except: number[] = []) => admin<{ n: number }[]>`SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE usename = current_user AND pid <> pg_backend_pid() AND backend_type = 'client backend' AND NOT (pid = ANY(${except}::int[]))) t`;

it('a wave of terminated connections (one hits an in-flight claim TX) leaves the same boot, child and lease running, and the next tick succeeds', async () => {
  await admin`DELETE FROM jobs`; await admin`DELETE FROM role_leases`;
  const instanceId = `term-wave-${process.pid}`;
  const worker = startRoleWorker(instanceId);
  const running = await until(async () => { const health = await supervisorHealth(instanceId); return health?.status === 'running' && health.childPid && health.lanes ? health : null; },
    40_000, worker.output);
  const before = await until(async () => { const row = await leaseRow(); return row?.owner_instance_id === instanceId ? row : null; }, 10_000, worker.output);

  // claim TX 의 UPDATE(lease_token 을 처음 쥐는 문장)만 잠시 붙잡는 trigger — 문장이 도는 TX 를 확실히 끊는다(운영의 19개 중 하나).
  // 행 잠금은 쓰지 않는다: 워커가 claim 앞에 하는 markWorkerSeen upsert 가 먼저 막혀 TX 밖 문장이 되기 때문이다
  // 끄기는 표의 행을 지워서 한다 — DROP TRIGGER 는 도는 UPDATE 가 끝날 때까지 jobs 의 배타 잠금을 기다린다
  await admin`CREATE TABLE IF NOT EXISTS term_test_slow_flag (on_flag boolean)`;
  await admin`INSERT INTO term_test_slow_flag VALUES (true)`;
  await admin`CREATE OR REPLACE FUNCTION term_test_slow_claim() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF EXISTS (SELECT 1 FROM term_test_slow_flag) THEN PERFORM pg_sleep(30); END IF; RETURN NEW; END $$`;
  await admin`CREATE TRIGGER term_test_slow_claim BEFORE UPDATE ON jobs FOR EACH ROW
    WHEN (NEW.name = 'cdn-purge' AND OLD.lease_token IS NULL AND NEW.lease_token IS NOT NULL) EXECUTE FUNCTION term_test_slow_claim()`;
  try {
    await requestPublisherJobs();
    await until(async () => (await admin`SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query ILIKE '%update "jobs"%'`).length > 0,
      20_000, worker.output);
    await admin`DELETE FROM term_test_slow_flag`;
    const waveAt = Date.now();
    expect((await terminateWave())[0].n).toBeGreaterThanOrEqual(2);
    // 운영처럼 두 번째 파도 — 여기서는 요청을 넣어 바쁜 틱 사이에 짧게 거듭 끊는다
    for (let wave = 0; wave < 20; wave++) {
      await requestPublisherJobs();
      await new Promise(resolve => setTimeout(resolve, 150));
      await terminateWave();
    }
    // 끊긴 틱은 그 잡의 평범한 실패로 남는다(프로세스는 그대로)
    const failed = await until(() => worker.events('worker.job').find(event => event.status === 'failed' && Date.parse(String(event.at)) >= waveAt),
      20_000, worker.output);
    expect(['CONNECTION_CLOSED', '57P01']).toContain(failed.code);

    // 그 뒤 요청한 틱이 성공한다 — 같은 자식 프로세스가 돌린다
    const settledAt = new Date();
    await requestPublisherJobs();
    await until(async () => { const at = await lastSuccess('cdn-purge'); return at && at >= settledAt; }, 30_000, worker.output);
    // role lease 는 같은 boot·epoch 로 파도 뒤에 다시 갱신된다(10초 주기) — 새 primary boot 를 남기지 않아 격리되지 않는다
    const after = await until(async () => { const row = await leaseRow(); return row && row.updated_at > settledAt ? row : null; }, 25_000, worker.output);
    expect(after).toMatchObject({ owner_instance_id: instanceId, owner_boot_id: before.owner_boot_id, epoch: before.epoch, quarantine_until: null });
    expect(after.primary_boots).toEqual(before.primary_boots);
    expect(after.primary_boots).toHaveLength(1);

    expect(await supervisorHealth(instanceId)).toMatchObject({ status: 'running', childPid: running.childPid });
    expect(alive(running.childPid!)).toBe(true);
    expect(worker.exitCode()).toBeUndefined();
    expect(worker.output()).not.toContain("reading 'write'");
    for (const event of ['supervisor.stopping', 'supervisor.stopped', 'role.supervisor_stopped', 'role.lease_lost', 'role.renew_unknown']) {
      expect(worker.events(event), `${event}\n${worker.output().slice(-6_000)}`).toEqual([]);
    }
    worker.child.kill('SIGTERM');
    expect(await worker.exited, worker.output().slice(-4_000)).toBe(0);
  } finally {
    await admin`DELETE FROM term_test_slow_flag`;
    if (worker.exitCode() === undefined) { worker.child.kill('SIGTERM'); await worker.exited; }
    await admin`DROP TRIGGER IF EXISTS term_test_slow_claim ON jobs`;
    await admin`DROP FUNCTION IF EXISTS term_test_slow_claim()`;
    await admin`DROP TABLE IF EXISTS term_test_slow_flag`;
  }
}, 120_000);

type Endpoint = { host: string; port: number };
function relay(target: Endpoint) {
  let server: net.Server | null = null;
  const open = new Set<net.Socket>();
  const state = { port: 0 };
  return {
    state,
    async start(port = state.port) {
      server = net.createServer(client => {
        const upstream = net.connect(target);
        const close = () => { client.destroy(); upstream.destroy(); open.delete(client); open.delete(upstream); };
        open.add(client); open.add(upstream);
        client.pipe(upstream).pipe(client);
        for (const socket of [client, upstream]) { socket.on('error', close); socket.on('close', close); }
      });
      await new Promise<void>(resolve => server!.listen(port, '127.0.0.1', resolve));
      state.port = (server.address() as net.AddressInfo).port;
    },
    async stop() {
      for (const socket of open) socket.destroy();
      open.clear();
      await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
      server = null;
    },
  };
}

it('when the DB stays unreachable for longer than the lease, the worker stops claiming before another owner can take the role, and stays standby', async () => {
  await admin`DELETE FROM jobs`; await admin`DELETE FROM role_leases`;
  const base = new URL(TEST_DATABASE_URL);
  const path = relay({ host: base.hostname === 'localhost' ? '127.0.0.1' : base.hostname, port: Number(base.port || 5432) });
  await path.start();
  const viaRelay = new URL(TEST_DATABASE_URL); viaRelay.hostname = '127.0.0.1'; viaRelay.port = String(path.state.port);
  const instanceId = `term-outage-${process.pid}`;
  const worker = startRoleWorker(instanceId, { DATABASE_URL: viaRelay.toString(), DB_CONNECT_TIMEOUT_SECONDS: '1' });
  let other: RoleLease | null = null;
  let keepOther: ReturnType<typeof setInterval> | undefined;
  try {
    const running = await until(async () => { const health = await supervisorHealth(instanceId); return health?.status === 'running' && health.childPid ? health : null; },
      40_000, worker.output);
    const before = await until(async () => { const row = await leaseRow(); return row?.owner_instance_id === instanceId ? row : null; }, 10_000, worker.output);
    await path.stop();
    const cutAt = Date.now();

    // 갱신은 끊긴 연결로 실패하지만 곧바로 자식을 끊지 않는다(다음 주기에 다시). 성공한 갱신 없이 lease 창(45초)이 지나면 지금처럼
    // lease 를 잃었다고 보고 자식의 새 claim 을 멈춘다(연결 대기로 갱신 한 번이 10초를 넘기면 role_renew_deadline 으로 더 일찍)
    const lostEvent = await until(() => worker.events('role.renew_unknown')[0], 60_000, worker.output);
    expect(['role_lease_expired', 'role_renew_deadline']).toContain(lostEvent.cause);
    const lostAt = Date.parse(String(lostEvent.at));
    expect(lostAt - cutAt).toBeLessThanOrEqual(46_000);
    expect(worker.events('role.renew_retry').length).toBeGreaterThanOrEqual(1);
    expect(worker.events('supervisor.stopping')[0]).toMatchObject({ reason: 'role_lease_lost' });

    // 다른 primary 는 DB 의 lease 가 만료된 뒤에야 맡는다 — 그때 이 워커는 이미 새 claim 을 멈췄다(두 주인이 함께 일을 잡지 않는다)
    const candidate = { role: 'publisher' as const, instanceId: `term-other-${process.pid}`, bootId: randomUUID(), release: 'terminate-test', kind: 'primary' as const };
    other = await until(async () => await tryAcquireRole(candidate).catch(() => null), 30_000, worker.output);
    expect(Date.now()).toBeGreaterThanOrEqual(lostAt);
    expect(other.epoch).toBe(Number(before.epoch) + 1);
    const lease = other;
    keepOther = setInterval(() => { void renewRole(lease).catch(() => false); }, 5_000);
    // 멈춘 자식은 drain 한도(45초) 안에 끝난다. 이 boot 는 exit 하지 않고 standby 로 돌아간다
    const stopped = await until(() => worker.events('role.supervisor_stopped')[0], 60_000, worker.output);
    expect(stopped).toMatchObject({ lost: true, epoch: Number(before.epoch), drainTimedOut: false });
    expect(alive(running.childPid!)).toBe(false);
    expect(worker.events('worker.job').filter(event => Date.parse(String(event.at)) > lostAt)).toEqual([]);
    expect(worker.exitCode()).toBeUndefined();

    // DB 가 돌아와도 이 워커는 남의 lease 를 다시 가져가지 않고 standby 로 기다린다(프로세스는 살아 있다)
    await path.start();
    await until(async () => { const health = await roleHealth(instanceId); return health?.phase === 'standby' ? health : null; }, 15_000, worker.output);
    await new Promise(resolve => setTimeout(resolve, 12_000));
    expect(await leaseRow()).toMatchObject({ owner_instance_id: candidate.instanceId, owner_boot_id: candidate.bootId, epoch: String(other.epoch) });
    expect(worker.events('role.acquired')).toHaveLength(1);
    expect(worker.exitCode()).toBeUndefined();
    expect(await roleHealth(instanceId)).toMatchObject({ phase: 'standby', epoch: null });
    worker.child.kill('SIGTERM');
    expect(await worker.exited, worker.output().slice(-4_000)).toBe(0);
  } finally {
    if (keepOther) clearInterval(keepOther);
    if (other) await releaseRole(other).catch(() => false);
    if (worker.exitCode() === undefined) worker.child.kill('SIGTERM');
    await path.stop();
  }
}, 240_000);
