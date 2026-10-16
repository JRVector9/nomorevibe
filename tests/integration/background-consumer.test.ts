import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { operationsObservations } from '@/lib/db/schema';
import { markWorkerSeen, pendingJobNames, requestJob, withJobLeaseWrite } from '@/lib/jobs/control';
import { runJob, type JobContext, type JobOutcome } from '@/lib/jobs/runner';
import { tryAcquireRole, type RoleLease } from '@/lib/jobs/role-leader';
import { backgroundConsumerLanes } from '@/lib/jobs/background-consumer';
import { translateToKorean } from '@/lib/crawl/translate';
import { INTRO_CHECK_MODEL } from '@/lib/domain/products/intro-check';
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from '@/lib/llm/capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { withSlotOnlyModelCapacity } from '@/lib/llm/capacity-consumer-scope';
import { readModelCapacityCallerControl } from '@/lib/llm/capacity-repository';
import { backgroundCliPath } from '@/lib/llm/cli-model-capacity';
import { jobRunOptions, runWorker } from '@/scripts/worker';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

/*
 * PR06c 실제 DB driver — 실제 runJob(job lease·heartbeat·ACK)·pendingJobNames·requestJob·역할 선출(role_leases)·
 * model_capacity_control 위에서 배경 consumer 줄을 돌린다. handler 만 fixture 이고 모델·HTTP·CLI 는 부르지 않는다
 * (번역 transport 는 주입한 request mock 만, CLI 는 경로 판정까지만). 손대는 행(jobs·관측·role_leases·control)은 시작 값으로 되돌린다.
 */
type Raw = Record<string, unknown>;
const JOB = 'product-tagline-ko', MARKER = `pr06c-${randomUUID().slice(0, 8)}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { fixture: 1 }, groupLimits: { fixture: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: JOB, provider: 'abcllm', model: 'pr06c-fixture', providerBudgetId: 'fixture', groupId: 'fixture' }] };
const candidate = { role: 'text' as const, instanceId: `text-${MARKER}`, release: MARKER, kind: 'primary' as const };
let baseline: { job?: Raw; observation?: Raw; role?: Raw; control: Raw }, lease: RoleLease;

async function first(query: PromiseLike<postgres.Row[]>) { return (await query)[0]?.row as Raw | undefined; }
async function jobRow() {
  return (await first(admin`SELECT to_jsonb(j) - 'worker_seen_at' - 'updated_at' AS row FROM jobs j WHERE name=${JOB}`))!;
}
async function control(mode: 'disabled' | 'open' | 'draining') {
  await admin`UPDATE model_capacity_control SET mode=${mode},policy=${JSON.stringify(policy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(policy)},updated_at=clock_timestamp() WHERE id=1`;
}
function gate() {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  return { held, started, release, entered };
}
type Handler = (ctx: JobContext<unknown>) => Promise<JobOutcome<unknown>>;
const legacyRun = (handler: Handler, roleLease = lease) =>
  (name: string, options: { requestedOnly: true; signal?: AbortSignal }) => runJob(name, handler, { ...jobRunOptions(name, options), roleLease });
/** main() 과 같은 연결: 실제 pending·seen 과 backgroundConsumerLanes(open 검사·슬롯 전용 범위·requestJob) */
function deps(handler: Handler) {
  return { names: [JOB], pending: () => pendingJobNames('text'), seen: markWorkerSeen,
    run: legacyRun(async () => { throw new Error('legacy_lane_must_not_run_consumed_job'); }),
    consumer: backgroundConsumerLanes([JOB], legacyRun(handler)) };
}
const pass = (handler: Handler) => runWorker({ role: 'text', once: true }, deps(handler));
const fixtureResponse = () => new Response(JSON.stringify({ choices: [{ message: { content: '["번역"]' } }] }), { status: 200 });

beforeAll(async () => {
  ensureSchema();
  const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: { tag: string }[] };
  const tags = journal.entries.map(entry => entry.tag);
  for (const tag of ['0077_pipeline_item_leases', '0078_model_capacity', '0082_job_batches', '0095_dr_writer_fence']) expect(tags).toContain(tag);
  const [applied] = await admin`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
  // legacy 역할 선출·job 실행의 전제: batch legacy, DR writer fence active
  expect((await admin`SELECT mode FROM job_batch_control WHERE id=1`)[0].mode).toBe('legacy');
  expect((await admin`SELECT state FROM dr_writer_fence WHERE id=1`)[0].state).toBe('active');
  baseline = {
    job: await first(admin`SELECT to_jsonb(j) AS row FROM jobs j WHERE name=${JOB}`),
    observation: await first(admin`SELECT to_jsonb(o) AS row FROM operations_observations o WHERE key=${`job:${JOB}`}`),
    role: await first(admin`SELECT to_jsonb(r) AS row FROM role_leases r WHERE role='text'`),
    control: (await first(admin`SELECT to_jsonb(c) AS row FROM model_capacity_control c WHERE id=1`))!,
  };
  console.info('background_consumer_migrations', { journal: journal.entries.length, applied: applied.count });
});
beforeEach(async () => {
  // 이 파일만 쓰는 깨끗한 job·역할 행에서 시작한다(시작 값은 afterAll 이 되돌린다)
  await admin`DELETE FROM jobs WHERE name=${JOB}`;
  await admin`DELETE FROM role_leases WHERE role='text'`;
  const acquired = await tryAcquireRole({ ...candidate, bootId: randomUUID() });
  expect(acquired).toMatchObject({ role: 'text', epoch: 1 });
  lease = acquired!;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await admin`DELETE FROM operations_observations WHERE key LIKE ${`${MARKER}:%`}`;
  await restore('model_capacity_control', 'id', 1, baseline.control);
});
afterAll(async () => {
  try {
    await restore('jobs', 'name', JOB, baseline.job);
    await restore('operations_observations', 'key', `job:${JOB}`, baseline.observation);
    await restore('role_leases', 'role', 'text', baseline.role);
    await restore('model_capacity_control', 'id', 1, baseline.control);
  } finally { await admin.end(); }
});
/** 시작에 없던 행은 지우고, 있던 행은 제자리에서 그 값 그대로 되돌린 뒤(singleton control 은 지우지 않는다) 같은지 확인한다 */
async function restore(table: string, column: string, key: string | number, original: Raw | undefined) {
  const where = `"${column}"::text=$1`, saved = `jsonb_populate_record(NULL::"${table}",$1::text::jsonb)`;
  const [current] = await admin.unsafe(`SELECT 1 AS present FROM "${table}" WHERE ${where}`, [String(key)]);
  if (!original) await admin.unsafe(`DELETE FROM "${table}" WHERE ${where}`, [String(key)]);
  else if (!current) await admin.unsafe(`INSERT INTO "${table}" SELECT * FROM ${saved}`, [JSON.stringify(original)]);
  else await admin.unsafe(`UPDATE "${table}" t SET ${Object.keys(original).filter(name => name !== column).map(name => `"${name}"=r."${name}"`).join(',')}
    FROM ${saved} r WHERE t."${column}"=r."${column}"`, [JSON.stringify(original)]);
  const [row] = await admin.unsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE ${where}`, [String(key)]);
  expect(row?.row).toEqual(original);
}

it('닫힌 공통 슬롯(disabled·draining)에서는 요청된 job 도 잡지 않고, open 에서만 기존 job lease 로 한 틱을 돈다', async () => {
  const handler = vi.fn(async () => ({ done: true }));
  await requestJob(JOB);
  const before = await jobRow();
  for (const mode of ['disabled', 'draining'] as const) {
    await control(mode);
    expect(await pass(handler)).toEqual({ ticks: 1, failures: 0 });
    expect(handler).not.toHaveBeenCalled();
    expect(await jobRow()).toEqual(before);
  }
  await control('open');
  expect(await pass(handler)).toEqual({ ticks: 1, failures: 0 });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(await jobRow()).toMatchObject({ runs: Number(before.runs) + 1, processed_version: before.requested_version,
    requested_version: before.requested_version, lease_token: null, locked_at: null, last_error: null });
});

it('남은 일이 있다고 끝난 틱 뒤 기존 requestJob 으로 다시 요청해 scheduler 없이 이어 돌고, 빈 큐(done)면 다음 요청까지 잡지 않는다', async () => {
  await control('open');
  await requestJob(JOB);
  const start = await jobRow();
  const outcomes = [{ done: false }, { done: false }, { done: true }];
  const handler = vi.fn(async () => outcomes.shift() ?? { done: true });
  const controller = new AbortController(), sleeps: number[] = [];
  const result = await runWorker({ role: 'text', signal: controller.signal }, { ...deps(handler),
    sleep: async ms => { sleeps.push(ms); if (sleeps.length === 4) controller.abort(); } });
  expect(result).toEqual({ ticks: 4, failures: 0 });
  expect(handler).toHaveBeenCalledTimes(3);
  // 남은 일 뒤 짧게(1초), 빈 큐 뒤와 요청이 없는 poll 은 기존 간격(5초)
  expect(sleeps).toEqual([1_000, 1_000, 5_000, 5_000]);
  expect(await jobRow()).toMatchObject({ runs: Number(start.runs) + 3, requested_version: Number(start.requested_version) + 2,
    processed_version: Number(start.requested_version) + 2, lease_token: null, locked_at: null });
});

it('legacy 틱이 job lease 를 쥐면 consumer 는 잡지 않고, consumer 가 쥐면 legacy 는 locked 로 건너뛴다(같은 일감 동시 처리 0)', async () => {
  await control('open');
  await requestJob(JOB);
  const legacyGate = gate();
  const legacy = legacyRun(async () => { legacyGate.entered(); await legacyGate.held; return { done: true }; })(JOB, { requestedOnly: true });
  await legacyGate.started;
  await requestJob(JOB);
  const blocked = vi.fn(async () => ({ done: true }));
  expect(await pass(blocked)).toEqual({ ticks: 1, failures: 0 });
  expect(blocked).not.toHaveBeenCalled();
  legacyGate.release();
  expect(await legacy).toMatchObject({ status: 'completed', done: true });

  const consumerGate = gate();
  const consumer = pass(async () => { consumerGate.entered(); await consumerGate.held; return { done: true }; });
  await consumerGate.started;
  await requestJob(JOB);
  const legacyHandler = vi.fn(async () => ({ done: true }));
  expect(await legacyRun(legacyHandler)(JOB, { requestedOnly: true })).toEqual({ status: 'skipped', reason: 'locked' });
  expect(legacyHandler).not.toHaveBeenCalled();
  consumerGate.release();
  expect(await consumer).toEqual({ ticks: 1, failures: 0 });
  expect(await jobRow()).toMatchObject({ lease_token: null, locked_at: null });
});

it('사람이 멈춘 job(not_before 먼 미래)과 실패 뒤 재시도 유예는 consumer 도 잡지 않는다', async () => {
  await control('open');
  await requestJob(JOB);
  await admin`UPDATE jobs SET not_before='2100-01-01' WHERE name=${JOB}`;
  const handler = vi.fn(async () => ({ done: true }));
  await pass(handler);
  expect(handler).not.toHaveBeenCalled();
  expect(await jobRow()).toMatchObject({ not_before: '2100-01-01T00:00:00', runs: 0 });
  await admin`UPDATE jobs SET not_before=NULL WHERE name=${JOB}`;
  expect(await pass(async () => { throw new Error('pr06c_fixture_failure'); })).toEqual({ ticks: 1, failures: 1 });
  const failed = await jobRow();
  expect(failed).toMatchObject({ runs: 1, last_error: 'pr06c_fixture_failure', lease_token: null });
  expect(Number(failed.processed_version)).toBeLessThan(Number(failed.requested_version));
  await pass(handler);
  expect(handler).not.toHaveBeenCalled();
});

it('종료 신호에는 진행 중 틱을 끝까지 기다려 lease 를 놓고 다시 요청하지 않으며, 그 뒤 기존 legacy 줄이 같은 job 을 이어받는다(legacy 복귀)', async () => {
  await control('open');
  await requestJob(JOB);
  const controller = new AbortController(), held = gate(), sleep = vi.fn(async () => {});
  const work = runWorker({ role: 'text', signal: controller.signal }, { ...deps(async ctx => {
    held.entered(); await held.held;
    expect(ctx.signal?.aborted).toBe(true);
    return { done: false };
  }), sleep });
  await held.started;
  expect((await jobRow()).lease_token).toEqual(expect.any(String));
  controller.abort();
  held.release();
  expect(await work).toEqual({ ticks: 1, failures: 0 });
  expect(sleep).not.toHaveBeenCalled();
  const drained = await jobRow();
  expect(drained).toMatchObject({ lease_token: null, locked_at: null, runs: 1 });
  expect(drained.processed_version).toBe(drained.requested_version);
  // 복귀: consumer 설정이 없는 기존 줄이 scheduler 의 다음 요청을 그대로 처리한다
  await requestJob(JOB);
  const legacyHandler = vi.fn(async () => ({ done: true }));
  expect(await runWorker({ role: 'text', once: true }, { names: [JOB], pending: () => pendingJobNames('text'), seen: markWorkerSeen,
    run: legacyRun(legacyHandler) })).toEqual({ ticks: 1, failures: 0 });
  expect(legacyHandler).toHaveBeenCalledTimes(1);
  expect(await jobRow()).toMatchObject({ runs: 2, lease_token: null });
});

it('역할 인계는 진행 중 consumer 틱의 job lease 를 폐기하고, 늦은 결과 쓰기는 기존 job lease fence 에 막힌다', async () => {
  await control('open');
  await requestJob(JOB);
  const held = gate(), key = `${MARKER}:late-write`;
  const work = pass(async ctx => {
    held.entered(); await held.held;
    await withJobLeaseWrite(ctx.lease, tx => tx.insert(operationsObservations).values({ key, value: { stale: true } }));
    return { done: true };
  });
  await held.started;
  await admin`UPDATE role_leases SET lease_until=now() - interval '1 second' WHERE role='text'`;
  const next = await tryAcquireRole({ ...candidate, bootId: randomUUID() });
  expect(next).toMatchObject({ role: 'text', epoch: lease.epoch + 1 });
  expect((await jobRow()).lease_token).toBeNull();
  held.release();
  expect(await work).toEqual({ ticks: 1, failures: 1 });
  expect(await admin`SELECT key FROM operations_observations WHERE key=${key}`).toHaveLength(0);
  // 옛 epoch 는 더 잡지 못하고, 새 주인이 같은 요청을 이어 돈다
  expect(await legacyRun(async () => ({ done: true }))(JOB, { requestedOnly: true })).toEqual({ status: 'skipped', reason: 'stopping' });
  const handler = vi.fn(async () => ({ done: true }));
  expect(await legacyRun(handler, next!)(JOB, { requestedOnly: true })).toMatchObject({ status: 'completed' });
  expect(handler).toHaveBeenCalledTimes(1);
});

it('consumer 범위에서는 disabled 원 경로(공통 슬롯 밖)를 고르는 지점이 호출 대신 typed defer 로 끝나고, 범위 밖 기존 경로는 그대로다', async () => {
  vi.stubEnv('ABCLLM_API_KEY', 'pr06c-fixture-key');
  await control('disabled');
  const request = vi.fn(async () => fixtureResponse());
  await expect(withSlotOnlyModelCapacity(() => translateToKorean(['hello'], 1_000, request)))
    .rejects.toMatchObject({ name: 'ModelCapacityDeferredError', reason: 'disabled' });
  await expect(withSlotOnlyModelCapacity(() => backgroundCliPath('product-intro-check', INTRO_CHECK_MODEL)))
    .rejects.toBeInstanceOf(ModelCapacityDeferredError);
  expect(request).not.toHaveBeenCalled();
  expect(await backgroundCliPath('product-intro-check', INTRO_CHECK_MODEL)).toBe('legacy');
  await translateToKorean(['hello'], 1_000, request);
  expect(request).toHaveBeenCalledTimes(1);
  await control('open');
  expect((await withSlotOnlyModelCapacity(() => readModelCapacityCallerControl())).mode).toBe('open');
});

it('틱 도중 open→disabled 로 바뀌어도 consumer 는 슬롯 밖 원 경로로 부르지 않고 미룬다(요청·처리 판 보존, lease 반환)', async () => {
  vi.stubEnv('ABCLLM_API_KEY', 'pr06c-fixture-key');
  await control('open');
  await requestJob(JOB);
  const before = await jobRow();
  const request = vi.fn(async () => fixtureResponse());
  const handler = vi.fn(async () => {
    await control('disabled');
    await translateToKorean(['hello'], 1_000, request);
    return { done: false };
  });
  expect(await pass(handler)).toEqual({ ticks: 1, failures: 0 });
  expect(handler).toHaveBeenCalledTimes(1);
  expect(request).not.toHaveBeenCalled();
  expect(await jobRow()).toMatchObject({ requested_version: before.requested_version, processed_version: before.processed_version,
    runs: Number(before.runs) + 1, lease_token: null, locked_at: null, last_error: null });
});
