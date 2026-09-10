import { beforeAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, crawlReviewAttempts } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { saveSettings, changeReviewMode, getSettings, resetSettings } from "@/lib/crawl/settings";
import { loadReviewInput, claimAgentReview, recordAgentReview,
  requeueStaleReviewSources } from "@/lib/crawl/agent-review-repository";
import { ensureSchema } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
});
const outcome = { decision: "approve" as const, reason: "A deployed service", evidenceIds: ["product"] };
async function fixture(mode: "observe" | "enforce" = "observe") {
  await saveSettings({ enabled: true }, "test");
  const previous = process.env.CRAWL_REVIEW_READY;
  process.env.CRAWL_REVIEW_READY = "true";
  try { expect(await changeReviewMode({ mode, expectedMode: "off", actor: "test", reason: "Integration test" })).toMatchObject({ ok: true }); }
  finally { if (previous === undefined) delete process.env.CRAWL_REVIEW_READY; else process.env.CRAWL_REVIEW_READY = previous; }
  await crawl.putDocument({ repo: "owner/review-app", productUrl: "https://review.example", pageStatus: 200,
    repoMeta: { description: "A deployed service" }, pageMeta: { title: "Review App", description: "A deployed service" } });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 2000) });
  await crawl.recordJudgement({ repo: "owner/review-app", productUrl: "https://review.example", state: "approved", reason: "passed", decidedBy: "auto" });
  const lease = { name: "crawl-agent-review", token: "review-owner", requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, leaseToken: lease.token, lockedAt: new Date(), requestedVersion: 1 });
  const candidate = (await crawl.getCandidate("owner/review-app"))!;
  const document = (await crawl.getDocument(candidate.repo))!;
  const settings = await getSettings();
  return { candidate, document, settings, lease, input: await loadReviewInput(candidate, document, settings), provider: "claude-cli", model: "test-model" };
}

it("stores observed reviews without mutating the candidate and reuses immutable success", async () => {
  const context = await fixture();
  const claim = await claimAgentReview(context);
  expect(claim.kind).toBe("claimed");
  if (claim.kind === "skipped") throw new Error(claim.reason);
  expect(await recordAgentReview({ ...context, attempt: claim.attempt, outcome })).toEqual({ applied: false, state: "succeeded" });
  expect(await crawl.getCandidate(context.candidate.repo)).toEqual(context.candidate);
  const again = await claimAgentReview(context);
  expect(again.kind).toBe("reused");
  if (again.kind === "skipped") throw new Error(again.reason);
  await recordAgentReview({ ...context, attempt: again.attempt, outcome: { ...outcome, decision: "reject" } });
  const rows = await db.select().from(crawlReviewAttempts);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ outcome, inputTokens: null, outputTokens: null, costUsd: null });
});

it("copies reusable success to a new source revision without rewriting history", async () => {
  const context = await fixture();
  const first = await claimAgentReview(context);
  if (first.kind === "skipped") throw new Error(first.reason);
  await recordAgentReview({ ...context, attempt: first.attempt, outcome });
  await db.update(crawlDocuments).set({ fetchedAt: new Date() }).where(eq(crawlDocuments.id, context.document.id));
  const document = (await crawl.getDocument(context.candidate.repo))!;
  const next = { ...context, document, input: await loadReviewInput(context.candidate, document, context.settings) };
  const reused = await claimAgentReview(next);
  if (reused.kind === "skipped") throw new Error(reused.reason);
  expect(reused).toMatchObject({ kind: "reused", attempt: { state: "running", reusedFromAttemptId: first.attempt.id, outcome } });
  expect(reused.attempt.id).not.toBe(first.attempt.id);
  await recordAgentReview({ ...next, attempt: reused.attempt, outcome });
  expect(await db.select().from(crawlReviewAttempts)).toHaveLength(2);
});

it("does not carry an approval over to a refetched page whose body changed", async () => {
  const context = await fixture();
  const first = await claimAgentReview(context);
  if (first.kind === "skipped") throw new Error(first.reason);
  await recordAgentReview({ ...context, attempt: first.attempt, outcome });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(), pageMeta: { ...context.document.pageMeta,
    textSample: "Review App — run it locally. Install: npm install -g review-app" } }).where(eq(crawlDocuments.id, context.document.id));
  const document = (await crawl.getDocument(context.candidate.repo))!;
  const next = { ...context, document, input: await loadReviewInput(context.candidate, document, context.settings) };
  expect(next.input.inputHash).not.toBe(context.input.inputHash);
  expect(await claimAgentReview(next)).toMatchObject({ kind: "claimed", attempt: { reusedFromAttemptId: null, outcome: null } });
});

it("protects an administrator decision and refuses a stale worker token", async () => {
  const context = await fixture("enforce");
  const claim = await claimAgentReview(context);
  if (claim.kind === "skipped") throw new Error(claim.reason);
  await crawl.recordJudgement({ repo: context.candidate.repo, productUrl: context.candidate.productUrl,
    state: "rejected", reason: "not_a_product", decidedBy: "admin" });
  expect(await recordAgentReview({ ...context, attempt: claim.attempt, outcome })).toEqual({ applied: false, state: "superseded" });
  expect(await crawl.getCandidate(context.candidate.repo)).toMatchObject({ state: "rejected", decidedBy: "admin" });
  await db.update(jobs).set({ leaseToken: "new-owner" }).where(eq(jobs.name, context.lease.name));
  await expect(recordAgentReview({ ...context, attempt: claim.attempt, outcome })).rejects.toThrow("job_lease_lost");
});

it("stops after three infrastructure failures without rejecting the product", async () => {
  const context = await fixture("enforce");
  for (let number = 1; number <= 3; number++) {
    const claim = await claimAgentReview(context);
    if (claim.kind === "skipped") throw new Error(claim.reason);
    expect(claim.attempt.attemptNumber).toBe(number);
    await recordAgentReview({ ...context, attempt: claim.attempt, error: "timeout", retryAfter: new Date(0) });
  }
  expect(await claimAgentReview(context)).toEqual({ kind: "skipped", reason: "attempts_exhausted" });
  expect(await crawl.getCandidate(context.candidate.repo)).toEqual(context.candidate);
});

it("requeues an expired automatic review source instead of stranding publication", async () => {
  const context = await fixture("enforce");
  const stale = new Date(Date.now() - 25 * 60 * 60_000);
  await db.update(crawlDocuments).set({ fetchedAt: stale }).where(eq(crawlDocuments.id, context.document.id));
  await db.insert(crawlFrontier).values({
    repo: context.candidate.repo, signal: "original", state: "done", attempts: 1,
    nextAttemptAt: stale, updatedAt: stale,
  });

  expect(await requeueStaleReviewSources(context.settings, context.lease)).toBe(1);
  expect(await db.query.crawlFrontier.findFirst({ where: eq(crawlFrontier.repo, context.candidate.repo) }))
    .toMatchObject({ state: "pending", attempts: 0, lastError: null });
  expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-fetch") }))
    .toMatchObject({ requestedVersion: 1, processedVersion: 0 });
  expect(await crawl.getCandidate(context.candidate.repo)).toMatchObject({ state: "approved", decidedBy: "auto" });
});

it("preserves enforce across a stale settings form and reset; mode changes use CAS", async () => {
  await fixture("enforce");
  await saveSettings({ reviewMode: "off", judge: { maxStars: 77 } }, "test");
  expect(await getSettings()).toMatchObject({ reviewMode: "enforce", judge: { maxStars: 77 } });
  await resetSettings("test");
  expect(await getSettings()).toMatchObject({ reviewMode: "enforce" });
  expect(await changeReviewMode({ mode: "off", expectedMode: "observe", actor: "test", reason: "stale request" })).toMatchObject({ ok: false });
  expect(await getSettings()).toMatchObject({ reviewMode: "enforce" });
});
