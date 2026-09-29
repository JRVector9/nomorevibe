import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, crawlReviewAttempts } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { saveSettings, changeReviewMode, getSettings, resetSettings } from "@/lib/crawl/settings";
import { loadReviewInput, claimAgentReview, recordAgentReview,
  requeueStaleReviewSources, handOffExhaustedFirstReviews, listReviewCandidates,
  reviewCandidatePredicate, reviewApprovalPredicate, assertReviewApproval } from "@/lib/crawl/agent-review-repository";
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

it("does not create another case variant while refreshing stale review sources", async () => {
  const context = await fixture();
  const stale = new Date(Date.now() - 25 * 60 * 60_000);
  await db.update(crawlDocuments).set({ fetchedAt: stale });
  await db.insert(crawlFrontier).values({ repo: context.candidate.repo.toUpperCase(), signal: "original", state: "done", updatedAt: stale });
  expect(await requeueStaleReviewSources(context.settings, context.lease)).toBe(0);
  expect(await db.select().from(crawlFrontier)).toHaveLength(1);
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

/** 거부 기록만 보고도 왜 거부됐는지 알 수 있어야 한다 — 규칙이 아니라 AI 가 멈췄으면 AI 의 이유를 남긴다 */
it("enforce 에서 AI 가 거부하면 그 이유를 거부 기록에 남긴다", async () => {
  const context = await fixture("enforce");
  const claim = await claimAgentReview(context);
  if (claim.kind === "skipped") throw new Error(claim.reason);
  await recordAgentReview({ ...context, attempt: claim.attempt, outcome: { ...outcome, decision: "reject", reason: "A docs site for a CLI" } });
  expect(await crawl.getCandidate(context.candidate.repo)).toMatchObject({
    state: "rejected", signals: { stoppedAt: { rule: "AI 심사", detail: "A docs site for a CLI" } },
  });
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

it("hands an approved candidate to human review after three current-source failures", async () => {
  const base = await fixture("enforce");
  await saveSettings({ firstReview: { provider: base.provider, model: base.model } }, "test");
  const settings = await getSettings();
  const context = { ...base, settings,
    input: await loadReviewInput(base.candidate, base.document, settings) };
  for (let number = 1; number <= 3; number++) {
    const claim = await claimAgentReview(context);
    if (claim.kind === "skipped") throw new Error(claim.reason);
    await recordAgentReview({ ...context, attempt: claim.attempt, error: "gateway_error", retryAfter: new Date(0) });
  }
  expect(await handOffExhaustedFirstReviews(settings, context.lease)).toBe(1);
  expect(await crawl.getCandidate(context.candidate.repo)).toMatchObject({
    state: "needs_review", reason: "ai_review_exhausted", decidedBy: "auto",
  });
  expect(await handOffExhaustedFirstReviews(settings, context.lease)).toBe(0);
  expect(await db.select().from(crawlReviewAttempts)).toHaveLength(3);
});

it("separates owner changes from model failures and retries after the interruption window", async () => {
  const base = await fixture("enforce");
  await saveSettings({ firstReview: { provider: base.provider, model: base.model } }, "test");
  const settings = await getSettings();
  const context = { ...base, settings,
    input: await loadReviewInput(base.candidate, base.document, settings) };
  const lease = { ...context.lease };
  const claim = () => claimAgentReview({ ...context, lease });
  for (let number = 1; number <= 3; number++) {
    lease.token = `owner-${number}`;
    await db.update(jobs).set({ leaseToken: lease.token, lockedAt: new Date() })
      .where(eq(jobs.name, lease.name));
    expect(await claim()).toMatchObject({ kind: "claimed", attempt: { attemptNumber: number } });
  }
  lease.token = "owner-4";
  await db.update(jobs).set({ leaseToken: lease.token, lockedAt: new Date() })
    .where(eq(jobs.name, lease.name));
  expect(await claim()).toEqual({ kind: "skipped", reason: "infrastructure_interruptions_exhausted" });
  expect((await db.select().from(crawlReviewAttempts)).map(row => [row.state, row.errorCode, row.outcome]))
    .toEqual(Array.from({ length: 3 }, () => ["superseded", "owner_changed", null]));
  const ready = () => db.select({ id: crawlCandidates.id }).from(crawlCandidates)
    .where(reviewCandidatePredicate(settings, { readyOnly: true }));
  expect(await ready()).toEqual([]);
  await db.update(crawlReviewAttempts).set({ completedAt: new Date(Date.now() - 25 * 60 * 60_000) });
  expect((await ready()).map(row => row.id)).toEqual([context.candidate.id]);
  expect(await claim()).toMatchObject({ kind: "claimed", attempt: { attemptNumber: 4 } });
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

it("does not reuse another model's success on the same or a refreshed source", async () => {
  const context = await fixture(); const first = await claimAgentReview(context);
  if (first.kind === "skipped") throw new Error(first.reason);
  await recordAgentReview({...context, attempt: first.attempt, outcome});
  expect(await claimAgentReview({...context, model: "other-model"})).toMatchObject({kind: "claimed", attempt: {reusedFromAttemptId: null, outcome: null}});
});
it("does not exhaust a new model from the old model's failures", async () => {
  const context = await fixture();
  for (let i = 0; i < 3; i++) {
    const attempt = await claimAgentReview(context); if (attempt.kind === "skipped") throw new Error(attempt.reason);
    await recordAgentReview({...context, attempt: attempt.attempt, error: "timeout", retryAfter: new Date(0)});
  }
  expect(await claimAgentReview({...context, model: "other-model"})).toMatchObject({kind: "claimed", attempt: {attemptNumber: 1}});
});
it("does not let an old model approval suppress review or satisfy enforce publication", async () => {
  const context = await fixture("enforce"); const first = await claimAgentReview(context);
  if (first.kind === "skipped") throw new Error(first.reason);
  await recordAgentReview({...context, attempt: first.attempt, outcome});
  vi.stubEnv("CRAWL_REVIEW_MODEL", "other-model");
  try {
    expect((await listReviewCandidates(context.settings)).map(row => row.id)).toContain(context.candidate.id);
    expect(await db.select().from(crawlCandidates).where(reviewApprovalPredicate(context.settings))).toEqual([]);
    const candidate = (await crawl.getCandidate(context.candidate.repo))!;
    await expect(db.transaction(tx => assertReviewApproval(tx, {...context, candidate}))).rejects.toThrow("review_approval_changed");
  } finally {vi.unstubAllEnvs();}
});

/**
 * 새 후보가 재심사 뒤에 굶지 않는다.
 *
 * observe 에서는 재심사 결과가 후보에 기록되지 않아(applied=false) 재심사 대상의 updatedAt 이
 * 영영 옛날로 남는다. 오래된 순으로만 뽑던 때는 그것이 늘 줄 맨 앞을 차지해, 2026-09-18 프로드에서
 * 한 번도 심사받지 못한 후보 55건이 평균 9시간(가장 오래 194시간) 기다렸다.
 */
it("한 번도 심사받지 않은 후보가 유효기간 지난 재심사보다 먼저 나온다", async () => {
  const old = await fixture();
  const first = await claimAgentReview(old);
  if (first.kind === "skipped") throw new Error(first.reason);
  await recordAgentReview({ ...old, attempt: first.attempt, outcome });
  // 유효기간이 지나 다시 보게 된 재심사 — 그리고 줄에서 더 오래된 쪽
  await db.update(crawlReviewAttempts).set({ validUntil: new Date(Date.now() - 60_000) });
  await db.update(crawlCandidates).set({ updatedAt: new Date(Date.now() - 7 * 86_400_000) })
    .where(eq(crawlCandidates.id, old.candidate.id));

  await crawl.putDocument({ repo: "owner/fresh-app", productUrl: "https://fresh.example", pageStatus: 200,
    repoMeta: { description: "A new deployed service" }, pageMeta: { title: "Fresh App", description: "A new deployed service" } });
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 2000) });
  await crawl.recordJudgement({ repo: "owner/fresh-app", productUrl: "https://fresh.example", state: "approved", reason: "passed", decidedBy: "auto" });
  const fresh = (await crawl.getCandidate("owner/fresh-app"))!;

  const settings = await getSettings();
  const order = (await listReviewCandidates(settings, 10)).map((row) => row.id);
  // 둘 다 심사 대상이지만 새 것이 먼저다 — updatedAt 은 재심사 쪽이 일주일 더 오래됐는데도
  expect(order).toEqual([fresh.id, old.candidate.id]);

  // 감사의 양보 조건은 새 것만 본다 — 재심사에는 양보하지 않는다
  expect((await listReviewCandidates(settings, 10, { unreviewedOnly: true })).map((row) => row.id)).toEqual([fresh.id]);
});

it("counts the complete ready review queue without the worker's 100-candidate page cap", async () => {
  expect(reviewCandidatePredicate).toBeTypeOf("function");
  const context = await fixture();
  const repos = Array.from({ length: 104 }, (_, index) => `ready/app-${index}`);
  await db.insert(crawlDocuments).values(repos.map(repo => ({ repo, repoMeta: {},
    productUrl: `https://${repo.replace('/', '-')}.example`, fetchedAt: new Date(Date.now() - 5_000) })));
  await db.insert(crawlCandidates).values(repos.map(repo => ({ repo,
    productUrl: `https://${repo.replace('/', '-')}.example`, state: 'approved' as const,
    reason: 'passed' as const, decidedBy: 'auto' as const })));
  const settings = context.settings;
  const aggregate = async (candidateSettings = settings, excludeCandidateIds: number[] = []) => {
    const [row] = await db.select({ count: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${crawlCandidates.updatedAt})` })
      .from(crawlCandidates).where(reviewCandidatePredicate(candidateSettings, { readyOnly: true, excludeCandidateIds }));
    return row;
  };
  expect(await aggregate()).toMatchObject({ count: 105, oldest: expect.anything() });
  expect(await listReviewCandidates(settings, 500, { readyOnly: true })).toHaveLength(100);
  expect((await aggregate(settings, [context.candidate.id])).count).toBe(104);
  for (const disabled of [{ ...settings, enabled: false }, { ...settings, reviewMode: 'off' as const }]) {
    expect(await aggregate(disabled)).toEqual({ count: 0, oldest: null });
    expect(await listReviewCandidates(disabled, 500, { readyOnly: true })).toEqual([]);
  }
});

it("uses worker eligibility for live review claims, stale leases, retry backoff and unreviewed filters", async () => {
  expect(reviewCandidatePredicate).toBeTypeOf("function");
  const base = await fixture();
  await saveSettings({ firstReview: { provider: base.provider, model: base.model } }, 'test');
  const settings = await getSettings();
  const context = { ...base, settings, input: await loadReviewInput(base.candidate, base.document, settings) };
  const claim = await claimAgentReview(context);
  if (claim.kind === 'skipped') throw new Error(claim.reason);
  const ids = async (options: Parameters<typeof reviewCandidatePredicate>[1] = {}) =>
    (await db.select({ id: crawlCandidates.id }).from(crawlCandidates).where(reviewCandidatePredicate(settings, options))).map(row => row.id);
  expect(await ids()).toEqual([context.candidate.id]);
  expect(await ids({ readyOnly: true })).toEqual([]);
  expect(await listReviewCandidates(settings, 100, { readyOnly: true })).toEqual([]);
  await db.update(jobs).set({ lockedAt: sql`now() - interval '2 minutes'` }).where(eq(jobs.name, context.lease.name));
  expect(await ids({ readyOnly: true })).toEqual([context.candidate.id]);
  await db.update(jobs).set({ lockedAt: sql`now()` }).where(eq(jobs.name, context.lease.name));
  await recordAgentReview({ ...context, attempt: claim.attempt, error: 'timeout', retryAfter: new Date(Date.now() + 60_000) });
  expect(await ids({ readyOnly: true })).toEqual([]);
  await db.update(crawlReviewAttempts).set({ state: 'succeeded', validUntil: new Date(0) });
  expect(await ids()).toEqual([context.candidate.id]);
  expect(await ids({ unreviewedOnly: true })).toEqual([]);
  expect(await listReviewCandidates(settings, 100, { unreviewedOnly: true })).toEqual([]);
});
