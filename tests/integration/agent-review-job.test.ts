import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs } from "@/lib/db/schema";
import { changeReviewMode, saveSettings } from "@/lib/crawl/settings";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema, resetTables } from "./setup";

/** 외부 CLI만 바꾼다. 규칙·claim·기록·lease는 실제 DB로 돈다 */
const review = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crawl/agent-review", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: review,
}));
const approve = { ok: true, outcome: { decision: "approve", reason: "A deployed product", evidenceIds: ["product"] }, usage: {} };

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  review.mockReset().mockResolvedValue(approve);
  vi.stubEnv("CRAWL_REVIEW_MODEL", "test-model");
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  await saveSettings({ enabled: true }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "agent review job test" })).toMatchObject({ ok: true });
});

async function source(repo: string, productUrl: string, candidate: { state: "approved" | "needs_review"; reason: "passed" | "ambiguous" },
  pageMeta: Record<string, unknown>) {
  const fetchedAt = new Date(Date.now() - 2000);
  await db.insert(crawlDocuments).values({ repo, productUrl, pageStatus: 200, fetchedAt, pageMeta,
    repoMeta: { description: "Orchestrate coding agents", pushed_at: fetchedAt.toISOString(), stargazers_count: 3, owner: { type: "User" } } });
  await db.insert(crawlCandidates).values({ repo, productUrl, ...candidate, decidedBy: "auto", judgedAt: fetchedAt, updatedAt: fetchedAt });
}
const tick = () => runJob("crawl-agent-review", reviewCrawlCandidates);

it("rejects a held candidate whose refetched body is an install page even when the model would approve", async () => {
  // codex 재현 그대로: owner.github.io 하위 경로라 사람 심사에 보류된 후보를 재수집했더니 본문이 설치 안내였다.
  // 같은 문서에 pageFactsFromDocument()를 적용하면 거부인데, AI 경로에서는 모델 승인으로 approved가 됐다.
  await source("someone/loom", "https://someone.github.io/loom", { state: "needs_review", reason: "ambiguous" },
    { title: "Loom", description: "Orchestrate coding agents", textSample: "Loom · orchestrate agents. Install: npm install -g loom" });
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: "rejected", reason: "not_a_product", decidedBy: "auto" }]);
  expect(review).not.toHaveBeenCalled();
  expect(await db.select().from(crawlReviewAttempts)).toMatchObject([{ provider: "rules", state: "succeeded", outcome: { decision: "reject" } }]);
  expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-publish") })).toBeUndefined();
});

it("records two concurrent model approvals and requests publication once", async () => {
  await source("maker/one", "https://one.example", { state: "approved", reason: "passed" }, { title: "One", description: "A deployed product" });
  await source("maker/two", "https://two.example", { state: "approved", reason: "passed" }, { title: "Two", description: "A deployed product" });
  let started = 0, release!: () => void;
  const bothStarted = new Promise<void>(resolve => { release = resolve; });
  review.mockImplementation(async () => {
    if (++started === 2) release();
    // 직렬로 돌면 두 번째 호출이 시작되지 않는다. 20초 제한 둘은 25초 예산에 들어가지 않는다
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([bothStarted, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("reviews ran serially")), 2_000); })]);
    clearTimeout(timer);
    return approve;
  });
  expect(await tick()).toMatchObject({ status: "completed" });
  expect(review).toHaveBeenCalledTimes(2);
  const attempts = await db.select().from(crawlReviewAttempts);
  expect(attempts.map(attempt => [attempt.provider, attempt.state])).toEqual([["claude-cli", "succeeded"], ["claude-cli", "succeeded"]]);
  expect(new Set(attempts.map(attempt => attempt.candidateId)).size).toBe(2);
  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: "approved" }, { state: "approved" }]);
  expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-publish") })).toMatchObject({ requestedVersion: 1 });
});
