import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, crawlCandidates, crawlDocuments, crawlSettings, crawlReviewAttempts, secondReviews } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { getSettings, saveSettings, changeReviewMode } from "@/lib/crawl/settings";
import { claimAgentReview, loadReviewInput, recordAgentReview } from "@/lib/crawl/agent-review-repository";
import { enqueueSecondReviews, recordSecondReview } from "@/lib/crawl/second-review";
import { getJobState } from "@/lib/jobs/runner";
import { ensureSchema } from "./setup";
beforeAll(ensureSchema);
beforeEach(async () => {
  for (const table of [secondReviews, crawlReviewAttempts, crawlCandidates, crawlDocuments, crawlSettings, jobs]) await db.delete(table);
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  vi.stubEnv("CRAWL_REVIEW_MODEL", "first-fixture");
});
async function fixture(mode: "off"|"observe"|"enforce" = "enforce", second = true) {
  await saveSettings({ enabled: true, firstReview: { provider: "claude-cli", model: "first-fixture" }, secondReview: {
    enabled: second, voters: [{ provider: "abcllm", model: "second-fixture" }], fallbacks: [{ provider: "claude-cli", model: "sonnet" }], sampleRate: 0,
  } }, "test");
  if (mode !== "off") await changeReviewMode({ mode, expectedMode: "off", actor: "test", reason: "fixture" });
  await crawl.putDocument({ repo: "handoff/app", productUrl: "https://app.example", pageStatus: 200,
    repoMeta: { description: "A useful app" }, pageMeta: { title: "App", description: "A useful app" } });
  const document = (await crawl.getDocument("handoff/app"))!;
  return { document, settings: await getSettings(), candidate: undefined };
}
const verdict = { state: "approved" as const, reason: "passed" as const, signals: {} };
const outcome = { decision: "approve" as const, reason: "Functional app", evidenceIds: ["product"], confidence: .95 };
async function first() {
  const f = await fixture();
  await crawl.recordAutomaticJudgement({ ...f, verdict });
  const candidate = (await crawl.getCandidate(f.document.repo))!;
  const lease = { name: "crawl-agent-review", token: "owner", requestedVersion: 1 };
  await db.update(jobs).set({ lockedAt: new Date(), leaseToken: lease.token }).where(eq(jobs.name, lease.name));
  // Before the handoff implementation this job row does not exist.
  await db.insert(jobs).values({ name: lease.name, lockedAt: new Date(), leaseToken: lease.token, requestedVersion: 1 }).onConflictDoNothing();
  const context = { ...f, candidate, lease, provider: "claude-cli", model: "first-fixture", input: await loadReviewInput(candidate, f.document, f.settings) };
  const claim = await claimAgentReview(context);
  if (claim.kind === "skipped") throw Error(claim.reason);
  return { ...context, attempt: claim.attempt };
}
it.each(["off", "observe", "enforce"] as const)("rules commit wakes the existing consumers for mode %s", async mode => {
  const f = await fixture(mode);
  expect(await crawl.recordAutomaticJudgement({ ...f, verdict })).toBe(true);
  expect(Boolean(await getJobState("crawl-agent-review"))).toBe(mode !== "off");
  expect(Boolean(await getJobState("crawl-publish"))).toBe(mode !== "enforce");
  expect(await crawl.recordAutomaticJudgement({ ...f, verdict })).toBe(false);
  if (mode !== "off") expect((await getJobState("crawl-agent-review"))?.requestedVersion).toBe(1);
});
it("rolls back the candidate if the next job request cannot commit", async () => {
  const f = await fixture();
  await db.insert(jobs).values({ name: "crawl-agent-review", requestedVersion: Number.MAX_SAFE_INTEGER });
  await expect(crawl.recordAutomaticJudgement({ ...f, verdict })).rejects.toThrow("job_version_exhausted");
  expect(await crawl.getCandidate(f.document.repo)).toBeUndefined();
});
it("first success requests second, never bypasses its publication gate, repeated delivery is silent", async () => {
  const context = await first();
  await recordAgentReview({ ...context, outcome });
  expect((await getJobState("second-review"))?.requestedVersion).toBe(1);
  expect(await getJobState("crawl-publish")).toBeUndefined();
  await recordAgentReview({ ...context, outcome });
  expect((await getJobState("second-review"))?.requestedVersion).toBe(1);
});
it("first result and signal both roll back on signal failure", async () => {
  const context = await first();
  await db.insert(jobs).values({ name: "second-review", requestedVersion: Number.MAX_SAFE_INTEGER });
  await expect(recordAgentReview({ ...context, outcome })).rejects.toThrow("job_version_exhausted");
  const [attempt] = await db.select().from(crawlReviewAttempts);
  expect(attempt.state).toBe("running");
  expect(await crawl.getCandidate(context.candidate.repo)).toEqual(context.candidate);
});
it.each(["approve", "reject"])("second %s signals publication only for an approval", async decision => {
  const context = await first();
  await recordAgentReview({ ...context, outcome });
  await enqueueSecondReviews(context.settings);
  const [row] = await db.select().from(secondReviews);
  expect(row).toBeDefined();
  await recordSecondReview(row.id, { ok: true, decision, confidence: .95, reason: "fixture", model: row.model!, provider: row.provider!, status: "agreed" });
  expect(Boolean(await getJobState("crawl-publish"))).toBe(decision === "approve");
  await recordSecondReview(row.id, { ok: true, decision, confidence: .95, reason: "fixture", model: row.model!, provider: row.provider!, status: "agreed" });
  if (decision === "approve") expect((await getJobState("crawl-publish"))?.requestedVersion).toBe(1);
});
it("a created fallback wakes second review without publishing", async () => {
  const context = await first(); await recordAgentReview({ ...context, outcome });
  await enqueueSecondReviews(context.settings);
  const [row] = await db.select().from(secondReviews);
  const before = (await getJobState("second-review"))!.requestedVersion;
  await recordSecondReview(row.id, { ok: false, error: "timeout", model: row.model!, provider: row.provider! });
  expect((await getJobState("second-review"))?.requestedVersion).toBe(before + 1);
  expect(await getJobState("crawl-publish")).toBeUndefined();
  expect(await db.select().from(secondReviews)).toHaveLength(2);
});
