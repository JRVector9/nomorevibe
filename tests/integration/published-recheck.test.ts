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
import { jobRunOptions } from "@/scripts/worker";
import { ensureSchema, resetTables } from "./setup";

/**
 * 공개분 변경 재검수(0171) — 견주기(published-recheck 잡)·올리기·묻기(감사 잡의 재검수 갈래)·보류·기준 갱신을 실제 DB 로 본다.
 * 모델 호출(게이트웨이)만 바꾼다. 심사자는 시험 설정의 1차 심사자를 1차 순위로 고정한 것이다(tests/integration/env.ts).
 */
const gateway = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crawl/agent-review-gateway", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-gateway")>(), reviewWithGateway: gateway,
}));
const COMPANY = 'pageText: "Acme Studio" — a marketing site for a design agency, not a usable product';
const verdict = (decision: "approve" | "reject" | "needs_review", confidence = 0.97) =>
  ({ ok: true, outcome: { decision, reason: decision === "approve" ? 'pageText: "usable app"' : COMPANY, evidenceIds: ["product"], confidence }, usage: {} });
const MODEL = "[MLX] gpt-oss-120b";
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
  gateway.mockReset().mockResolvedValue(verdict("approve"));
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: MODEL }, reviewConcurrency: 2 }, "test");
});
afterEach(() => setRuntimeSettingsForTest(null));

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
    expect(stream).toMatchObject({ status: "rolling", startedBy: "system:published-recheck", provider: "first-review-ranks" });
    expect(await rollingItems()).toEqual([]);
    const [attempt] = await db.select().from(crawlReviewAttempts);
    expect(await baselineOf(approved.id)).toMatchObject({ source: "first_review", attemptId: attempt.id, content: null });
    expect(await baselineOf(approved.id)).toMatchObject({ checkedHash: (await baselineOf(approved.id)).contentHash });
    expect(await baselineOf(plain.id)).toMatchObject({ source: "seeded", attemptId: null });
    // 한 바퀴를 마쳤다 — 처음부터 다시
    expect(await cursorOf()).toEqual({ afterId: 0 });

    // 사람이 연 감사의 자리는 그대로다 — 재검수 줄은 "진행 중인 감사"가 아니다
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

describe("묻기 — 감사 잡의 재검수 갈래", () => {
  it("1차 순위 모델로 묻고, 확신 높은 회사 소개 거절은 감사 보류다 — 상태는 그대로, 답이 새 기준이고, 보류 중에는 다시 올리지 않는다", async () => {
    const product = await listed("e/agency");
    await scan();
    await page("e/agency", { text: words(60, "agency") });
    await scan();
    gateway.mockResolvedValue(verdict("reject", 0.97));
    expect(await ask()).toMatchObject({ status: "completed" });

    expect(gateway).toHaveBeenCalledTimes(1);
    expect(gateway.mock.calls[0][0].snapshot.product.pageText).toContain("agencyaa");
    expect(gateway.mock.calls[0][1]).toMatchObject({ model: MODEL });
    const [item] = await rollingItems();
    expect(item).toMatchObject({ aiDecision: "reject", aiProvider: "abcllm", aiModel: MODEL, promptVersion: REVIEW_PROMPT_VERSION,
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
    expect(gateway).not.toHaveBeenCalled();
    expect((await rollingItems())[0]).toMatchObject({ aiDecision: null, attempts: 0 });
  });
});

describe("사람이 연 감사와 함께 산다", () => {
  it("재검수 줄이 있어도 감사를 열고 닫는다 — 지금 감사·진행 중인 감사는 사람이 연 것이다", async () => {
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

  it("공통 슬롯의 도메인 증명 — 재검수 항목은 지금 코드의 글 판으로만 묻는다", async () => {
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
