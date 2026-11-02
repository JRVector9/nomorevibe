import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, secondReviews } from "@/lib/db/schema";
import { changeReviewMode, saveSettings } from "@/lib/crawl/settings";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { runJob } from "@/lib/jobs/runner";
import { logger } from "@/lib/observability/logger";
import { ensureSchema, resetTables } from "./setup";

/**
 * 1차 순위 대체(2026-11-01 운영자 결정): 설정 풀은 순위다 — firstReview 1순위, firstReviewAdditional 2·3순위. 1순위를 이 틱에 쓸 수 없을 때만
 * 다음 순위로 가고, grok-cli 를 마지막 순위에 두면 앞 순위를 모두 쓸 수 없을 때만 부른다. 모델 호출 경계(claude·grok CLI 실행)만 바꾼다.
 */
const claude = vi.hoisted(() => vi.fn());
const grok = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crawl/agent-review", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: claude,
}));
vi.mock("@/lib/crawl/agent-review-grok", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-grok")>(), reviewWithGrokCli: grok,
}));
const approve = { ok: true, outcome: { decision: "approve", reason: "A deployed product", evidenceIds: ["product"] }, usage: {} };
const rank1 = { provider: "claude-cli" as const, model: "qwen3.8-flash-next" };
const rank2 = { provider: "claude-cli" as const, model: "second-rank-model" };
const lastRank = { provider: "grok-cli" as const, model: "grok-4.7" };

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(secondReviews); await db.delete(crawlReviewAttempts); await db.delete(crawlCandidates);
  await db.delete(crawlDocuments); await db.delete(crawlFrontier); await db.delete(crawlSettings); await db.delete(jobs);
  await resetTables();
  claude.mockReset().mockResolvedValue(approve);
  grok.mockReset().mockResolvedValue({ ...approve, outcome: { ...approve.outcome, confidence: 0.9 } });
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  await saveSettings({ enabled: true, reviewConcurrency: 1, firstReview: rank1, firstReviewAdditional: [lastRank] }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "rank fallback test" })).toMatchObject({ ok: true });
  vi.spyOn(logger, "info");
});

let serial = 0;
async function source(count: number) {
  const repos: string[] = [];
  for (let index = 0; index < count; index++) {
    const repo = `rank/app-${++serial}`, fetchedAt = new Date(Date.now() - 2000), productUrl = `https://rank-${serial}.example`;
    await db.insert(crawlDocuments).values({ repo, productUrl, pageStatus: 200, fetchedAt,
      pageMeta: { title: repo, description: "A deployed product", readmeSample: "", readmeSampleVersion: "2026-09-14.1" },
      repoMeta: { description: "Orchestrate coding agents", pushed_at: fetchedAt.toISOString(), stargazers_count: 3, owner: { type: "User" } } });
    // 고정한 순서로 들이게 updatedAt 을 하나씩 늦춘다
    await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed", decidedBy: "auto", judgedAt: fetchedAt,
      updatedAt: new Date(fetchedAt.getTime() + index) });
    repos.push(repo);
  }
  return repos;
}
const tick = () => runJob("crawl-agent-review", reviewCrawlCandidates, { budgetMs: 110_000 });
const logged = (event: string) => vi.mocked(logger.info).mock.calls.filter(([name]) => name === event).map(([, fields]) => fields);
const calledModels = () => [...claude.mock.calls.map(([, options]) => `claude:${options.model}`), ...grok.mock.calls.map(([, options]) => `grok:${options.model}`)];

it("uses rank 1 while it is usable and never calls the grok-cli last rank", async () => {
  await source(3);
  await tick();
  expect(claude).toHaveBeenCalledTimes(3);
  expect(claude.mock.calls.every(([, options]) => options.model === rank1.model)).toBe(true);
  expect(grok).not.toHaveBeenCalled();
});

it("moves later candidates to the grok-cli last rank only after rank 1 became unusable in the tick (engine down)", async () => {
  await source(3);
  // 1순위 엔진이 내려갔다 — 첫 호출이 network 로 실패하면 그 모델은 이 틱에 쉰다
  claude.mockResolvedValue({ ok: false, error: "network" });
  await tick();
  expect(calledModels()).toEqual([`claude:${rank1.model}`, `grok:${lastRank.model}`, `grok:${lastRank.model}`]);
  const attempts = await db.select().from(crawlReviewAttempts).orderBy(crawlReviewAttempts.id);
  expect(attempts.map(row => [row.provider, row.model, row.state])).toEqual([
    ["claude-cli", rank1.model, "failed"], ["grok-cli", lastRank.model, "succeeded"], ["grok-cli", lastRank.model, "succeeded"]]);
});

it("keeps the listed order as rank order: rank 2 before the grok-cli last rank", async () => {
  await saveSettings({ firstReviewAdditional: [rank2, lastRank] }, "test");
  await source(2);
  claude.mockImplementation(async (_input, options) => options.model === rank1.model ? { ok: false, error: "network" } : approve);
  await tick();
  expect(calledModels()).toEqual([`claude:${rank1.model}`, `claude:${rank2.model}`]);
  expect(grok).not.toHaveBeenCalled();
});

it("skips with all_ranks_unusable when every rank is unusable and the queue moves past those candidates", async () => {
  const repos = await source(3);
  claude.mockResolvedValue({ ok: false, error: "network" });
  grok.mockResolvedValue({ ok: false, error: "network" });
  await tick();
  expect(calledModels()).toEqual([`claude:${rank1.model}`, `grok:${lastRank.model}`]);
  expect(logged("crawl.agent_review_skipped")).toEqual([expect.objectContaining({ repo: repos[2], reason: "all_ranks_unusable", ranks: 2, unusable: 2 })]);
  const [last] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repos[2]));
  expect((await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-agent-review") }))?.cursor)
    .toMatchObject({ firstReviewPoolScan: { id: last.id } });
});

it("a saved rank order takes effect on the next tick without a restart", async () => {
  await source(1);
  await tick();
  expect(calledModels()).toEqual([`claude:${rank1.model}`]);
  // 관리자가 순위를 바꿔 저장한다(설정 저장 경로 — /admin/models 1차 순위 폼이 쓰는 것과 같다)
  await saveSettings({ firstReview: lastRank, firstReviewAdditional: [rank1] }, "test");
  await source(1);
  await db.update(jobs).set({ cursor: null }).where(eq(jobs.name, "crawl-agent-review"));
  claude.mockClear(); grok.mockClear();
  await tick();
  expect(calledModels()).toEqual([`grok:${lastRank.model}`]);
});
