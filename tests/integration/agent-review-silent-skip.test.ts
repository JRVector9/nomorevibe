import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, modelCapacityRequests,
  operationsObservations, secondReviews } from "@/lib/db/schema";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { ai1LiveCallWindowMs } from "@/lib/crawl/ai1-live-call";
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
  await db.delete(modelCapacityRequests).where(sql`${modelCapacityRequests.logicalWorkKey} LIKE 'ai1:%'
    AND ${modelCapacityRequests.ownerInstanceId} = 'silent-skip-dead-owner'`);
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
  // 호출 기한 안에 시작한(지금 보내진 중일 수 있는) 옛 모델 시도는 보호한다 — 같은 후보에 두 호출을 만들지 않는다
  await db.update(crawlReviewAttempts).set({ state: "running", completedAt: null, retryAfter: null, startedAt: new Date() });
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

const window = () => ai1LiveCallWindowMs(current.provider);

it("moves a running attempt of a removed model whose call window has passed (dead owner) to the current pool", async () => {
  await failOnRemovedModel(["maker/one"]);
  await db.update(crawlReviewAttempts).set({ state: "running", completedAt: null, retryAfter: null,
    startedAt: new Date(Date.now() - window() - 10_000) });
  expect(await tick()).toMatchObject({ status: "completed", done: false });
  expect(review).toHaveBeenCalledOnce();
  expect(review.mock.calls[0][1]).toMatchObject({ model: current.model });
  // 주인이 죽은 running 은 claim 이 owner_changed 로 넘긴다 — 새 시도는 지금 모델이다
  expect((await db.select().from(crawlReviewAttempts).orderBy(crawlReviewAttempts.id)).map(row => [row.model, row.state, row.errorCode]))
    .toEqual([[removed.model, "superseded", "owner_changed"], [current.model, "succeeded", null]]);
});

/** 주인이 죽은 boot 의 dispatched 장부 행(운영의 gpu3090 14:33Z 행과 같은 모양). 모양만 맞춘 고정값이다 — 도메인 증명이 아니다. */
async function deadDispatch(repo: string, ageMs: number) {
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  const hash = "a".repeat(64), requestId = randomUUID();
  const binding = { kind: "ai1_legacy_gateway", version: 1, logicalWorkKey: `ai1:${candidate.id}`, candidateId: candidate.id, attemptId: 900_000 + candidate.id,
    inputHash: hash, sourceRevisionHash: hash, reviewPolicyHash: hash, promptVersion: "fixture", rulesVersion: "fixture",
    provider: "abcllm", model: removed.model, routeId: "crawl-agent-review", stageEpoch: 1, wireHash: hash, servingContractHash: hash,
    totalTokenBound: 8000, chargedTokens: 8000, job: { name: "crawl-agent-review", token: randomUUID(), requestedVersion: 1 } };
  await db.execute(sql`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
      provider_budget_id, group_id, epoch, revision, policy_hash, state, token, reserved_until, queue_until, logical_work_key,
      dispatch_binding, dispatch_binding_hash, dispatched_at, updated_at)
    VALUES (${requestId}::uuid, ${`ai1:${candidate.id}:${hash}`}, 'silent-skip-dead-owner', ${randomUUID()}::uuid, 'first', 'reviewer',
      'crawl-agent-review', 'abcllm', ${removed.model}, 'fixture', 'gpu3090-qwen', 1, 1, ${hash}, 'dispatched', ${randomUUID()}::uuid,
      clock_timestamp() - ${ageMs} * interval '1 millisecond', clock_timestamp(), ${`ai1:${candidate.id}`},
      ${JSON.stringify(binding)}::jsonb, ${hash}, clock_timestamp() - ${ageMs} * interval '1 millisecond',
      clock_timestamp() - ${ageMs} * interval '1 millisecond')`);
}

it.each([["older than the call window", true], ["inside the call window", false]] as const)(
  "a dead-owner dispatched ledger row of a removed model %s pins the candidate only while it may be in flight", async (_label, old) => {
    await failOnRemovedModel(["maker/one"]);
    await deadDispatch("maker/one", old ? ai1LiveCallWindowMs("abcllm") + 10_000 : 5_000);
    const result = await tick();
    if (old) {
      // 장부가 꺼진(disabled) 이 시험에서는 지금 풀의 호출이 나간다. 운영(open)에서는 점유 유일 색인·같은 후보 fence 가 그대로라
      // 이 행이 회수될 때까지 claim 이 work_busy 로 이 후보만 넘긴다(로그와 커서는 지나간다) — 두 호출이 함께 보내지지 않는다.
      expect(review).toHaveBeenCalledOnce();
      expect(review.mock.calls[0][1]).toMatchObject({ model: current.model });
    } else {
      expect(review).not.toHaveBeenCalled();
      expect(result).toMatchObject({ degraded: "agent_review_all_skipped" });
      expect(logged("crawl.agent_review_skipped")).toEqual([expect.objectContaining({ repo: "maker/one", reason: "reviewer_unassigned" })]);
    }
  });

it("moves a retry pinned to a pool model that this tick paused to the next pool slot", async () => {
  const extra = { provider: "claude-cli" as const, model: "extra-first-model" };
  // 두 후보 모두 지금 primary 에서 실패한 재시도다(재시도 시각은 지났다)
  await saveSettings({ reviewConcurrency: 1 }, "test");
  for (const repo of ["maker/one", "maker/two"]) {
    await source(repo);
    await db.update(jobs).set({ cursor: null }).where(eq(jobs.name, "crawl-agent-review"));
    review.mockResolvedValue({ ok: false, error: "timeout" });
    await tick();
  }
  expect((await db.select().from(crawlReviewAttempts)).map(row => [row.model, row.state])).toEqual([[current.model, "failed"], [current.model, "failed"]]);
  await db.update(crawlReviewAttempts).set({ retryAfter: new Date(Date.now() - 1000) });
  await db.update(jobs).set({ cursor: null }).where(eq(jobs.name, "crawl-agent-review"));
  await saveSettings({ firstReviewAdditional: [extra] }, "test");
  // 첫 호출(primary)이 실패해 이 틱에서 primary 가 쉰다 — 두 번째 후보는 primary 에 묶여 기다리지 않고 다음 칸(extra)으로 간다
  review.mockReset().mockResolvedValueOnce({ ok: false, error: "timeout" }).mockResolvedValue(approve);
  vi.mocked(logger.info).mockClear();
  await tick();
  expect(review.mock.calls.map(([, options]) => options.model)).toEqual([current.model, extra.model]);
  expect(logged("crawl.agent_review_skipped")).toEqual([]);
});

it("advances past an unassignable head and reviews the next candidate in the same tick", async () => {
  await failOnRemovedModel(["maker/head"]);
  // 맨 앞 후보는 지금 보내진 중일 수 있는 옛 모델 시도에 묶여 있다(보호)
  await db.update(crawlReviewAttempts).set({ state: "running", completedAt: null, retryAfter: null, startedAt: new Date() });
  await source("maker/next");
  await db.update(crawlCandidates).set({ updatedAt: new Date(Date.now() + 60_000) }).where(eq(crawlCandidates.repo, "maker/next"));
  expect(await tick()).toMatchObject({ status: "completed", done: false });
  expect(review).toHaveBeenCalledOnce();
  expect(logged("crawl.agent_review_skipped")).toEqual([expect.objectContaining({ repo: "maker/head", reason: "reviewer_unassigned" })]);
  expect(logged("crawl.agent_review_tick")).toEqual([expect.objectContaining({ admitted: 2, calls: 1, succeeded: 1,
    skipped: { reviewer_unassigned: 1 } })]);
  // 커서는 두 후보를 모두 지나간다 — 다음 틱은 그 뒤에서 시작하고, 끝에 닿으면 처음으로 돌아온다
  const [next] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, "maker/next"));
  const job = await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-agent-review") });
  expect(job?.cursor).toMatchObject({ firstReviewPoolScan: { id: next.id } });
});
