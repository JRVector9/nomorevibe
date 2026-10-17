import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { batchJobsForRole } from '@/lib/jobs/batches';
import { httpOriginPolicyHash } from '@/lib/net/http-origin-policy';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// 실제 production 장부 모듈을 각자 별도 Node 프로세스로 띄운다. 명령은 IPC 로만 받는다(시험 전용 driver).
const driver = `
const { startHostBudget } = require('./lib/operations/host-budget-runtime.ts');
const host = startHostBudget(process.env, JSON.parse(process.env.HOST_BUDGET_TEST_TIMING));
const held = new Map();
process.on('message', async ({ id, cmd, job, ms }) => {
  try {
    if (cmd === 'state') return process.send({ id, ready: host.ready() });
    if (cmd === 'admit') {
      const result = await host.admit(job);
      if (result.admitted) held.set(job, result.release);
      return process.send({ id, admitted: result.admitted, reason: result.admitted ? null : result.reason });
    }
    if (cmd === 'release') { await held.get(job)(); held.delete(job); return process.send({ id, released: true }); }
    if (cmd === 'block') { const end = Date.now() + ms; while (Date.now() < end); return process.send({ id, blocked: true }); }
    if (cmd === 'stop') { await host.stop(); await globalThis.pgClient?.end({ timeout: 2 }); process.send({ id, stopped: true }); process.disconnect(); }
  } catch (error) { process.send({ id, error: String(error && error.message || error) }); }
});
host.settled.then(() => process.send({ started: true }));
`;
type Reply = Record<string, unknown>;
const RELEASE = 'pr10e-fixture';
const relaxed = { maxLoadPerCpu: 1_000, maxHostRssBytes: 2 ** 40, maxEventLoopDelayMs: 60_000, maxHeartbeatGapMs: 60_000 };
const timing = { leaseMs: 2_000, renewMs: 200, holdMs: 400 };
const instanceHosts: Record<string, string> = { 'pr10e-mini-a': 'mini', 'pr10e-mini-b': 'mini', 'pr10e-mini-c': 'mini',
  'pr10e-osaka-a': 'oracle-osaka-smoke', 'pr10e-osaka-b': 'oracle-osaka-smoke', 'pr10e-m3-a': 'm3', 'pr10e-m3-b': 'm3', 'pr10e-wrong': 'm3' };
const client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const children = new Set<() => Promise<void>>();
let original: unknown;

function environment(host: string, roles: string[], role: string, instance: string,
  options: { pressure?: typeof relaxed; timing?: Record<string, number>; rolloutCopies?: 1 | 2 } = {}): NodeJS.ProcessEnv {
  const policy = { version: 1, host, release: RELEASE, roles, schedulerReplicas: 0, webReplicas: 0, webReadReplica: false,
    monitor: false, connectAgent: false, preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: options.rolloutCopies ?? 1 };
  // 자식은 최소 env 만 받는다 — 개발자 셸의 provider 키를 물려받지 않고, 혹시 잡이 돌아도 모델 주소는 닫힌 로컬 포트다
  return { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LOG_LEVEL: 'error', ABCLLM_BASE_URL: 'http://127.0.0.1:9',
    DATABASE_URL: TEST_DATABASE_URL, WORKER_ROLE: role, PHYSICAL_HOST: host,
    RELEASE_TAG: RELEASE, SERVICE_INSTANCE_ID: instance, HTTP_ORIGIN_PERMITS: '1', DB_POOLER_MODE: 'direct',
    DB_POOL_MAX: undefined, READ_DB_POOL_MAX: undefined, DB_STATEMENT_TIMEOUT_MS: '5000', DB_LOCK_TIMEOUT_MS: '2000',
    HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy, process: { kind: 'worker', role, host, release: RELEASE, replica: 1, copy: 1 } }),
    HOST_BUDGET_ENFORCEMENT: JSON.stringify({ mode: 'enabled', pressure: options.pressure ?? relaxed }),
    HOST_BUDGET_TEST_TIMING: JSON.stringify(options.timing ?? timing) };
}

function launch(name: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', '-e', driver], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '';
  child.stdout!.on('data', () => {});
  child.stderr!.on('data', data => { stderr = (stderr + String(data)).slice(-4096); });
  const pending = new Map<string, { resolve: (value: Reply) => void; reject: (error: Error) => void }>();
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const started = new Promise<void>((resolve, reject) => {
    child.on('message', (message: Reply) => {
      if (message.started) resolve();
      const waiter = typeof message.id === 'string' ? pending.get(message.id) : undefined;
      if (waiter) { pending.delete(message.id as string); waiter.resolve(message); }
    });
    child.once('exit', code => {
      const error = new Error(`${name}_exited_${code}:${stderr}`);
      reject(error);
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    });
  });
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; };
  children.add(kill);
  const request = (command: Reply) => new Promise<Reply>((resolve, reject) => {
    const id = randomUUID();
    pending.set(id, { resolve, reject });
    child.send({ id, ...command }, error => { if (error) { pending.delete(id); reject(error); } });
  });
  return { started, request, kill, admit: (job: string) => request({ cmd: 'admit', job }) };
}
const ledger = (host: string) => client<{ key: string; value: Record<string, unknown> }[]>`SELECT key, value FROM operations_observations
  WHERE key LIKE ${`host-slot:${host}:%`} ORDER BY key`;
async function openHttp(mapping: Record<string, string>, mode: 'open' | 'disabled' = 'open') {
  const policy = { version: 1, instanceHosts: mapping };
  await client`UPDATE http_origin_control SET mode=${mode}, policy=${client.json(policy)}, policy_hash=${httpOriginPolicyHash(policy)} WHERE id=1`;
}

beforeAll(async () => {
  ensureSchema();
  [{ row: original }] = await client<{ row: unknown }[]>`SELECT to_jsonb(c) AS row FROM http_origin_control c WHERE id=1`;
  await client`DELETE FROM operations_observations WHERE key LIKE 'host-slot:%'`;
  await openHttp(instanceHosts);
});
afterEach(async () => {
  await Promise.allSettled([...children].map(kill => kill()));
  children.clear();
  await client`DELETE FROM operations_observations WHERE key LIKE 'host-slot:%'`;
  await openHttp(instanceHosts);
});
afterAll(async () => {
  await client`UPDATE http_origin_control c SET (mode,epoch,revision,policy,policy_hash,updated_at)=(x.mode,x.epoch,x.revision,x.policy,x.policy_hash,x.updated_at)
    FROM jsonb_populate_record(NULL::http_origin_control, ${JSON.stringify(original)}::text::jsonb) x WHERE c.id=1`;
  await client.end({ timeout: 5 });
});

it('control: without HOST_BUDGET_ENFORCEMENT two translation processes both run and nothing is written (original behavior)', async () => {
  const disabled = (role: string, instance: string) => ({ ...environment('oracle-osaka-smoke', ['translation', 'text'], role, instance), HOST_BUDGET_ENFORCEMENT: undefined });
  const a = launch('legacy-a', disabled('translation', 'pr10e-osaka-a'));
  const b = launch('legacy-b', disabled('text', 'pr10e-osaka-b'));
  await Promise.all([a.started, b.started]);
  expect(await a.admit('product-translate')).toEqual(expect.objectContaining({ admitted: true }));
  expect(await b.admit('reason-translate')).toEqual(expect.objectContaining({ admitted: true }));
  expect(await client`SELECT key FROM operations_observations WHERE key LIKE 'host-slot:%'`).toEqual([]);
}, 40_000);

it('rejects a second process for the same declared slot and a larger roster until the holder crashes and its DB-clock lease expires', async () => {
  const a = launch('a', environment('mini', ['crawler'], 'crawler', 'pr10e-mini-a'));
  await a.started;
  expect(await a.admit('crawl-fetch')).toEqual(expect.objectContaining({ admitted: true }));
  const b = launch('b', environment('mini', ['crawler'], 'crawler', 'pr10e-mini-b'));
  const larger = launch('larger', environment('mini', ['crawler'], 'crawler', 'pr10e-mini-c', { rolloutCopies: 2 }));
  await Promise.all([b.started, larger.started]);
  expect(await b.request({ cmd: 'state' })).toEqual(expect.objectContaining({ ready: false }));
  expect(await b.admit('crawl-fetch')).toEqual(expect.objectContaining({ admitted: false, reason: 'host_process_duplicate' }));
  expect(await larger.admit('crawl-fetch')).toEqual(expect.objectContaining({ admitted: false, reason: 'host_policy_mismatch' }));
  const [holder] = await ledger('mini');
  expect(holder).toMatchObject({ key: 'host-slot:mini:p:worker:crawler:-:1:1', value: { type: 'process', primaryMax: 4, readMax: 0 } });
  await larger.kill();
  await a.kill();
  // SIGKILL 은 정리 코드를 돌리지 않는다. 자리는 DB 시계 만료 전까지 그대로다
  expect((await ledger('mini')).map(row => row.value.bootId)).toEqual([holder.value.bootId]);
  expect(await b.admit('crawl-fetch')).toEqual(expect.objectContaining({ admitted: false, reason: 'host_process_duplicate' }));
  await vi.waitFor(async () => expect(await b.admit('crawl-fetch')).toEqual(expect.objectContaining({ admitted: true })), { timeout: 8_000, interval: 100 });
  const [taken] = await ledger('mini');
  expect(taken.key).toBe(holder.key);
  expect(taken.value.bootId).not.toBe(holder.value.bootId);
  // 정상 종료는 자기 행만 즉시 지운다
  await b.request({ cmd: 'stop' });
  expect(await ledger('mini')).toEqual([]);
}, 40_000);

it('keeps Oracle translation calls at one across processes, leaves other jobs and the holder untouched, and frees a crashed holder only after lease plus hold', async () => {
  const a = launch('translation', environment('oracle-osaka-smoke', ['translation', 'text'], 'translation', 'pr10e-osaka-a'));
  const b = launch('text', environment('oracle-osaka-smoke', ['translation', 'text'], 'text', 'pr10e-osaka-b'));
  await Promise.all([a.started, b.started]);
  expect(await a.admit('product-translate')).toEqual(expect.objectContaining({ admitted: true }));
  expect(await b.admit('reason-translate')).toEqual(expect.objectContaining({ admitted: false, reason: 'host_translation_busy' }));
  expect(await b.admit('product-tagline-ko')).toEqual(expect.objectContaining({ admitted: false, reason: 'host_translation_busy' }));
  expect(await b.admit('crawl-tagline')).toEqual(expect.objectContaining({ admitted: true }));
  // 막힌 쪽 시도는 보유자의 slot 을 건드리지 않는다(여러 갱신 주기 뒤에도 같은 token)
  const [slot] = (await ledger('oracle-osaka-smoke')).filter(row => row.value.type === 'translation');
  await new Promise(resolve => setTimeout(resolve, 3 * timing.renewMs));
  const [kept] = (await ledger('oracle-osaka-smoke')).filter(row => row.value.type === 'translation');
  expect(kept.value).toMatchObject({ token: slot.value.token, job: 'product-translate', holdMs: timing.holdMs });
  expect(Number(kept.value.leaseUntilMs)).toBeGreaterThan(Number(slot.value.leaseUntilMs));
  await a.request({ cmd: 'release', job: 'product-translate' });
  expect(await b.admit('reason-translate')).toEqual(expect.objectContaining({ admitted: true }));
  expect(await a.admit('product-translate')).toEqual(expect.objectContaining({ admitted: false, reason: 'host_translation_busy' }));
  await b.kill();
  expect(await a.admit('product-tagline-ko')).toEqual(expect.objectContaining({ admitted: false, reason: 'host_translation_busy' }));
  await vi.waitFor(async () => expect(await a.admit('product-tagline-ko')).toEqual(expect.objectContaining({ admitted: true })), { timeout: 10_000, interval: 100 });
  const translations = (await ledger('oracle-osaka-smoke')).filter(row => row.value.type === 'translation');
  expect(translations).toHaveLength(1);
  expect(translations[0].value).toMatchObject({ job: 'product-tagline-ko', owner: 'worker:translation:-:1:1' });
}, 40_000);

it('stops new admissions host-wide while another process misses its heartbeat, then resumes', async () => {
  const pressure = { ...relaxed, maxEventLoopDelayMs: 700, maxHeartbeatGapMs: 1_200 };
  const slow = { leaseMs: 6_000, renewMs: 200 };
  const a = launch('stalled', environment('m3', ['crawler', 'publisher'], 'crawler', 'pr10e-m3-a', { pressure, timing: slow }));
  const b = launch('healthy', environment('m3', ['crawler', 'publisher'], 'publisher', 'pr10e-m3-b', { pressure, timing: slow }));
  await Promise.all([a.started, b.started]);
  await vi.waitFor(async () => expect(await b.admit('crawl-publish')).toEqual(expect.objectContaining({ admitted: true })), { timeout: 8_000, interval: 100 });
  const blocked = a.request({ cmd: 'block', ms: 3_000 });
  // 막힌 프로세스는 스스로 알릴 수 없다 — 그 행이 DB 시계로 오래됐다는 것만으로 host 의 새 admission 을 멈춘다
  await vi.waitFor(async () => expect(await b.admit('crawl-publish')).toEqual(expect.objectContaining({ admitted: false, reason: 'host_pressure_heartbeat' })),
    { timeout: 2_800, interval: 50 });
  expect(await blocked).toEqual(expect.objectContaining({ blocked: true }));
  await vi.waitFor(async () => expect(await b.admit('crawl-publish')).toEqual(expect.objectContaining({ admitted: true })), { timeout: 8_000, interval: 100 });
  const rows = await ledger('m3');
  expect(rows.map(row => row.key)).toEqual(['host-slot:m3:p:worker:crawler:-:1:1', 'host-slot:m3:p:worker:publisher:-:1:1']);
}, 40_000);

function runWorkerOnce(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/worker.ts', '--role=text', '--once'], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout = (stdout + String(data)).slice(-65_536); });
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-8_192); });
  const closed = new Promise<number | null>(resolve => child.once('close', code => resolve(code)));
  children.add(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  return closed.then(code => { clearTimeout(timer); return { code, stdout, stderr }; });
}

it('real worker entry: an over-budget pending job is deferred before any claim, run or attempt, and the worker leaves the ledger', async () => {
  const holder = launch('holder', environment('oracle-osaka-smoke', ['translation', 'text'], 'translation', 'pr10e-osaka-a'));
  await holder.started;
  expect(await holder.admit('product-translate')).toEqual(expect.objectContaining({ admitted: true }));
  const names = batchJobsForRole('text', 'legacy');
  const [{ snapshot }] = await client<{ snapshot: unknown[] }[]>`SELECT coalesce(jsonb_agg(to_jsonb(j)), '[]'::jsonb) AS snapshot FROM jobs j WHERE name = ANY(${names})`;
  const state = () => client`SELECT requested_version, processed_version, runs, cursor, locked_at, lease_token, last_run_at, last_success_at,
    last_error, not_before FROM jobs WHERE name='product-translate'`;
  try {
    await client.begin(async tx => {
      await tx`UPDATE jobs SET processed_version=requested_version WHERE name = ANY(${names})`;
      await tx`INSERT INTO jobs(name, requested_version, processed_version) VALUES ('product-translate', 1, 0)
        ON CONFLICT (name) DO UPDATE SET requested_version=jobs.processed_version + 1, locked_at=NULL, lease_token=NULL, not_before=NULL`;
    });
    const before = await state();
    const result = await runWorkerOnce(environment('oracle-osaka-smoke', ['translation', 'text'], 'text', 'pr10e-osaka-b'));
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const events = result.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line) as Reply]; } catch { return []; } })
      .filter(event => event.event === 'worker.job');
    expect(events).toEqual([{ event: 'worker.job', at: expect.any(String), role: 'text', name: 'product-translate', status: 'deferred', reason: 'host_translation_busy' }]);
    expect(await state()).toEqual(before);
    const rows = await ledger('oracle-osaka-smoke');
    expect(rows.map(row => row.key)).toEqual(['host-slot:oracle-osaka-smoke:p:worker:translation:-:1:1', 'host-slot:oracle-osaka-smoke:t:1']);
  } finally {
    await client.begin(async tx => {
      await tx`DELETE FROM jobs WHERE name = ANY(${names})`;
      await tx`INSERT INTO jobs SELECT * FROM jsonb_populate_recordset(NULL::jobs, ${client.json(snapshot as never)})`;
    });
  }
}, 60_000);

it('admits only while the shared HTTP permit ledger is open and counts this instance on the same physical host', async () => {
  await openHttp({ ...instanceHosts, 'pr10e-wrong': 'm3' });
  const worker = launch('wrong', environment('mini', ['text'], 'text', 'pr10e-wrong'));
  await worker.started;
  expect(await worker.request({ cmd: 'state' })).toEqual(expect.objectContaining({ ready: true }));
  expect(await worker.admit('product-repo-review')).toEqual(expect.objectContaining({ admitted: false, reason: 'host_http_unbound' }));
  await openHttp({ ...instanceHosts, 'pr10e-wrong': 'mini' });
  await vi.waitFor(async () => expect(await worker.admit('product-repo-review')).toEqual(expect.objectContaining({ admitted: true })), { timeout: 5_000, interval: 100 });
  await openHttp({ ...instanceHosts, 'pr10e-wrong': 'mini' }, 'disabled');
  await vi.waitFor(async () => expect(await worker.admit('product-repo-review')).toEqual(expect.objectContaining({ admitted: false, reason: 'host_http_unbound' })),
    { timeout: 5_000, interval: 100 });
}, 40_000);
