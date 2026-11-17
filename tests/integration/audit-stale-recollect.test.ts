import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { agentRepositoryClaims, agentRepositoryScans, crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, jobs, operationsObservations,
  productAuditCampaigns, productAuditItems, productAuditRecollects, productAuditSecondOpinions, products } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { getSettings, saveSettings, setQwenAutoStep } from "@/lib/crawl/settings";
import { QWEN_AUTO_OBSERVATION, qwenSecondOpinionStatus } from "@/lib/crawl/audit-second-opinion-auto";
import { auditRecollectScanDemand, AUDIT_RECOLLECT_WAIT_MS } from "@/lib/crawl/audit-stale-recollect";
import { startProductAudit } from "@/lib/crawl/product-audit";
import { resetQwenAuditBackoff } from "@/lib/crawl/qwen-endpoint-backoff";
import { reviewAuditSecondOpinions } from "@/lib/crawl/jobs/audit-second-opinion";
import { AGENT_SCAN_PRIORITY, fillAgentScanQueue } from "@/lib/domain/evidence/agents/claims";
import { AGENT_DETECTOR_VERSION } from "@/lib/domain/evidence/agents/types";
import { runJob } from "@/lib/jobs/runner";
import { jobRunOptions } from "@/scripts/worker";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

/**
 * 입력 기한이 지난 감사 거절의 원본 다시 받기(0188, lib/crawl/audit-stale-recollect.ts) — 실제 PostgreSQL.
 * 두 번째 의견 잡(audit-second-opinion)이 기한 지난 감사 거절을 만나면 기존 수집 길(crawl_frontier → crawl-fetch)을 다시 열고, 수집이 원본을
 * 덮어쓴 뒤의 틱에서 끝남(바뀐 근거 칸)으로 적고 새 입력으로 묻는다. 수집이 404 로 끝나면 사람 몫(failed)으로 두고 다시 고르지 않는다.
 * 스캔은 스캔 줄 채우기(fillAgentScanQueue)가 1차 심사 몫 우선순위로 올린다. 모델(gpu3090 Qwen)만 가짜다.
 */
const server = vi.hoisted(() => ({ calls: [] as { repo: string; readme: string }[] }));
async function fakeQwen(_url: string | URL | Request, init?: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init?.body));
  const user: string = body.messages[1].content;
  const product = JSON.parse(user.slice(user.indexOf("\n") + 1, user.lastIndexOf("\n"))).product;
  server.calls.push({ repo: product.repo, readme: product.readme });
  const content = JSON.stringify({ decision: "approve", reason: "Usable product.", evidenceIds: ["product"], confidence: 0.95 });
  return new Response(JSON.stringify({ model: "qwen3.8-flash-next", choices: [{ finish_reason: "stop", message: { content } }],
    usage: { prompt_tokens: 5_000, completion_tokens: 120 } }), { status: 200 });
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  for (const table of [productAuditItems, productAuditCampaigns, crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, jobs,
    agentRepositoryClaims]) await db.delete(table);
  await db.delete(operationsObservations).where(eq(operationsObservations.key, QWEN_AUTO_OBSERVATION));
  await resetTables();
  server.calls.length = 0;
  resetQwenAuditBackoff();
  vi.stubGlobal("fetch", vi.fn(fakeQwen));
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" }, reviewConcurrency: 1 }, "test");
  const expected = (await getSettings()).qwenAuto.auditSecondOpinion;
  expect(await setQwenAutoStep({ step: "auditSecondOpinion", expected, actor: "jr", reason: "다시 받기 시험",
    next: { enabled: true, perTick: 10, scope: "all", autoClose: false, recollectPerTick: 1 } })).toMatchObject({ ok: true });
});
afterEach(() => vi.unstubAllGlobals());

let sequence = 0;
/** 공개 제품 하나 — 원본은 50일 전(11/01 grok 감사가 본 8~9월 원본처럼), 수집 행은 오래전에 끝났다 */
async function listed(repo: string, readme = "옛 README — 설치 안내만") {
  const slug = repo.split("/")[1];
  const url = `https://${slug}.test`;
  await db.insert(products).values({ slug, url, name: slug, tagline: "한 줄", description: "소개", category: "Productivity", status: "seeded",
    source: "crawler", verifyToken: `token-${++sequence}`, editTokenHash: "h".repeat(64) });
  await crawl.putDocument({ repo, productUrl: url, pageStatus: 200,
    repoMeta: { description: "레포", stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: "User" } },
    pageMeta: { title: slug, textSample: "쓸 수 있는 앱 — 가입하고 바로 씁니다. ".repeat(14), readmeSample: readme } });
  await db.update(crawlDocuments).set({ fetchedAt: sql`now() - interval '50 days'` }).where(eq(crawlDocuments.repo, repo));
  await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", reason: "passed", decidedBy: "auto",
    publishedSlug: slug, judgedAt: new Date(), decidedAt: new Date() });
  await db.insert(crawlFrontier).values({ repo, signal: "Claude 커밋 트레일러", state: "done", updatedAt: sql`now() - interval '50 days'` });
}
/** 감사(사람이 연 것)를 열고 grok 처럼 답을 직접 적은 뒤 닫는다 */
async function judged(repos: string[]) {
  for (const repo of repos) await listed(repo);
  await startProductAudit({ startedBy: "jr", reason: "감사", reauditKept: false });
  for (const repo of repos) {
    await db.update(productAuditItems).set({ aiDecision: "reject", aiConfidence: 0.97, aiReason: "pageText: only install docs",
      reviewedAt: sql`now()`, attempts: 1 }).where(eq(productAuditItems.slug, repo.split("/")[1]));
  }
  await db.update(productAuditCampaigns).set({ status: "done" });
}
/** 기존 수집 길의 끝 — crawl-fetch 가 원본을 받아 덮어쓴 것처럼(saveFetchedDocument 와 같은 칸: fetched_at = clock_timestamp(), 프론티어 done) */
async function fetched(repo: string, readme: string) {
  const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, repo));
  await db.update(crawlDocuments).set({ pageMeta: { ...document.pageMeta, readmeSample: readme }, fetchedAt: sql`clock_timestamp()` })
    .where(eq(crawlDocuments.repo, repo));
  await db.update(crawlFrontier).set({ state: "done", updatedAt: sql`clock_timestamp()` }).where(eq(crawlFrontier.repo, repo));
}
const opinion = () => runJob("audit-second-opinion", reviewAuditSecondOpinions,
  { budgetMs: jobRunOptions("audit-second-opinion", { requestedOnly: true }).budgetMs });
const recollectOf = async (slug: string) => {
  const [item] = await db.select().from(productAuditItems).where(eq(productAuditItems.slug, slug));
  const [row] = await db.select().from(productAuditRecollects).where(eq(productAuditRecollects.itemId, item.id));
  return row;
};
const frontierOf = async (repo: string) => (await db.select().from(crawlFrontier).where(eq(crawlFrontier.repo, repo)))[0];

describe("input_stale → 원본 다시 받기 → 두 번째 의견", () => {
  it("기존 수집 길을 다시 열고(프론티어 pending·crawl-fetch 깨움), 수집 뒤 틱에서 끝남·바뀐 근거를 적고 새 입력으로 묻는다", async () => {
    await judged(["r/stale-app"]);
    expect(await opinion()).toMatchObject({ status: "completed" });
    expect(server.calls).toEqual([]);
    const waiting = await recollectOf("stale-app");
    expect(waiting).toMatchObject({ state: "waiting", requests: 1, repo: "r/stale-app", failureCode: null });
    expect(waiting.beforeDigest).toHaveProperty("readme");
    expect(await frontierOf("r/stale-app")).toMatchObject({ state: "pending", attempts: 0, lastError: null });
    const [fetchJob] = await db.select().from(jobs).where(eq(jobs.name, "crawl-fetch"));
    expect(fetchJob?.requestedVersion).toBeGreaterThanOrEqual(1);
    // 다시 받는 중에는 고르지 않는다 — 예전처럼 input_stale 로 쉬는 기록도 남기지 않는다
    expect(await opinion()).toMatchObject({ status: "completed" });
    expect(server.calls).toEqual([]);
    const [observation] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, QWEN_AUTO_OBSERVATION));
    expect(Object.keys((observation?.value as { failures?: object } | undefined)?.failures ?? {})).toEqual([]);

    await fetched("r/stale-app", "새 README — 브라우저에서 바로 쓰는 앱");
    expect(await opinion()).toMatchObject({ status: "completed" });
    const done = await recollectOf("stale-app");
    expect(done).toMatchObject({ state: "done", sourceChanged: true, changedFields: ["readme"] });
    expect(done.afterFetchedAt!.getTime()).toBeGreaterThan(done.beforeFetchedAt!.getTime());
    expect(server.calls).toEqual([{ repo: "r/stale-app", readme: "새 README — 브라우저에서 바로 쓰는 앱" }]);
    const rows = await db.select().from(productAuditSecondOpinions).orderBy(asc(productAuditSecondOpinions.id));
    expect(rows.map((row) => [row.decision, row.source])).toEqual([["approve", "qwen-v2-auto"]]);

    const status = await qwenSecondOpinionStatus(await getSettings());
    expect(status.recollect).toEqual({ waiting: 0, done: 1, changed: 1, failed: 0, failures: {} });
    expect(status.audit.recollectPerTick).toBe(1);
  });

  it("한 틱에 recollectPerTick(1) 건만 요청하고 나머지는 예전처럼 쉰다", async () => {
    await judged(["r/one", "r/two", "r/three"]);
    expect(await opinion()).toMatchObject({ status: "completed" });
    const rows = await db.select().from(productAuditRecollects);
    expect(rows.map((row) => row.state)).toEqual(["waiting"]);
    const pending = await db.select().from(crawlFrontier).where(eq(crawlFrontier.state, "pending"));
    expect(pending).toHaveLength(1);
    const [observation] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, QWEN_AUTO_OBSERVATION));
    const failures = (observation!.value as { failures: Record<string, { code: string }> }).failures;
    expect(Object.values(failures).map((failure) => failure.code)).toEqual(["input_stale", "input_stale"]);
  });
});

describe("다시 받기 실패 → 사람 몫", () => {
  it("요청 뒤 수집이 404 로 끝나면 사유를 남겨 실패로 두고, 그 뒤로는 고르지도 다시 요청하지도 않는다", async () => {
    await judged(["r/gone"]);
    await opinion();
    await db.update(crawlFrontier).set({ state: "skipped", lastError: crawl.SKIP_NOT_FOUND, updatedAt: sql`clock_timestamp()` })
      .where(eq(crawlFrontier.repo, "r/gone"));
    await opinion();
    const failed = await recollectOf("gone");
    expect(failed).toMatchObject({ state: "failed", failureCode: "repo_deleted", failureDetail: crawl.GONE_DETAIL });
    for (let tick = 0; tick < 2; tick += 1) await opinion();
    expect(await recollectOf("gone")).toMatchObject({ state: "failed", requests: 1 });
    expect(await frontierOf("r/gone")).toMatchObject({ state: "skipped" });
    expect(server.calls).toEqual([]);
    const status = await qwenSecondOpinionStatus(await getSettings());
    expect(status.recollect).toMatchObject({ failed: 1, failures: { repo_deleted: 1 } });
    // 남은 수(remaining)에서도 빠진다 — 두 번째 의견의 일감이 아니라 사람 몫이다
    expect(status.audit.remaining).toBe(0);
  });

  it("앞선 수집이 원본 뒤에 이미 실패로 끝나 있었으면 GitHub 를 다시 부르지 않고 바로 실패로 적는다", async () => {
    await judged(["r/broken"]);
    await db.update(crawlFrontier).set({ state: "failed", lastError: "GitHub 500", updatedAt: sql`now() - interval '10 days'` })
      .where(eq(crawlFrontier.repo, "r/broken"));
    await opinion();
    expect(await recollectOf("broken")).toMatchObject({ state: "failed", failureCode: "source_refresh_failed" });
    expect(await frontierOf("r/broken")).toMatchObject({ state: "failed", lastError: "GitHub 500" });
  });

  it("정한 시간 안에 새로워지지 않으면 recollect_timeout 으로 사람 몫이다", async () => {
    await judged(["r/slow"]);
    await opinion();
    await db.update(productAuditRecollects).set({ requestedAt: sql`clock_timestamp() - ${AUDIT_RECOLLECT_WAIT_MS + 60_000} * interval '1 millisecond'` });
    await opinion();
    expect(await recollectOf("slow")).toMatchObject({ state: "failed", failureCode: "recollect_timeout" });
  });

  it("그 사이 사람이 정한 항목은 dropped 로 닫는다(스캔 수요에서도 빠진다)", async () => {
    await judged(["r/decided"]);
    await opinion();
    await db.update(productAuditItems).set({ humanDecision: "kept", humanBy: "jr", humanAt: new Date() });
    await opinion();
    expect(await recollectOf("decided")).toMatchObject({ state: "dropped" });
  });
});

describe("스캔은 기존 스캔 줄(claims)로", () => {
  it("다시 받는 중이고 마지막 스캔이 오래된 저장소를 스캔 줄 채우기가 1차 심사 몫 우선순위·매일 수요로 올린다", async () => {
    await judged(["r/scanned"]);
    await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(42), repositoryKey: "r/scanned", commitSha: "a".repeat(40),
      detectorVersion: AGENT_DETECTOR_VERSION, scopeHash: "s".repeat(64), state: "complete", startedAt: sql`now() - interval '40 days'`,
      completedAt: sql`now() - interval '40 days'`, nextAttemptAt: sql`now() - interval '39 days'` });
    const before = await db.execute<{ repository_key: string }>(sql`select * from ${auditRecollectScanDemand()} demand`);
    expect(before.map((row) => row.repository_key)).toEqual([]);
    await opinion();
    expect(await recollectOf("scanned")).toMatchObject({ state: "waiting" });
    const demand = await db.execute<{ repository_key: string }>(sql`select * from ${auditRecollectScanDemand()} demand`);
    expect(demand.map((row) => row.repository_key)).toEqual(["r/scanned"]);
    await fillAgentScanQueue({ settings: await getSettings() });
    const [claim] = await db.select().from(agentRepositoryClaims).where(eq(agentRepositoryClaims.repositoryKey, "r/scanned"));
    expect(claim).toMatchObject({ priority: AGENT_SCAN_PRIORITY.review, requiresDaily: true, state: "active" });
    expect(claim.dueAt.getTime()).toBeLessThanOrEqual(Date.now());

    // 원본만 다시 받았다 — 스캔이 오래돼 아직 묻지 않는다(기다림)
    await fetched("r/scanned", "옛 README — 설치 안내만");
    await opinion();
    expect(await recollectOf("scanned")).toMatchObject({ state: "waiting" });
    expect(server.calls).toEqual([]);
    // 스캔 줄이 새 스캔을 끝냈다 — 끝남으로 적고 묻는다. 근거 칸은 그대로다
    await db.update(agentRepositoryScans).set({ completedAt: sql`clock_timestamp()`, startedAt: sql`clock_timestamp()` });
    await opinion();
    expect(await recollectOf("scanned")).toMatchObject({ state: "done", sourceChanged: false, changedFields: [] });
    expect(server.calls.map((call) => call.repo)).toEqual(["r/scanned"]);
    expect((await db.execute(sql`select * from ${auditRecollectScanDemand()} demand`)).length).toBe(0);
  });
});
