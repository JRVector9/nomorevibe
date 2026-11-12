import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { executeFirstReviewConsumerItem } from '@/lib/crawl/agent-review-item-lifecycle';
import { runFirstReviewConsumer } from '@/lib/crawl/consumers/first';
import { parsePipelineFirstConsumerArgs, runPipelineFirstConsumer } from '@/scripts/pipeline-first-consumer';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';
import { consumerHealthPath, supervisorCommand, supervisorHealthPath } from '@/scripts/worker-supervisor';
import { pinReviewRanks } from './review-task-ranks-fixture';

const mocks = vi.hoisted(() => ({ choose: vi.fn(), load: vi.fn(), prepare: vi.fn(), claim: vi.fn(), observe: vi.fn(), renew: vi.fn(),
  record: vi.fn(), spam: vi.fn(), select: vi.fn(), where: vi.fn(), pages: [] as unknown[][], limit: vi.fn(),
  sleep: vi.fn(), runtime: vi.fn(), report: vi.fn(), settings: vi.fn(), predicate: vi.fn(), ensureAssignments: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { select: mocks.select }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: () => null }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: mocks.settings }));
vi.mock('@/lib/crawl/agent-review-repository', () => ({ chooseFirstReviewForCandidate: mocks.choose, loadFirstReviewConsumerContext: mocks.load,
  claimConsumerItemAgentReview: mocks.claim, observeAgentReviewItemDispatch: mocks.observe,
  renewAgentReviewItemOwnership: mocks.renew, recordAgentReview: mocks.record,
  recordConsumerSuspectedSpam: mocks.spam, reviewCandidatePredicate: mocks.predicate,
  // 쪽 쿼리의 「심사한 적 있음」 식 — 가짜 db 는 식을 실행하지 않으니 표시만 돌려준다
  firstReviewSeenSql: () => ({ kind: 'first-review-seen' }) }));
vi.mock('@/lib/crawl/agent-review-preparation', () => ({ prepareAgentReview: mocks.prepare }));
vi.mock('@/lib/crawl/agent-review', () => ({ firstReviewer: () => ({ provider: 'abcllm', model: 'same-model' }) }));
// 「작업 ↔ 모델」 순위 스냅숏(PR C1, 예전 3b-E 배정 표): 소비자 쪽마다 순위를 새로 받는 길목만 가짜다(고르기는 위 chooseFirstReviewForCandidate 가짜가 받는다).
// 순위 자체는 pinReviewRanks 로 고정한다 — 순위가 없으면 소비자가 no_task_models 로 쉰다(그 경우는 아래 시험이 본다).
vi.mock('@/lib/crawl/review-task-ranks', async (importOriginal) => ({ ...await importOriginal<typeof import('@/lib/crawl/review-task-ranks')>(),
  ensureReviewTaskRanks: mocks.ensureAssignments }));
vi.mock('@/scripts/worker', () => ({ withRuntimeProcess: mocks.runtime, interruptibleSleep: mocks.sleep }));
vi.mock('@/lib/operations/observations', () => ({ observeService: vi.fn() }));
const owner = () => ({ instanceId: 'ai1-consumer-unit', bootId: 'f70bfcce-92d0-4ed8-a5db-bfd092d17950' });
const context = { candidate: { id: 4 }, document: {}, settings: { enabled: true, reviewMode: 'enforce' }, input: {} };
const receipt = { attemptId: 3, origin: 'fresh', ownership: { kind: 'item' } };
const outcome = { decision: 'reject', reason: 'Server rule', evidenceIds: ['product'] };
const hint = (id: number) => ({ id, reviewed: false, updatedAt: '2026-10-16 01:02:03.123456', ceiling: 1000 });
function gate<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.resetAllMocks(); mocks.pages = [];
  pinReviewRanks({ first: [{ provider: 'abcllm', model: 'same-model' }] });
  // PR C1: 소비자는 늘 순위 고르기다(단일 모델 길이 없어졌다) — 기본 고르기는 1순위 same-model
  mocks.choose.mockResolvedValue({ provider: 'abcllm', model: 'same-model' });
  mocks.load.mockResolvedValue({ kind: 'current', context });
  mocks.prepare.mockResolvedValue({ provider: 'rules', model: 'rules-version', outcome, spam: false, ruleRejection: { reason: 'not_a_product' } });
  mocks.claim.mockResolvedValue({ kind: 'claimed', receipt, attempt: { id: 3, outcome: null } });
  mocks.observe.mockResolvedValue({ kind: 'current' }); mocks.renew.mockResolvedValue({});
  mocks.record.mockResolvedValue({ applied: true, state: 'succeeded' }); mocks.spam.mockResolvedValue({ applied: true, state: 'succeeded' });
  mocks.settings.mockResolvedValue({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'enforce' });
  mocks.limit.mockImplementation(async () => mocks.pages.shift() ?? []);
  mocks.ensureAssignments.mockResolvedValue(undefined);
  mocks.select.mockImplementation(() => ({ from: () => ({ where: (query: SQL) => { mocks.where(query);
    return { orderBy: () => ({ limit: mocks.limit }) }; } }) }));
  mocks.runtime.mockImplementation(async (_role, run) => run(new AbortController().signal, mocks.report));
});
afterEach(() => { vi.useRealTimers(); pinReviewRanks(null); });
it('has a separate fixed AI1 parser and default opt-out before runtime/database work', async () => {
  expect(parsePipelineFirstConsumerArgs(['--once'])).toEqual({ once: true });
  for (const args of [['--stage=ai1'], ['--stage=ai2'], ['--once', '--once'], ['--script=x']]) expect(() => parsePipelineFirstConsumerArgs(args)).toThrow();
  expect(await runPipelineFirstConsumer([], {})).toEqual({ state: 'disabled' });
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled();
});
it('strict target/owner and pre-aborted caller do not claim', async () => {
  const abort = new AbortController(); abort.abort();
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner(), signal: abort.signal })).toEqual({ state: 'skipped', reason: 'aborted' });
  await expect(executeFirstReviewConsumerItem({ candidateId: 0, owner: owner() })).rejects.toThrow();
  await expect(executeFirstReviewConsumerItem({ candidateId: 4, owner: { ...owner(), extra: true } as ReturnType<typeof owner> })).rejects.toThrow();
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('stopClaims before the item or after preparation does not claim', async () => {
  const stopped = new AbortController(); stopped.abort();
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner(), stopClaims: stopped.signal })).toEqual({ state: 'skipped', reason: 'aborted' });
  const late = new AbortController();
  mocks.prepare.mockImplementationOnce(async () => { late.abort(); return { provider: 'rules', model: 'rules-version', outcome, spam: false }; });
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner(), stopClaims: late.signal })).toEqual({ state: 'skipped', reason: 'aborted' });
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('stopClaims ends the AI1 loop after the current item without a backoff', async () => {
  const cancel = new AbortController(), stopClaims = new AbortController();
  mocks.pages = [[hint(4), hint(5)]];
  mocks.record.mockImplementationOnce(async () => { stopClaims.abort(); return { applied: true, state: 'succeeded' }; });
  expect(await runFirstReviewConsumer({ owner: owner(), signal: cancel.signal, stopClaims: stopClaims.signal }))
    .toEqual({ attempted: 1, recorded: 1, skipped: 0, deferred: 0 });
  expect(mocks.load.mock.calls.map(call => call[0])).toEqual([4]); expect(mocks.sleep).not.toHaveBeenCalled(); expect(cancel.signal.aborted).toBe(false);
});

it('an item pool isolates local capacity waits by selected model and moves the same candidate to the next rank (PR C1)', async () => {
  const primary = { provider: 'abcllm' as const, model: 'primary-model' };
  const extra = { provider: 'abcllm' as const, model: 'extra-model' };
  const settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'enforce' as const,
    firstReview: primary, firstReviewAdditional: [extra] };
  mocks.settings.mockResolvedValue(settings);
  pinReviewRanks({ first: [primary, extra] });
  mocks.pages = [[hint(4), hint(5), hint(6)]];
  mocks.load.mockImplementation(async id => ({ kind: 'current', context: { ...context, candidate: { id }, settings } }));
  // 고르기는 쉬는 모델(avoid)을 비켜 다음 순위를 준다 — 실제 chooseFirstReviewForCandidate 와 같은 뜻
  const keyOf = (value: { provider: string; model: string }) => JSON.stringify([value.provider, value.model]);
  mocks.choose.mockImplementation(async ({ candidate }, _ownership, avoid: Set<string>) =>
    candidate.id === 5 || avoid.has(keyOf(primary)) ? extra : primary);
  mocks.prepare.mockImplementation(async (_context, reviewer) => ({ ...reviewer, spam: false }));
  mocks.claim.mockImplementation(async ({ candidate, model }) => {
    if (candidate.id === 4 && model === primary.model) throw new ModelCapacityDeferredError('capacity');
    return { kind: 'reused', receipt, attempt: { id: 3, outcome } };
  });
  const circuit = { admitted: true as const, record: vi.fn(), done: vi.fn() };
  const circuits = { admit: vi.fn((key: string) => { void key; return circuit; }) };
  // 4: 1순위 primary 가 capacity 로 미뤄져 primary 만 이 패스 동안 쉬고, 같은 후보 4 를 2순위 extra 로 다시 고른다(claim 이 reused). 6 도 extra.
  expect(await runFirstReviewConsumer({ owner: owner(), once: true, circuits }))
    .toEqual({ attempted: 3, recorded: 3, skipped: 0, deferred: 1 });
  expect(mocks.claim.mock.calls.map(call => [call[0].candidate.id, call[0].model])).toEqual([[4, primary.model], [4, extra.model], [5, extra.model], [6, extra.model]]);
  // 회로는 고른 모델마다 따로다(primary 한 번, extra 세 번 — 후보 4 의 2순위·5·6)
  const ai1 = (value: { provider: string; model: string }) => 'ai1:' + JSON.stringify([value.provider, value.model]);
  expect(circuits.admit.mock.calls.map(call => call[0])).toEqual([ai1(primary), ai1(extra), ai1(extra), ai1(extra)]);
  expect(circuit.done).toHaveBeenCalledTimes(4);
});
// 2026-10-30 결정: 한 후보의 fence 거절(work_busy)은 그 후보만 건너뛴다 — 같은 모델의 다음 후보도 claim 한다(모델 pause 없음).
it('a per-candidate fence refusal skips only that candidate and keeps its model admitting (D1)', async () => {
  const primary = { provider: 'abcllm' as const, model: 'primary-model' };
  const extra = { provider: 'abcllm' as const, model: 'extra-model' };
  const settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'enforce' as const,
    firstReview: primary, firstReviewAdditional: [extra] };
  mocks.settings.mockResolvedValue(settings);
  mocks.pages = [[hint(4), hint(5), hint(6)]];
  mocks.load.mockImplementation(async id => ({ kind: 'current', context: { ...context, candidate: { id }, settings } }));
  mocks.choose.mockImplementation(async ({ candidate }) => candidate.id === 5 ? extra : primary);
  mocks.prepare.mockImplementation(async (_context, reviewer) => ({ ...reviewer, spam: false }));
  mocks.claim.mockImplementation(async ({ candidate }) => {
    if (candidate.id === 4) throw new ModelCapacityDeferredError('work_busy');
    return { kind: 'reused', receipt, attempt: { id: 3, outcome } };
  });
  expect(await runFirstReviewConsumer({ owner: owner(), once: true }))
    .toEqual({ attempted: 3, recorded: 2, skipped: 1, deferred: 0 });
  expect(mocks.claim.mock.calls.map(call => call[0].candidate.id)).toEqual([4, 5, 6]);
  expect(mocks.sleep).not.toHaveBeenCalled();
});
it('a per-candidate fence refusal without a pool does not end the page (D1)', async () => {
  mocks.pages = [[hint(4), hint(5)]];
  mocks.load.mockImplementation(async id => ({ kind: 'current', context: { ...context, candidate: { id } } }));
  mocks.claim.mockImplementation(async ({ candidate }) => {
    if (candidate.id === 4) throw new ModelCapacityDeferredError('work_busy');
    return { kind: 'claimed', receipt, attempt: { id: 3, outcome: null } };
  });
  expect(await runFirstReviewConsumer({ owner: owner(), once: true }))
    .toEqual({ attempted: 2, recorded: 1, skipped: 1, deferred: 0 });
  expect(mocks.claim.mock.calls.map(call => call[0].candidate.id)).toEqual([4, 5]);
});
// 2026-10-31 결정: host 예산 거절은 그 hint 하나만 넘기고 쪽을 계속 본다 — 하나가 잘못되면 다음 작업도 안 되는 구조는 이유가 없다
it('a host-budget refusal skips only that hint and the page continues (no break, no extra sleep in once mode)', async () => {
  mocks.pages = [[hint(4), hint(5), hint(6)]];
  mocks.load.mockImplementation(async id => ({ kind: 'current', context: { ...context, candidate: { id } } }));
  const release = vi.fn(async () => {});
  const admit = vi.fn(async () => admit.mock.calls.length === 1 ? { admitted: false as const, reason: 'budget_exhausted' as const }
    : { admitted: true as const, release });
  expect(await runFirstReviewConsumer({ owner: owner(), once: true, admit: admit as never }))
    .toEqual({ attempted: 2, recorded: 2, skipped: 0, deferred: 1 });
  expect(mocks.load.mock.calls.map(call => call[0])).toEqual([5, 6]);
  expect(admit).toHaveBeenCalledTimes(3); expect(release).toHaveBeenCalledTimes(2); expect(mocks.sleep).not.toHaveBeenCalled();
});
it('launches one fixed reviewer runtime with a fresh boot and matching observation identity', async () => {
  await runPipelineFirstConsumer(['--once'], { PIPELINE_ITEM_CONSUMER_VERSION: '1',
    PIPELINE_ITEM_CONSUMER_INSTANCE_ID: owner().instanceId, SERVICE_INSTANCE_ID: owner().instanceId });
  expect(mocks.runtime).toHaveBeenCalledExactlyOnceWith('reviewer', expect.any(Function));
  expect(mocks.select).toHaveBeenCalledOnce();
});
it('rejects mismatched identity/reserved health paths and unknown opt-in before runtime work', async () => {
  for (const env of [{ PIPELINE_ITEM_CONSUMER_VERSION: '2' }, { PIPELINE_ITEM_CONSUMER_VERSION: '1' },
    { PIPELINE_ITEM_CONSUMER_VERSION: '1', SERVICE_INSTANCE_ID: 'ai2-consumer-unit', PIPELINE_ITEM_CONSUMER_INSTANCE_ID: owner().instanceId },
    { PIPELINE_ITEM_CONSUMER_VERSION: '1', SERVICE_INSTANCE_ID: owner().instanceId, PIPELINE_ITEM_CONSUMER_INSTANCE_ID: 'different' }])
    await expect(runPipelineFirstConsumer([], env)).rejects.toThrow();
  expect(mocks.runtime).not.toHaveBeenCalled(); expect(mocks.select).not.toHaveBeenCalled();
});
it('completes prepared server rules with the actual item receipt and mandatory writer', async () => {
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() })).toEqual({ applied: true, state: 'succeeded' });
  expect(mocks.claim).toHaveBeenCalledExactlyOnceWith({ ...context, provider: 'rules', model: 'rules-version', owner: owner(), ttlMs: 90_000 });
  expect(mocks.observe).toHaveBeenCalledExactlyOnceWith(context, receipt);
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ ...context, receipt, outcome, ruleRejection: { reason: 'not_a_product' } });
});
it('uses stored reused outcome without dispatch and passes spam only through its fixed writer', async () => {
  mocks.prepare.mockResolvedValueOnce({ provider: 'abcllm', model: 'same-model', spam: false });
  mocks.claim.mockResolvedValueOnce({ kind: 'reused', receipt: { ...receipt, origin: 'semantic_reuse' }, attempt: { outcome } });
  await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() });
  expect(mocks.record.mock.calls[0][0].outcome).toBe(outcome);
  mocks.prepare.mockResolvedValueOnce({ provider: 'rules', model: 'rules-version', spam: true, outcome });
  await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() });
  expect(mocks.spam).toHaveBeenCalledExactlyOnceWith({ ...context, receipt });
});
it('unprepared source and explicit settings stops never claim', async () => {
  mocks.load.mockResolvedValueOnce({ kind: 'skipped', reason: 'source_not_prepared' });
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() })).toEqual({ state: 'skipped', reason: 'source_not_prepared' });
  mocks.load.mockResolvedValueOnce({ kind: 'skipped', reason: 'disabled' });
  expect(await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() })).toEqual({ state: 'skipped', reason: 'disabled' });
  expect(mocks.claim).not.toHaveBeenCalled();
});
it('propagates fresh model typed refusal and genuine claim errors without a writer', async () => {
  const deferred = new ModelCapacityDeferredError('disabled'), original = new Error('actual SQL error');
  mocks.claim.mockRejectedValueOnce(deferred).mockRejectedValueOnce(original);
  // PR C1: 늘 순위 고르기라 모델 미룸은 고른 심사자를 실은 FirstReviewModelDeferredError 로 올라간다(소비자가 그 모델만 쉬게 하거나 쪽을 접는다)
  await expect(executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() })).rejects.toMatchObject({
    reason: 'disabled', reviewer: { provider: 'abcllm', model: 'same-model' } });
  await expect(executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() })).rejects.toBe(original);
  expect(mocks.record).not.toHaveBeenCalled();
});
it('current-domain invalidation/caller abort goes to the original cancelled writer', async () => {
  mocks.observe.mockResolvedValue({ kind: 'changed' });
  await executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() });
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith({ ...context, receipt, error: 'cancelled' });
});
it('drains the actual in-flight renewal before its single writer', async () => {
  vi.useFakeTimers(); const observed = gate<{ kind: string }>(), renewal = gate<object>();
  mocks.observe.mockReturnValue(observed.promise); mocks.renew.mockReturnValue(renewal.promise);
  const running = executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() });
  try {
    await vi.advanceTimersByTimeAsync(15_000); expect(mocks.renew).toHaveBeenCalledExactlyOnceWith(context, receipt, 90_000);
    observed.resolve({ kind: 'current' }); await vi.advanceTimersByTimeAsync(0); expect(mocks.record).not.toHaveBeenCalled();
  } finally { renewal.resolve({}); await running; }
  expect(mocks.record).toHaveBeenCalledOnce(); await vi.advanceTimersByTimeAsync(60_000); expect(mocks.renew).toHaveBeenCalledOnce();
});
it('renewal error survives drain with writer zero', async () => {
  vi.useFakeTimers(); const observed = gate<{ kind: string }>(), original = new Error('renew SQL failure');
  mocks.observe.mockReturnValue(observed.promise); mocks.renew.mockRejectedValue(original);
  const running = executeFirstReviewConsumerItem({ candidateId: 4, owner: owner() }); void running.catch(() => {});
  await vi.advanceTimersByTimeAsync(15_000); observed.resolve({ kind: 'current' });
  await expect(running).rejects.toBe(original); expect(mocks.record).not.toHaveBeenCalled();
});
// 소비자는 틱이 없어 쪽마다 「작업 ↔ 모델」 순위 스냅숏을 새로 받는다(PR C1, 예전 3b-E 배정 표) — 관리자가 저장하면 재시작 없이 다음 쪽부터 쓴다
it('refreshes the assignment toggle and table snapshot before every page, and a global assignments_unavailable deferral folds the page', async () => {
  mocks.pages = [Array.from({ length: 24 }, (_, n) => hint(n + 1)), [hint(30)]];
  mocks.claim.mockResolvedValue({ kind: 'skipped', reason: 'running' });
  expect(await runFirstReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 25, recorded: 0, skipped: 25, deferred: 0 });
  expect(mocks.ensureAssignments).toHaveBeenCalledTimes(2);
  expect(mocks.ensureAssignments.mock.invocationCallOrder[0]).toBeLessThan(mocks.limit.mock.invocationCallOrder[0]);
  // the switch is on but the table (or the toggle itself) was never read: the chooser defers globally → page folds, cursor kept, no claim
  const settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'enforce' as const, firstReview: { provider: 'abcllm' as const, model: 'legacy' }, firstReviewAdditional: [] };
  mocks.settings.mockResolvedValue(settings);
  mocks.load.mockImplementation(async id => ({ kind: 'current', context: { ...context, candidate: { id }, settings } }));
  mocks.pages = [[hint(4), hint(5)]];
  mocks.choose.mockRejectedValue(new ModelCapacityDeferredError('assignments_unavailable'));
  expect(await runFirstReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 1, recorded: 0, skipped: 0, deferred: 1 });
  expect(mocks.claim).toHaveBeenCalledTimes(25);
  expect(mocks.load.mock.calls.at(-1)?.[0]).toBe(4);
});
it('empty once pass does not claim or back off', async () => {
  expect(await runFirstReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 0, recorded: 0, skipped: 0, deferred: 0 });
  expect(mocks.limit).toHaveBeenCalledExactlyOnceWith(24); expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.sleep).not.toHaveBeenCalled();
});
it('refills a short page immediately, then backs off empty, with a fresh per-item clock', async () => {
  const abort = new AbortController(); mocks.pages = [[hint(4)], [hint(5)], []];
  mocks.sleep.mockImplementation(async () => { abort.abort(); });
  expect(await runFirstReviewConsumer({ owner: owner(), signal: abort.signal, report: mocks.report })).toEqual({ attempted: 2, recorded: 2, skipped: 0, deferred: 0 });
  expect(mocks.load.mock.calls.map(call => call[0])).toEqual([4, 5]); expect(mocks.sleep).toHaveBeenCalledExactlyOnceWith(5_000, abort.signal);
  expect(mocks.report.mock.calls.filter(call => call[0] === 'running')).toEqual([
    ['running', 'crawl-agent-review', expect.any(Number)], ['running', 'crawl-agent-review', expect.any(Number)]]);
});
it('bounds once scans to four pages and keysets preserve microseconds and initial ceiling', async () => {
  mocks.pages = Array.from({ length: 5 }, (_, page) => Array.from({ length: 24 }, (_, n) => hint(page * 24 + n + 1)));
  mocks.claim.mockResolvedValue({ kind: 'skipped', reason: 'running' });
  expect(await runFirstReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 96, recorded: 0, skipped: 96, deferred: 0 });
  expect(mocks.limit).toHaveBeenCalledTimes(4);
  const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[1][0]);
  expect(query.params).toContain('2026-10-16 01:02:03.123456'); expect(query.params).toContain(1000); expect(query.sql).not.toContain('offset');
});
it('backs off typed refusal then resumes past it; genuine error stays primary', async () => {
  const abort = new AbortController(); mocks.pages = [[hint(4)], [hint(5)], []];
  mocks.claim.mockRejectedValueOnce(new ModelCapacityDeferredError('disabled'));
  mocks.sleep.mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { abort.abort(); });
  expect(await runFirstReviewConsumer({ owner: owner(), signal: abort.signal })).toEqual({ attempted: 2, recorded: 1, skipped: 0, deferred: 1 });
  const original = new Error('SQL failure'); mocks.pages = [[hint(6)]]; mocks.claim.mockRejectedValueOnce(original);
  await expect(runFirstReviewConsumer({ owner: owner(), once: true })).rejects.toBe(original);
});
it('routes fixed AI1 supervisor and health independently of legacy and AI2 files', () => {
  const env = { SERVICE_INSTANCE_ID: owner().instanceId };
  expect(supervisorCommand('reviewer', { consumer: 'ai1', once: true })).toEqual(['scripts/pipeline-first-consumer.ts', '--once']);
  expect(consumerHealthPath(env)).toBe('/tmp/nomorevibe-ai1-consumer-health.json');
  expect(supervisorHealthPath({ consumer: 'ai1' }, env)).toBe('/tmp/nomorevibe-ai1-consumer-health.json');
  for (const path of ['/tmp/nomorevibe-worker-health.json', '/tmp/./nomorevibe-ai2-consumer-health.json'])
    expect(() => supervisorHealthPath({ consumer: 'ai1', healthPath: path }, env)).toThrow();
});

it('ranks absent: the consumer rests with no_task_models instead of a code default, and never claims', async () => {
  pinReviewRanks({ first: [] }); mocks.pages = [[hint(4)]];
  expect(await runFirstReviewConsumer({ owner: owner(), once: true })).toEqual({ attempted: 0, recorded: 0, skipped: 0, deferred: 1 });
  expect(mocks.claim).not.toHaveBeenCalled(); expect(mocks.choose).not.toHaveBeenCalled();
});
