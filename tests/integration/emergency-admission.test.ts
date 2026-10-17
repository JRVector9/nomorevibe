import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { batchCanaryAnchorKey, batchPolicyHash, BATCH_ROLES } from '@/lib/jobs/batches';
import { tryAcquireRole } from '@/lib/jobs/role-leader';
import { httpOriginPolicyHash } from '@/lib/net/http-origin-policy';
import { emergencyTakeoverGate } from '@/lib/operations/emergency-admission-runtime';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

/**
 * PR16b — 비상 admission 을 실제 host 장부(PR10e)와 실제 자식 프로세스로 확인한다. 각 프로세스는 production 장부 모듈을
 * 띄우고 IPC 명령으로만 admit/release 한다(PR10e 시험 driver). 비상 모드 입력(역할 후보 관측·역할 lease·jobs·writer fence)은
 * 이 시험이 DB 에 직접 둔다 — 모델·provider 호출은 없다(자식 env 는 최소, 모델 주소는 닫힌 로컬 포트).
 */
const driver = `
const { startHostBudget } = require('./lib/operations/host-budget-runtime.ts');
const host = startHostBudget(process.env, JSON.parse(process.env.HOST_BUDGET_TEST_TIMING));
const held = new Map();
process.on('message', async ({ id, cmd, job }) => {
  try {
    if (cmd === 'admit') {
      const result = await host.admit(job);
      if (result.admitted) held.set(job, result.release);
      return process.send({ id, admitted: result.admitted, reason: result.admitted ? null : result.reason });
    }
    if (cmd === 'release') { await held.get(job)(); held.delete(job); return process.send({ id, released: true }); }
  } catch (error) { process.send({ id, error: String(error && error.message || error) }); }
});
host.settled.then(() => process.send({ started: true }));
`;
type Reply = Record<string, unknown>;
const RELEASE = 'pr16b-fixture', ORACLE = 'oracle-osaka-smoke';
const ROSTER = ['translation', 'text', 'maintenance', 'reviewer', 'publisher'];
const relaxed = { maxLoadPerCpu: 1_000, maxHostRssBytes: 2 ** 40, maxEventLoopDelayMs: 60_000, maxHeartbeatGapMs: 60_000 };
const timing = { leaseMs: 2_000, renewMs: 200, holdMs: 400 };
const instanceHosts: Record<string, string> = { 'pr16b-osaka-a': ORACLE, 'pr16b-osaka-b': ORACLE, 'pr16b-osaka-w': ORACLE, 'pr16b-m3': 'm3', 'pr16b-mini': 'mini' };
const budget = (patch: Record<string, number> = {}) => ({ jobs: 1, modelJobs: 1, httpJobs: 1, agingMs: 600_000, ...patch });
type Emergency = { budget: ReturnType<typeof budget>; verifiedModelJobs: string[] };
const client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const children = new Set<() => Promise<void>>();
const anchorKey = batchCanaryAnchorKey('text', 'pr16b-osaka-a');
let original: Record<string, unknown>;

function environment(role: string, instance: string, emergency: Emergency | null): NodeJS.ProcessEnv {
  const policy = { version: 1, host: ORACLE, release: RELEASE, roles: ROSTER, schedulerReplicas: 0, webReplicas: 0, webReadReplica: false,
    monitor: false, connectAgent: false, preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 };
  // 자식은 최소 env 만 받는다 — 개발자 셸의 provider 키를 물려받지 않고, 혹시 잡이 돌아도 모델 주소는 닫힌 로컬 포트다
  return { NODE_ENV: process.env.NODE_ENV, PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LOG_LEVEL: 'error', ABCLLM_BASE_URL: 'http://127.0.0.1:9',
    DATABASE_URL: TEST_DATABASE_URL, WORKER_ROLE: role, PHYSICAL_HOST: ORACLE, RELEASE_TAG: RELEASE, SERVICE_INSTANCE_ID: instance, HTTP_ORIGIN_PERMITS: '1',
    DB_POOLER_MODE: 'direct', DB_STATEMENT_TIMEOUT_MS: '5000', DB_LOCK_TIMEOUT_MS: '2000',
    HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy, process: { kind: 'worker', role, host: ORACLE, release: RELEASE, replica: 1, copy: 1 } }),
    HOST_BUDGET_ENFORCEMENT: JSON.stringify({ mode: 'enabled', pressure: relaxed }), HOST_BUDGET_TEST_TIMING: JSON.stringify(timing),
    ...(emergency ? { EMERGENCY_ADMISSION: JSON.stringify({ mode: 'enabled', ...emergency }) } : {}) };
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
  return { started, admit: (job: string) => request({ cmd: 'admit', job }), release: (job: string) => request({ cmd: 'release', job }) };
}
const ledger = () => client<{ key: string; value: Record<string, unknown> }[]>`SELECT key, value FROM operations_observations
  WHERE key LIKE ${`host-slot:${ORACLE}:%`} AND key NOT LIKE ${`host-slot:${ORACLE}:p:%`} ORDER BY key`;
const deferred = (reason: string) => expect.objectContaining({ admitted: false, reason });
const admittedReply = expect.objectContaining({ admitted: true });

/** m3·mini 의 역할 후보 관측 — 살아 있으면 지금, 아니면 5분 전(60초 신선도 밖) */
async function hosts(alive: { m3: boolean; mini: boolean }) {
  await client`DELETE FROM operations_observations WHERE key LIKE 'candidate:%:pr16b-%'`;
  for (const [host, fresh] of Object.entries(alive)) {
    await client`INSERT INTO operations_observations(key, value, observed_at) VALUES (${`candidate:text:pr16b-${host}`}, ${client.json({ phase: 'standby' })},
      CASE WHEN ${fresh} THEN localtimestamp ELSE localtimestamp - interval '5 minutes' END)`;
  }
}
/** 주어진 역할만 그 인스턴스가 쥔 살아 있는 lease, 나머지 역할은 2분 전에 만료 */
async function leases(owned: Record<string, string>) {
  for (const role of BATCH_ROLES) await client`INSERT INTO role_leases(role) VALUES (${role}) ON CONFLICT (role) DO NOTHING`;
  await client`UPDATE role_leases SET owner_instance_id=NULL, owner_boot_id=NULL, owner_kind=NULL, quarantine_until=NULL, primary_boots='[]'::jsonb,
    lease_until=clock_timestamp() - interval '2 minutes'`;
  for (const [role, instance] of Object.entries(owned)) {
    await client`INSERT INTO role_leases(role, owner_instance_id, owner_boot_id, owner_kind, owner_release, epoch, lease_until)
      VALUES (${role}, ${instance}, 'pr16b-held', 'primary', ${RELEASE}, 1, clock_timestamp() + interval '1 hour')
      ON CONFLICT (role) DO UPDATE SET owner_instance_id=excluded.owner_instance_id, owner_boot_id=excluded.owner_boot_id, owner_kind=excluded.owner_kind,
        owner_release=excluded.owner_release, epoch=greatest(role_leases.epoch, 1), lease_until=excluded.lease_until`;
  }
}
/** 모든 잡을 처리된 상태로 두고, 주어진 잡만 due(마지막 차례 = 지금 − 간격) */
async function due(since: Record<string, string>) {
  await client`UPDATE jobs SET processed_version=requested_version, locked_at=NULL, lease_token=NULL, not_before=NULL`;
  for (const [name, ago] of Object.entries(since)) {
    await client`INSERT INTO jobs(name, requested_version, processed_version, last_run_at) VALUES (${name}, 1, 0, now() - ${ago}::interval)
      ON CONFLICT (name) DO UPDATE SET requested_version=jobs.processed_version + 1, last_run_at=excluded.last_run_at, locked_at=NULL, lease_token=NULL, not_before=NULL`;
  }
}
async function openHttp() {
  const policy = { version: 1, instanceHosts };
  await client`UPDATE http_origin_control SET mode='open', policy=${client.json(policy)}, policy_hash=${httpOriginPolicyHash(policy)} WHERE id=1`;
}
const table = async (name: string) => (await client.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows FROM ${name} t`))[0].rows;

beforeAll(async () => {
  ensureSchema();
  original = { jobs: await table('jobs'), role_leases: await table('role_leases'), job_batch_control: await table('job_batch_control'),
    http_origin_control: await table('http_origin_control'), dr_writer_fence: await table('dr_writer_fence') };
  await client`DELETE FROM operations_observations WHERE key LIKE 'host-slot:%'`;
  await openHttp();
});
afterEach(async () => {
  await Promise.allSettled([...children].map(kill => kill()));
  children.clear();
  await client.begin(async tx => {
    await tx`DELETE FROM operations_observations WHERE key LIKE 'host-slot:%' OR key LIKE 'candidate:%:pr16b-%' OR key LIKE 'batch-result:pr16b-%' OR key = ${anchorKey}`;
    await tx`DELETE FROM job_batch_candidates WHERE instance_id LIKE 'pr16b-%'`;
    for (const name of ['jobs', 'role_leases']) {
      await tx.unsafe(`DELETE FROM ${name}`);
      await tx.unsafe(`INSERT INTO ${name} SELECT * FROM jsonb_populate_recordset(NULL::${name}, $1::text::jsonb)`, [JSON.stringify(original[name])]);
    }
    for (const [name, columns] of [['job_batch_control', 'mode,draining_from,epoch,writer_contract_version,policy,policy_hash,updated_at'],
      ['http_origin_control', 'mode,epoch,revision,policy,policy_hash,updated_at'], ['dr_writer_fence', 'lineage_id,writer_epoch,state,reason,fenced_db,promotion_id,updated_at']]) {
      await tx.unsafe(`UPDATE ${name} c SET (${columns}) = (${columns.split(',').map(column => `x.${column}`).join(',')})
        FROM jsonb_populate_record(NULL::${name}, ($1::text::jsonb)->0) x WHERE c.id = x.id`, [JSON.stringify(original[name])]);
    }
  });
  await openHttp();
});
afterAll(async () => {
  await client.begin(async tx => {
    await tx.unsafe(`UPDATE http_origin_control c SET (mode,epoch,revision,policy,policy_hash,updated_at)=(x.mode,x.epoch,x.revision,x.policy,x.policy_hash,x.updated_at)
      FROM jsonb_populate_record(NULL::http_origin_control, ($1::text::jsonb)->0) x WHERE c.id = x.id`, [JSON.stringify(original.http_origin_control)]);
  });
  await client.end({ timeout: 5 });
});

it('control: with M3 and mini alive the enabled emergency config stays out of the way (PR10e admission, no emergency slot)', async () => {
  await hosts({ m3: true, mini: true });
  await leases({ translation: 'pr16b-osaka-a' });
  await due({ 'crawl-tagline': '1 minute', 'product-translate': '1 minute' });
  const text = launch('text', environment('text', 'pr16b-osaka-a', { budget: budget({ jobs: 0 }), verifiedModelJobs: [] }));
  await text.started;
  // 예산 0·검증 0 이어도 정상 모드에서는 끼어들지 않는다
  expect(await text.admit('crawl-tagline')).toEqual(admittedReply);
  expect(await text.admit('product-translate')).toEqual(admittedReply);
  expect((await ledger()).map(row => row.key)).toEqual([`host-slot:${ORACLE}:t:1`]);
}, 40_000);

it('full: defers unverified model and suspended jobs, admits the oldest due job across processes within the one-job budget, and frees it on release', async () => {
  await hosts({ m3: false, mini: false });
  await leases({ text: 'pr16b-osaka-a', maintenance: 'pr16b-osaka-b' });
  await due({ 'product-translate': '10 minutes', 'uptime-ping': '2 minutes' });
  const emergency = { budget: budget(), verifiedModelJobs: ['product-translate'] };
  const text = launch('text', environment('text', 'pr16b-osaka-a', emergency));
  const maintenance = launch('maintenance', environment('maintenance', 'pr16b-osaka-b', emergency));
  await Promise.all([text.started, maintenance.started]);
  expect(await text.admit('reason-translate')).toEqual(deferred('emergency_model_unverified'));
  expect(await text.admit('product-repo-review')).toEqual(deferred('emergency_suspended'));
  // 번역(9분 기다림)이 uptime(1분)보다 먼저다 — 다른 프로세스의 due 도 같은 장부 TX 에서 함께 줄 세운다
  expect(await maintenance.admit('uptime-ping')).toEqual(deferred('emergency_budget_jobs'));
  expect(await ledger()).toEqual([]);
  expect(await text.admit('product-translate')).toEqual(admittedReply);
  const rows = await ledger();
  expect(rows.map(row => row.key)).toEqual([`host-slot:${ORACLE}:e:1`, `host-slot:${ORACLE}:t:1`]);
  expect(rows[0].value).toMatchObject({ type: 'emergency', job: 'product-translate', owner: 'worker:text:-:1:1', holdMs: timing.holdMs, token: rows[1].value.token });
  // 진행 중 비상 잡은 소유 프로세스가 살아 있는 동안 갱신으로 연장된다(끊지 않는다)
  await new Promise(resolve => setTimeout(resolve, 3 * timing.renewMs));
  const [kept] = await ledger();
  expect(kept.value.token).toBe(rows[0].value.token);
  expect(Number(kept.value.leaseUntilMs)).toBeGreaterThan(Number(rows[0].value.leaseUntilMs));
  expect(await maintenance.admit('uptime-ping')).toEqual(deferred('emergency_budget_jobs'));
  await text.release('product-translate');
  expect(await ledger()).toEqual([]);
  // 번역 틱이 끝나 due 에서 빠지면 다음 차례가 자리를 얻는다
  await client`UPDATE jobs SET processed_version=requested_version, last_run_at=now() WHERE name='product-translate'`;
  expect(await maintenance.admit('uptime-ping')).toEqual(admittedReply);
  expect((await ledger()).map(row => [row.key, row.value.job])).toEqual([[`host-slot:${ORACLE}:e:1`, 'uptime-ping']]);
}, 40_000);

it('aging: a lower tier job that waited long past its interval outranks fresh translation-tier work, otherwise tier order holds', async () => {
  await hosts({ m3: false, mini: false });
  await leases({ reviewer: 'pr16b-osaka-a', maintenance: 'pr16b-osaka-b' });
  await due({ 'crawl-judge': '30 minutes', 'product-search-refresh': '1 minute' });
  const emergency = { budget: budget(), verifiedModelJobs: [] };
  const reviewer = launch('reviewer', environment('reviewer', 'pr16b-osaka-a', emergency));
  const maintenance = launch('maintenance', environment('maintenance', 'pr16b-osaka-b', emergency));
  await Promise.all([reviewer.started, maintenance.started]);
  expect(await maintenance.admit('product-search-refresh')).toEqual(deferred('emergency_budget_jobs'));
  expect(await reviewer.admit('crawl-judge')).toEqual(admittedReply);
  await reviewer.release('crawl-judge');
  await due({ 'crawl-judge': '6 minutes', 'product-search-refresh': '1 minute' });
  expect(await reviewer.admit('crawl-judge')).toEqual(deferred('emergency_budget_jobs'));
  expect(await maintenance.admit('product-search-refresh')).toEqual(admittedReply);
}, 40_000);

it('recovering keeps the emergency budget; a fenced writer (hold) admits control only and writes no slot', async () => {
  await hosts({ m3: true, mini: false });
  await leases({ text: 'pr16b-osaka-a', publisher: 'pr16b-osaka-b' });
  await due({ 'crawl-tagline': '2 minutes' });
  const text = launch('text', environment('text', 'pr16b-osaka-a', { budget: budget(), verifiedModelJobs: ['crawl-tagline'] }));
  await text.started;
  expect(await text.admit('crawl-tagline')).toEqual(admittedReply);
  expect((await ledger()).map(row => [row.key, row.value.job])).toEqual([[`host-slot:${ORACLE}:e:1`, 'crawl-tagline']]);
  await text.release('crawl-tagline');
  const fencedDb = { systemIdentifier: '7000000000000000001', databaseOid: '16384', databaseName: 'nomorevibe_test' };
  await client`UPDATE dr_writer_fence SET state='fenced', reason='operator_fence', fenced_db=${client.json(fencedDb)} WHERE id=1`;
  expect(await text.admit('crawl-tagline')).toEqual(deferred('emergency_hold_control_only'));
  expect(await text.admit('heartbeat')).toEqual(admittedReply);
  expect(await ledger()).toEqual([]);
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

it('real worker entry: in full mode an unverified model job is deferred before any claim or attempt and the worker leaves the ledger', async () => {
  await hosts({ m3: false, mini: false });
  await leases({ text: 'pr16b-osaka-a' });
  await due({ 'product-translate': '5 minutes' });
  const state = () => client`SELECT requested_version, processed_version, runs, cursor, locked_at, lease_token, last_run_at, last_success_at,
    last_error, not_before FROM jobs WHERE name='product-translate'`;
  const before = await state();
  const result = await runWorkerOnce(environment('text', 'pr16b-osaka-w', { budget: budget(), verifiedModelJobs: [] }));
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  const events = result.stdout.split('\n').flatMap(line => { try { return [JSON.parse(line) as Reply]; } catch { return []; } })
    .filter(event => event.event === 'worker.job');
  expect(events).toEqual([{ event: 'worker.job', at: expect.any(String), role: 'text', name: 'product-translate', status: 'deferred', reason: 'emergency_model_unverified' }]);
  expect(await state()).toEqual(before);
  expect(await client`SELECT key FROM operations_observations WHERE key LIKE ${`host-slot:${ORACLE}:%:%`}`).toEqual([]);
}, 60_000);

const gate = emergencyTakeoverGate({ PHYSICAL_HOST: ORACLE, EMERGENCY_ADMISSION: JSON.stringify({ mode: 'enabled', budget: budget(), verifiedModelJobs: [] }) })!;
const roleRow = async (role: string) => (await client`SELECT owner_instance_id, owner_boot_id, epoch::int AS epoch FROM role_leases WHERE role=${role}`)[0];

it('legacy election: while recovering Oracle does not take a new M3/mini role, keeps the one it owns, and takes it again only in full', async () => {
  expect(emergencyTakeoverGate({})).toBeUndefined();
  await hosts({ m3: true, mini: false });
  await leases({ publisher: 'pr16b-osaka-b' });
  const candidate = { role: 'text' as const, instanceId: 'pr16b-osaka-a', bootId: 'pr16b-boot-legacy', release: RELEASE, kind: 'primary' as const };
  const before = await roleRow('text');
  expect(await tryAcquireRole(candidate, gate)).toBeNull();
  expect(await roleRow('text')).toEqual(before);
  await hosts({ m3: false, mini: false });
  const lease = await tryAcquireRole(candidate, gate);
  expect(lease).toMatchObject({ instanceId: 'pr16b-osaka-a', epoch: Number(before?.epoch ?? 0) + 1 });
  // M3 가 돌아와 recovering 이 돼도 이미 쥔 역할은 그대로다(비선점) — 새 인계만 막는다
  await hosts({ m3: true, mini: false });
  expect(await tryAcquireRole(candidate, gate)).toEqual(lease);
  expect(await tryAcquireRole({ ...candidate, role: 'maintenance' }, gate)).toBeNull();
}, 40_000);

it('versioned election: the gate runs inside acquireBatchRole before the canary pin and claim', async () => {
  const policy = { version: 1 as const, release: RELEASE, instances: [{ instanceId: 'pr16b-osaka-a', host: ORACLE as typeof ORACLE }, { instanceId: 'pr16b-m3', host: 'm3' as const }] };
  await client`UPDATE job_batch_control SET mode='versioned', draining_from=NULL, writer_contract_version=1, policy=${client.json(policy)}, policy_hash=${batchPolicyHash(policy)} WHERE id=1`;
  const [{ epoch, at }] = await client`SELECT epoch::int AS epoch, to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM job_batch_control WHERE id=1`;
  const identity = { instanceId: 'pr16b-osaka-a', host: ORACLE, release: RELEASE };
  const capability = { ...identity, dbPrivileges: 'verified', dbRole: 'fixture-only', effectivePrivilegeHash: 'a'.repeat(64), modelBoundEvidenceHash: 'b'.repeat(64),
    http: 'verified', model: 'verified', observedAt: at };
  const readback = { ...identity, job: 'crawl-tagline', requestedVersion: 1, domainReadbackHash: 'c'.repeat(64), observedAt: at };
  await client`INSERT INTO job_batch_candidates(role, instance_id, host, boot_id, release, policy_hash, capability, result_evidence)
    VALUES ('text', 'pr16b-osaka-a', ${ORACLE}, 'pr16b-boot-batch', ${RELEASE}, ${batchPolicyHash(policy)}, ${client.json(capability)}, ${client.json(readback)})`;
  await client`INSERT INTO operations_observations(key, value) VALUES ('batch-result:pr16b-osaka-a:crawl-tagline',
    ${client.json({ batchResult: { ...identity, role: 'text', batchEpoch: epoch, job: 'crawl-tagline', bootId: 'pr16b-boot-batch', recordedAt: at, count: 1, requestedVersion: 1 } })})`;
  await hosts({ m3: true, mini: false });
  await leases({ publisher: 'pr16b-osaka-b' });
  const candidate = { role: 'text' as const, instanceId: 'pr16b-osaka-a', bootId: 'pr16b-boot-batch', release: RELEASE, kind: 'primary' as const, batchVersion: 1 as const, host: ORACLE as typeof ORACLE };
  const before = await roleRow('text');
  expect(await tryAcquireRole(candidate, gate)).toBeNull();
  expect(await roleRow('text')).toEqual(before);
  expect(await client`SELECT key FROM operations_observations WHERE key=${anchorKey}`).toEqual([]);
  await hosts({ m3: false, mini: false });
  expect(await tryAcquireRole(candidate, gate)).toMatchObject({ instanceId: 'pr16b-osaka-a', batchEpoch: epoch, epoch: Number(before?.epoch ?? 0) + 1 });
  expect((await client`SELECT key FROM operations_observations WHERE key=${anchorKey}`).length).toBe(1);
}, 40_000);

it('real role-worker entry: an Oracle candidate stays standby while recovering (hook logged) and is elected once both Macs are down', async () => {
  await hosts({ m3: true, mini: false });
  await leases({ publisher: 'pr16b-osaka-b' });
  await due({});
  const healthPath = `/tmp/nomorevibe-pr16b-role-${process.pid}.json`;
  const env: NodeJS.ProcessEnv = { ...environment('text', 'pr16b-osaka-r', { budget: budget(), verifiedModelJobs: [] }), LOG_LEVEL: 'info',
    WORKER_HEALTH_PATH: healthPath, ROLE_HEALTH_PATH: `/tmp/nomorevibe-pr16b-role-candidate-${process.pid}.json` };
  const declared = JSON.parse(env.HOST_DB_BUDGET!) as { process: Record<string, unknown> };
  env.HOST_DB_BUDGET = JSON.stringify({ ...declared, process: { ...declared.process, kind: 'role-parent' } });
  instanceHosts['pr16b-osaka-r'] = ORACLE;
  await openHttp();
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/role-worker.ts', '--role=text', '--kind=primary'],
    { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output = (output + String(data)).slice(-262_144); });
  child.stderr.on('data', data => { output = (output + String(data)).slice(-262_144); });
  const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  children.add(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; });
  const until = async (check: () => Promise<boolean> | boolean, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw new Error(`role worker did not reach expected state: ${output.slice(-4_000)}`);
  };
  try {
    await until(() => output.split('\n').some(line => line.includes('"event":"emergency.takeover_held"') && line.includes('"role":"text"')
      && line.includes('"mode":"recovering"')), 30_000);
    expect((await roleRow('text'))?.owner_instance_id ?? null).toBeNull();
    await hosts({ m3: false, mini: false });
    await until(async () => (await roleRow('text'))?.owner_instance_id === 'pr16b-osaka-r', 30_000);
    const { readFile } = await import('node:fs/promises');
    await until(async () => { try { return (JSON.parse(await readFile(healthPath, 'utf8')) as { status: string }).status === 'running'; } catch { return false; } }, 30_000);
    child.kill('SIGTERM');
    expect(await exited, output.slice(-4_000)).toBe(0);
    expect((await roleRow('text'))?.owner_instance_id ?? null).toBeNull();
  } finally {
    delete instanceHosts['pr16b-osaka-r'];
  }
}, 120_000);
