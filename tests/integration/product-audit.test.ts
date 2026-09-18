import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, products,
  productAuditAttempts, productAuditCampaigns, productAuditItems } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { changeReviewMode, saveSettings } from "@/lib/crawl/settings";
import { MAX_REVIEW_ATTEMPTS } from "@/lib/crawl/agent-review-contract";
import { cancelProductAudit, keepAuditedProduct, listAuditFindings, productAuditOverview, removeAuditedProduct,
  startProductAudit } from "@/lib/crawl/product-audit";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema, resetTables } from "./setup";

/** 외부 모델 호출만 바꾼다. 올리기·고르기·기록·lease 는 실제 DB 로 돈다 */
const gateway = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crawl/agent-review-gateway", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-gateway")>(), reviewWithGateway: gateway,
}));
const verdict = (decision: "approve" | "reject" | "needs_review", confidence = 0.9) =>
  ({ ok: true, outcome: { decision, reason: `pageText: "${decision}"`, evidenceIds: ["product"], confidence }, usage: {} });

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.unstubAllEnvs();
  await db.delete(productAuditAttempts);
  await db.delete(productAuditItems);
  await db.delete(productAuditCampaigns);
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(jobs);
  await resetTables();
  gateway.mockReset().mockResolvedValue(verdict("reject"));
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" }, reviewConcurrency: 2 }, "test");
});

let sequence = 0;
/** 공개된 제품 하나. source:false 면 메이커가 직접 올린 것 — 수집 원본이 없다 */
async function listed(repo: string, over: {
  status?: "seeded" | "verified" | "banned" | "unverified"; claimed?: boolean; source?: boolean; text?: string;
} = {}) {
  const slug = repo.split("/")[1];
  const url = `https://${slug}.test`;
  const [product] = await db.insert(products).values({
    slug, url, name: slug, tagline: "한 줄", description: "소개", category: "Productivity",
    status: over.status ?? "seeded", source: over.source === false ? "skill" : "crawler",
    claimedAt: over.claimed ? new Date() : null, verifyToken: `token-${++sequence}`, editTokenHash: "h".repeat(64),
  }).returning();
  if (over.source !== false) await page(repo, over.text ?? "쓸 수 있는 앱");
  if (over.source !== false) {
    await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", reason: "passed", decidedBy: "auto",
      publishedSlug: slug, judgedAt: new Date(), decidedAt: new Date() });
  }
  return product;
}
/** 생존 확인이 본문을 다시 채운 것처럼 원본을 바꾼다 */
async function page(repo: string, text: string) {
  await crawl.putDocument({ repo, productUrl: `https://${repo.split("/")[1]}.test`, pageStatus: 200,
    repoMeta: { description: "레포", stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: "User" } },
    pageMeta: { title: repo.split("/")[1], textSample: text } });
}
const start = (over: Partial<Parameters<typeof startProductAudit>[0]> = {}) =>
  startProductAudit({ startedBy: "jr", reason: "첫 감사", reauditKept: false, ...over });
const tick = () => runJob("product-audit", auditPublishedProducts);
const items = () => db.select().from(productAuditItems).orderBy(asc(productAuditItems.id));

describe("감사 올리기", () => {
  it("공개된 제품만 올리고, 시작할 때의 심사자·글을 굳혀 둔다 — 한 번에 하나만 돈다", async () => {
    await listed("a/seeded");
    await listed("a/verified", { status: "verified" });
    await listed("a/banned", { status: "banned" });
    await listed("a/pending", { status: "unverified", source: false });

    const result = await start();
    expect(result).toMatchObject({ ok: true, enrolled: 2, keptSkipped: 0 });
    expect((await items()).map((item) => item.slug)).toEqual(["seeded", "verified"]);
    const [campaign] = await db.select().from(productAuditCampaigns);
    expect(campaign).toMatchObject({ status: "running", startedBy: "jr", reason: "첫 감사", provider: "abcllm",
      model: "[MLX] gpt-oss-120b", reauditKept: false });

    expect(await start()).toEqual({ ok: false, error: expect.stringContaining("진행 중") });
    expect(await db.select().from(productAuditCampaigns)).toHaveLength(1);
  });

  it("사유 없이는 열지 않는다", async () => {
    expect(await start({ reason: "  " })).toMatchObject({ ok: false });
    expect(await db.select().from(productAuditCampaigns)).toHaveLength(0);
  });

  /**
   * 사람이 유지로 둔 것은 다시 올리지 않는다 — 기한 안이고 그 페이지가 그대로인 동안만.
   * 페이지가 바뀌었거나 기한이 지났거나, "유지 판정도 다시 보기"를 켰으면 다시 올린다.
   */
  it("살아 있는 유지 판정만 다음 감사에서 뺀다", async () => {
    await listed("k/kept");
    await listed("k/other");
    await start();
    await tick();
    const [kept] = await items();
    expect(await keepAuditedProduct({ itemId: kept.id, slug: "kept", by: "jr", note: "직접 열어 봤다" })).toEqual({ ok: true });
    await cancelProductAudit();

    // 스타·푸시 시각만 바뀐 것은 페이지가 바뀐 것이 아니다
    await db.update(crawlDocuments).set({ repoMeta: { description: "레포", stargazers_count: 99, pushed_at: new Date().toISOString(), owner: { type: "User" } } })
      .where(eq(crawlDocuments.repo, "k/kept"));
    expect(await start({ reason: "두 번째" })).toMatchObject({ ok: true, enrolled: 1, keptSkipped: 1 });
    await cancelProductAudit();

    expect(await start({ reason: "유지도 다시", reauditKept: true })).toMatchObject({ ok: true, enrolled: 2, keptSkipped: 0 });
    await cancelProductAudit();

    await page("k/kept", "이제는 로그인 화면뿐");
    expect(await start({ reason: "페이지가 바뀜" })).toMatchObject({ ok: true, enrolled: 2, keptSkipped: 0 });
    await cancelProductAudit();

    await page("k/kept", "쓸 수 있는 앱");
    expect(await start({ reason: "되돌아옴" })).toMatchObject({ ok: true, keptSkipped: 1 });
    await cancelProductAudit();
    await db.update(productAuditItems).set({ keepUntil: sql`now() - interval '1 minute'` }).where(eq(productAuditItems.id, kept.id));
    expect(await start({ reason: "기한 지남" })).toMatchObject({ ok: true, enrolled: 2, keptSkipped: 0 });
  });
});

describe("감사 잡", () => {
  /** 이 테스트가 감사의 약속이다 — 모델이 전부 "아니다"라고 해도 공개 목록과 후보는 그대로다 */
  it("후보 상태와 제품 상태를 쓰지 않는다 — enforce 에서 모두 거부여도", async () => {
    vi.stubEnv("CRAWL_REVIEW_READY", "true");
    expect(await changeReviewMode({ mode: "enforce", expectedMode: "off", actor: "test", reason: "감사 격리 확인" })).toMatchObject({ ok: true });
    await listed("x/one");
    await listed("x/two", { status: "verified" });
    await listed("x/three", { claimed: true });
    const candidatesBefore = await db.select().from(crawlCandidates).orderBy(asc(crawlCandidates.id));
    const productsBefore = await db.select().from(products).orderBy(asc(products.id));
    await start();

    expect(await tick()).toMatchObject({ status: "completed" });
    expect(await tick()).toMatchObject({ status: "completed" });

    expect(gateway).toHaveBeenCalledTimes(3);
    expect((await items()).map((item) => item.aiDecision)).toEqual(["reject", "reject", "reject"]);
    expect(await db.select().from(crawlCandidates).orderBy(asc(crawlCandidates.id))).toEqual(candidatesBefore);
    expect(await db.select().from(products).orderBy(asc(products.id))).toEqual(productsBefore);
    // 발행 문의 장부에도 쓰지 않고, 발행 잡을 깨우지도 않는다
    expect(await db.select().from(crawlReviewAttempts)).toEqual([]);
    expect(await db.query.jobs.findFirst({ where: eq(jobs.name, "crawl-publish") })).toBeUndefined();
  });

  it("발행 문에 기다리는 후보가 있으면 이 틱은 쉰다", async () => {
    vi.stubEnv("CRAWL_REVIEW_READY", "true");
    expect(await changeReviewMode({ mode: "observe", expectedMode: "off", actor: "test", reason: "양보 확인" })).toMatchObject({ ok: true });
    await listed("y/published");
    await crawl.putDocument({ repo: "y/new", productUrl: "https://new.test", pageStatus: 200,
      repoMeta: { description: "새 것", stargazers_count: 1, pushed_at: new Date().toISOString(), owner: { type: "User" } },
      pageMeta: { title: "New", textSample: "새 앱" } });
    await db.insert(crawlCandidates).values({ repo: "y/new", productUrl: "https://new.test", state: "approved", reason: "passed",
      decidedBy: "auto", judgedAt: new Date() });
    await start();

    await tick();
    expect(gateway).not.toHaveBeenCalled();
    expect((await items())[0]).toMatchObject({ aiDecision: null, attempts: 0 });

    // 문이 비면 감사가 이어서 본다
    await db.delete(crawlCandidates).where(eq(crawlCandidates.repo, "y/new"));
    await tick();
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it("답을 적고 근거를 남긴다 — 주인 없는 것부터 묻는다", async () => {
    await listed("o/owned", { claimed: true });
    await listed("o/unclaimed");
    await saveSettings({ reviewConcurrency: 1 }, "test");
    gateway.mockResolvedValueOnce(verdict("reject", 0.97)).mockResolvedValueOnce(verdict("approve", 0.8));
    await start();

    await tick();
    const [owned, unclaimed] = await items();
    expect(unclaimed).toMatchObject({ aiDecision: "reject", aiConfidence: 0.97, attempts: 1, errorCode: null });
    expect(unclaimed.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(unclaimed.reviewedAt).toBeInstanceOf(Date);
    expect(owned).toMatchObject({ aiDecision: "approve" });
    expect(gateway.mock.calls.map(([input]) => input.snapshot.product.repo)).toEqual(["o/unclaimed", "o/owned"]);
    // 감사는 푸시 나이와 개발 근거 강제를 끈 입력으로 묻는다
    expect(gateway.mock.calls[0][0].snapshot.policy.enforceEligibility).toBe(false);
    const attempts = await db.select().from(productAuditAttempts).orderBy(asc(productAuditAttempts.id));
    expect(attempts.map((attempt) => [attempt.itemId, attempt.provider, attempt.model, attempt.outcome?.decision])).toEqual([
      [unclaimed.id, "abcllm", "[MLX] gpt-oss-120b", "reject"], [owned.id, "abcllm", "[MLX] gpt-oss-120b", "approve"],
    ]);
    expect(attempts[0].source.documentId).toEqual(expect.any(Number));
  });

  it("도중에 1차 심사자를 바꿔도 그 감사는 시작할 때의 모델로 묻는다", async () => {
    await listed("m/one");
    await start();
    await saveSettings({ firstReview: { provider: "abcllm", model: "gemma4-31b" } }, "test");
    await tick();
    expect(gateway.mock.calls[0][1]).toMatchObject({ model: "[MLX] gpt-oss-120b" });
  });

  it("실패는 물러났다가 다시 묻고, 시도를 다 쓰면 멈춘다 — 다른 제품은 막지 않는다", async () => {
    await listed("f/flaky");
    await listed("f/fine");
    await saveSettings({ reviewConcurrency: 1 }, "test");
    gateway.mockImplementation(async (input: { snapshot: { product: { repo: string } } }) =>
      input.snapshot.product.repo === "f/flaky" ? { ok: false, error: "timeout" } : verdict("reject"));
    await start();

    await tick();
    const [flaky, fine] = await items();
    expect(fine).toMatchObject({ aiDecision: "reject" });
    expect(flaky).toMatchObject({ aiDecision: null, attempts: 1, errorCode: "timeout" });
    expect(flaky.retryAt).toBeInstanceOf(Date);

    // 물러나는 동안은 묻지 않는다
    await tick();
    expect(gateway).toHaveBeenCalledTimes(2);

    for (let attempt = 2; attempt <= MAX_REVIEW_ATTEMPTS; attempt++) {
      await db.update(productAuditItems).set({ retryAt: sql`now() - interval '1 second'` }).where(eq(productAuditItems.id, flaky.id));
      await tick();
    }
    expect((await items())[0]).toMatchObject({ aiDecision: null, attempts: MAX_REVIEW_ATTEMPTS });
    await db.update(productAuditItems).set({ retryAt: sql`now() - interval '1 second'` }).where(eq(productAuditItems.id, flaky.id));
    await tick();
    expect(gateway).toHaveBeenCalledTimes(1 + MAX_REVIEW_ATTEMPTS);
    // 더 물을 것이 없으면 감사를 닫는다
    expect((await db.select().from(productAuditCampaigns))[0]).toMatchObject({ status: "done" });
    expect((await productAuditOverview()).counts).toMatchObject({ total: 2, reviewed: 1, failed: 1 });
  });

  it("심사자 자체가 없으면 시도로 세지 않고 잡을 실패로 남긴다", async () => {
    await listed("d/one");
    gateway.mockResolvedValue({ ok: false, error: "not_configured" });
    await start();
    expect(await tick()).toMatchObject({ status: "failed", error: "product_audit_reviewer_unavailable:not_configured" });
    expect((await items())[0]).toMatchObject({ attempts: 0, errorCode: null, aiDecision: null });
    expect(await db.select().from(productAuditAttempts)).toMatchObject([{ errorCode: "not_configured" }]);
  });

  it("수집 원본이 없는 제품은 묻지 않고 답 못 받음으로 센다 — 감사는 끝난다", async () => {
    await listed("s/maker", { status: "verified", source: false });
    await start();
    await tick();
    await tick();
    expect(gateway).not.toHaveBeenCalled();
    expect((await items())[0]).toMatchObject({ errorCode: "no_source", aiDecision: null });
    expect((await db.select().from(productAuditCampaigns))[0]).toMatchObject({ status: "done" });
    expect((await productAuditOverview()).counts).toMatchObject({ total: 1, failed: 1 });
  });

  it("그 사이 내려간 제품은 건너뛰고, 그래도 감사는 끝난다", async () => {
    await listed("b/gone");
    await start();
    await db.update(products).set({ status: "banned" }).where(eq(products.slug, "gone"));
    await tick();
    await tick();
    expect(gateway).not.toHaveBeenCalled();
    expect((await db.select().from(productAuditCampaigns))[0]).toMatchObject({ status: "done" });
    expect((await productAuditOverview()).counts).toMatchObject({ total: 1, reviewed: 0, failed: 0, skipped: 1 });
  });

  it("시작한 뒤 심사 글이 바뀌면 묻지 않고 멈춘 까닭을 보인다", async () => {
    await listed("p/one");
    await start();
    await db.update(productAuditCampaigns).set({ promptVersion: "2000-01-01.1" });
    await tick();
    expect(gateway).not.toHaveBeenCalled();
    expect((await productAuditOverview()).paused).toContain("2000-01-01.1");
  });
});

describe("사람의 결정", () => {
  async function flagged() {
    await listed("h/low");
    await listed("h/high");
    await listed("h/mine", { claimed: true });
    await listed("h/unsure");
    gateway.mockImplementation(async (input: { snapshot: { product: { repo: string } } }) => ({
      "h/low": verdict("reject", 0.6), "h/high": verdict("reject", 0.99), "h/mine": verdict("reject", 1),
      "h/unsure": verdict("needs_review", 0.5),
    })[input.snapshot.product.repo]);
    await start();
    await tick();
    await tick();
    const [campaign] = await db.select().from(productAuditCampaigns);
    return campaign.id;
  }

  it("주인 없는 것 먼저, 확신 높은 순으로 보이고 보류는 따로 모은다", async () => {
    const campaignId = await flagged();
    const page = { limit: 50, offset: 0 };
    expect((await listAuditFindings(campaignId, "reject", page)).map((row) => [row.slug, row.owned])).toEqual([
      ["high", false], ["low", false], ["mine", true],
    ]);
    expect((await listAuditFindings(campaignId, "needs_review", page)).map((row) => row.slug)).toEqual(["unsure"]);
    expect((await productAuditOverview()).counts).toMatchObject({ reviewed: 4, reject: 3, needsReview: 1, openReject: 3, openNeedsReview: 1 });
  });

  it("내리기는 그 제품 하나만 차단하고 누가 했는지 남긴다", async () => {
    const campaignId = await flagged();
    const [high] = await listAuditFindings(campaignId, "reject", { limit: 1, offset: 0 });
    expect(await removeAuditedProduct({ itemId: high.id, slug: "high", by: "jr" })).toEqual({ ok: true });

    const statuses = Object.fromEntries((await db.select().from(products)).map((row) => [row.slug, row.status]));
    expect(statuses).toEqual({ low: "seeded", high: "banned", mine: "seeded", unsure: "seeded" });
    const [item] = await db.select().from(productAuditItems).where(eq(productAuditItems.id, high.id));
    expect(item).toMatchObject({ humanDecision: "removed", humanBy: "jr" });
    expect(item.humanAt).toBeInstanceOf(Date);
    expect((await listAuditFindings(campaignId, "reject", { limit: 50, offset: 0 })).map((row) => row.slug)).toEqual(["low", "mine"]);
    // 두 번 누르면 아무것도 하지 않는다
    expect(await removeAuditedProduct({ itemId: high.id, slug: "high", by: "jr" })).toMatchObject({ ok: false });
  });

  it("폼의 slug 가 그 항목의 제품과 다르면 아무것도 내리지 않는다", async () => {
    const campaignId = await flagged();
    const [high] = await listAuditFindings(campaignId, "reject", { limit: 1, offset: 0 });
    expect(await removeAuditedProduct({ itemId: high.id, slug: "low", by: "jr" })).toMatchObject({ ok: false });
    expect((await db.select().from(products)).every((row) => row.status === "seeded")).toBe(true);
  });

  it("유지는 90일짜리 판정과 메모를 남기고 목록에서 뺀다 — 제품은 건드리지 않는다", async () => {
    const campaignId = await flagged();
    const [high] = await listAuditFindings(campaignId, "reject", { limit: 1, offset: 0 });
    expect(await keepAuditedProduct({ itemId: high.id, slug: "high", by: "jr", note: "  열어 보니 계산기다 " })).toEqual({ ok: true });
    const [{ days }] = await db.select({ days: sql<number>`round(extract(epoch from (${productAuditItems.keepUntil} - now())) / 86400)::int` })
      .from(productAuditItems).where(eq(productAuditItems.id, high.id));
    expect(days).toBe(90);
    const [item] = await db.select().from(productAuditItems).where(eq(productAuditItems.id, high.id));
    expect(item).toMatchObject({ humanDecision: "kept", humanBy: "jr", humanNote: "열어 보니 계산기다" });
    expect((await listAuditFindings(campaignId, "reject", { limit: 50, offset: 0 })).map((row) => row.slug)).toEqual(["low", "mine"]);
    expect((await db.select().from(products)).every((row) => row.status === "seeded")).toBe(true);
  });
});
