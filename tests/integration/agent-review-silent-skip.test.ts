import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, operationsObservations,
  secondReviews } from "@/lib/db/schema";
import { changeReviewMode, saveSettings } from "@/lib/crawl/settings";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { runJob } from "@/lib/jobs/runner";
import { logger } from "@/lib/observability/logger";
import { ensureSchema, resetTables } from "./setup";

/**
 * 2026-11-01 AI1 정체 재현: 운영처럼 firstReviewAdditional: [](풀 모드)·ai1 legacy 에서 같은 입력의 마지막 시도가 지금 풀에 없는 모델의
 * 끝난 실패면 chooseFirstReviewForCandidate 가 null 을 돌려 processCandidate 가 말없이 return 했다 — 틱 로그는 admitted N · calls 0 뿐.
 * 모델 호출 경계(reviewWithAgent)만 바꾸고 고르기·claim·기록은 실제 DB 로 돈다.
 */
const review = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crawl/agent-review", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: review,
}));
const approve = { ok: true, outcome: { decision: "approve", reason: "A deployed product", evidenceIds: ["product"] }, usage: {} };
const current = { provider: "claude-cli" as const, model: "qwen3.8-flash-next" };
const removed = { provider: "claude-cli" as const, model: "removed-first-model" };

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(secondReviews); await db.delete(crawlReviewAttempts); await db.delete(crawlCandidates);
  await db.delete(crawlDocuments); await db.delete(crawlFrontier); await db.delete(crawlSettings); await db.delete(jobs);
  await resetTables();
  review.mockReset().mockResolvedValue(approve);
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  await saveSettings({ enabled: true, firstReview: current, firstReviewAdditional: [] }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "silent skip test" })).toMatchObject({ ok: true });
  vi.spyOn(logger, "info");
});

async function source(repo: string) {
  const fetchedAt = new Date(Date.now() - 2000), productUrl = `https://${repo.split("/")[1]}.example`;
  await db.insert(crawlDocuments).values({ repo, productUrl, pageStatus: 200, fetchedAt,
    pageMeta: { title: repo, description: "A deployed product", readmeSample: "", readmeSampleVersion: "2026-09-14.1" },
    repoMeta: { description: "Orchestrate coding agents", pushed_at: fetchedAt.toISOString(), stargazers_count: 3, owner: { type: "User" } } });
  await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed",
    decidedBy: "auto", judgedAt: fetchedAt, updatedAt: fetchedAt });
}
const tick = () => runJob("crawl-agent-review", reviewCrawlCandidates, { budgetMs: 110_000 });
const logged = (event: string) => vi.mocked(logger.info).mock.calls.filter(([name]) => name === event).map(([, fields]) => fields);

/** 지금 입력에 지금 풀에 없는 모델의 실패 시도를 남긴다(운영의 옛 모델 이름 시도와 같은 모양) — 재시도 대기는 이미 지났다. */
async function failOnRemovedModel(repos: string[]) {
  await saveSettings({ firstReview: removed }, "test");
  review.mockResolvedValue({ ok: false, error: "timeout" });
  // 실패한 모델은 그 틱에서 쉰다 — 후보마다 한 틱씩 돌려 모두 옛 모델 실패를 갖게 한다
  for (const repo of repos) {
    await source(repo);
    await db.update(jobs).set({ cursor: null }).where(eq(jobs.name, "crawl-agent-review"));
    await tick();
  }
  const attempts = await db.select().from(crawlReviewAttempts);
  expect(attempts.map(row => [row.provider, row.model, row.state])).toEqual(repos.map(() => [removed.provider, removed.model, "failed"]));
  await db.update(crawlReviewAttempts).set({ retryAfter: new Date(Date.now() - 1000) });
  await db.update(jobs).set({ cursor: null }).where(eq(jobs.name, "crawl-agent-review"));
  await saveSettings({ firstReview: current }, "test");
  review.mockReset().mockResolvedValue(approve);
  vi.mocked(logger.info).mockClear();
}

it("reassigns a settled retry of a model removed from an empty-extra pool and makes the call", async () => {
  await failOnRemovedModel(["maker/one", "maker/two"]);
  expect(await tick()).toMatchObject({ status: "completed", done: false });
  expect(review).toHaveBeenCalledTimes(2);
  expect(review.mock.calls.map(([, options]) => options.model)).toEqual([current.model, current.model]);
  expect(logged("crawl.agent_review_tick")).toEqual([expect.objectContaining({ admitted: 2, calls: 2, succeeded: 2, skipped: {} })]);
  const attempts = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.state, "succeeded"));
  expect(attempts.map(row => row.model)).toEqual([current.model, current.model]);
  // 시도 예산은 모델과 무관하게 이어진다 — 옛 모델의 실패 1건이 그대로 남는다
  expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.state, "failed"))).toHaveLength(2);
});

it("names every still-protected skip, counts it in the tick summary and records an all-skipped degraded tick", async () => {
  await failOnRemovedModel(["maker/one", "maker/two"]);
  // 진행 중(running)인 옛 모델 시도는 그대로 보호한다 — 다른 모델로 옮기지 않는다
  await db.update(crawlReviewAttempts).set({ state: "running", completedAt: null, retryAfter: null });
  const result = await tick();
  expect(result).toMatchObject({ status: "completed", done: false, degraded: "agent_review_all_skipped" });
  expect(review).not.toHaveBeenCalled();
  expect(logged("crawl.agent_review_skipped")).toEqual(expect.arrayContaining([
    expect.objectContaining({ repo: "maker/one", reason: "reviewer_unassigned" }),
    expect.objectContaining({ repo: "maker/two", reason: "reviewer_unassigned" })]));
  expect(logged("crawl.agent_review_tick")).toEqual([expect.objectContaining({ admitted: 2, calls: 0, succeeded: 0,
    skipped: { reviewer_unassigned: 2 } })]);
  const [observation] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, "job:crawl-agent-review"));
  expect(observation.value).toMatchObject({ degraded: { code: "agent_review_all_skipped", detail: "reviewer_unassigned=2", streak: 1 } });
  // 제 일 못 한 틱은 성공 시각을 옮기지 않는다
  expect((await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-agent-review") }))?.lastSuccessAt).toBeNull();
});
