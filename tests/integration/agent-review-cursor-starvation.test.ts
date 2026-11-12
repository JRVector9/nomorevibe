import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, secondReviews } from "@/lib/db/schema";
import { changeReviewMode, saveSettings } from "@/lib/crawl/settings";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { releaseLostDelegatedReviews } from "@/lib/crawl/human-review-repository";
import { DEEPSEEK_REVIEW_PROVIDER } from "@/lib/crawl/deepseek-review-policy";
import { FIRST_REVIEW_SKIP_STREAK_LIMIT } from "@/lib/crawl/first-review-skips";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema, resetTables } from "./setup";

/**
 * 2026-11-11 16:00Z~ 1차 심사 정체 재현 — 같은 후보 2건(심사한 적 있음, 주인 잃은 DeepSeek 위임 시도가 running)만 매 틱 건너뛰고(running)
 * ceiling 위의 새 후보 1,030건을 굶겼다. 모델 호출 경계(reviewWithAgent)만 바꾸고 쪽 쿼리·claim·기록·커서는 실제 DB 로 돈다.
 */
const review = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crawl/agent-review", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: review,
}));
const approve = { ok: true, outcome: { decision: "approve", reason: "A deployed product", evidenceIds: ["product"] }, usage: {} };
const current = { provider: "claude-cli" as const, model: "qwen3.8-flash-next" };
const DAY = 24 * 3600_000;

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(secondReviews); await db.delete(crawlReviewAttempts); await db.delete(crawlCandidates);
  await db.delete(crawlDocuments); await db.delete(crawlFrontier); await db.delete(crawlSettings); await db.delete(jobs);
  await resetTables();
  review.mockReset().mockResolvedValue(approve);
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  await saveSettings({ enabled: true, firstReview: current, firstReviewAdditional: [] }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "cursor starvation test" })).toMatchObject({ ok: true });
});

/** 지금 원본이 있는 1차 대상 후보(approved) */
async function source(repo: string) {
  const fetchedAt = new Date(Date.now() - 2000), productUrl = `https://${repo.split("/")[1]}.example`;
  await db.insert(crawlDocuments).values({ repo, productUrl, pageStatus: 200, fetchedAt,
    pageMeta: { title: repo, description: "A deployed product", readmeSample: "", readmeSampleVersion: "2026-09-14.1" },
    repoMeta: { description: "Orchestrate coding agents", pushed_at: fetchedAt.toISOString(), stargazers_count: 3, owner: { type: "User" } } });
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "approved", reason: "passed",
    decidedBy: "auto", judgedAt: fetchedAt, updatedAt: fetchedAt }).returning();
  return row;
}
/** 사람 몫 후보(1차 대상이 아니다) — 시도 행만 붙이려고 쓴다 */
async function held(repo: string) {
  const [row] = await db.insert(crawlCandidates).values({ repo, state: "needs_review", reason: "second_review_split", decidedBy: "auto" }).returning();
  return row;
}
const fixtureHash = (c: string) => c.repeat(64);
const attemptBase = (candidateId: number) => ({ candidateId, inputHash: fixtureHash("f"), policyHash: fixtureHash("e"),
  sourceRevisionHash: fixtureHash("d"), snapshot: {} as never, source: {} as never, promptVersion: "old", rulesVersion: "old", attemptNumber: 1 });
/** 지난 입력에서 성공한 1차 시도 — 「심사한 적 있음」(지금 입력의 승인은 아니라 다시 1차 대상이다) */
async function reviewedBefore(candidateId: number) {
  await db.insert(crawlReviewAttempts).values({ ...attemptBase(candidateId), kind: "automatic", state: "succeeded",
    provider: current.provider, model: "old-model", outcome: approve.outcome as never,
    startedAt: new Date(Date.now() - 3 * DAY), completedAt: new Date(Date.now() - 3 * DAY), validUntil: new Date(Date.now() - 2 * DAY) });
}
/** running 으로 남은 DeepSeek 위임 시도(운영 11-10 08:18Z 행과 같은 모양) */
async function delegatedRunning(candidateId: number, options: { leaseToken: string; ageMs: number; provider?: string; kind?: "delegated" | "automatic" }) {
  const [row] = await db.insert(crawlReviewAttempts).values({ ...attemptBase(candidateId), kind: options.kind ?? "delegated", state: "running",
    provider: options.provider ?? DEEPSEEK_REVIEW_PROVIDER, model: "deepseek-fixture", actor: `${options.provider ?? DEEPSEEK_REVIEW_PROVIDER}:1`,
    leaseToken: options.leaseToken, startedAt: new Date(Date.now() - options.ageMs), validUntil: new Date(Date.now() + DAY) }).returning();
  return row;
}
const tick = () => runJob("crawl-agent-review", reviewCrawlCandidates, { budgetMs: 110_000 });
const cursor = async () => (await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-agent-review") }))?.cursor as Record<string, unknown> | null;
const reviewedRepos = async () => (await db.select({ repo: crawlCandidates.repo }).from(crawlReviewAttempts)
  .innerJoin(crawlCandidates, eq(crawlCandidates.id, crawlReviewAttempts.candidateId))
  .where(sql`${crawlReviewAttempts.state} = 'succeeded' AND ${crawlReviewAttempts.model} = ${current.model}`)).map(row => row.repo);

describe("1차 쪽 커서 — 심사한 적 있는 후보를 지나간다", () => {
  it("건너뛴 심사한 후보를 커서가 지나가 다음 틱에 쪽이 비고, 그다음 틱에 ceiling 이 새로 잡혀 새 후보를 본다", async () => {
    const stuck = await source("maker/stuck");
    await reviewedBefore(stuck.id);
    await delegatedRunning(stuck.id, { leaseToken: randomUUID(), ageMs: 2 * DAY });

    // 틱 1: 쪽 [stuck] — 위임 시도가 running 이라 비킨다. 커서는 「심사한 적 있음」=true 로 그 후보를 지나간다
    expect(await tick()).toMatchObject({ status: "completed", degraded: "agent_review_all_skipped" });
    expect(review).not.toHaveBeenCalled();
    expect((await cursor())?.firstReviewPoolScan).toMatchObject({ id: stuck.id, reviewed: true, ceiling: stuck.id });

    // ceiling 보다 id 가 큰 새 후보(운영의 1,030건)
    const fresh = await source("maker/fresh");
    expect(fresh.id).toBeGreaterThan(stuck.id);

    // 틱 2: 커서 뒤(심사한 묶음의 stuck 다음)·ceiling 아래에 남은 후보가 없다 — 쪽이 비어 커서를 처음으로 돌린다
    expect(await tick()).toMatchObject({ status: "completed", done: false });
    expect(review).not.toHaveBeenCalled();
    expect((await cursor())?.firstReviewPoolScan).toBeNull();

    // 틱 3: 새 ceiling — 한 번도 안 본 새 후보가 먼저다
    await tick();
    expect(await reviewedRepos()).toEqual(["maker/fresh"]);
    expect((await cursor())?.firstReviewPoolScan).toMatchObject({ id: stuck.id, reviewed: true, ceiling: fresh.id });
  });
});

describe("주인 잃은 위임 시도 정리(human-deepseek-review 틱 시작)", () => {
  it("lease 를 쥔 살아 있는 잡이 없고 오래된 DeepSeek 위임 시도만 닫고, 그 뒤 1차가 그 후보를 본다", async () => {
    const own = randomUUID(), alive = randomUUID();
    await db.insert(jobs).values([{ name: "human-deepseek-review", leaseToken: own, lockedAt: sql`now()` as never, requestedVersion: 1 },
      { name: "split-confirm", leaseToken: alive, lockedAt: sql`now()` as never, requestedVersion: 1 }]);
    const lease = { name: "human-deepseek-review", token: own, requestedVersion: 1 };
    const orphanCandidate = await source("maker/orphan");
    await reviewedBefore(orphanCandidate.id);
    const orphan = await delegatedRunning(orphanCandidate.id, { leaseToken: randomUUID(), ageMs: 2 * DAY });
    const liveOwner = await delegatedRunning((await held("keep/live-owner")).id, { leaseToken: alive, ageMs: 2 * DAY });
    const recent = await delegatedRunning((await held("keep/recent")).id, { leaseToken: randomUUID(), ageMs: 60_000 });
    const mine = await delegatedRunning((await held("keep/mine")).id, { leaseToken: own, ageMs: 2 * DAY });
    const qwen = await delegatedRunning((await held("keep/qwen")).id, { leaseToken: randomUUID(), ageMs: 2 * DAY, provider: "qwen-direct" });
    const automatic = await delegatedRunning((await held("keep/automatic")).id, { leaseToken: randomUUID(), ageMs: 2 * DAY, kind: "automatic", provider: "claude-cli" });

    const released = await releaseLostDelegatedReviews(lease, 60_000);
    expect(released.map(row => row.id)).toEqual([orphan.id]);
    const rows = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.state, "running")).orderBy(asc(crawlReviewAttempts.id));
    // 살아 있는 주인·시작한 지 얼마 안 된 것·지금 lease·다른 종류는 그대로다
    expect(rows.map(row => row.id)).toEqual([liveOwner.id, recent.id, mine.id, qwen.id, automatic.id]);
    const [closed] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, orphan.id));
    expect(closed).toMatchObject({ state: "failed", errorCode: "owner_lost" });
    expect(closed.retryAfter).not.toBeNull();

    // 막혔던 후보를 1차가 이제 본다
    await tick();
    expect(await reviewedRepos()).toEqual(["maker/orphan"]);
  });
});

describe("1차 건너뜀 상한 — 사람 확인으로 넘기기", () => {
  const capped = (candidateId: number, firstCappedAt: number) => ({ [String(candidateId)]: { reason: "running", streak: FIRST_REVIEW_SKIP_STREAK_LIMIT - 1,
    strikes: 2, firstCappedAt, excludedUntil: null, lastAt: Date.now() - 60_000 } });

  it("세 번째로 상한에 닿고 다른 후보가 나아갔으면 사람 확인(ai_review_skip_exhausted)으로 넘기고 까닭을 남긴다", async () => {
    const stuck = await source("maker/stuck");
    await reviewedBefore(stuck.id);
    await delegatedRunning(stuck.id, { leaseToken: randomUUID(), ageMs: 2 * DAY });
    await source("maker/fresh");
    await db.insert(jobs).values({ name: "crawl-agent-review", cursor: { firstReviewSkips: capped(stuck.id, Date.now() - 3600_000) } });
    await tick();
    expect(await reviewedRepos()).toEqual(["maker/fresh"]);
    const [after] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, stuck.id));
    expect(after).toMatchObject({ state: "needs_review", reason: "ai_review_skip_exhausted", decidedBy: "auto" });
    expect(after.signals).toMatchObject({
      firstReviewSkipExhausted: { previousState: "approved", previousReason: "passed", skipReason: "running", strikes: 3, streakLimit: 5 },
      stoppedAt: { rule: "AI 1차 심사", detail: expect.stringContaining("같은 까닭으로 계속 건너뜀 — 다른 검수(1차·위임)가 이 후보를 보는 중(running)") } });
    // 넘긴 후보는 표에서 지운다 — 다시 1차 대상이 아니다
    expect((await cursor())?.firstReviewSkips).toBeUndefined();
  });

  it.each([["다른 후보의 진전이 없으면", false], ["위임 시도의 주인이 살아 있으면", true]] as const)("%s 넘기지 않고 빼 두기만 이어진다", async (_label, liveOwner) => {
    const stuck = await source("maker/stuck");
    await reviewedBefore(stuck.id);
    const alive = randomUUID();
    if (liveOwner) {
      await db.insert(jobs).values({ name: "human-deepseek-review", leaseToken: alive, lockedAt: sql`now()` as never, requestedVersion: 1 });
      await source("maker/fresh");
    }
    await delegatedRunning(stuck.id, { leaseToken: liveOwner ? alive : randomUUID(), ageMs: 2 * DAY });
    await db.insert(jobs).values({ name: "crawl-agent-review", cursor: { firstReviewSkips: capped(stuck.id, Date.now() - 3600_000) } });
    await tick();
    const [after] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, stuck.id));
    expect(after).toMatchObject({ state: "approved", reason: "passed" });
    const skips = (await cursor())?.firstReviewSkips as Record<string, { strikes: number; excludedUntil: number }>;
    expect(skips[String(stuck.id)]).toMatchObject({ strikes: 3 });
    expect(skips[String(stuck.id)].excludedUntil).toBeGreaterThan(Date.now());
    // 빼 둔 동안은 쪽에 들지 않는다 — 다음 틱은 그 후보를 다시 건너뛰지 않는다
    review.mockClear();
    await tick();
    const again = (await cursor())?.firstReviewSkips as Record<string, { strikes: number; streak: number }>;
    expect(again[String(stuck.id)]).toMatchObject({ strikes: 3, streak: 0 });
  });
});
