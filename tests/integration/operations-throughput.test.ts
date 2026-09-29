import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { categoryDecisions, crawlCandidates, crawlDocuments, crawlFrontier, crawlPublicationChanges,
  crawlReviewAttempts, secondReviews } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { judgementQueue } from "@/lib/crawl/repository";
import { pipelineThroughput } from "@/lib/operations/throughput";
import { ensureSchema, resetTables } from "./setup";

const settings: CrawlSettings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "off" };
let now: Date;
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
beforeAll(ensureSchema);
beforeEach(async () => {
  vi.unstubAllEnvs();
  await resetTables();
  for (const table of [secondReviews, categoryDecisions, crawlCandidates, crawlDocuments, crawlFrontier, crawlPublicationChanges]) {
    await db.delete(table);
  }
  now = new Date();
});
const stage = async (key: string, config = settings) => (await pipelineThroughput(config, now)).stages.find(row => row.key === key)!;
async function candidate(repo: string, overrides: Partial<typeof crawlCandidates.$inferInsert> = {}) {
  return (await db.insert(crawlCandidates).values({ repo, state: "rejected", reason: "not_a_product",
    decidedBy: "auto", judgedAt: ago(20), updatedAt: ago(600), ...overrides }).returning())[0];
}

it("uses rolling windows, excludes future rows and counts only completed automatic rules", async () => {
  for (const [name, seconds] of [["one", 20], ["five", 120], ["boundary", 300], ["future", -60]] as const) {
    await db.insert(crawlDocuments).values({ repo: `time/${name}`, fetchedAt: ago(seconds), repoMeta: {} });
    await candidate(`time/${name}`, { judgedAt: ago(seconds) });
  }
  await candidate("time/manual", { decidedBy: "admin" });
  await candidate("time/new", { state: "new", reason: "ambiguous" });
  expect(await stage("fetch")).toMatchObject({ completed1m: 1, completed5m: 2 });
  expect(await stage("judge")).toMatchObject({ completed1m: 1, completed5m: 2, errors5m: null });
});

it("matches the actual rules queue including documents without a candidate and reconsideration holds", async () => {
  for (const name of ["orphan", "new", "held", "fresh"]) {
    await db.insert(crawlDocuments).values({ repo: `rules/${name}`, repoMeta: {}, fetchedAt: ago(600) });
  }
  await candidate("rules/new", { state: "new" });
  await candidate("rules/held", { state: "new", signals: { reconsiderAfter: ago(500).toISOString() } });
  await candidate("rules/fresh", { state: "new", signals: { reconsiderAfter: ago(700).toISOString() } });
  expect(await judgementQueue(100)).toHaveLength(3);
  expect(await stage("judge")).toMatchObject({ waiting: 3, completed5m: 0, status: "stalled" });
});

it("counts human handoffs separately from executable collection and first-review work", async () => {
  await candidate("manual/source", { state: "needs_review", reason: "source_refresh_failed" });
  await candidate("manual/review", { state: "needs_review", reason: "ai_review_exhausted" });
  expect(await stage("fetch")).toMatchObject({ waiting: 0, manualAttention: 1 });
  expect(await stage("first")).toMatchObject({ waiting: 0, manualAttention: 1 });
});

it("separates fetch retry reservations from a stuck ready queue and recent error records", async () => {
  await db.insert(crawlFrontier).values([
    { signal: "test", repo: "fetch/old", state: "pending", discoveredAt: ago(600), updatedAt: ago(600), nextAttemptAt: ago(600) },
    { signal: "test", repo: "fetch/claimed", state: "fetching", discoveredAt: ago(600), updatedAt: ago(10), nextAttemptAt: ago(-60) },
    { signal: "test", repo: "fetch/backoff", state: "pending", nextAttemptAt: ago(-600), updatedAt: ago(10), lastError: "timeout" },
    { signal: "test", repo: "fetch/failure", state: "failed", updatedAt: ago(10), lastError: "timeout" },
    { signal: "test", repo: "fetch/old-failure", state: "failed", updatedAt: ago(600), lastError: "timeout" },
  ]);
  expect(await stage("fetch")).toMatchObject({ waiting: 2, errors5m: 2, status: "stalled" });
  expect((await stage("fetch")).queueNote).toContain("재시도 예약 1건");
  expect(await stage("fetch", { ...settings, enabled: false })).toMatchObject({ waiting: 2, status: "paused" });
});

it("counts AI-reviewed candidates once and excludes rules, reused outcomes, manual work and cancelled calls", async () => {
  const c = await candidate("first/model");
  const other = await candidate("first/other");
  const row = (overrides: Partial<typeof crawlReviewAttempts.$inferInsert> = {}) => ({
    candidateId: c.id, state: "succeeded" as const, kind: "automatic" as const,
    inputHash: "i", policyHash: "p", sourceRevisionHash: "s", snapshot: {} as never, source: {} as never,
    promptVersion: "test", rulesVersion: "test", provider: "abcllm", model: "model", attemptNumber: 1,
    completedAt: ago(20), validUntil: ago(-3600), ...overrides,
  });
  await db.insert(crawlReviewAttempts).values([
    row(), row({ completedAt: ago(120) }),
    row({ candidateId: other.id, provider: "rules" }),
    row({ candidateId: other.id, reusedFromAttemptId: 99 }),
    row({ candidateId: other.id, kind: "admin_override" }),
    row({ candidateId: other.id, state: "failed", errorCode: "cancelled" }),
    row({ candidateId: other.id, state: "failed", errorCode: "timeout" }),
    row({ candidateId: other.id, completedAt: ago(-60) }),
    row({ candidateId: other.id, completedAt: ago(600) }),
  ]);
  expect(await stage("first")).toMatchObject({ completed1m: 1, completed5m: 1, errors5m: 1, status: "paused" });
  expect((await stage("first")).queueNote).toContain("재사용 1건");
});

it("counts second-review model votes and retains fallback errors without treating failed votes as completions", async () => {
  const c = await candidate("second/candidate");
  const row = (model: string, overrides: Partial<typeof secondReviews.$inferInsert> = {}) => ({
    candidateId: c.id, repo: c.repo, trigger: "ai_decided" as const, firstDecision: "approve", inputHash: "test",
    model, status: "agreed" as const, secondDecision: "approve", reviewedAt: ago(20), createdAt: ago(600), ...overrides,
  });
  await db.insert(secondReviews).values([
    row("a"), row("b", { reviewedAt: ago(120) }),
    row("pending", { status: "pending", secondDecision: null, reviewedAt: null }),
    row("failure", { status: "failed", secondDecision: null, errorCode: "timeout" }),
    row("fallback", { status: "resolved", resolution: "fallback", secondDecision: null, errorCode: "model_unavailable" }),
    row("future", { reviewedAt: ago(-60) }), row("old", { reviewedAt: ago(600) }),
  ]);
  expect(await stage("second", { ...settings, secondReview: { ...settings.secondReview, enabled: true } }))
    .toMatchObject({ unit: "표", completed1m: 1, completed5m: 2, errors5m: 2, waiting: 1 });
});

it("does not mark an old second-review vote stalled immediately after retry backoff expires", async () => {
  const c = await candidate("second/retried");
  await db.insert(secondReviews).values({ candidateId: c.id, repo: c.repo, trigger: "ai_decided", firstDecision: "approve",
    inputHash: "retry", model: "retry-model", status: "pending", createdAt: ago(7200), reviewedAt: ago(310), errorCode: "timeout" });
  const result = await stage("second", { ...settings, secondReview: { ...settings.secondReview, enabled: true } });
  expect(result).toMatchObject({ waiting: 1, completed5m: 0, status: "idle" });
  expect(result.oldestMinutes).toBeCloseTo(10 / 60);
});

it("treats rules and reuse as queue progress while keeping them out of AI model throughput", async () => {
  const c = await candidate("first/reused", { state: "needs_review", reason: "ambiguous" });
  await db.insert(crawlDocuments).values({ repo: c.repo, repoMeta: {}, fetchedAt: ago(600) });
  await db.insert(crawlReviewAttempts).values({ candidateId: c.id, state: "succeeded", kind: "automatic",
    inputHash: "i", policyHash: "p", sourceRevisionHash: "s", snapshot: {} as never, source: {} as never,
    promptVersion: "test", rulesVersion: "test", provider: "rules", model: "rules", attemptNumber: 1,
    completedAt: ago(20), validUntil: ago(-3600) });
  expect(await stage("first", { ...settings, reviewMode: "observe" }))
    .toMatchObject({ completed1m: 0, completed5m: 0, progress5m: 1, waiting: 1, status: "processing" });
});

it("uses positive publication transitions and separates blocked approvals from ready publication", async () => {
  vi.stubEnv("CONNECT_AGENT_URL", "http://agent.test");
  await candidate("publish/ready", { state: "approved", decidedBy: "admin", judgedAt: ago(600) });
  await candidate("publish/review-wait", { state: "approved", judgedAt: ago(600) });
  await candidate("publish/classification-wait", { state: "approved", decidedBy: "admin", judgedAt: ago(600) });
  await db.insert(categoryDecisions).values({ repo: "publish/classification-wait", sourceHash: "x", category: null,
    reason: "waiting", actor: "publisher", retryAt: ago(-600), updatedAt: ago(300) });
  await db.insert(crawlPublicationChanges).values([
    { repo: "publication/1", delta: 1, occurredAt: ago(20) },
    { repo: "publication/2", delta: 1, occurredAt: ago(120) },
    { repo: "publication/deleted", delta: -1, occurredAt: ago(10) },
    { repo: "publication/future", delta: 1, occurredAt: ago(-60) },
  ]);
  const result = await stage("publish", { ...settings, reviewMode: "enforce" });
  expect(result).toMatchObject({ completed1m: 1, completed5m: 2, waiting: 1, errors5m: null });
  expect(result.queueNote).toContain("심사·분류 조건 대기 2건");
});
