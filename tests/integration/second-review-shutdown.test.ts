import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, secondReviews } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { secondReviewCandidates } from '@/lib/crawl/jobs/second-review';
import { getJobState, runJob } from '@/lib/jobs/runner';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { ensureSchema } from './setup';

beforeAll(() => ensureSchema());
beforeEach(async () => {
  for (const table of [secondReviews, crawlReviewAttempts, crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, jobs]) await db.delete(table);
  await saveSettings({ enabled: true, secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }] } }, 'fixture');
});

/**
 * 응답하지 않는 abcllm 투표자 — 끊길 때까지 기다린다.
 * 호출이 들어온 순간을 알려 준다: 시각에 기대지 않고 그때 종료 신호를 준다.
 * 게이트웨이(abcLLM)는 2026-10-30 제거돼 진짜 옛 잎(reviewWithGateway)은 엔진 주소 없이는 보내지 않고 not_configured 로 끝난다.
 * 이 파일은 종료 신호가 진행 중인 호출을 끊는지를 보므로, 그 잎만 끊길 때까지 기다리는 대역으로 바꾼다(pipeline-consumer 와 같은 방식).
 */
const hang = vi.hoisted(() => { let calling: () => void = () => {}; const firstCall = new Promise<void>(resolve => { calling = resolve; });
  return { firstCall, called: () => calling() }; });
vi.mock('@/lib/crawl/agent-review-gateway', async load => {
  const original = await load<typeof import('@/lib/crawl/agent-review-gateway')>();
  const reviewWithGateway: typeof original.reviewWithGateway = (_input, options) => new Promise(resolve => {
    hang.called();
    options.signal?.addEventListener('abort', () => resolve({ ok: false, error: 'cancelled' }), { once: true });
  });
  return { ...original, reviewWithGateway };
});
const firstCall = hang.firstCall;

it('배포로 멈출 때 진행 중인 호출을 끊고, 잠금을 놓아 다음 회차가 곧바로 집는다', async () => {
  await crawl.putDocument({ repo: 'acme/stopping', productUrl: 'https://stopping.test', pageStatus: 200,
    repoMeta: { description: '서비스', stargazers_count: 2, pushed_at: new Date().toISOString(), owner: { type: 'User' } },
    pageMeta: { title: '제품', textSample: '쓸 수 있는 앱' } });
  await crawl.recordJudgement({ repo: 'acme/stopping', productUrl: 'https://stopping.test', state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto' });
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, 'acme/stopping'));
  const settings = await getSettings();
  const input = await loadReviewInput(candidate, (await crawl.getDocument('acme/stopping'))!, settings);
  await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: 'automatic', state: 'succeeded', attemptNumber: 1,
    inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: 'claude-cli', model: 'sonnet', startedAt: new Date(), completedAt: new Date(), validUntil: input.validUntil,
    outcome: { decision: 'reject', reason: '문서 사이트', evidenceIds: ['product'], confidence: 0.9 } });

  const stopping = new AbortController();
  const run = runJob('second-review', secondReviewCandidates, { budgetMs: 110_000, signal: stopping.signal });
  // 게이트웨이 호출이 들어간 것을 확인한 뒤 종료 신호를 준다
  await firstCall;
  const started = Date.now();
  stopping.abort();
  const result = await run;

  // 60초 상한을 기다리지 않고 곧바로 나온다
  expect(Date.now() - started).toBeLessThan(5_000);
  expect(result.status).toBe('completed');
  const state = await getJobState('second-review');
  expect(state?.lockedAt).toBeNull();

  // 끊긴 표는 실패가 아니라 대기로 남아 다음 회차가 처음부터 본다
  const [row] = await db.select().from(secondReviews);
  expect(row).toMatchObject({ status: 'pending', errorCode: null });
});
