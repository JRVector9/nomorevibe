import { beforeAll, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments, crawlFrontier,
  crawlReviewAttempts, crawlSettings, jobs, secondReviews } from "@/lib/db/schema";
import { getSettings } from "@/lib/crawl/settings";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { assertReviewApproval, claimAgentReview, handOffExhaustedFirstReviews, listReviewCandidates, loadReviewInput,
  recordAgentReview, reviewApprovalPredicate, requeueStaleReviewSources } from "@/lib/crawl/agent-review-repository";
import { closeSettledSecondReviews, enqueueSecondReviews, recordSecondReview } from "@/lib/crawl/second-review";
import { loadSecondReviewInput } from "@/lib/crawl/second-review-input";
import { withReviewReplayContext } from "@/lib/crawl/review-replay-context";
import { ensureSchema } from "./setup";
import { admitSecondReviewFixture, withLegacySecondReviewJob } from "./second-review-receipt-fixtures";

const referenceTime = new Date("2001-11-01T00:00:00.000Z");
const approve = { decision: "approve" as const, confidence: 0.95, reason: "A usable application", evidenceIds: ["product"] };
const scope = <T>(load: () => Promise<T>) => withReviewReplayContext({ referenceTime }, load);
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(secondReviews);
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(agentRepositoryObservations);
  await db.delete(agentRepositoryScans);
  await db.delete(jobs);
});

async function fixture(fetchedAt = new Date(referenceTime.getTime() - 1_000), completedAt = referenceTime) {
  await db.insert(crawlSettings).values({ values: { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first" }, secondReview: { ...DEFAULT_CRAWL_SETTINGS.secondReview,
      enabled: true, sampleRate: 0, voters: [{ provider: "abcllm", model: "second-a" }, { provider: "abcllm", model: "second-b" }] } } });
  const [candidate] = await db.insert(crawlCandidates).values({ repo: "clock/app", productUrl: "https://clock.example",
    state: "approved", reason: "passed", decidedBy: "auto", judgedAt: referenceTime, updatedAt: referenceTime }).returning();
  const [document] = await db.insert(crawlDocuments).values({ repo: candidate.repo, productUrl: candidate.productUrl,
    fetchedAt, pageStatus: 200, repoMeta: { description: "A useful application", pushed_at: referenceTime.toISOString() },
    pageMeta: { title: "Clock", description: "A useful application", repositoryKeys: [candidate.repo],
      readmeSample: "A useful application", readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(1), repositoryKey: candidate.repo,
    commitSha: "a".repeat(40), detectorVersion: DEFAULT_CRAWL_SETTINGS.agentEvidence.detectorVersion,
    scopeHash: "0".repeat(64), state: "complete", startedAt: referenceTime, completedAt });
  const lease = { name: "crawl-agent-review", token: "clock-first", requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token,
    requestedVersion: 1, lockedAt: new Date() });
  const settings = await getSettings();
  const input = await scope(() => loadReviewInput(candidate, document, settings));
  return { candidate, document, settings, input, lease, provider: "abcllm", model: "first" };
}

it("agrees across reference SQL selection, locked AI1/AI2 writers and the exact required-slot gate", async () => {
  const context = await fixture(), wallBefore = Date.now();
  expect(await listReviewCandidates(context.settings)).toEqual([]);
  await scope(async () => {
    expect((await listReviewCandidates(context.settings)).map(row => row.id)).toEqual([context.candidate.id]);
    expect(await requeueStaleReviewSources(context.settings, context.lease)).toBe(0);
    const claim = await claimAgentReview(context);
    if (claim.kind === "skipped") throw new Error(claim.reason);
    expect(claim.kind).toBe("claimed");
    expect(claim.attempt.startedAt.getTime()).toBeGreaterThanOrEqual(wallBefore);
    expect(claim.attempt.validUntil.getTime()).toBeLessThan(wallBefore);
    expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: approve }))
      .toEqual({ applied: true, state: "succeeded" });
    const [candidate] = await db.select().from(crawlCandidates);
    const current = { ...context, candidate };
    expect(await claimAgentReview(current)).toMatchObject({ kind: "reused", attempt: { id: claim.attempt.id } });
    expect(await listReviewCandidates(context.settings)).toEqual([]);
    const gate = () => db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(reviewApprovalPredicate(context.settings));
    expect(await gate()).toEqual([]);
    await withLegacySecondReviewJob(async secondLease => {
      expect(await enqueueSecondReviews(context.settings, new Date(), secondLease)).toBe(2);
      expect(await closeSettledSecondReviews(new Date(), secondLease)).toBe(0);
      const votes = await db.select().from(secondReviews).orderBy(secondReviews.id);
      for (const [index, vote] of votes.entries()) {
        expect(await loadSecondReviewInput(vote)).toEqual(context.input);
        const receipt = await admitSecondReviewFixture(vote.id, secondLease);
        await recordSecondReview({ receipt, result: { ok: true, decision: "approve", confidence: 0.95,
          reason: "Independent approval", model: vote.model!, provider: "abcllm", status: "agreed" }, now: new Date() });
        expect((await gate()).map(row => row.id)).toEqual(index === 0 ? [] : [candidate.id]);
      }
    });
    expect(await db.transaction(tx => assertReviewApproval(tx, current))).toMatchObject({ id: claim.attempt.id });
    const [stored] = await db.select().from(crawlReviewAttempts);
    expect(stored.completedAt!.getTime()).toBeGreaterThanOrEqual(wallBefore);
    for (const vote of await db.select().from(secondReviews)) {
      expect(vote.status).toBe("agreed");
      expect(vote.createdAt.getTime()).toBeGreaterThanOrEqual(wallBefore);
      expect(vote.reviewedAt!.getTime()).toBeGreaterThanOrEqual(wallBefore);
    }
    expect((await db.select().from(crawlCandidates))[0].updatedAt.getTime()).toBeGreaterThanOrEqual(wallBefore);
  });
  expect(await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(reviewApprovalPredicate(context.settings))).toEqual([]);
});

it("keeps AI1 retry readiness on the wall clock", async () => {
  const context = await fixture();
  await scope(async () => {
    const first = await claimAgentReview(context);
    if (first.kind === "skipped") throw new Error(first.reason);
    await recordAgentReview({ ...context, receipt: first.receipt, error: "timeout", retryAfter: new Date(Date.now() + 60_000) });
    expect(await claimAgentReview(context)).toEqual({ kind: "skipped", reason: "retry_wait" });
    expect(await listReviewCandidates(context.settings, 20, { readyOnly: true })).toEqual([]);
    // This is still decades after the reference, but is a completed wall-clock backoff.
    await db.update(crawlReviewAttempts).set({ retryAfter: new Date(Date.now() - 1_000) });
    expect((await listReviewCandidates(context.settings, 20, { readyOnly: true })).map(row => row.id)).toEqual([context.candidate.id]);
    expect(await claimAgentReview(context)).toMatchObject({ kind: "claimed", attempt: { attemptNumber: 2 } });
  });
});

it("refuses a lease that was live at reference time but expired in real time", async () => {
  const context = await fixture();
  await db.update(jobs).set({ lockedAt: referenceTime }).where(eq(jobs.name, context.lease.name));
  await scope(async () => expect(claimAgentReview(context)).rejects.toThrow("job_lease_lost"));
  expect(await db.select().from(crawlReviewAttempts)).toEqual([]);
});

it.each([
  ["expired document", new Date(referenceTime.getTime() - 86_400_000), referenceTime],
  ["future document", new Date(referenceTime.getTime() + 1_000), referenceTime],
  ["future scan", new Date(referenceTime.getTime() - 1_000), new Date(referenceTime.getTime() + 1_000)],
] as const)("refuses %s against the reference in selection and locked claim", async (_name, fetchedAt, completedAt) => {
  const context = await fixture(fetchedAt, completedAt);
  await scope(async () => {
    expect(await listReviewCandidates(context.settings)).toEqual([]);
    expect(await claimAgentReview(context)).toEqual({ kind: "skipped", reason: "input_changed" });
  });
});

it("closes reference-expired AI2 work with a real resolution timestamp", async () => {
  const context = await fixture();
  await scope(async () => {
    const first = await claimAgentReview(context);
    if (first.kind === "skipped") throw new Error(first.reason);
    await recordAgentReview({ ...context, receipt: first.receipt, outcome: approve });
    await withLegacySecondReviewJob(async secondLease => {
      expect(await enqueueSecondReviews(context.settings, new Date(), secondLease)).toBe(2);
      await db.update(crawlReviewAttempts).set({ validUntil: referenceTime });
      const wallBefore = Date.now();
      expect(await closeSettledSecondReviews(new Date(), secondLease)).toBe(2);
      for (const row of await db.select().from(secondReviews)) {
        expect(row).toMatchObject({ status: "resolved", resolution: "superseded" });
        expect(row.resolvedAt!.getTime()).toBeGreaterThanOrEqual(wallBefore);
      }
    });
  });
});

it("hands reference-current exhausted attempts to a person using a real event timestamp", async () => {
  const context = await fixture();
  await scope(async () => {
    for (let index = 0; index < 3; index++) {
      const claim = await claimAgentReview(context);
      if (claim.kind === "skipped") throw new Error(claim.reason);
      await recordAgentReview({ ...context, receipt: claim.receipt, error: "timeout", retryAfter: new Date(0) });
    }
    // The writer uses the DB clock. A local Docker VM can lag the host by tens of ms.
    const [clock] = await db.execute<{ ms: string }>(sql`select extract(epoch from clock_timestamp()) * 1000 as ms`);
    const wallBefore = Math.floor(Number(clock.ms));
    expect(await handOffExhaustedFirstReviews(context.settings, context.lease)).toBe(1);
    const [candidate] = await db.select().from(crawlCandidates);
    expect(candidate).toMatchObject({ state: "needs_review", reason: "ai_review_exhausted" });
    expect(candidate.updatedAt.getTime()).toBeGreaterThanOrEqual(wallBefore);
  });
});
