import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, secondReviews } from '@/lib/db/schema';
import { dbErrorTag } from '@/lib/db/error-fields';
import { claimHumanReview, deferHumanReviewBeforeTransport, recordHumanReview, type HumanReviewClaim } from '@/lib/crawl/human-review-repository';
import { getSettings, saveSettings, setHumanReviewEnabled } from '@/lib/crawl/settings';
import { judgeRevision } from '@/lib/crawl/rules';
import { JobLeaseLostError, type JobLease } from '@/lib/jobs/control';
import { runJob } from '@/lib/jobs/runner';
import { ensureSchema, resetTables } from './setup';

const JOB = 'human-deepseek-review';
beforeAll(() => ensureSchema());
async function clear() {
  await db.delete(secondReviews); await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlFrontier);
}
afterAll(clear);
beforeEach(async () => {
  await clear(); await db.delete(crawlSettings); await db.delete(jobs); await resetTables();
  await saveSettings({ enabled: true, firstReview: { provider: 'claude-cli', model: 'test-model' } }, 'test');
  expect(await setHumanReviewEnabled({ enabled: true, expectedGeneration: (await getSettings()).humanReview.generation,
    actor: 'test' })).toMatchObject({ ok: true });
});

async function held() {
  const repo = 'human-infrastructure/app', productUrl = 'https://human-infrastructure.example.test', now = new Date();
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: 'A practical application for daily work', stargazers_count: 3,
      pushed_at: now.toISOString(), owner: { type: 'User' } },
    pageMeta: { title: 'Infrastructure App', description: 'A practical application for daily work', repositoryKeys: [repo] } }).returning();
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl, state: 'needs_review',
    reason: 'second_review_split', decidedBy: 'auto', judgedAt: now, updatedAt: now,
    signals: { judgedRevision: judgeRevision(document) } }).returning();
  return candidate;
}
async function withJob<T>(work: (lease: JobLease) => Promise<T>): Promise<T> {
  let value!: T;
  const result = await runJob<null>(JOB, async ctx => { value = await work(ctx.lease!); return { done: true }; });
  expect(result.status).toBe('completed');
  return value;
}
const history = (candidateId: number) => db.select().from(crawlReviewAttempts)
  .where(and(eq(crawlReviewAttempts.candidateId, candidateId), eq(crawlReviewAttempts.kind, 'delegated')))
  .orderBy(crawlReviewAttempts.id);
async function claim(repo: string, lease: JobLease): Promise<HumanReviewClaim> {
  const value = await claimHumanReview(repo, lease);
  expect(value).not.toBeNull();
  return value!;
}
async function makeDue(id: number) {
  await db.update(crawlReviewAttempts).set({ retryAfter: new Date(Date.now() - 1_000) }).where(eq(crawlReviewAttempts.id, id));
}

describe('delegated human review infrastructure recovery', () => {
  it('recovers the same input after bounded owner interruptions from 25006 result rollbacks', async () => {
    const candidate = await held();
    for (let turn = 0; turn < 3; turn++) {
      const current = await withJob(lease => claim(candidate.repo, lease));
      let code: string | undefined;
      try {
        // Transaction-scoped only: reproduce the persisted running claim left
        // by a failed result write without changing any connection default.
        await db.transaction(async tx => {
          await tx.execute(sql`SET TRANSACTION READ ONLY`);
          await tx.update(crawlReviewAttempts).set({ state: 'failed', errorCode: 'timeout' })
            .where(eq(crawlReviewAttempts.id, current.attemptId));
        });
      } catch (error) { code = dbErrorTag(error)?.code; }
      expect(code).toBe('25006');
      expect((await history(candidate.id)).at(-1)).toMatchObject({ id: current.attemptId, state: 'running' });
      // The owning job has ACKed and released its token. Age this persisted
      // claim rather than sleeping through the production abandoned-owner bound.
      await db.update(crawlReviewAttempts).set({ startedAt: new Date(Date.now() - 121_000) })
        .where(eq(crawlReviewAttempts.id, current.attemptId));
    }
    expect(await withJob(lease => claimHumanReview(candidate.repo, lease))).toBeNull();
    const interrupted = await history(candidate.id);
    expect(interrupted).toHaveLength(3);
    expect(interrupted.every(row => row.state === 'failed' && row.errorCode === 'owner_lost')).toBe(true);
    expect(new Set(interrupted.map(row => row.inputHash)).size).toBe(1);
    // The infrastructure throttle expires automatically for this same input
    // and switch generation; no administrator retry/reset is needed.
    await db.update(crawlReviewAttempts).set({ completedAt: new Date(Date.now() - 25 * 3600_000),
      retryAfter: new Date(Date.now() - 1_000) }).where(eq(crawlReviewAttempts.candidateId, candidate.id));
    const recovered = await withJob(lease => claim(candidate.repo, lease));
    expect(recovered.input.inputHash).toBe(interrupted[0].inputHash);
    expect((await history(candidate.id)).at(-1)).toMatchObject({ state: 'running', attemptNumber: 4 });
  });

  it('applies the short unsent cooldown and a separate rolling infrastructure cap', async () => {
    const candidate = await held();
    for (let turn = 0; turn < 3; turn++) {
      const current = await withJob(async lease => {
        const value = await claim(candidate.repo, lease);
        await deferHumanReviewBeforeTransport(value);
        return value;
      });
      const row = (await history(candidate.id)).at(-1)!;
      expect(row).toMatchObject({ id: current.attemptId, state: 'superseded', errorCode: 'not_started_before_transport' });
      expect(row.retryAfter!.getTime()).toBeGreaterThan(Date.now() + 45_000);
      expect(await withJob(lease => claimHumanReview(candidate.repo, lease))).toBeNull();
      await makeDue(current.attemptId);
    }
    expect(await withJob(lease => claimHumanReview(candidate.repo, lease))).toBeNull();
    await db.update(crawlReviewAttempts).set({ completedAt: new Date(Date.now() - 25 * 3600_000) })
      .where(eq(crawlReviewAttempts.candidateId, candidate.id));
    expect(await withJob(lease => claimHumanReview(candidate.repo, lease))).not.toBeNull();
  });

  it('retains the three-attempt cap for cancellation results that may have been sent', async () => {
    const candidate = await held();
    for (let turn = 0; turn < 3; turn++) {
      const current = await withJob(async lease => {
        const value = await claim(candidate.repo, lease);
        expect(await recordHumanReview(value, { ok: false, error: 'cancelled' })).toBe('failed');
        return value;
      });
      await makeDue(current.attemptId);
    }
    expect(await withJob(lease => claimHumanReview(candidate.repo, lease))).toBeNull();
    expect((await history(candidate.id)).every(row => row.state === 'failed' && row.errorCode === 'cancelled')).toBe(true);
  });

  it('rolls back an unsent release after its actual job lease is gone', async () => {
    const candidate = await held();
    const current = await withJob(lease => claim(candidate.repo, lease));
    await expect(deferHumanReviewBeforeTransport(current)).rejects.toBeInstanceOf(JobLeaseLostError);
    expect((await history(candidate.id)).at(-1)).toMatchObject({ id: current.attemptId, state: 'running', errorCode: null });
  });

  it('preserves an intentional pause installed while the current claim drains', async () => {
    const candidate = await held(), pausedUntil = new Date('2100-01-01T00:00:00Z');
    await withJob(async lease => {
      const current = await claim(candidate.repo, lease);
      await db.update(jobs).set({ notBefore: pausedUntil }).where(eq(jobs.name, JOB));
      await deferHumanReviewBeforeTransport(current);
    });
    expect((await db.select().from(jobs).where(eq(jobs.name, JOB)))[0].notBefore).toEqual(pausedUntil);
  });
});
