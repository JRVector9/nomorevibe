import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createReviewInput } from '@/lib/crawl/agent-review-contract';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import type { CrawlCandidate, CrawlDocument } from '@/lib/db/schema';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';
import { firstReviewers, selectFirstReviewer } from '@/lib/crawl/first-reviewers';
import { pinReviewRanks, pinReviewRanksFromSettings } from './review-task-ranks-fixture';

/**
 * F2 결함 1·2 의 AI1 job 경로(mock 경계, tests/agent-review-model-capacity.test.ts 와 같은 고정 mock).
 * - 슬롯을 얻은 뒤 틱 여유가 없으면 준비 호출과 함께 포기해 not_started 정산을 맡긴다.
 * - 한 후보의 'dispatched' 미룸은 그 후보만 건너뛴다(목록 맨 앞 고착 방지). 다른 미룸은 지금처럼 틱을 미룬다.
 * - native 계약 위반 결과의 detail 을 결과 기록기에 넘긴다.
 */
const mocks = vi.hoisted(() => ({ settings: null as CrawlSettings | null, list: vi.fn(), document: vi.fn(), input: vi.fn(),
  claim: vi.fn(), record: vi.fn(), resume: vi.fn(), reservedReview: vi.fn(), abandon: vi.fn(), gateway: vi.fn(), choose: vi.fn() }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => mocks.settings }));
vi.mock('@/lib/crawl/repository', () => ({ getDocument: mocks.document, setReadmeSample: vi.fn() }));
vi.mock('@/lib/crawl/readme', () => ({ fetchReadmeSample: async () => '', README_SAMPLE_LIMIT: 3000, README_SAMPLE_VERSION: '2026-09-14.1' }));
vi.mock('@/lib/domain/products/repository', () => ({ findRepositoryProduct: async () => null }));
// 1차 잡은 늘 순위 고르기다(PR C1): 자기 대기 행·풀 쪽(keyset)·후보별 고르기·막힌 모델 읽기를 경계 mock 으로 둔다
vi.mock('@/lib/crawl/agent-review-repository', () => ({ canStartLegacyAgentReview: async () => true,
  requeueStaleReviewSources: async () => 0, handOffExhaustedFirstReviews: async () => 0,
  listOwnPendingFirstReviewCandidates: async () => [],
  listFirstReviewPoolCandidates: async (settings: CrawlSettings, limit: number) => ((await mocks.list(settings, limit)) as CrawlCandidate[]).map(candidate =>
    ({ candidate, position: { id: candidate.id, reviewed: false, updatedAt: '2026-10-27 00:00:00.000001', ceiling: 1000 } })),
  chooseFirstReviewForCandidate: mocks.choose,
  listReviewCandidates: mocks.list, loadReviewInput: mocks.input, claimAgentReview: mocks.claim, recordAgentReview: mocks.record }));
vi.mock('@/lib/crawl/first-reviewer-blocks', () => ({ readBlockedFirstReviewerKeys: async () => new Set<string>() }));
vi.mock('@/lib/crawl/agent-review-model-capacity', () => ({ claimAgentReviewModelCapacity: mocks.resume,
  reviewAgentReviewModelCapacity: mocks.reservedReview, abandonAgentReviewModelCapacity: mocks.abandon }));
vi.mock('@/lib/crawl/agent-review', () => ({ firstReviewer: (s: CrawlSettings) => s.firstReview, reviewWithAgent: vi.fn(), REVIEW_CLI_TIMEOUT_MS: 20_000, reviewCliTimeoutMs: () => 20_000, reviewCliMaxOutputTokens: () => 2_000 }));
vi.mock('@/lib/crawl/agent-review-gateway', () => ({ reviewWithGateway: mocks.gateway, REVIEW_GATEWAY_TIMEOUT_MS: 60_000, reviewGatewayTimeoutMs: () => 60_000 }));
vi.mock('@/lib/crawl/agent-review-grok', () => ({ reviewWithGrokCli: vi.fn(), GROK_REVIEW_TIMEOUT_MS: 90_000, grokReviewTimeoutMs: () => 90_000 }));
import { reviewCrawlCandidates } from '@/lib/crawl/jobs/agent-review';

const lease = { name: 'crawl-agent-review', token: randomUUID(), requestedVersion: 4 };
const outcome = { decision: 'approve', reason: 'Deployed task tracker', evidenceIds: ['product'] };
const receipt = { attemptId: 1, origin: 'fresh', ownership: { kind: 'legacy', stageEpoch: 1, job: lease } };
const dispatch = Object.freeze({ fixture: 'opaque-dispatch-boundary' }), call = Object.freeze({ fixture: 'opaque-prepared-boundary' });
const positive = () => ({ claim: { kind: 'claimed', attempt: { id: 1, attemptNumber: 1 }, receipt, dispatch }, call });
const reservationRequired = () => Reflect.construct(ModelCapacityDeferredError, ['reservation_required']) as ModelCapacityDeferredError;
let budget = true;
const log = vi.fn();
const context = () => ({ cursor: null, lease, signal: undefined, hasBudget: () => budget, save: vi.fn(), log });
function candidate(id: number) {
  const now = new Date();
  return { id, repo: `f2-job/app-${id}`, productUrl: `https://f2-${id}.example`, state: 'approved', decidedBy: 'auto',
    judgedAt: now, updatedAt: now } as CrawlCandidate;
}
beforeEach(() => {
  vi.resetAllMocks(); budget = true;
  mocks.settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'observe', reviewConcurrency: 1,
    firstReview: { provider: 'abcllm', model: 'Exact Model' } };
  mocks.list.mockResolvedValue([candidate(1), candidate(2)]);
  mocks.document.mockImplementation(async (repo: string) => ({ id: 1, repo, productUrl: `https://${repo.split('/')[1]}.example`,
    pageStatus: 200, repoMeta: { description: 'Task tracker', pushed_at: new Date().toISOString(), stargazers_count: 0, owner: { type: 'User' } },
    pageMeta: { title: 'Tracker' }, fetchedAt: new Date() } as CrawlDocument));
  mocks.input.mockImplementation(async (c, d, s) => createReviewInput(c, d, s, { scan: null, observations: [] }));
  mocks.claim.mockRejectedValue(reservationRequired());
  mocks.reservedReview.mockResolvedValue({ ok: true, outcome, usage: {} });
  mocks.record.mockResolvedValue({ applied: false, state: 'succeeded' });
  mocks.choose.mockImplementation(async ({ candidate }, _executor, blocked) =>
    selectFirstReviewer(firstReviewers(), candidate.id, [], [], { blocked: blocked ?? new Set() }));
  // 1차 심사자는 「작업 ↔ 모델」 순위뿐이다 — 시험 설정의 firstReview 를 1순위로 고정한다
  pinReviewRanksFromSettings(() => mocks.settings);
});
afterEach(() => pinReviewRanks(null));

it('abandons a committed dispatch with its unused preparation when the tick has no room after the claim', async () => {
  mocks.list.mockResolvedValue([candidate(1)]);
  mocks.resume.mockImplementation(async () => { budget = false; return positive(); });
  const started = Date.now();
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false });
  expect(mocks.abandon).toHaveBeenCalledExactlyOnceWith(dispatch, call);
  expect(mocks.reservedReview).not.toHaveBeenCalled();
  const written = mocks.record.mock.calls[0][0];
  expect(written).toMatchObject({ receipt, error: 'cancelled' });
  expect(written.retryAfter.getTime() - started).toBeGreaterThanOrEqual(60_000 - 50);
});

it('skips only the candidate whose earlier call is still dispatched and keeps reviewing the rest of the tick', async () => {
  mocks.resume.mockRejectedValueOnce(Reflect.construct(ModelCapacityDeferredError, ['dispatched'])).mockResolvedValueOnce(positive());
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false });
  expect(mocks.resume.mock.calls.map(([value]) => value.candidate.id)).toEqual([1, 2]);
  expect(mocks.reservedReview).toHaveBeenCalledTimes(1);
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ receipt, outcome }));
  expect(log).toHaveBeenCalledWith('crawl.agent_review_skipped', { repo: 'f2-job/app-1', reason: 'dispatched' });
  expect(log).not.toHaveBeenCalledWith('crawl.agent_review_deferred', expect.anything());
});

it('still defers the whole tick for a shared capacity refusal', async () => {
  mocks.resume.mockRejectedValue(Reflect.construct(ModelCapacityDeferredError, ['capacity']));
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false, deferred: 'model_capacity' });
  expect(mocks.resume).toHaveBeenCalledTimes(1); expect(mocks.record).not.toHaveBeenCalled();
});

it('hands the native contract diagnostic to the result writer', async () => {
  mocks.list.mockResolvedValue([candidate(1)]); mocks.resume.mockResolvedValue(positive());
  mocks.reservedReview.mockResolvedValue({ ok: false, error: 'invalid_output', detail: 'invalid_native_terminal' });
  mocks.record.mockResolvedValue({ applied: false, state: 'failed' });
  // 실패한 호출은 그 모델을 이 틱 동안 쉬게 한다(늘 순위 고르기, PR C1) — 남긴 심사가 없으니 미룸으로 끝난다
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false, deferred: 'model_capacity' });
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ receipt, error: 'invalid_output', detail: 'invalid_native_terminal' }));
});
