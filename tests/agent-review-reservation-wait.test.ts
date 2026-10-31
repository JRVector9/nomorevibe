import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import type { CrawlCandidate, CrawlDocument } from '@/lib/db/schema';
import { ai1DispatchBindingHash, ai1ModelDispatchSchema, type ModelCapacityRequest } from '@/lib/llm/capacity';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { firstReviewerKey, firstReviewers, selectFirstReviewer } from '@/lib/crawl/first-reviewers';

/**
 * AI1 틱 안의 예약 대기(2026-10-29) — 실제 coordinator(lib/crawl/agent-review-model-capacity.ts)와 job 을 그대로 돌리고, 장부만
 * 모델마다 물리 한도 1·FIFO 인 작은 가짜로 바꾼다. 실제 SQL grant·TTL 은 tests/integration/ai1-reservation-wait.test.ts 가 본다.
 * 예전에는 같은 모델의 둘째 후보가 capacity 를 받으면 그 모델을 틱 끝까지 pause 해, 틱마다 모델당 호출이 1건 안팎이었다.
 */
type Row = { requestId: string; workKey: string; model: string; state: 'waiting' | 'reserved' | 'dispatched'; ordinal: number; foreign?: boolean };
const ledger = vi.hoisted(() => ({ rows: new Map<string, Row>(), ordinal: 0, requests: 0, fenced: new Set<number>() }));
const mocks = vi.hoisted(() => ({ settings: null as CrawlSettings | null, list: vi.fn(), blocked: vi.fn(), gatewayActive: new Map<string, number>(),
  gatewayPeak: new Map<string, number>(), gatewayCalls: [] as string[], record: vi.fn(), cancel: vi.fn(), unknown: vi.fn(), callMs: 30 }));

function grant() {
  const models = new Set([...ledger.rows.values()].map(row => row.model));
  for (const model of models) {
    const rows = [...ledger.rows.values()].filter(row => row.model === model);
    if (rows.some(row => row.state !== 'waiting')) continue;
    const head = rows.filter(row => row.state === 'waiting').sort((a, b) => a.ordinal - b.ordinal)[0];
    if (head) head.state = 'reserved';
  }
}
vi.mock('@/lib/llm/capacity-repository', () => ({
  findOwnPendingModelRequest: async (identity: { workKey: string }) => {
    const row = [...ledger.rows.values()].find(value => value.workKey === identity.workKey);
    return row ? { requestId: row.requestId, state: row.state } : null;
  },
  requestAi1ModelSlot: async (request: ModelCapacityRequest, candidateId: number) => {
    ledger.requests++;
    // 같은 후보 fence(다른 요청이 ai1:<id> 를 쥠): 장부는 행을 만들지 않고 포화와 같은 capacity 로 답한다
    if (ledger.fenced.has(candidateId)) return { kind: 'deferred', reason: 'capacity' };
    if (!ledger.rows.has(request.requestId)) ledger.rows.set(request.requestId,
      { requestId: request.requestId, workKey: request.workKey, model: request.model, state: 'waiting', ordinal: ++ledger.ordinal });
    grant();
    const row = ledger.rows.get(request.requestId)!;
    return row.state === 'reserved' ? { kind: 'granted', reservation: { requestId: row.requestId } } : { kind: 'deferred', reason: 'capacity' };
  },
  cancelReservedModelSlot: async (reservation: { requestId: string }) => { mocks.cancel(reservation); ledger.rows.delete(reservation.requestId); return true; },
  markModelDispatchIndeterminate: async (...args: unknown[]) => { mocks.unknown(...args); return true; },
  reconcileAi1GatewayTerminal: async (terminal: { requestId: string }) => { ledger.rows.delete(terminal.requestId); return { kind: 'settled' }; },
  reconcileGatewayNotStarted: vi.fn(), reconcileAi1ItemGatewayTerminal: vi.fn(),
}));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => mocks.settings }));
vi.mock('@/lib/crawl/repository', () => ({ getDocument: async () => document(), setReadmeSample: vi.fn(), holdSuspectedSpam: vi.fn() }));
vi.mock('@/lib/crawl/readme', () => ({ fetchReadmeSample: async () => '', README_SAMPLE_LIMIT: 3000, README_SAMPLE_VERSION: '2026-09-14.1' }));
vi.mock('@/lib/domain/products/repository', () => ({ findRepositoryProduct: async () => null }));
vi.mock('@/lib/crawl/first-reviewer-blocks', () => ({ readBlockedFirstReviewerKeys: mocks.blocked }));
vi.mock('@/lib/crawl/agent-review-repository', () => ({
  canStartLegacyAgentReview: async () => true, requeueStaleReviewSources: async () => 0, handOffExhaustedFirstReviews: async () => 0,
  listOwnPendingFirstReviewCandidates: async () => [],
  // 단일 모델(pool 없음)은 이 목록에서 후보를 읽는다. 틱 끝의 이어 하기 확인(readyOnly)은 남은 후보가 없다고 답한다
  listReviewCandidates: async (_settings: unknown, limit: number, options?: { readyOnly?: boolean }) =>
    options?.readyOnly ? [] : ((await mocks.list()) as CrawlCandidate[]).slice(0, limit),
  listFirstReviewPoolCandidates: async (_settings: unknown, limit: number) => ((await mocks.list()) as CrawlCandidate[]).slice(0, limit)
    .map(candidate => ({ candidate, position: { id: candidate.id, reviewed: false, updatedAt: '2026-10-29 00:00:00.000001', ceiling: 1000 } })),
  chooseFirstReviewForCandidate: async ({ candidate, settings }: { candidate: CrawlCandidate; settings: CrawlSettings }) =>
    selectFirstReviewer(firstReviewers(settings), candidate.id),
  loadReviewInput: async (candidate: CrawlCandidate, doc: CrawlDocument, settings: CrawlSettings) =>
    createReviewInput(candidate, doc, settings, { scan: null, observations: [] }),
  claimAgentReview: async () => { throw Reflect.construct(ModelCapacityDeferredError, ['reservation_required']); },
  claimAgentReviewWithModelReservation: async (value: { reservation: { requestId: string }; candidate: CrawlCandidate; model: string }) => {
    const row = ledger.rows.get(value.reservation.requestId);
    if (row?.state !== 'reserved') return { kind: 'skipped', reason: 'reservation_lost' };
    row.state = 'dispatched';
    return { kind: 'claimed', attempt: { id: value.candidate.id, attemptNumber: 1 }, receipt: { attemptId: value.candidate.id, origin: 'fresh',
      ownership: { kind: 'legacy', stageEpoch: 1, job: lease } }, dispatch: dispatchFor(row.requestId, value.candidate.id, value.model) };
  },
  recordAgentReview: async (value: unknown) => { mocks.record(value); return { applied: false, state: 'succeeded' }; },
}));
vi.mock('@/lib/crawl/agent-review-gateway', () => ({
  REVIEW_GATEWAY_TIMEOUT_MS: 60_000, reviewGatewayTimeoutMs: () => 60_000, reviewWithGateway: vi.fn(), reviewWithReservedAi1ItemGateway: vi.fn(),
  settleAi1GatewayNotStarted: vi.fn(), settleAi1ItemGatewayNotStarted: vi.fn(),
  prepareAi1GatewayCall: (_input: unknown, options: { model: string }) => ({ kind: 'prepared', model: options.model }),
  reviewWithReservedAi1Gateway: async (_input: unknown, dispatch: { requestId: string; binding: { model: string } }) => {
    const model = dispatch.binding.model;
    mocks.gatewayCalls.push(model);
    mocks.gatewayActive.set(model, (mocks.gatewayActive.get(model) ?? 0) + 1);
    mocks.gatewayPeak.set(model, Math.max(mocks.gatewayPeak.get(model) ?? 0, mocks.gatewayActive.get(model)!));
    await new Promise(resolve => setTimeout(resolve, mocks.callMs));
    mocks.gatewayActive.set(model, mocks.gatewayActive.get(model)! - 1);
    return { result: { ok: true, outcome: { decision: 'approve', reason: 'Deployed task tracker', evidenceIds: ['product'] }, usage: {} },
      terminal: { requestId: dispatch.requestId } };
  },
}));
import { reviewCrawlCandidates } from '@/lib/crawl/jobs/agent-review';

const lease = { name: 'crawl-agent-review', token: randomUUID(), requestedVersion: 4 };
const owner = { instanceId: 'ai1-wait-unit-reviewer', bootId: randomUUID() };
const primary = { provider: 'abcllm' as const, model: 'model-a' }, extra = { provider: 'abcllm' as const, model: 'model-b' };
const now = new Date();
function document() {
  return { id: 1, repo: 'wait-unit/app', productUrl: 'https://wait.example', pageStatus: 200,
    repoMeta: { description: 'Task tracker', homepage: 'https://wait.example', pushed_at: now.toISOString(), stargazers_count: 0, owner: { type: 'User' } },
    pageMeta: { title: 'Tracker' }, fetchedAt: now } as CrawlDocument;
}
function dispatchFor(requestId: string, candidateId: number, model: string) {
  const binding = { kind: 'ai1_legacy_gateway' as const, version: 1 as const, logicalWorkKey: `ai1:${candidateId}`, candidateId, attemptId: candidateId,
    inputHash: 'a'.repeat(64), sourceRevisionHash: 'b'.repeat(64), reviewPolicyHash: 'c'.repeat(64),
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: 'abcllm' as const,
    model, routeId: 'crawl-agent-review' as const, stageEpoch: 1, wireHash: 'd'.repeat(64),
    servingContractHash: 'e'.repeat(64), totalTokenBound: 8192, chargedTokens: 8192,
    job: { name: 'crawl-agent-review' as const, token: lease.token, requestedVersion: lease.requestedVersion } };
  return ai1ModelDispatchSchema.parse({ requestId, owner, token: randomUUID(), epoch: 1, revision: 1,
    policyHash: 'f'.repeat(64), binding, bindingHash: ai1DispatchBindingHash(binding) });
}
const candidates = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index + 1, repo: `wait-unit/app-${index + 1}`,
  productUrl: 'https://wait.example', state: 'approved', decidedBy: 'auto', judgedAt: now, updatedAt: now }) as CrawlCandidate);
function context(deadlineAt?: number) {
  const log = vi.fn();
  return { cursor: null, lease, hasBudget: () => true, save: vi.fn(), log, ...(deadlineAt ? { deadlineAt } : {}) };
}
const tickSummary = (log: ReturnType<typeof vi.fn>) => log.mock.calls.find(([event]) => event === 'crawl.agent_review_tick')?.[1];
function foreignHolder(model: string) {
  const requestId = randomUUID();
  ledger.rows.set(requestId, { requestId, workKey: `foreign:${model}`, model, state: 'dispatched', ordinal: ++ledger.ordinal, foreign: true });
  return () => { ledger.rows.delete(requestId); };
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger.rows.clear(); ledger.ordinal = 0; ledger.requests = 0; ledger.fenced.clear();
  mocks.gatewayActive.clear(); mocks.gatewayPeak.clear(); mocks.gatewayCalls.length = 0; mocks.callMs = 30;
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'observe', reviewConcurrency: 4, firstReview: primary, firstReviewAdditional: [extra] };
  mocks.blocked.mockResolvedValue(new Set());
  for (const [key, value] of Object.entries({ ROLE_LEASE_ROLE: 'reviewer', ROLE_LEASE_INSTANCE_ID: owner.instanceId, ROLE_LEASE_BOOT_ID: owner.bootId,
    ROLE_LEASE_RELEASE: 'ai1-wait-unit-release', ROLE_LEASE_EPOCH: '1' })) vi.stubEnv(key, value);
});
afterAll(() => vi.unstubAllEnvs());

it('keeps dispatching several candidates per model in one tick while lanes wait for the one physical slot', async () => {
  mocks.list.mockResolvedValue(candidates(8));
  const ctx = context();
  const result = await reviewCrawlCandidates(ctx);
  // 같은 모델의 둘째 후보가 pause 대신 기다려, 여덟 후보가 한 틱에 모두 호출된다(예전: 모델당 1건 뒤 deferred)
  expect(result).not.toHaveProperty('deferred');
  expect(mocks.gatewayCalls.filter(model => model === 'model-a')).toHaveLength(4);
  expect(mocks.gatewayCalls.filter(model => model === 'model-b')).toHaveLength(4);
  // 물리 한도(모델당 1)는 그대로다
  expect(mocks.gatewayPeak.get('model-a')).toBe(1); expect(mocks.gatewayPeak.get('model-b')).toBe(1);
  expect(mocks.record).toHaveBeenCalledTimes(8);
  expect(mocks.cancel).not.toHaveBeenCalled(); expect(mocks.unknown).not.toHaveBeenCalled();
  expect(ledger.rows.size).toBe(0);
  const summary = tickSummary(ctx.log);
  expect(summary).toMatchObject({ admitted: 8, calls: 8, succeeded: 8, pausedModels: 0, modelDeferred: false, waitCapped: 0, waitWindowClosed: 0 });
  expect(summary.waits).toBeGreaterThan(0);
  expect(summary.waitGranted).toBe(summary.waits);
  expect(summary.models).toMatchObject({ 'model-a': { calls: 4 }, 'model-b': { calls: 4 } });
}, 20_000);

it('takes a slot released by another route mid-wait instead of pausing the model for the tick', async () => {
  mocks.settings = { ...mocks.settings!, reviewConcurrency: 1, firstReviewAdditional: undefined };
  mocks.list.mockResolvedValue(candidates(2));
  const release = foreignHolder('model-a');
  setTimeout(release, 700);
  const ctx = context();
  const result = await reviewCrawlCandidates(ctx);
  expect(result).not.toHaveProperty('deferred');
  expect(mocks.gatewayCalls).toEqual(['model-a', 'model-a']);
  expect(tickSummary(ctx.log)).toMatchObject({ calls: 2, waits: 1, waitGranted: 1, modelDeferred: false });
}, 20_000);

it('does not wait on a model whose physical slots are all unknown-occupied; the other model keeps working', async () => {
  mocks.blocked.mockResolvedValue(new Set([firstReviewerKey(primary)]));
  mocks.list.mockResolvedValue(candidates(4));
  foreignHolder('model-a');
  const started = Date.now();
  const ctx = context();
  expect(await reviewCrawlCandidates(ctx)).toEqual({ done: false, deferred: 'model_capacity' });
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(mocks.gatewayCalls).toEqual(['model-b', 'model-b']);
  const summary = tickSummary(ctx.log);
  expect(summary).toMatchObject({ pausedModels: 1, waitCapped: 0 });
  expect(summary.models['model-a']?.waits ?? 0).toBe(0);
});

it('leaves a still-queued candidate for the next tick without pausing its model when the tick window closes', async () => {
  mocks.settings = { ...mocks.settings!, reviewConcurrency: 2 };
  mocks.list.mockResolvedValue(candidates(2));
  const release = foreignHolder('model-a');
  // 시작 가능 창 약 0.8초: 60초 호출 제한 + 2초 기록 여유 + 3초 claim 여유 뒤
  const ctx = context(Date.now() + 65_800);
  try {
    const result = await reviewCrawlCandidates(ctx);
    // 다른 모델의 진전이 있으므로 runner 가 곧바로 다시 요청하게 한다(전용 줄 1초 refill)
    expect(result).toEqual({ done: false, continuation: 'ready' });
  } finally { release(); }
  expect(mocks.gatewayCalls).toEqual(['model-b']);
  const left = [...ledger.rows.values()].filter(row => !row.foreign);
  expect(left).toEqual([expect.objectContaining({ model: 'model-a', state: 'waiting' })]);
  expect(mocks.cancel).not.toHaveBeenCalled();
  expect(tickSummary(ctx.log)).toMatchObject({ waitWindowClosed: 1, pausedModels: 0 });
  expect(ctx.log).toHaveBeenCalledWith('crawl.agent_review_wait_window_closed', expect.objectContaining({ model: 'model-a' }));
}, 20_000);

it('keeps the request (deferred) when the window closes with a queued row and no other progress', async () => {
  mocks.settings = { ...mocks.settings!, reviewConcurrency: 1, firstReviewAdditional: undefined };
  mocks.list.mockResolvedValue(candidates(1));
  const release = foreignHolder('model-a');
  const ctx = context(Date.now() + 65_800);
  try { expect(await reviewCrawlCandidates(ctx)).toEqual({ done: false, deferred: 'model_capacity' }); }
  finally { release(); }
  expect(mocks.gatewayCalls).toEqual([]);
  expect([...ledger.rows.values()].filter(row => !row.foreign)).toEqual([expect.objectContaining({ state: 'waiting' })]);
}, 20_000);

// 2026-10-30 결정: 한 후보의 fence 거절(행 없는 capacity → work_busy)은 그 후보만 건너뛴다 — 모델을 pause 하지도, 틱을 미루지도 않는다.
it('skips only the fenced candidate and keeps admitting the same model in the pool tick (D1)', async () => {
  mocks.settings = { ...mocks.settings!, reviewConcurrency: 1 };
  mocks.list.mockResolvedValue(candidates(4)); // 1·3 → model-a, 2·4 → model-b
  ledger.fenced.add(1);
  const ctx = context();
  const result = await reviewCrawlCandidates(ctx);
  expect(result).not.toHaveProperty('deferred');
  expect(mocks.gatewayCalls).toEqual(['model-b', 'model-a', 'model-b']);
  expect(ctx.log).toHaveBeenCalledWith('crawl.agent_review_skipped', expect.objectContaining({ repo: 'wait-unit/app-1', reason: 'work_busy' }));
  expect(tickSummary(ctx.log)).toMatchObject({ pausedModels: 0, modelDeferred: false });
  expect(mocks.cancel).not.toHaveBeenCalled(); expect(ledger.rows.size).toBe(0);
}, 20_000);

it('a fenced candidate on the single configured model does not defer the rest of the tick (D1)', async () => {
  mocks.settings = { ...mocks.settings!, reviewConcurrency: 1, firstReviewAdditional: undefined };
  mocks.list.mockResolvedValue(candidates(3));
  ledger.fenced.add(1);
  const ctx = context();
  const result = await reviewCrawlCandidates(ctx);
  expect(result).not.toHaveProperty('deferred');
  expect(mocks.gatewayCalls).toEqual(['model-a', 'model-a']);
  expect(tickSummary(ctx.log)).toMatchObject({ modelDeferred: false });
}, 20_000);

it('true saturation (a queued row) still pauses that model for the tick while the other model keeps working', async () => {
  mocks.blocked.mockResolvedValue(new Set([firstReviewerKey(primary)]));
  mocks.settings = { ...mocks.settings!, reviewConcurrency: 1 };
  mocks.list.mockResolvedValue(candidates(4));
  const release = foreignHolder('model-a');
  const ctx = context();
  try { expect(await reviewCrawlCandidates(ctx)).toEqual({ done: false, deferred: 'model_capacity' }); }
  finally { release(); }
  expect(mocks.gatewayCalls).toEqual(['model-b', 'model-b']);
  expect(tickSummary(ctx.log)).toMatchObject({ pausedModels: 1 });
}, 20_000);
