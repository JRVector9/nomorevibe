import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryScans, crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, secondReviews } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { reconcileStaleSecondReviews } from '@/lib/crawl/second-review';
import { STALE_REVIEW_OWNER } from '@/lib/crawl/second-review-stale';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { ensureSchema } from './setup';
import { enqueueSecondReviewsFixture as enqueue, withLegacySecondReviewJob } from './second-review-receipt-fixtures';

/**
 * 오래된 AI2 대기 정리(2026-10-29) — 운영 138985/357316 모양: 관문 표(ai_approved)가 남은 채 후보가 갈림 보류가 아닌
 * needs_review 로 내려갔다. 예전에는 stale 힌트(승인만)와 closeSettled(needs_review 는 사람 대기) 어느 쪽도 집지 않았다.
 */
const PREFIX = 'ai2-stale/';
const hours = (count: number) => new Date(Date.now() - count * 3_600_000);

beforeAll(() => ensureSchema());
async function clean() {
  await db.delete(agentRepositoryScans).where(like(agentRepositoryScans.repositoryKey, `${PREFIX}%`));
  await db.delete(crawlFrontier).where(like(crawlFrontier.repo, `${PREFIX}%`));
}
afterAll(clean);
beforeEach(async () => {
  await clean();
  for (const table of [secondReviews, jobs, crawlReviewAttempts, crawlCandidates, crawlDocuments, crawlSettings]) await db.delete(table);
  await saveSettings({ enabled: true, reviewMode: 'enforce', firstReview: { provider: 'claude-cli', model: 'sonnet' },
    secondReview: { enabled: true, voters: [{ provider: 'claude-cli', model: 'opus' }], includeAiHeld: false, sampleRate: 0, agreeAt: 0.85 } }, 'fixture');
  // 심사 방식은 설정 저장이 바꾸지 않는다 — 다른 관문 시험처럼 저장된 값에 직접 둔다
  const [saved] = await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
  await db.update(crawlSettings).set({ values: { ...(saved.values as object), reviewMode: 'enforce' } }).where(eq(crawlSettings.id, 1));
});

/** 1차 AI 가 승인한 자동 후보, 신선한 원본·스캔, 관문 대기 표 하나 */
async function gateFixture(name: string) {
  const repo = `${PREFIX}${name}`, productUrl = `https://ai2-stale-${name}.test`;
  await crawl.putDocument({ repo, productUrl, pageStatus: 200,
    repoMeta: { description: '배포한 서비스', stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: 'User' } },
    pageMeta: { title: 'Taskly', textSample: '쓸 수 있는 앱' } });
  await crawl.recordJudgement({ repo, productUrl, state: 'approved', reason: 'passed', decidedBy: 'auto' });
  const settings = await getSettings();
  expect(settings.reviewMode).toBe('enforce');
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  const [scan] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(200_000_000 + candidate.id),
    repositoryKey: repo, commitSha: 'a'.repeat(40), detectorVersion: settings.agentEvidence.detectorVersion,
    scope: '', scopeHash: 'a'.repeat(64), state: 'complete', startedAt: hours(1), completedAt: hours(1), nextAttemptAt: hours(-23) }).returning();
  const first = await firstReview(candidate.id, 'approve', 0.9);
  expect(await enqueue(settings)).toBe(1);
  const [vote] = await db.select().from(secondReviews).where(eq(secondReviews.candidateId, candidate.id));
  expect(vote).toMatchObject({ trigger: 'ai_approved', status: 'pending', firstAttemptId: first.id });
  return { candidate, scan, first, vote };
}

async function firstReview(candidateId: number, decision: 'approve' | 'reject' | 'needs_review', confidence: number | null) {
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidateId));
  const input = await loadReviewInput(candidate, (await crawl.getDocument(candidate.repo))!, await getSettings());
  const [attempt] = await db.insert(crawlReviewAttempts).values({
    candidateId, kind: 'automatic', state: 'succeeded', attemptNumber: 1,
    inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: 'claude-cli', model: 'sonnet', startedAt: new Date(), completedAt: new Date(), validUntil: input.validUntil,
    outcome: confidence === null ? { decision, reason: '사유', evidenceIds: ['product'] } : { decision, reason: '사유', evidenceIds: ['product'], confidence },
  }).returning();
  return attempt;
}

const reconcile = () => withLegacySecondReviewJob(lease => reconcileStaleSecondReviews(undefined, lease));
const votes = (candidateId: number) => db.select().from(secondReviews).where(eq(secondReviews.candidateId, candidateId)).orderBy(secondReviews.id);
const demote = (candidateId: number, reason: 'ambiguous' | 'second_review_split' = 'ambiguous') =>
  db.update(crawlCandidates).set({ state: 'needs_review', reason }).where(eq(crawlCandidates.id, candidateId));

it('closes a gate vote stranded on a non-split hold and re-enqueues the current first verdict exactly once', async () => {
  const { candidate, vote, first } = await gateFixture('requeue');
  await demote(candidate.id);
  expect(await reconcile()).toBeGreaterThan(0);
  const rows = await votes(candidate.id);
  expect(rows.map(row => [row.trigger, row.status, row.resolution, row.resolvedBy])).toEqual([
    ['ai_approved', 'resolved', 'superseded', STALE_REVIEW_OWNER],
    ['ai_decided', 'pending', null, null],
  ]);
  expect(rows[1]).toMatchObject({ firstAttemptId: first.id, model: 'opus', firstDecision: 'approve' });
  expect(rows[1].generationKey).not.toBe(vote.generationKey);
  // 다시 돌아도 같은 항목을 또 넣지 않는다
  expect(await reconcile()).toBe(0);
  expect(await votes(candidate.id)).toEqual(rows);
});

it('retires the stranded gate demand when the current first verdict no longer calls for AI2', async () => {
  const { candidate } = await gateFixture('retire');
  await demote(candidate.id);
  await firstReview(candidate.id, 'needs_review', null);
  expect(await reconcile()).toBeGreaterThan(0);
  const rows = await votes(candidate.id);
  expect(rows.map(row => [row.status, row.resolution, row.resolvedBy])).toEqual([['resolved', 'not_required', STALE_REVIEW_OWNER]]);
  expect(await reconcile()).toBe(0);
});

it('leaves a gate vote on a human split hold untouched', async () => {
  const { candidate, vote } = await gateFixture('split');
  await demote(candidate.id, 'second_review_split');
  expect(await reconcile()).toBe(0);
  expect(await votes(candidate.id)).toEqual([vote]);
});

it('keeps demand and requests a source refresh when the new input is not yet available', async () => {
  const { candidate } = await gateFixture('refresh');
  await demote(candidate.id);
  await db.update(crawlDocuments).set({ fetchedAt: hours(48) }).where(eq(crawlDocuments.repo, candidate.repo));
  expect(await reconcile()).toBeGreaterThan(0);
  const rows = await votes(candidate.id);
  expect(rows.map(row => [row.status, row.resolution])).toEqual([['resolved', 'superseded']]);
  expect((await db.select().from(crawlFrontier).where(eq(crawlFrontier.repo, candidate.repo)))[0].state).toBe('pending');
  // 갱신을 기다리는 동안은 아무것도 바꾸지 않는다(쿨다운·이미 대기 중인 frontier)
  expect(await reconcile()).toBe(0);
  expect(await votes(candidate.id)).toEqual(rows);
});
