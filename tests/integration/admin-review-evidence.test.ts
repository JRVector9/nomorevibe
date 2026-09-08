import { beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { candidateRevisionHash, requestCandidateEvidence, requeueAfterAdminEvidenceRefresh } from '@/lib/crawl/admin-review';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { ensureSchema } from './setup';
const repo = 'admin-fixture/product';
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await saveSettings({ enabled: true, agentEvidence: { enabled: true } }, 'fixture');
  await crawl.putDocument({ repo, repoMeta: { description: 'A deployed product' }, productUrl: 'https://admin-fixture.test',
    pageMeta: { title: 'Product', description: 'A deployed product', repositoryKeys: [repo] }, pageStatus: 200 });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 3_600_000) }).where(eq(crawlDocuments.repo, repo));
  await crawl.recordJudgement({ repo, productUrl: 'https://admin-fixture.test', state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto' });
});
async function requestInput() {
  const candidate = (await crawl.getCandidate(repo))!;
  const input = await loadReviewInput(candidate, (await crawl.getDocument(repo))!, await getSettings());
  return { repo, actor: 'jr', reason: '공개 근거 재확인', inputHash: input.inputHash,
    sourceRevisionHash: input.sourceRevisionHash, candidateRevisionHash: candidateRevisionHash(candidate) };
}
async function completedCollection(minutesAgo: number) {
  await crawl.markFrontier(repo, 'done');
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - minutesAgo * 60_000) }).where(eq(crawlDocuments.repo, repo));
  await db.update(crawlReviewAttempts).set({ startedAt: new Date(Date.now() - 20 * 60_000) }).where(eq(crawlReviewAttempts.kind, 'evidence_refresh'));
}
it('accepts a durable request once and enforces cooldown, source change and two requests per semantic input', async () => {
  const first = await requestInput();
  expect(await requestCandidateEvidence(first)).toMatchObject({ ok: true });
  expect(await requestCandidateEvidence(first)).toMatchObject({ ok: false });
  await completedCollection(30);
  const second = await requestInput();
  expect(second.inputHash).toBe(first.inputHash);
  expect(await requestCandidateEvidence(second)).toMatchObject({ ok: true });
  await completedCollection(10);
  expect(await requestCandidateEvidence(await requestInput())).toMatchObject({ ok: false });
  const audit = await db.select().from(crawlReviewAttempts);
  expect(audit).toHaveLength(2);
  expect(audit.every(row => row.kind === 'evidence_refresh' && row.actor === 'jr')).toBe(true);
});
it('rejudges only after a source changes and consumes each accepted request once', async () => {
  expect(await requestCandidateEvidence(await requestInput())).toMatchObject({ ok: true });
  expect(await requeueAfterAdminEvidenceRefresh(repo)).toBe(false);
  await completedCollection(30);
  expect(await requeueAfterAdminEvidenceRefresh(repo)).toBe(true);
  const candidate = (await crawl.getCandidate(repo))!;
  expect(candidate.state).toBe('new');
  expect(candidate.signals?.adminEvidenceRefreshConsumedId).toBeTypeOf('number');
  // Even a rule result with the same millisecond judgedAt must not consume this request again.
  await db.update(crawlCandidates).set({ state: 'needs_review', reason: 'ambiguous' }).where(eq(crawlCandidates.repo, repo));
  expect(await requeueAfterAdminEvidenceRefresh(repo)).toBe(false);
});
it('preserves a newer administrator decision when requested evidence finishes', async () => {
  expect(await requestCandidateEvidence(await requestInput())).toMatchObject({ ok: true });
  await completedCollection(30);
  await db.update(crawlCandidates).set({ decidedBy: 'admin', state: 'rejected' }).where(eq(crawlCandidates.repo, repo));
  expect(await requeueAfterAdminEvidenceRefresh(repo)).toBe(false);
  expect((await crawl.getCandidate(repo))?.state).toBe('rejected');
});
