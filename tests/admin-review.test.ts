import { expect, it } from 'vitest';
import { adminReviewRequestSchema, candidateRevisionHash, currentReviewStatus } from '@/lib/crawl/admin-review';
import type { CrawlCandidate, CrawlReviewAttempt } from '@/lib/db/schema';
import type { ReviewInput } from '@/lib/crawl/agent-review-contract';
const now = new Date('2026-09-08T00:00:00Z');
const input = { inputHash: 'a'.repeat(64), sourceRevisionHash: 'b'.repeat(64) } as ReviewInput;
const attempt = (id: number, patch: Partial<CrawlReviewAttempt> = {}) => ({
  id, kind: 'automatic', inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
  state: 'failed', validUntil: new Date(now.getTime() + 60_000), ...patch,
}) as CrawlReviewAttempt;
it('requires nonblank bounded reasons and all stale-input guards', () => {
  const valid = { repo: 'acme/product', actor: 'jr', reason: '제품과 근거 확인', inputHash: input.inputHash,
    sourceRevisionHash: input.sourceRevisionHash, candidateRevisionHash: 'c'.repeat(64) };
  expect(adminReviewRequestSchema.safeParse(valid).success).toBe(true);
  expect(adminReviewRequestSchema.safeParse({ ...valid, reason: ' ' }).success).toBe(false);
  expect(adminReviewRequestSchema.safeParse({ ...valid, reason: 'a'.repeat(2001) }).success).toBe(false);
  expect(adminReviewRequestSchema.safeParse({ ...valid, candidateRevisionHash: undefined }).success).toBe(false);
});
it('distinguishes failed, exhausted, running and fresh successful review without counting duplicate rows', () => {
  expect(currentReviewStatus(input, [], now)).toBe('unreviewed');
  expect(currentReviewStatus(input, [attempt(1), attempt(2), attempt(2)], now)).toBe('failed');
  expect(currentReviewStatus(input, [attempt(1), attempt(2), attempt(3)], now)).toBe('exhausted');
  expect(currentReviewStatus(input, [attempt(1, { state: 'running' })], now)).toBe('running');
  expect(currentReviewStatus(input, [attempt(1, { state: 'succeeded' })], now)).toBe('succeeded');
});
it('never labels an old approval or human audit as a current AI success', () => {
  expect(currentReviewStatus(input, [attempt(1, { state: 'succeeded', sourceRevisionHash: 'd'.repeat(64) })], now)).toBe('outdated');
  expect(currentReviewStatus(input, [attempt(1, { state: 'succeeded', validUntil: new Date(now.getTime() - 1) })], now)).toBe('outdated');
  expect(currentReviewStatus(input, [attempt(1, { kind: 'admin_override', state: 'succeeded' })], now)).toBe('unreviewed');
});
it('changes the candidate guard when another admin decides on the same underlying evidence', () => {
  const candidate = { id: 1, repo: 'acme/product', state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto',
    productUrl: 'https://product.test', publishedSlug: null, signals: {}, judgedAt: now, decidedAt: null, updatedAt: now } as CrawlCandidate;
  expect(candidateRevisionHash(candidate)).not.toBe(candidateRevisionHash({ ...candidate, state: 'approved', decidedBy: 'admin' }));
  expect(candidateRevisionHash(candidate)).not.toBe(candidateRevisionHash({ ...candidate, signals: { adminReviewAttemptId: 1 } }));
});
