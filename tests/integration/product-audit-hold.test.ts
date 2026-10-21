import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, products,
  productAuditAttempts, productAuditCampaigns, productAuditItems, productAuditSecondOpinions, productEvidenceAudit } from "@/lib/db/schema";
import { notifications, productMakerMembers, userFollows } from "@/lib/db/me-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import * as crawl from "@/lib/crawl/repository";
import { getSettings, resetSettings, saveSettings, setAuditHold } from "@/lib/crawl/settings";
import { DEFAULT_AUDIT_HOLD } from "@/lib/crawl/settings-schema";
import { classifyAuditReason } from "@/lib/crawl/audit-reason-category";
import { keepAuditedProduct, productAuditOverview, recordAuditResult, removeAuditedProduct, removeAuditedProducts,
  startProductAudit } from "@/lib/crawl/product-audit";
import { AUDIT_HOLD_SWEEP_BATCH, releaseAllAuditHolds } from "@/lib/crawl/product-audit-hold";
import { importAuditSecondOpinions } from "@/lib/crawl/audit-second-opinion-import";
import { auditPublishedProducts } from "@/lib/crawl/jobs/product-audit";
import { banProduct, unbanProduct } from "@/lib/domain/products/manage";
import { getPublicList } from "@/lib/domain/products/view";
import { productHistory } from "@/lib/domain/products/history";
import { purgeTags } from "@/lib/cdn/purge";
import { sendDelistedNotifications } from "@/lib/jobs/me/notifications";
import { runJob } from "@/lib/jobs/runner";
import { jobRunOptions } from "@/scripts/worker";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

/** 외부 모델 호출만 바꾼다. 올리기·답 적기·보류·쓸기·lease 는 실제 DB 로 돈다 */
const gateway = vi.hoisted(() => vi.fn());
vi.mock("@/lib/crawl/agent-review-gateway", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/crawl/agent-review-gateway")>(), reviewWithGateway: gateway,
}));

/** 사유 갈래(audit-reason-category) — 허용 목록에 드는 것(회사 소개)과 들지 않는 것(글·문서) */
const COMPANY = 'pageText: "Acme Studio" — a marketing site for a design agency, not a usable product';
const CONTENT = 'pageText: "Getting started" — a documentation site for a library, not a usable product';
const verdict = (decision: "approve" | "reject" | "needs_review", confidence: number, reason = COMPANY) =>
  ({ ok: true, outcome: { decision, reason, evidenceIds: ["product"], confidence }, usage: {} });

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
  gateway.mockReset().mockResolvedValue(verdict("reject", 0.97));
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" }, reviewConcurrency: 1 }, "test");
});

let sequence = 0;
async function listed(repo: string, over: Partial<typeof products.$inferInsert> = {}) {
  const slug = repo.split("/")[1];
  const url = `https://${slug}.test`;
  const [product] = await db.insert(products).values({
    slug, url, name: slug, tagline: "한 줄", description: "소개", category: "Productivity", status: "seeded", source: "crawler",
    verifyToken: `token-${++sequence}`, editTokenHash: "h".repeat(64), ...over,
  }).returning();
  await crawl.putDocument({ repo, productUrl: url, pageStatus: 200,
    repoMeta: { description: "레포", stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: "User" } },
    pageMeta: { title: slug, textSample: "쓸 수 있는 앱" } });
  await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", reason: "passed", decidedBy: "auto",
    publishedSlug: slug, judgedAt: new Date(), decidedAt: new Date() });
  return product;
}
const start = (over: Partial<Parameters<typeof startProductAudit>[0]> = {}) =>
  startProductAudit({ startedBy: "jr", reason: "첫 감사", reauditKept: false, ...over });
/** 감사 잡 한 틱 — 쓸기가 먼저 돌고, 진행 중인 감사의 남은 것을 묻는다 */
const tick = () => runJob("product-audit", auditPublishedProducts, {
  budgetMs: jobRunOptions("product-audit", { requestedOnly: true }).budgetMs,
});
const item = async (slug: string) => (await db.select().from(productAuditItems).where(eq(productAuditItems.slug, slug))
  .orderBy(asc(productAuditItems.id))).at(-1)!;
const productOf = async (slug: string) => (await db.select().from(products).where(eq(products.slug, slug)))[0];
const heldSlugs = async () => (await db.select({ slug: products.slug }).from(products)
  .where(sql`${products.auditHoldAt} is not null`).orderBy(asc(products.id))).map((row) => row.slug);
const holdRows = (action: string) => db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, action))
  .orderBy(asc(productEvidenceAudit.id));
const purges = () => db.select({ slug: cdnPurges.slug, reason: cdnPurges.reason }).from(cdnPurges).orderBy(asc(cdnPurges.id));
const listedSlugs = async () => (await getPublicList(100)).map((row) => row.slug).sort();
const turn = async (next: Partial<typeof DEFAULT_AUDIT_HOLD>) => {
  const expected = (await getSettings()).auditHold;
  expect(await setAuditHold({ next: { ...expected, ...next }, expected, actor: "jr" })).toMatchObject({ ok: true });
};

/** 감사를 열고 모델의 답을 직접 적는다 — 쓸기가 밀린 것을 거는지 본다(답을 적는 길을 타지 않는다) */
async function judged(rows: { repo: string; confidence?: number; reason?: string; decision?: "reject" | "needs_review" | "approve";
  over?: Partial<typeof products.$inferInsert> }[]) {
  for (const row of rows) await listed(row.repo, row.over);
  await start();
  for (const row of rows) {
    await db.update(productAuditItems).set({ aiDecision: row.decision ?? "reject", aiConfidence: row.confidence ?? 0.97,
      aiReason: row.reason ?? COMPANY, reviewedAt: sql`now()`, attempts: 1 }).where(eq(productAuditItems.slug, row.repo.split("/")[1]));
  }
  // 묻는 길을 타지 않게 감사를 닫는다 — 틱은 쓸기만 돈다
  await db.update(productAuditCampaigns).set({ status: "done" });
}

it("테스트의 두 사유는 감사 화면의 갈래로 회사 소개·글 문서다", () => {
  expect(classifyAuditReason(COMPANY)).toBe("company");
  expect(classifyAuditReason(CONTENT)).toBe("content");
  expect(DEFAULT_AUDIT_HOLD).toEqual({ enabled: true, minConfidence: 0.95, categories: ["placeholder", "company", "platform", "shop"],
    secondOpinionReject: true });
});

describe("새 답이 같은 커밋에서 보류한다", () => {
  it("회사 소개 0.97 은 보류하고, 글·문서 0.97 과 회사 소개 0.94 는 목록에 둔다 — 상태는 바꾸지 않는다", async () => {
    await listed("n/company");
    await listed("n/content");
    await listed("n/low");
    gateway.mockImplementation(async (input: { snapshot: { product: { repo: string } } }) => ({
      "n/company": verdict("reject", 0.97), "n/content": verdict("reject", 0.97, CONTENT), "n/low": verdict("reject", 0.94),
    })[input.snapshot.product.repo]);
    await start();
    await tick();
    expect(gateway).toHaveBeenCalledTimes(3);

    expect(await heldSlugs()).toEqual(["company"]);
    const company = await productOf("company");
    expect(company).toMatchObject({ status: "seeded", auditHoldItemId: (await item("company")).id });
    expect(await listedSlugs()).toEqual(["content", "low"]);
    const [held] = await holdRows("audit.hold");
    expect(held).toMatchObject({ slug: "company", actor: "system:audit-hold", reason: "ai_reject · audit:company" });
    expect(held.metadata).toMatchObject({ itemId: company.auditHoldItemId, aiConfidence: 0.97, minConfidence: 0.95, category: "company",
      byCategory: true, bySecondOpinion: false });
    // 상태가 바뀌지 않아 트리거가 적지 않는다 — 목록과 그 상세를 지울 줄을 따로 하나 적는다
    expect(await purges()).toEqual([{ slug: "company", reason: "audit_hold" }]);
    expect((await productAuditOverview()).held).toBe(1);
  });

  it("스위치가 꺼진 뒤의 답은 보류하지 않는다 — 틱이 읽은 설정이 켜져 있어도 쓰는 커밋이 다시 읽는다", async () => {
    await listed("s/late");
    await start();
    const stale = (await getSettings()).auditHold;
    await turn({ enabled: false });
    await db.insert(jobs).values({ name: "product-audit", leaseToken: "owner", lockedAt: sql`now()`, requestedVersion: 1 });
    const input = { inputHash: "h", source: { documentId: 1 }, snapshot: { product: { repo: "s/late" } } } as never;
    await recordAuditResult({ itemId: (await item("late")).id, startedAt: new Date(), provider: "abcllm", model: "m", input, ok: true,
      outcome: verdict("reject", 0.99).outcome }, { name: "product-audit", token: "owner", requestedVersion: 1 }, stale);
    expect((await item("late")).aiDecision).toBe("reject");
    expect(await heldSlugs()).toEqual([]);
  });
});

describe("보류의 경계 — 쓸기와 새 답이 같은 조건을 쓴다", () => {
  it("주인 있는 것(클레임·검증·메이커 권한)·살아 있는 유지·사람이 정한 것은 보류하지 않는다 — 거둔 메이커 권한은 주인이 아니다", async () => {
    const [user] = await db.insert(publicUsers).values({ displayName: "메이커" }).returning();
    await judged([
      { repo: "b/plain" }, { repo: "b/claimed", over: { claimedAt: new Date() } },
      { repo: "b/verified", over: { status: "verified", verifiedAt: new Date() } }, { repo: "b/member" }, { repo: "b/revoked" },
      { repo: "b/decided" }, { repo: "b/unsure", decision: "needs_review" }, { repo: "b/approved", decision: "approve" },
    ]);
    for (const [slug, revokedAt] of [["member", null], ["revoked", new Date()]] as const) {
      await db.insert(productMakerMembers).values({ productId: (await productOf(slug)).id, userId: user.id, role: "owner", method: "admin", revokedAt });
    }
    await db.update(productAuditItems).set({ humanDecision: "kept", humanBy: "sam", humanAt: sql`now()` }).where(eq(productAuditItems.slug, "decided"));
    await tick();
    expect(await heldSlugs()).toEqual(["plain", "revoked"]);
  });

  it("다른 감사의 살아 있는 유지가 있으면 새 감사의 거절도 보류하지 않는다 — 기한이 지나면 건다", async () => {
    await listed("k/kept");
    gateway.mockResolvedValue(verdict("approve", 0.9));
    await start();
    await tick();
    expect(await keepAuditedProduct({ itemId: (await item("kept")).id, slug: "kept", by: "jr", note: "봤다" })).toEqual({ ok: true });
    await db.update(productAuditCampaigns).set({ status: "done" });
    gateway.mockResolvedValue(verdict("reject", 0.99));
    await start({ reason: "유지도 다시", reauditKept: true });
    await tick();
    expect((await item("kept")).aiDecision).toBe("reject");
    expect(await heldSlugs()).toEqual([]);
    await db.update(productAuditItems).set({ keepUntil: sql`now() - interval '1 minute'` }).where(eq(productAuditItems.humanDecision, "kept"));
    await tick();
    expect(await heldSlugs()).toEqual(["kept"]);
  });

  it("차단된 것·문턱 밖은 걸지 않고, 새 감사가 다시 물으면 옛 항목으로는 걸지 않는다", async () => {
    await judged([{ repo: "e/banned" }, { repo: "e/edge", confidence: 0.95 }, { repo: "e/below", confidence: 0.9499 }, { repo: "e/requeued" }]);
    await db.update(products).set({ status: "banned" }).where(eq(products.slug, "banned"));
    // 다음 감사가 같은 제품을 다시 올렸다 — 새 답을 기다린다
    const [next] = await db.insert(productAuditCampaigns).values({ startedBy: "jr", reason: "다시", promptVersion: "x", rulesVersion: "x",
      provider: "abcllm", model: "m", status: "cancelled" }).returning();
    await db.insert(productAuditItems).values({ campaignId: next.id, productId: (await productOf("requeued")).id, slug: "requeued" });
    await tick();
    expect(await heldSlugs()).toEqual(["edge"]);
  });
});

describe("쓸기", () => {
  it(`밀린 것을 틱마다 ${AUDIT_HOLD_SWEEP_BATCH}건씩 오래된 것부터 건다 — 몇 번 돌아도 한 번만 건다`, async () => {
    await judged(Array.from({ length: AUDIT_HOLD_SWEEP_BATCH + 5 }, (_, index) => ({ repo: `w/p${index}` })));
    await tick();
    expect(await heldSlugs()).toEqual(Array.from({ length: AUDIT_HOLD_SWEEP_BATCH }, (_, index) => `p${index}`));
    await tick();
    await tick();
    expect(await heldSlugs()).toHaveLength(AUDIT_HOLD_SWEEP_BATCH + 5);
    expect(await holdRows("audit.hold")).toHaveLength(AUDIT_HOLD_SWEEP_BATCH + 5);
    expect(await purges()).toHaveLength(AUDIT_HOLD_SWEEP_BATCH + 5);
  });

  it("허용 밖 갈래(글·문서)가 앞자리를 차지해도 나아간다 — 글·문서 0.97 은 보류하지 않고 회사 소개 0.97 은 한다", async () => {
    await judged([
      ...Array.from({ length: AUDIT_HOLD_SWEEP_BATCH + 3 }, (_, index) => ({ repo: `c/doc${index}`, reason: CONTENT })),
      { repo: "c/agency" }, { repo: "c/studio" },
    ]);
    await tick();
    expect(await heldSlugs()).toEqual(["agency", "studio"]);
    expect(await listedSlugs()).toHaveLength(AUDIT_HOLD_SWEEP_BATCH + 3);
  });

  it("끄면 새로 걸지 않고 건 보류는 남는다. 갈래·문턱을 좁혀도 남는다. 다시 켜면 이어서 건다", async () => {
    await judged([{ repo: "o/first" }, { repo: "o/second" }]);
    await db.update(productAuditItems).set({ aiDecision: null }).where(eq(productAuditItems.slug, "second"));
    await tick();
    expect(await heldSlugs()).toEqual(["first"]);
    await turn({ enabled: false });
    await db.update(productAuditItems).set({ aiDecision: "reject" }).where(eq(productAuditItems.slug, "second"));
    await tick();
    expect(await heldSlugs()).toEqual(["first"]);
    await turn({ enabled: true, categories: ["shop"], minConfidence: 0.99 });
    await tick();
    expect(await heldSlugs()).toEqual(["first"]);
    await turn({ categories: ["company"], minConfidence: 0.95 });
    await tick();
    expect(await heldSlugs()).toEqual(["first", "second"]);
  });
});

describe("두 번째 의견", () => {
  const vote = async (slug: string, decision: "approve" | "reject" | "needs_review", model = "grok-4-fast") => {
    const row = await item(slug);
    await db.insert(productAuditSecondOpinions).values({ itemId: row.id, productId: row.productId, model, decision, confidence: 0.9,
      reason: "second", source: "test" });
  };

  it("글·문서 0.97 거절도 두 번째 모델이 거절했으면 보류하고, 의견이 없으면 두지 않는다 — 쓸기", async () => {
    await judged([{ repo: "v/voted", reason: CONTENT }, { repo: "v/alone", reason: CONTENT }]);
    await vote("voted", "reject");
    await tick();
    expect(await heldSlugs()).toEqual(["voted"]);
    expect((await holdRows("audit.hold"))[0].metadata).toMatchObject({ category: "content", byCategory: false, bySecondOpinion: true });
  });

  it("새 답도 같다 — 두 번째 거절이 먼저 와 있으면 글·문서 거절을 그 커밋에서 보류한다", async () => {
    await listed("v/fresh");
    await listed("v/plain");
    gateway.mockResolvedValue(verdict("reject", 0.97, CONTENT));
    await start();
    await vote("fresh", "reject");
    await tick();
    expect(await heldSlugs()).toEqual(["fresh"]);
    // 같은 틱의 쓸기가 먼저 돌았지만 그때는 답이 없었다 — 이 보류는 답을 적는 커밋이 걸었다
    expect((await holdRows("audit.hold")).map((row) => row.slug)).toEqual(["fresh"]);
  });

  it("회사 소개 0.97 도 두 번째 모델이 승인했으면 보류하지 않는다 — 쓸기. 판단 보류 의견은 막지도 걸지도 않는다", async () => {
    await judged([{ repo: "a/approved" }, { repo: "a/unsure" }, { repo: "a/plain" }, { repo: "a/doc-unsure", reason: CONTENT }]);
    await vote("approved", "approve");
    await vote("unsure", "needs_review");
    await vote("doc-unsure", "needs_review");
    await tick();
    expect(await heldSlugs()).toEqual(["unsure", "plain"]);
    expect(await listedSlugs()).toEqual(["approved", "doc-unsure"]);
  });

  it("새 답도 같다 — 두 번째 승인이 먼저 와 있으면 회사 소개 0.97 거절을 보류하지 않는다", async () => {
    await listed("n/approved");
    await listed("n/plain");
    await start();
    await vote("approved", "approve");
    await tick();
    expect((await item("approved")).aiDecision).toBe("reject");
    expect(await heldSlugs()).toEqual(["plain"]);
  });

  it("승인과 거절이 함께 있으면 두 번째 거절이 이긴다. 스위치를 끄면 두 번째 거절을 세지 않는다", async () => {
    await judged([{ repo: "m/mixed" }, { repo: "m/switched", reason: CONTENT }]);
    await vote("mixed", "approve", "grok-4-fast");
    await vote("mixed", "reject", "grok-5");
    await turn({ secondOpinionReject: false });
    await vote("switched", "reject");
    await tick();
    expect(await heldSlugs()).toEqual([]);
    await turn({ secondOpinionReject: true });
    await tick();
    expect(await heldSlugs()).toEqual(["mixed", "switched"]);
  });

  it("쓸기가 건 회사 소개 보류는 승인을 옮겨 적으면 풀리고, 다음 틱에 다시 걸리지 않는다", async () => {
    await judged([{ repo: "i/company" }]);
    await tick();
    expect(await heldSlugs()).toEqual(["company"]);
    const row = await item("company");
    expect(await importAuditSecondOpinions(db, [{ auditResultId: row.id, productId: row.productId, grokDecision: "approve", grokConfidence: 0.8,
      model: "grok-4-fast" }], { dryRun: false, source: "grok-cli-batch" })).toMatchObject({ inserted: 1, released: 1 });
    expect(await heldSlugs()).toEqual([]);
    expect(await listedSlugs()).toEqual(["company"]);
    await tick();
    expect(await heldSlugs()).toEqual([]);
    expect((await holdRows("audit.hold.release")).map((release) => [release.actor, release.reason])).toEqual([["import:grok-cli-batch", "second_approve"]]);
  });

  it("DB 에 바로 들어온 승인은 건 보류를 풀지 않는다 — 푸는 것은 옮겨 적기(audit-second-opinion-import.ts)와 사람이다", async () => {
    await judged([{ repo: "d/company" }]);
    await tick();
    await vote("company", "approve");
    await tick();
    expect(await heldSlugs()).toEqual(["company"]);
  });
});

describe("사람의 결정이 보류를 푼다", () => {
  it("유지 — 같은 커밋에서 풀어 목록에 돌려놓고, 지울 줄과 기록을 남긴다. 다시 걸지 않는다", async () => {
    await judged([{ repo: "h/kept" }]);
    await tick();
    expect(await listedSlugs()).toEqual([]);
    expect(await keepAuditedProduct({ itemId: (await item("kept")).id, slug: "kept", by: "jr", note: "계산기다" })).toEqual({ ok: true });
    expect(await productOf("kept")).toMatchObject({ auditHoldAt: null, auditHoldItemId: null, status: "seeded" });
    expect(await listedSlugs()).toEqual(["kept"]);
    expect((await holdRows("audit.hold.release")).map((row) => [row.slug, row.actor, row.reason])).toEqual([["kept", "jr", "kept"]]);
    expect(await purges()).toEqual([{ slug: "kept", reason: "audit_hold" }, { slug: "kept", reason: "audit_release" }]);
    await tick();
    expect(await heldSlugs()).toEqual([]);
    // 제품 화면의 기록에 걸고 푼 줄이 남는다
    expect((await productHistory("kept")).filter((row) => row.kind === "status").map((row) => row.action))
      .toEqual(["audit.hold.release", "audit.hold"]);
  });

  it("폼의 slug 가 다르면 유지하지 않는다 — 보류도 그대로다", async () => {
    await judged([{ repo: "h/one" }, { repo: "h/two" }]);
    await tick();
    expect(await keepAuditedProduct({ itemId: (await item("one")).id, slug: "two", by: "jr", note: "" })).toMatchObject({ ok: false });
    expect(await heldSlugs()).toEqual(["one", "two"]);
  });

  it("내리기 — 한 건·묶음 모두 차단하고 보류를 푼다. 동시에 유지를 눌러도 한 결정과 상태가 맞는다", async () => {
    await judged([{ repo: "r/single" }, { repo: "r/bulk1" }, { repo: "r/bulk2" }, { repo: "r/race" }]);
    await tick();
    expect(await removeAuditedProduct({ itemId: (await item("single")).id, slug: "single", by: "jr" })).toEqual({ ok: true });
    const bulk = await removeAuditedProducts({ by: "jr", items: [{ itemId: (await item("bulk1")).id, slug: "bulk1" },
      { itemId: (await item("bulk2")).id, slug: "bulk2" }] });
    expect(bulk.removed).toEqual(["bulk1", "bulk2"]);
    const race = (await item("race")).id;
    const results = await Promise.all([removeAuditedProduct({ itemId: race, slug: "race", by: "a" }),
      keepAuditedProduct({ itemId: race, slug: "race", by: "b", note: "" })]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const statuses = Object.fromEntries((await db.select().from(products)).map((row) => [row.slug, [row.status, row.auditHoldAt]]));
    expect(statuses).toMatchObject({ single: ["banned", null], bulk1: ["banned", null], bulk2: ["banned", null] });
    expect(statuses.race[1]).toBeNull();
    expect((await holdRows("audit.hold.release")).filter((row) => row.reason === "banned").map((row) => row.slug).sort())
      .toEqual(expect.arrayContaining(["bulk1", "bulk2", "single"]));
  });

  it("제품 관리의 차단 해제 — 보류를 풀고, 그 제품의 열린 항목으로는 다시 보류하지 않는다(보류된 적 없어도)", async () => {
    await judged([{ repo: "u/held" }, { repo: "u/never" }]);
    await turn({ enabled: false });
    await tick();
    await turn({ enabled: true });
    await db.update(productAuditItems).set({ aiConfidence: 0.5 }).where(eq(productAuditItems.slug, "never"));
    await tick();
    expect(await heldSlugs()).toEqual(["held"]);
    for (const slug of ["held", "never"]) {
      expect(await banProduct(slug, { reason: "spam" })).toMatchObject({ ok: true });
      expect(await unbanProduct(slug)).toMatchObject({ ok: true, value: { status: "seeded" } });
    }
    expect(await heldSlugs()).toEqual([]);
    expect((await item("held")).holdReleasedAt).toBeInstanceOf(Date);
    await db.update(productAuditItems).set({ aiConfidence: 0.97 }).where(eq(productAuditItems.slug, "never"));
    await tick();
    expect(await heldSlugs()).toEqual([]);
    expect(await listedSlugs()).toEqual(["held", "never"]);
    expect((await holdRows("audit.hold.release")).map((row) => [row.slug, row.reason])).toEqual([["held", "banned"]]);
  });

  it("보류 모두 풀기 — 모두 풀어 목록에 돌려놓고 기록·목록 지우기 한 줄을 남긴다. 푼 항목은 다시 걸지 않는다", async () => {
    await judged([{ repo: "x/a" }, { repo: "x/b" }, { repo: "x/c" }]);
    await tick();
    const before = (await purges()).length;
    expect(await releaseAllAuditHolds({ by: "jr", note: "문턱을 잘못 잡음" })).toBe(3);
    expect(await heldSlugs()).toEqual([]);
    expect(await listedSlugs()).toEqual(["a", "b", "c"]);
    expect((await holdRows("audit.hold.release")).map((row) => [row.slug, row.actor, row.reason, row.metadata.note]))
      .toEqual([["a", "jr", "release_all", "문턱을 잘못 잡음"], ["b", "jr", "release_all", "문턱을 잘못 잡음"], ["c", "jr", "release_all", "문턱을 잘못 잡음"]]);
    // 제품마다가 아니라 목록만 — 빈 slug 한 줄이 lists 태그만 지운다
    expect((await purges()).slice(before)).toEqual([{ slug: "", reason: "audit_release" }]);
    expect(purgeTags([""])).toEqual(["lists"]);
    await tick();
    expect(await heldSlugs()).toEqual([]);
    expect(await releaseAllAuditHolds({ by: "jr", note: null })).toBe(0);
  });
});

describe("팔로한 사람", () => {
  it("보류는 알리지 않는다 — 그 뒤 사람이 내리면 한 번만 알린다", async () => {
    await judged([{ repo: "f/followed" }]);
    const [user] = await db.insert(publicUsers).values({ displayName: "팔로" }).returning();
    await db.insert(userFollows).values({ userId: user.id, targetType: "product", targetKey: String((await productOf("followed")).id),
      createdAt: new Date(Date.now() - 3_600_000) });
    const context = { cursor: null as never, save: async () => {}, hasBudget: () => true, log: () => {} };
    const first = await sendDelistedNotifications(context);
    await tick();
    expect(await heldSlugs()).toEqual(["followed"]);
    const second = await sendDelistedNotifications({ ...context, cursor: first.cursor as never });
    expect(await db.select().from(notifications)).toEqual([]);

    expect(await removeAuditedProduct({ itemId: (await item("followed")).id, slug: "followed", by: "jr" })).toEqual({ ok: true });
    await sendDelistedNotifications({ ...context, cursor: second.cursor as never });
    // 보류 줄을 다시 볼 때 그 제품은 이제 차단이다 — 그 줄로 두 번째 알림을 넣지 않는다
    await sendDelistedNotifications({ ...context, cursor: second.cursor as never });
    const rows = await db.select().from(notifications);
    expect(rows.map((row) => [row.userId, row.kind, row.payload])).toEqual([[user.id, "followed_delisted", { reason: "removed" }]]);
  });
});

describe("보류 설정", () => {
  it("감사 화면의 스위치만 바꾼다 — 크롤 설정 저장·기본값 되돌리기는 건드리지 않고, 본 값이 다르면 쓰지 않는다", async () => {
    const floor = await auditFloor();
    const expected = (await getSettings()).auditHold;
    const next = { ...expected, enabled: false, minConfidence: 0.97, categories: ["company" as const] };
    expect(await setAuditHold({ next, expected, actor: "jr", reason: "오탐 확인" })).toEqual({ ok: true, auditHold: next });
    // 같은 expected 로 다시 보내면 그 사이 바뀐 것이다
    expect(await setAuditHold({ next: expected, expected, actor: "jr" })).toMatchObject({ ok: false });
    expect(await setAuditHold({ next: { ...next, minConfidence: 0.79 }, expected: next, actor: "jr" })).toMatchObject({ ok: false });
    expect(await setAuditHold({ next: { ...next, categories: ["company", "company"] }, expected: next, actor: "jr" })).toMatchObject({ ok: false });

    await saveSettings({ auditHold: DEFAULT_AUDIT_HOLD, reviewConcurrency: 2 }, "test");
    await resetSettings("test");
    expect((await getSettings()).auditHold).toEqual(next);
    const rows = (await auditRowsAfter(floor, "audit-hold-settings")).sort((left, right) => left.id - right.id);
    expect(rows.map((row) => [row.ok, row.error])).toEqual([[true, null], [false, "stale_state"], [false, expect.any(String)], [false, expect.any(String)]]);
    expect(rows[0].detail).toMatchObject({ before: DEFAULT_AUDIT_HOLD, after: next, reason: "오탐 확인" });
  });
});
