import { randomUUID } from 'node:crypto';
import { beforeEach, expect, it, vi } from 'vitest';
import { createReviewInput } from '@/lib/crawl/agent-review-contract';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import type { CrawlCandidate, CrawlDocument } from '@/lib/db/schema';
import { ModelCapacityDeferredError } from '@/lib/llm/capacity-deferred';

/*
 * AI1 legacy job 의 CLI 분기(05c-4)만 본다: 되감은 fresh claim 이 CLI 심사자면 CLI coordinator 로, 아니면 기존 gateway 로 간다.
 * coordinator·장부·claim 은 경계 mock 이다(실제 경로는 coordinator 단위 시험과 실제 DB driver 가 본다).
 */
const mocks = vi.hoisted(() => ({ settings: null as CrawlSettings | null, list: vi.fn(), document: vi.fn(), input: vi.fn(), claim: vi.fn(),
  record: vi.fn(), gatewayClaim: vi.fn(), gatewayReview: vi.fn(), gatewayAbandon: vi.fn(), cliClaim: vi.fn(), cliReview: vi.fn(), cliAbandon: vi.fn(),
  legacyCli: vi.fn(), legacyGrok: vi.fn(), budget: vi.fn() }));
vi.mock('@/lib/crawl/settings', () => ({ getSettings: async () => mocks.settings }));
vi.mock('@/lib/crawl/repository', () => ({ getDocument: mocks.document, setReadmeSample: vi.fn(), holdSuspectedSpam: vi.fn() }));
vi.mock('@/lib/crawl/readme', () => ({ fetchReadmeSample: async () => '', README_SAMPLE_LIMIT: 3000, README_SAMPLE_VERSION: '2026-09-14.1' }));
vi.mock('@/lib/domain/products/repository', () => ({ findRepositoryProduct: async () => null }));
vi.mock('@/lib/crawl/agent-review-repository', () => ({ canStartLegacyAgentReview: async () => true,
  requeueStaleReviewSources: async () => 0, handOffExhaustedFirstReviews: async () => 0,
  listReviewCandidates: mocks.list, loadReviewInput: mocks.input, claimAgentReview: mocks.claim, recordAgentReview: mocks.record }));
vi.mock('@/lib/crawl/agent-review-model-capacity', () => ({ claimAgentReviewModelCapacity: mocks.gatewayClaim,
  reviewAgentReviewModelCapacity: mocks.gatewayReview, abandonAgentReviewModelCapacity: mocks.gatewayAbandon }));
vi.mock('@/lib/crawl/review-cli-model-capacity', () => ({ claimAgentReviewCliModelCapacity: mocks.cliClaim,
  reviewCliModelCapacity: mocks.cliReview, abandonCliModelCapacity: mocks.cliAbandon }));
vi.mock('@/lib/crawl/agent-review', () => ({ firstReviewer: (s: CrawlSettings) => s.firstReview,
  reviewWithAgent: mocks.legacyCli, REVIEW_CLI_TIMEOUT_MS: 20_000 }));
vi.mock('@/lib/crawl/agent-review-gateway', () => ({ reviewWithGateway: vi.fn(), REVIEW_GATEWAY_TIMEOUT_MS: 60_000 }));
vi.mock('@/lib/crawl/agent-review-grok', () => ({ reviewWithGrokCli: mocks.legacyGrok, GROK_REVIEW_TIMEOUT_MS: 90_000 }));
import { reviewCrawlCandidates } from '@/lib/crawl/jobs/agent-review';

const lease = { name: 'crawl-agent-review', token: randomUUID(), requestedVersion: 4 };
const outcome = { decision: 'approve', reason: 'Deployed task tracker', evidenceIds: ['product'] };
const receipt = { attemptId: 1, origin: 'fresh', ownership: { kind: 'legacy', stageEpoch: 1, job: lease } };
const dispatch = Object.freeze({ fixture: 'opaque-cli-dispatch' }), call = Object.freeze({ fixture: 'opaque-cli-call' });
const claimed = () => ({ claim: { kind: 'claimed', attempt: { id: 1, attemptNumber: 2 }, receipt, dispatch }, call });
const context = (signal?: AbortSignal) => ({ cursor: null, lease, signal, hasBudget: mocks.budget, save: vi.fn(), log: vi.fn() });
beforeEach(() => {
  vi.resetAllMocks();
  const now = new Date();
  const candidate = { id: 1, repo: 'cli-job/app', productUrl: 'https://cli-job.example', state: 'approved', decidedBy: 'auto', judgedAt: now, updatedAt: now } as CrawlCandidate;
  const document = { id: 1, repo: candidate.repo, productUrl: candidate.productUrl, pageStatus: 200,
    repoMeta: { description: 'Task tracker', homepage: candidate.productUrl, pushed_at: now.toISOString(), stargazers_count: 0, owner: { type: 'User' } },
    pageMeta: { title: 'Tracker' }, fetchedAt: now } as CrawlDocument;
  mocks.list.mockResolvedValue([candidate]); mocks.document.mockResolvedValue(document);
  mocks.input.mockImplementation(async (c, d, s) => createReviewInput(c, d, s, { scan: null, observations: [] }));
  mocks.budget.mockReturnValue(true);
  mocks.claim.mockRejectedValue(new ModelCapacityDeferredError('reservation_required'));
  mocks.cliClaim.mockResolvedValue(claimed()); mocks.cliReview.mockResolvedValue({ ok: true, outcome, usage: {} });
  mocks.record.mockResolvedValue({ applied: true, state: 'succeeded' });
});
const settings = (provider: 'claude-cli' | 'grok-cli') => ({ ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: 'observe' as const,
  reviewConcurrency: 1, firstReview: { provider, model: 'fake-model' } });

it.each([['claude-cli', 20_000], ['grok-cli', 90_000]] as const)('%s 의 되감은 fresh claim 은 CLI coordinator 로 가고, 정산된 결과를 기존 writer 가 적는다', async (provider, timeoutMs) => {
  mocks.settings = settings(provider);
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false });
  expect(mocks.cliClaim).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ lease, provider, model: 'fake-model', timeoutMs }));
  expect(mocks.cliReview).toHaveBeenCalledExactlyOnceWith(expect.anything(), dispatch, call, { signal: expect.any(AbortSignal) });
  expect(mocks.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ receipt, outcome }));
  for (const mock of [mocks.gatewayClaim, mocks.gatewayReview, mocks.legacyCli, mocks.legacyGrok, mocks.cliAbandon]) expect(mock).not.toHaveBeenCalled();
});

it('CLI 실패 결과는 기존과 같은 backoff 로 적는다(재시도 규칙 불변)', async () => {
  mocks.settings = settings('claude-cli'); mocks.cliReview.mockResolvedValue({ ok: false, error: 'timeout' });
  const started = Date.now();
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false });
  const written = mocks.record.mock.calls[0][0];
  expect(written).toMatchObject({ receipt, error: 'timeout' });
  // attemptNumber 2 → 60s·2^(2-1) = 120s
  expect(written.retryAfter.getTime() - started).toBeGreaterThanOrEqual(120_000 - 50);
  expect(written.retryAfter.getTime() - started).toBeLessThan(120_000 + 5_000);
});

it('슬롯 대기는 attempt·결과 기록 없이 model_capacity 로 미룬다', async () => {
  mocks.settings = settings('grok-cli'); mocks.cliClaim.mockRejectedValue(new ModelCapacityDeferredError('capacity'));
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false, deferred: 'model_capacity' });
  for (const mock of [mocks.cliReview, mocks.record, mocks.gatewayClaim, mocks.legacyGrok]) expect(mock).not.toHaveBeenCalled();
});

it('슬롯을 얻은 뒤 틱 여유가 없으면 spawn 하지 않고 not_started 로 버린 뒤 기존 cancelled+60s 를 적는다', async () => {
  mocks.settings = settings('claude-cli');
  let calls = 0;
  mocks.cliClaim.mockImplementation(async () => { calls = 1; return claimed(); });
  mocks.budget.mockImplementation(() => calls === 0);
  const started = Date.now();
  expect(await reviewCrawlCandidates(context())).toEqual({ done: false });
  expect(mocks.cliAbandon).toHaveBeenCalledExactlyOnceWith(dispatch, call);
  expect(mocks.cliReview).not.toHaveBeenCalled(); expect(mocks.gatewayAbandon).not.toHaveBeenCalled();
  const written = mocks.record.mock.calls[0][0];
  expect(written).toMatchObject({ receipt, error: 'cancelled' });
  expect(written.retryAfter.getTime() - started).toBeGreaterThanOrEqual(60_000 - 50);
  expect(written.retryAfter.getTime() - started).toBeLessThan(65_000);
});

it('CLI 정산은 호출자 abort 로 업무 결과가 cancelled 로 바뀌기 전에 끝난다', async () => {
  mocks.settings = settings('claude-cli');
  const controller = new AbortController(), order: string[] = [];
  mocks.cliReview.mockImplementation(async () => { order.push('physical_terminal_settled'); controller.abort(); return { ok: true, outcome, usage: {} }; });
  mocks.record.mockImplementation(async value => { order.push(value.error); return { applied: false, state: 'failed' }; });
  expect(await reviewCrawlCandidates(context(controller.signal))).toEqual({ done: false });
  expect(order).toEqual(['physical_terminal_settled', 'cancelled']);
});
