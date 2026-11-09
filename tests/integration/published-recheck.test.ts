import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs, productAuditAttempts, productAuditCampaigns, productAuditItems,
  productRecheckBaselines, products } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { getSettings, saveSettings } from "@/lib/crawl/settings";
import { createReviewInput, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { auditSettings, cancelProductAudit, listAuditFindings, lockAuditDispatchItem, productAuditOverview, runningAuditCampaign,
  startProductAudit } from "@/lib/crawl/product-audit";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { recheckPublishedChanges } from "@/lib/crawl/jobs/published-recheck";
import { recheckOverview, rollingStream } from "@/lib/crawl/published-recheck";
import { runJob } from "@/lib/jobs/runner";
import { setRuntimeSettingsForTest } from "@/lib/operations/runtime-settings-store";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { setAiTaskModelsForTest, type AiTaskModelSnapshotRow } from "@/lib/llm/ai-task-models-snapshot";
import { noteRecheckRankPaused, recheckRankPaused, resetRecheckLanes } from "@/lib/crawl/published-recheck-lanes";
import { cliRankRow } from "../fake-cli-path";
import { jobRunOptions } from "@/scripts/worker";
import { ensureSchema, resetTables } from "./setup";

/**
 * 공개분 변경 재판정(0171) — 견주기(published-recheck 잡)·올리기·묻기(감사 잡의 재판정 갈래)·보류·기준 갱신을 실제 DB 로 본다.
 * 심사자는 「작업 ↔ 모델」의 발행분 감사 · 변경 재판정(product-audit) 순위를 시험 고정(setAiTaskModelsForTest)한 것이다 — 1차 순위(env.ts 가 고정)와 따로다.
 * 장부 입장(backgroundCliPath)과 모델 호출(원격 OpenCode·Claude CLI)만 바꾼다. 감사 경로 장부 binding·원격 호스트는 tests/integration/cli-model-capacity-admission 이 본다.
 */
const calls = vi.hoisted(() => ({ path: vi.fn(), remote: vi.fn(), agent: vi.fn() }));
vi.mock("@/lib/llm/cli-model-capacity", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/llm/cli-model-capacity")>(), backgroundCliPath: calls.path,
}));
vi.mock("@/lib/crawl/product-audit-model-capacity", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/crawl/product-audit-model-capacity")>(), reviewAuditWithRemoteCliModelCapacity: calls.remote,
}));
vi.mock("@/lib/crawl/agent-review", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review")>(), reviewWithAgent: calls.agent,
}));
const COMPANY = 'pageText: "Acme Studio" — a marketing site for a design agency, not a usable product';
const verdict = (decision: "approve" | "reject" | "needs_review", confidence = 0.97) =>
  ({ ok: true, outcome: { decision, reason: decision === "approve" ? 'pageText: "usable app"' : COMPANY, evidenceIds: ["product"], confidence }, usage: {} });
/** 1차 심사 설정(옛 firstReview — 1차 승인 기록의 provider·model 칸에만 쓴다) */
const MODEL = "[MLX] gpt-oss-120b";
const OPENCODE = "opencode-go/deepseek-v4.1-flash";
const OPENCODE_CONNECTION = "0a0b0c0d-0000-4000-8000-000000000001";
/** 발행분 감사 · 변경 재판정 순위 — 1순위 M3 OpenCode(원격 호스트), 2순위 Claude CLI */
const ranks = (): AiTaskModelSnapshotRow[] => {
  const first = cliRankRow("product-audit", OPENCODE, { rank: 1, cliTool: "opencode", label: "M3 OpenCode", connectionId: OPENCODE_CONNECTION });
  return [Object.freeze({ ...first, connection: Object.freeze({ ...first.connection, baseUrl: "http://m3.test:4096/v1", apiKey: "k".repeat(40) }) }),
    cliRankRow("product-audit", "sonnet", { rank: 2, cliTool: "claude", label: "Claude CLI", connectionId: "0a0b0c0d-0000-4000-8000-000000000002" })];
};
const remoteResult = (decision: "approve" | "reject" | "needs_review", confidence = 0.97) => ({ kind: "result", result: verdict(decision, confidence) });
const words = (count: number, prefix: string) => Array.from({ length: count }, (_, index) =>
  `${prefix}${String.fromCharCode(97 + (index % 26))}${String.fromCharCode(97 + Math.floor(index / 26))}`).join(" ");
const APP_TEXT = words(60, "notes");

beforeAll(() => ensureSchema());
beforeEach(async () => {
  setRuntimeSettingsForTest(null);
  await db.delete(productAuditAttempts);
  await db.delete(productAuditItems);
  await db.delete(productAuditCampaigns);
  await db.delete(productRecheckBaselines);
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  calls.path.mockReset().mockImplementation(async (_route: string, _model: string, provider?: string) => provider === "opencode-cli" ? "native" : "legacy");
  calls.remote.mockReset().mockResolvedValue(remoteResult("approve"));
  calls.agent.mockReset().mockResolvedValue(verdict("approve"));
  setAiTaskModelsForTest(ranks());
  resetRecheckLanes();
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: MODEL }, reviewConcurrency: 2 }, "test");
});
afterEach(() => { setRuntimeSettingsForTest(null); setAiTaskModelsForTest(null); });

let sequence = 0;
/** 원본을 바꾼다 — 다시 받은 것처럼(제목·본문·소개·토픽) */
async function page(repo: string, over: { title?: string; text?: string; description?: string } = {}) {
  const slug = repo.split("/")[1];
  await crawl.putDocument({ repo, productUrl: `https://${slug}.test`, pageStatus: 200,
    repoMeta: { description: over.description ?? "메모 앱", stargazers_count: 3 + ++sequence, pushed_at: new Date().toISOString(), owner: { type: "User" },
      topics: ["notes"] },
    pageMeta: { title: over.title ?? slug, textSample: over.text ?? APP_TEXT } });
}
/** 공개된 제품 하나 — approved 면 1차 심사의 성공 승인 기록(그때의 입력 그대로)을 남긴다 */
async function listed(repo: string, over: { approved?: boolean; text?: string } = {}) {
  const slug = repo.split("/")[1];
  const [product] = await db.insert(products).values({
    slug, url: `https://${slug}.test`, name: slug, tagline: "한 줄", description: "소개", category: "Productivity", status: "seeded", source: "crawler",
    verifyToken: `token-${++sequence}`, editTokenHash: "h".repeat(64),
  }).returning();
  await page(repo, { text: over.text });
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://${slug}.test`, state: "published", reason: "passed",
    decidedBy: "auto", publishedSlug: slug, judgedAt: new Date(), decidedAt: new Date() }).returning();
  if (over.approved !== false) {
    const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, repo));
    const input = createReviewInput(candidate, document, auditSettings(await getSettings()), { scan: null, observations: [] });
    await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: "automatic", state: "succeeded", inputHash: input.inputHash,
      policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot, source: input.source,
      promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: "abcllm", model: MODEL, attemptNumber: 1,
      outcome: { decision: "approve", reason: 'pageText: "notes"', evidenceIds: ["product"], confidence: 0.9 }, completedAt: new Date(),
      validUntil: input.validUntil });
  }
  return product;
}
const scan = () => runJob("published-recheck", recheckPublishedChanges, { budgetMs: 25_000 });
const ask = () => runJob("product-audit", auditPublishedProducts, { budgetMs: jobRunOptions("product-audit", { requestedOnly: true }).budgetMs });
const rollingItems = async () => {
  const stream = await rollingStream();
  return stream ? db.select().from(productAuditItems).where(eq(productAuditItems.campaignId, stream.id)).orderBy(asc(productAuditItems.id)) : [];
};
const baselineOf = async (productId: number) => (await db.select().from(productRecheckBaselines).where(eq(productRecheckBaselines.productId, productId)))[0];
const cursorOf = async () => (await db.select({ cursor: jobs.cursor }).from(jobs).where(eq(jobs.name, "published-recheck")))[0]?.cursor as { afterId: number } | undefined;

describe("견주기 — 기준", () => {
  it("1차 승인과 같으면 올리지 않고 그 승인을 가리킨다. 승인 기록이 없는 제품은 지금 내용으로 시작한다", async () => {
    const approved = await listed("a/approved");
    const plain = await listed("a/plain", { approved: false });
    expect(await scan()).toMatchObject({ status: "completed" });

    const stream = await rollingStream();
    expect(stream).toMatchObject({ status: "rolling", startedBy: "system:published-recheck", provider: "product-audit-ranks" });
    expect(await rollingItems()).toEqual([]);
    const [attempt] = await db.select().from(crawlReviewAttempts);
    expect(await baselineOf(approved.id)).toMatchObject({ source: "first_review", attemptId: attempt.id, content: null });
    expect(await baselineOf(approved.id)).toMatchObject({ checkedHash: (await baselineOf(approved.id)).contentHash });
    expect(await baselineOf(plain.id)).toMatchObject({ source: "seeded", attemptId: null });
    // 한 바퀴를 마쳤다 — 처음부터 다시
    expect(await cursorOf()).toEqual({ afterId: 0 });

    // 사람이 연 감사의 자리는 그대로다 — 재판정 줄은 "진행 중인 감사"가 아니다
    expect(await runningAuditCampaign()).toBeNull();
    expect((await productAuditOverview()).campaign).toBeNull();
    expect(await scan()).toMatchObject({ status: "completed" });
    expect(await db.select().from(productAuditCampaigns)).toHaveLength(1);
  });
});

describe("견주기 — 바뀜", () => {
  it("이름·본문이 크게 바뀐 것만 올린다 — 숫자·스타만 바뀐 것은 올리지 않고, 기다리는 동안 다시 올리지 않는다", async () => {
    const renamed = await listed("b/renamed");
    const counter = await listed("b/counter");
    const pivot = await listed("b/pivot");
    await scan();
    await page("b/renamed", { title: "Royal Casino Bonus" });
    await page("b/counter", { text: `${APP_TEXT} 1,234 users 2026-11-09` });
    await page("b/pivot", { text: words(60, "casino") });
    await scan();

    const items = await rollingItems();
    expect(items.map((item) => [item.slug, item.round])).toEqual([["renamed", 1], ["pivot", 1]]);
    expect(items[0]).toMatchObject({ aiDecision: null, attempts: 0, enrolledAt: expect.any(Date) });
    expect(items[0].changeSummary).toMatchObject({ version: 1, fields: [{ field: "name", kind: "changed" }],
      baseline: { source: "first_review" } });
    expect(items[1].changeSummary).toMatchObject({ fields: [{ field: "pageText", kind: "changed", similarity: 0 }] });
    expect(await baselineOf(counter.id)).toMatchObject({ source: "first_review" });
    expect((await baselineOf(counter.id)).checkedHash).not.toBe((await baselineOf(counter.id)).contentHash);

    await page("b/renamed", { title: "Royal Casino Bonus 2" });
    await scan();
    expect(await rollingItems()).toHaveLength(2);
    expect([renamed.id, pivot.id]).toEqual(items.map((item) => item.productId));
  });

  it("하루 상한에 닿으면 그 제품 앞에서 멈추고, 상한이 풀리면 이어서 올린다", async () => {
    setRuntimeSettingsForTest({ version: 1, jobs: { "published-recheck": { dailyCap: 1 } } });
    const first = await listed("c/first");
    await listed("c/second");
    await scan();
    await page("c/first", { title: "Totally Different Name" });
    await page("c/second", { title: "Another Different Name" });
    await scan();
    expect((await rollingItems()).map((item) => item.slug)).toEqual(["first"]);
    expect(await cursorOf()).toEqual({ afterId: first.id });

    await scan();
    expect((await rollingItems()).map((item) => item.slug)).toEqual(["first"]);
    setRuntimeSettingsForTest({ version: 1, jobs: { "published-recheck": { dailyCap: 5 } } });
    await scan();
    expect((await rollingItems()).map((item) => item.slug)).toEqual(["first", "second"]);
  });

  it("하루 상한 0 은 멈춤이다 — 줄도 만들지 않는다", async () => {
    setRuntimeSettingsForTest({ version: 1, jobs: { "published-recheck": { dailyCap: 0 } } });
    await listed("d/one");
    await scan();
    expect(await rollingStream()).toBeNull();
    expect(await db.select().from(productRecheckBaselines)).toEqual([]);
  });
});

describe("묻기 — 감사 잡의 재판정 갈래", () => {
  it("발행분 감사 · 변경 재판정 1순위로 묻고, 확신 높은 회사 소개 거절은 감사 보류다 — 상태는 그대로, 답이 새 기준이고, 보류 중에는 다시 올리지 않는다", async () => {
    const product = await listed("e/agency");
    await scan();
    await page("e/agency", { text: words(60, "agency") });
    await scan();
    calls.remote.mockResolvedValue(remoteResult("reject", 0.97));
    expect(await ask()).toMatchObject({ status: "completed" });

    expect(calls.remote).toHaveBeenCalledTimes(1);
    expect(calls.agent).not.toHaveBeenCalled();
    const [request] = calls.remote.mock.calls[0];
    expect(request.input.snapshot.product.pageText).toContain("agencyaa");
    // 순위의 연결·모델로 감사 경로(product-audit)의 원격 OpenCode 를 부른다 — 감사 시작 때 굳힌 심사자가 아니다
    expect(request).toMatchObject({ campaign: { provider: "opencode-cli", model: OPENCODE, promptVersion: REVIEW_PROMPT_VERSION },
      source: { connectionId: OPENCODE_CONNECTION } });
    expect(calls.path).toHaveBeenCalledWith("product-audit", OPENCODE, "opencode-cli", OPENCODE_CONNECTION);
    const [item] = await rollingItems();
    expect(item).toMatchObject({ aiDecision: "reject", aiProvider: "opencode-cli", aiModel: OPENCODE, promptVersion: REVIEW_PROMPT_VERSION,
      rulesVersion: REVIEW_RULES_VERSION, attempts: 1, humanDecision: null });
    const [held] = await db.select().from(products).where(eq(products.id, product.id));
    expect(held).toMatchObject({ status: "seeded", auditHoldItemId: item.id });
    expect(held.auditHoldAt).not.toBeNull();
    expect(await baselineOf(product.id)).toMatchObject({ source: "recheck", itemId: item.id, attemptId: null });
    expect((await baselineOf(product.id)).content).toMatchObject({ pageText: expect.stringContaining("agencyaa") });

    // 사람이 볼 목록(감사 거절과 같은 줄) — 무엇이 바뀌었는지 함께
    const stream = (await rollingStream())!;
    const findings = await listAuditFindings(stream.id, "reject", { limit: 10, offset: 0 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ slug: "agency", changeSummary: { fields: [{ field: "pageText" }] } });
    expect((await recheckOverview()).counts).toMatchObject({ openReject: 1, held: 1, pending: 0, rejectedDay: 1 });

    await page("e/agency", { text: words(60, "casino") });
    await scan();
    expect(await rollingItems()).toHaveLength(1);
  });

  it("승인은 기준만 새로 둔다 — 같은 내용은 다시 올리지 않고, 또 바뀌면 다음 회차로 올린다", async () => {
    const product = await listed("f/app");
    await scan();
    await page("f/app", { title: "App Two" });
    await scan();
    await ask();
    const [first] = await rollingItems();
    expect(first).toMatchObject({ aiDecision: "approve", round: 1 });
    expect(await baselineOf(product.id)).toMatchObject({ source: "recheck", itemId: first.id });
    const [kept] = await db.select().from(products).where(eq(products.id, product.id));
    expect(kept.auditHoldAt).toBeNull();

    await scan();
    expect(await rollingItems()).toHaveLength(1);
    await page("f/app", { title: "Something Else Entirely" });
    await scan();
    expect((await rollingItems()).map((item) => item.round)).toEqual([1, 2]);
  });

  it("묻기 0 이면 묻지 않는다", async () => {
    setRuntimeSettingsForTest({ version: 1, jobs: { "published-recheck": { askBatch: 0 } } });
    await listed("g/app");
    await scan();
    await page("g/app", { title: "Changed Title" });
    await scan();
    await ask();
    expect(calls.remote).not.toHaveBeenCalled();
    expect((await rollingItems())[0]).toMatchObject({ aiDecision: null, attempts: 0 });
  });

  it("1순위가 감사 경로에서 열리지 않으면(경로·계약 없음·포화) 그 틱은 2순위로 묻는다", async () => {
    calls.path.mockImplementation(async (_route: string, _model: string, provider?: string) => {
      if (provider === "opencode-cli") throw new ModelCapacityDeferredError("unmapped");
      return "legacy";
    });
    calls.agent.mockResolvedValue(verdict("needs_review", 0.6));
    await listed("j/app");
    await scan();
    await page("j/app", { title: "Changed Title For Rank Two" });
    await scan();
    await ask();
    expect(calls.remote).not.toHaveBeenCalled();
    expect(calls.agent).toHaveBeenCalledTimes(1);
    expect(calls.agent.mock.calls[0][1]).toMatchObject({ model: "sonnet" });
    expect(calls.path.mock.calls.map((call) => call.slice(0, 3))).toEqual([["product-audit", OPENCODE, "opencode-cli"], ["product-audit", "sonnet"]]);
    expect((await rollingItems())[0]).toMatchObject({ aiDecision: "needs_review", aiProvider: "claude-cli", aiModel: "sonnet" });
  });

  it("2026-11-09 API 순위가 차례면 감사 잡은 묻지 않고 Qwen 직접 감사 잡에 맡긴다 — 그 줄이 그 순위를 쉼으로 적으면 다음 CLI 순위로 묻는다", async () => {
    const api = Object.freeze({ task: "product-audit", slot: 1, rank: 1, model: "qwen3.8-flash-next", enabled: true, options: Object.freeze({}),
      connection: Object.freeze({ id: "0a0b0c0d-0000-4000-8000-000000000009", label: "gpu3090-qwen", kind: "api" as const, baseUrl: "http://gpu.test:8090/v1",
        cliTool: null, deviceId: "gpu3090-qwen", enabled: true, models: [{ id: "qwen3.8-flash-next", maxModelLen: 131072 }], contextTokens: null, apiKey: null,
        keyUnreadable: false }) }) satisfies AiTaskModelSnapshotRow;
    setAiTaskModelsForTest([api, cliRankRow("product-audit", "sonnet", { rank: 2, cliTool: "claude", label: "Claude CLI", connectionId: "0a0b0c0d-0000-4000-8000-000000000002" })]);
    calls.agent.mockResolvedValue(verdict("approve"));
    await listed("l/app");
    await scan();
    await page("l/app", { title: "Changed Title For Api Rank" });
    await scan();
    await ask();
    expect(calls.path).not.toHaveBeenCalled();
    expect(calls.agent).not.toHaveBeenCalled();
    expect((await rollingItems())[0]).toMatchObject({ aiDecision: null, attempts: 0 });

    noteRecheckRankPaused({ rank: 1, provider: "local-direct", connectionId: api.connection.id, model: api.model }, "capacity");
    await db.update(jobs).set({ notBefore: null }).where(eq(jobs.name, "product-audit"));
    await ask();
    expect(calls.agent).toHaveBeenCalledTimes(1);
    expect((await rollingItems())[0]).toMatchObject({ aiDecision: "approve", aiProvider: "claude-cli", aiModel: "sonnet" });
  });

  it("2026-11-09 CLI 1순위가 열리지 않으면 그 순위를 쉼으로 적고, 2순위 API 는 Qwen 직접 감사 잡에 맡긴다(감사 잡이 부르지 않음)", async () => {
    calls.path.mockImplementation(async (_route: string, _model: string, provider?: string) => {
      if (provider === "opencode-cli") throw new ModelCapacityDeferredError("capacity");
      return "legacy";
    });
    const [opencode] = ranks();
    const api = Object.freeze({ ...opencode, rank: 2, model: "qwen3.8-flash-next", connection: Object.freeze({ id: "0a0b0c0d-0000-4000-8000-000000000009",
      label: "gpu3090-qwen", kind: "api" as const, baseUrl: "http://gpu.test:8090/v1", cliTool: null, deviceId: "gpu3090-qwen", enabled: true,
      models: [{ id: "qwen3.8-flash-next", maxModelLen: 131072 }], contextTokens: null, apiKey: null, keyUnreadable: false }) }) satisfies AiTaskModelSnapshotRow;
    setAiTaskModelsForTest([opencode, api]);
    await listed("m/app");
    await scan();
    await page("m/app", { title: "Changed Title For Rank Pause" });
    await scan();
    await ask();
    expect(calls.path.mock.calls.map((call) => call.slice(0, 3))).toEqual([["product-audit", OPENCODE, "opencode-cli"]]);
    expect(calls.remote).not.toHaveBeenCalled();
    expect((await rollingItems())[0]).toMatchObject({ aiDecision: null, attempts: 0 });
    expect(recheckRankPaused({ rank: 1, provider: "opencode-cli", connectionId: OPENCODE_CONNECTION, model: OPENCODE })).toBe(true);
  });

  it("순위가 없으면 묻지 않는다 — 1차 순위로 대신 부르지 않고 항목은 기다린다", async () => {
    setAiTaskModelsForTest([]);
    await listed("k/app");
    await scan();
    await page("k/app", { title: "Changed Title Without Ranks" });
    await scan();
    await ask();
    expect(calls.path).not.toHaveBeenCalled();
    expect(calls.remote).not.toHaveBeenCalled();
    expect(calls.agent).not.toHaveBeenCalled();
    expect((await rollingItems())[0]).toMatchObject({ aiDecision: null, attempts: 0 });
  });
});

describe("사람이 연 감사와 함께 산다", () => {
  it("재판정 줄이 있어도 감사를 열고 닫는다 — 지금 감사·진행 중인 감사는 사람이 연 것이다", async () => {
    await listed("h/one");
    await scan();
    const stream = (await rollingStream())!;
    expect(await startProductAudit({ startedBy: "jr", reason: "감사", reauditKept: false })).toMatchObject({ ok: true, enrolled: 1 });
    const running = await runningAuditCampaign();
    expect(running?.id).not.toBe(stream.id);
    expect((await productAuditOverview()).campaign?.id).toBe(running?.id);
    expect(await cancelProductAudit()).toBe(true);
    expect((await rollingStream())?.status).toBe("rolling");
    expect((await productAuditOverview()).campaign?.status).toBe("cancelled");
  });

  it("2026-11-09 사람이 연 감사는 CLI 순위 중 가장 앞의 것으로 시작한다 — API 순위는 재판정만 쓰고, API 순위뿐이면 시작하지 않는다", async () => {
    await listed("n/one");
    const api = Object.freeze({ task: "product-audit", slot: 1, rank: 1, model: "qwen3.8-flash-next", enabled: true, options: Object.freeze({}),
      connection: Object.freeze({ id: "0a0b0c0d-0000-4000-8000-000000000009", label: "gpu3090-qwen", kind: "api" as const, baseUrl: "http://gpu.test:8090/v1",
        cliTool: null, deviceId: "gpu3090-qwen", enabled: true, models: [{ id: "qwen3.8-flash-next", maxModelLen: 131072 }], contextTokens: null, apiKey: null,
        keyUnreadable: false }) }) satisfies AiTaskModelSnapshotRow;
    setAiTaskModelsForTest([api]);
    expect(await startProductAudit({ startedBy: "jr", reason: "감사", reauditKept: false }))
      .toEqual({ ok: false, error: expect.stringContaining("사람이 연 감사는 OpenCode·Claude CLI 순위로 시작합니다") });
    expect(await runningAuditCampaign()).toBeNull();
    setAiTaskModelsForTest([api, cliRankRow("product-audit", "sonnet", { rank: 2, cliTool: "claude", label: "Claude CLI", connectionId: "0a0b0c0d-0000-4000-8000-000000000002" })]);
    expect(await startProductAudit({ startedBy: "jr", reason: "감사", reauditKept: false })).toMatchObject({ ok: true, enrolled: 1 });
    expect(await runningAuditCampaign()).toMatchObject({ provider: "claude-cli", model: "sonnet", cliSource: null });
  });

  it("공통 슬롯의 도메인 증명 — 재판정 항목은 지금 코드의 글 판으로만 묻는다", async () => {
    await listed("i/one");
    await scan();
    await page("i/one", { title: "Changed Product Name" });
    await scan();
    const stream = (await rollingStream())!;
    const [item] = await rollingItems();
    const campaign = { id: stream.id, provider: "claude-cli", model: "claude-sonnet", promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION };
    expect(await db.transaction((tx) => lockAuditDispatchItem(tx, { itemId: item.id, slug: "one", campaign }))).toEqual({ productId: item.productId, attempts: 0 });
    expect(await db.transaction((tx) => lockAuditDispatchItem(tx, { itemId: item.id, slug: "one", campaign: { ...campaign, promptVersion: "old" } }))).toBeNull();
    expect(await db.transaction((tx) => lockAuditDispatchItem(tx, { itemId: item.id, slug: "one", campaign: { ...campaign, id: stream.id + 1 } }))).toBeNull();
    // 같은 제품을 두 번 올려도(회차) 유일 색인에 걸리지 않는다
    await db.update(productAuditItems).set({ aiDecision: "approve", reviewedAt: sql`now()` }).where(eq(productAuditItems.id, item.id));
    await page("i/one", { title: "Yet Another Product Name" });
    await scan();
    expect((await rollingItems()).map((row) => row.round)).toEqual([1, 2]);
  });
});
