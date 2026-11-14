import { createHash } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRepositoryClaims, agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments, crawlFrontier,
  crawlReviewAttempts, crawlSettings, jobs, secondReviews } from "@/lib/db/schema";
import { changeReviewMode, getSettings, saveSettings } from "@/lib/crawl/settings";
import { reviewCrawlCandidates } from "@/lib/crawl/jobs/agent-review";
import { firstReviewPoolQuery, loadReviewInput } from "@/lib/crawl/agent-review-repository";
import { firstReviewHasWork } from "@/lib/crawl/published-recheck";
import { FIRST_REVIEW_EVIDENCE_WAIT_MS } from "@/lib/crawl/first-review-evidence";
import { AGENT_DETECTOR_VERSION, type AgentObservation } from "@/lib/domain/evidence/agents/types";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema, resetTables } from "./setup";

/**
 * 1차 심사는 AI 제작 근거 스캔이 자리 잡은 뒤에 돈다(상한 6시간), 이미 승인된 후보는 근거만 늘면 승인을 잇는다 — 2026-11-14.
 * 모델 호출 경계(reviewWithAgent)만 바꾸고 쪽 쿼리·고르기·claim·기록·커서는 실제 DB 로 돈다.
 */
const review = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crawl/agent-review", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: review,
}));
const approve = { ok: true, outcome: { decision: "approve", reason: "A deployed product", evidenceIds: ["product"] }, usage: {} };
const current = { provider: "claude-cli" as const, model: "qwen3.8-flash-next" };
const ROOT_SCOPE_HASH = createHash("sha256").update(JSON.stringify("")).digest("hex");
let commit = 0;

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(secondReviews); await db.delete(crawlReviewAttempts); await db.delete(agentRepositoryObservations);
  await db.delete(agentRepositoryScans); await db.delete(agentRepositoryClaims); await db.delete(crawlCandidates);
  await db.delete(crawlDocuments); await db.delete(crawlFrontier); await db.delete(crawlSettings); await db.delete(jobs);
  await resetTables();
  review.mockReset().mockResolvedValue(approve);
  vi.stubEnv("CRAWL_REVIEW_READY", "true");
  await saveSettings({ enabled: true, firstReview: current, firstReviewAdditional: [] }, "test");
  expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "evidence wait test" })).toMatchObject({ ok: true });
});

/** 지금 원본이 있는 1차 대상 후보. seenAgoMs — 그 원본을 본(판정·수집) 뒤 지난 시간 */
async function source(repo: string, options: { seenAgoMs?: number; state?: "approved" | "needs_review" | "published"; queued?: boolean } = {}) {
  const fetchedAt = new Date(Date.now() - (options.seenAgoMs ?? 2000)), productUrl = `https://${repo.split("/")[1]}.example`;
  await db.insert(crawlDocuments).values({ repo, productUrl, pageStatus: 200, fetchedAt,
    pageMeta: { title: repo, description: "A deployed product", readmeSample: "# App", readmeSampleVersion: "2026-09-14.1" },
    repoMeta: { description: "Orchestrate coding agents", pushed_at: "2026-11-13T00:00:00.000Z", stargazers_count: 3, owner: { type: "User" } } });
  const state = options.state ?? "approved";
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state, reason: state === "needs_review" ? "ai_evidence_pending" : "passed",
    decidedBy: "auto", judgedAt: fetchedAt, updatedAt: fetchedAt, ...(state === "published" ? { publishedSlug: repo.split("/")[1] } : {}) }).returning();
  // 운영(agent_scan_control items)의 모든 1차 후보 저장소는 스캔 대기열에 있다
  if (options.queued ?? true) await db.insert(agentRepositoryClaims).values({ repositoryKey: repo.toLowerCase(), priority: 2, requiresDaily: true, dueAt: new Date() });
  return row;
}
function observation(repo: string, sha: string): AgentObservation {
  return { commitEvidence: { basis: "coauthor", changedPaths: ["src/app.ts"], changeKind: "development", headSha: sha }, kind: "commit_attribution",
    client: "claude-code", compatibleClients: [], modelDeveloper: "anthropic", declaredModelId: null, gateway: null, routing: "unknown", role: null, scope: "",
    keyPath: null, ruleId: "commit.coauthor.v2", sourcePath: null, commitSha: sha, blobSha: null, sourceUrl: `https://github.com/${repo}/commit/${sha}` } as AgentObservation;
}
/** 그 저장소의 스캔 한 건(가장 최근). facts — 붙일 관측 수 */
async function scan(repo: string, values: Partial<typeof agentRepositoryScans.$inferInsert> = {}, facts = 0) {
  const sha = (++commit).toString(16).padStart(40, "0");
  const [row] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(commit), repositoryKey: repo.toLowerCase(),
    commitSha: sha, detectorVersion: AGENT_DETECTOR_VERSION, scope: "", scopeHash: ROOT_SCOPE_HASH, state: "complete",
    startedAt: new Date(Date.now() - 60_000), completedAt: new Date(Date.now() - 30_000), ...values }).returning();
  for (let index = 0; index < facts; index++) await db.insert(agentRepositoryObservations).values({ scanId: row.id,
    observationKey: `${row.id}-${index}`, facts: observation(repo, `${sha.slice(0, 39)}${index}`) });
  return row;
}
const pendingCursor = { commitSha: "0".repeat(40), pendingTrees: [{ sha: "1".repeat(40), path: "" }], pendingBlobs: [], pendingCommits: [] } as never;
const tick = () => runJob("crawl-agent-review", reviewCrawlCandidates, { budgetMs: 110_000 });
const cursor = async () => (await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-agent-review") }))?.cursor as Record<string, unknown> | null;
const reviewedRepos = async () => (await db.select({ repo: crawlCandidates.repo }).from(crawlReviewAttempts)
  .innerJoin(crawlCandidates, eq(crawlCandidates.id, crawlReviewAttempts.candidateId))
  .where(eq(crawlReviewAttempts.state, "succeeded")).orderBy(asc(crawlReviewAttempts.id))).map(row => row.repo);
const poolRepos = async () => (await firstReviewPoolQuery(await getSettings(), 32, null)).map(row => row.candidate.repo).sort();

describe("1차는 AI 제작 근거 스캔이 자리 잡은 뒤에 심사한다", () => {
  it("스캔이 아직 없는 새 후보는 고르지도 건너뛰지도 않고, 같은 틱에 근거가 자리 잡은 후보·스캔 대기열 밖 후보는 심사한다", async () => {
    await source("maker/waiting");
    await source("maker/ready"); await scan("maker/ready", {}, 2);
    await source("maker/unqueued", { queued: false });
    expect(await poolRepos()).toEqual(["maker/ready", "maker/unqueued"]);

    const outcome = await tick();
    expect(outcome).toMatchObject({ status: "completed" });
    expect(outcome).not.toMatchObject({ degraded: expect.anything() });
    expect((await reviewedRepos()).sort()).toEqual(["maker/ready", "maker/unqueued"]);
    expect(review).toHaveBeenCalledTimes(2);
    // 기다리는 후보는 건너뛴 것이 아니다 — 건너뜀 표(first-review-skips.ts)에 오르지 않아 사람에게 넘어가지도 않는다
    expect((await cursor())?.firstReviewSkips).toBeUndefined();
  });

  it("근거만 기다리는 후보뿐이면 1차에 「일 없음」 — 잡이 곧바로 다시 돌지 않고 재판정은 양보하지 않는다", async () => {
    await source("maker/waiting");
    expect(await firstReviewHasWork(await getSettings())).toBe(false);
    expect(await tick()).toMatchObject({ status: "completed" });
    expect(review).not.toHaveBeenCalled();
    expect(await reviewedRepos()).toEqual([]);
  });

  it("기다리는 후보가 한 쪽보다 많아도 뒤의 준비된 후보가 첫 틱에 심사된다 — 쪽 커서가 굶지 않는다(11/11 정체 회귀)", async () => {
    for (let index = 0; index < 40; index++) await source(`maker/waiting-${index}`, { seenAgoMs: 60_000 + index });
    await source("maker/ready"); await scan("maker/ready");
    await tick();
    expect(await reviewedRepos()).toEqual(["maker/ready"]);
    expect((await cursor())?.firstReviewSkips).toBeUndefined();
  });

  it("상한(6시간)이 지나면 스캔이 끝나지 않았어도 그대로 심사한다 — 1차가 굶지 않는다", async () => {
    await source("maker/stalled", { seenAgoMs: FIRST_REVIEW_EVIDENCE_WAIT_MS + 60_000 });
    await scan("maker/stalled", { state: "partial", completedAt: null, cursor: pendingCursor });
    await source("maker/young", { seenAgoMs: FIRST_REVIEW_EVIDENCE_WAIT_MS - 60_000 });
    expect(await poolRepos()).toEqual(["maker/stalled"]);
    await tick();
    expect(await reviewedRepos()).toEqual(["maker/stalled"]);
    const [attempt] = await db.select().from(crawlReviewAttempts);
    expect(attempt.snapshot.scanState).toBe("partial");
  });

  it("이어 볼 범위가 남은 partial·옛 탐지기 스캔은 기다리고, 범위 제한으로 끝난 partial·failed·complete 는 기다리지 않는다", async () => {
    await source("maker/resuming"); await scan("maker/resuming", { state: "partial", completedAt: null, cursor: pendingCursor });
    await source("maker/old-detector"); await scan("maker/old-detector", { detectorVersion: "2026-01-01.1" });
    await source("maker/limited"); await scan("maker/limited", { state: "partial", completedAt: null, coverage: { limited: true },
      cursor: { commitSha: "0".repeat(40), pendingTrees: [], pendingBlobs: [], pendingCommits: [], coverageLimited: true } as never });
    await source("maker/failed"); await scan("maker/failed", { state: "failed", completedAt: null, lastErrorCode: "unavailable" });
    await source("maker/complete"); await scan("maker/complete", {}, 1);
    expect(await poolRepos()).toEqual(["maker/complete", "maker/failed", "maker/limited"]);
  });

  it("발행된 후보는 근거가 늘어도 1차 대상이 아니다", async () => {
    await source("maker/published", { state: "published" }); await scan("maker/published", {}, 3);
    expect(await poolRepos()).toEqual([]);
  });
});

describe("이미 승인된 후보는 근거만 늘면 다시 1차 심사하지 않는다", () => {
  /** 상한이 지나 근거 없이(pending) 먼저 승인된 후보 */
  async function approvedEarly(repo: string, state: "approved" | "needs_review" = "approved") {
    const candidate = await source(repo, { seenAgoMs: FIRST_REVIEW_EVIDENCE_WAIT_MS + 60_000, state });
    if (state === "needs_review") review.mockResolvedValueOnce({ ok: true, outcome: { decision: "needs_review", reason: "Unclear", evidenceIds: [] }, usage: {} });
    await tick();
    expect(review).toHaveBeenCalledTimes(1);
    const [first] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, candidate.id));
    expect(first.snapshot.scanState).toBe("pending");
    review.mockClear();
    return { candidate, first };
  }

  it("스캔이 complete 되며 근거가 붙으면 모델을 부르지 않고 그 승인을 지금 입력으로 잇는다", async () => {
    const { candidate, first } = await approvedEarly("maker/grown");
    expect(await reviewedRepos()).toEqual(["maker/grown"]);
    await scan("maker/grown", {}, 2);
    await tick();
    expect(review).not.toHaveBeenCalled();
    const attempts = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, candidate.id)).orderBy(asc(crawlReviewAttempts.id));
    expect(attempts).toHaveLength(2);
    const carried = attempts[1];
    expect(carried).toMatchObject({ state: "succeeded", reusedFromAttemptId: first.id, provider: current.provider, model: current.model,
      outcome: { decision: "approve" } });
    expect(carried.snapshot.scanState).toBe("complete");
    expect(carried.snapshot.evidence).toHaveLength(2);
    // 지금 입력의 승인이다 — 발행 관문(assertReviewApproval)이 보는 입력·원본 해시와 같다
    const [row] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id));
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, row.repo));
    const input = await loadReviewInput(row, document, await getSettings());
    expect({ inputHash: carried.inputHash, sourceRevisionHash: carried.sourceRevisionHash })
      .toEqual({ inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash });
    expect(row).toMatchObject({ state: "approved", signals: expect.objectContaining({ agentReviewAttemptId: carried.id }) });
    // 이은 승인으로 1차 대상에서 빠진다
    expect(await poolRepos()).toEqual([]);
  });

  it("원본(README)이 바뀌었으면 근거가 늘었어도 다시 심사한다", async () => {
    const { candidate } = await approvedEarly("maker/readme");
    await scan("maker/readme", {}, 1);
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, "maker/readme"));
    await db.update(crawlDocuments).set({ pageMeta: { ...document.pageMeta, readmeSample: "# App v2" } }).where(eq(crawlDocuments.id, document.id));
    await tick();
    expect(review).toHaveBeenCalledTimes(1);
    const attempts = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, candidate.id)).orderBy(asc(crawlReviewAttempts.id));
    expect(attempts.map(row => row.reusedFromAttemptId)).toEqual([null, null]);
  });

  it("승인되지 않은 후보(근거 대기 보류)는 근거가 늘면 다시 심사한다", async () => {
    const { candidate } = await approvedEarly("maker/held", "needs_review");
    await scan("maker/held", {}, 1);
    await tick();
    expect(review).toHaveBeenCalledTimes(1);
    const attempts = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, candidate.id)).orderBy(asc(crawlReviewAttempts.id));
    expect(attempts.map(row => row.reusedFromAttemptId)).toEqual([null, null]);
  });
});
