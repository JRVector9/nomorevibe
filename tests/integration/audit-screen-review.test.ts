import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, productAuditCampaigns, productAuditItems, productAuditSecondOpinions,
  productEvidenceAudit, products } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { getSettings, saveSettings, setQwenAutoStep } from "@/lib/crawl/settings";
import { startProductAudit } from "@/lib/crawl/product-audit";
import { markScreenJudged, screenReviewCounts, screenReviewQueue } from "@/lib/crawl/audit-screen-review";
import { QWEN_VISION_AUTO_SOURCE } from "@/lib/crawl/audit-import-sources";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));
const fence = vi.hoisted(() => ({ active: true }));
vi.mock("@/lib/operations/dr/epoch", async (original) => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(),
  writerSiteActive: async () => fence.active }));

/**
 * 화면 판별 대기(lib/crawl/audit-screen-review.ts) — 화면 판정 잡이 가져가 판정하고 적는 큐. 대기는 지금 있는 행에서 고른다(이전 없음):
 * 열린 감사 거절 가운데 수집 본문이 300자 아래(원본 없음 포함)이고 화면 판정 출처의 의견이 없는 것. 적으면(markScreenJudged) 빠진다.
 */
const COMPANY = 'pageText: "Acme Studio" — a marketing site for a design agency, not a usable product';
const CONTENT = 'pageText: "Getting started" — a documentation site for a library, not a usable product';
const RICH = "쓸 수 있는 앱 — 가입하고 바로 씁니다. ".repeat(14);
const THIN = "Loading…";
const VISION = "qwen3.8-flash-next+vision";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  fence.active = true;
  for (const table of [productAuditItems, productAuditCampaigns, crawlCandidates, crawlDocuments, crawlSettings]) await db.delete(table);
  await resetTables();
  await saveSettings({ enabled: true, firstReview: { provider: "abcllm", model: "[MLX] gpt-oss-120b" }, reviewConcurrency: 1 }, "test");
  // 글만 본 m1 의 의견을 보류에서 세는 단계를 켠다 — 글이 적은 항목에서 그 의견을 세지 않는 것을 본다(이 파일은 틱을 돌리지 않는다)
  const expected = (await getSettings()).qwenAuto.auditSecondOpinion;
  expect(await setQwenAutoStep({ step: "auditSecondOpinion", next: { ...expected, enabled: true, perTick: 10 }, expected, actor: "jr",
    reason: "테스트" })).toMatchObject({ ok: true });
});

let sequence = 0;
type Row = { repo: string; confidence?: number; reason?: string; text?: string | null; over?: Partial<typeof products.$inferInsert> };
/** 공개 제품·수집 원본(text null 이면 원본 없음)을 만들고 감사를 열어 거절을 적은 뒤 닫는다 */
async function judged(rows: Row[]) {
  for (const row of rows) {
    const slug = row.repo.split("/")[1];
    const url = `https://${slug}.test`;
    await db.insert(products).values({ slug, url, name: slug, tagline: "한 줄", description: "소개", category: "Productivity", status: "seeded",
      source: "crawler", verifyToken: `token-${++sequence}`, editTokenHash: "h".repeat(64), ...row.over });
    if (row.text === null) continue;
    await crawl.putDocument({ repo: row.repo, productUrl: url, pageStatus: 200,
      repoMeta: { description: "레포", stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: "User" } },
      pageMeta: { title: slug, textSample: row.text ?? RICH } });
    await db.insert(crawlCandidates).values({ repo: row.repo, productUrl: url, state: "published", reason: "passed", decidedBy: "auto",
      publishedSlug: slug, judgedAt: new Date(), decidedAt: new Date() });
  }
  await startProductAudit({ startedBy: "jr", reason: "감사", reauditKept: false });
  for (const row of rows) {
    await db.update(productAuditItems).set({ aiDecision: "reject", aiConfidence: row.confidence ?? 0.97, aiReason: row.reason ?? CONTENT,
      reviewedAt: sql`now()`, attempts: 1 }).where(eq(productAuditItems.slug, row.repo.split("/")[1]));
  }
  await db.update(productAuditCampaigns).set({ status: "done" });
}
const item = async (slug: string) => (await db.select().from(productAuditItems).where(eq(productAuditItems.slug, slug))
  .orderBy(asc(productAuditItems.id))).at(-1)!;
const opinion = async (slug: string, model: string, decision: "approve" | "reject" | "needs_review", source: string, confidence = 0.95) => {
  const row = await item(slug);
  await db.insert(productAuditSecondOpinions).values({ itemId: row.id, productId: row.productId, model, decision, confidence, reason: "earlier", source,
    promptVersion: "2026-10-21.v2" });
};
const hold = (slug: string) => db.update(products)
  .set({ auditHoldAt: sql`now()`, auditHoldItemId: sql`(select id from product_audit_items where slug = ${slug})` }).where(eq(products.slug, slug));
const queued = async (options: Parameters<typeof screenReviewQueue>[0] = {}) => (await screenReviewQueue(options)).map((row) => row.slug);
const judgement = async (slug: string, decision: "approve" | "reject" | "needs_review", over: Record<string, unknown> = {}) => {
  const row = await item(slug);
  return { itemId: row.id, productId: row.productId, model: VISION, decision, confidence: 0.95, reason: `screen says ${decision}`,
    promptVersion: "2026-10-22.vision1", ...over };
};

describe("screenReviewQueue", () => {
  it("글이 적은(원본 없음 포함) 열린 거절 중 화면 판정이 없는 것 — 공개 중 먼저(확신 높은 순), 그다음 보류 중", async () => {
    await judged([{ repo: "q/rich", confidence: 0.99 }, { repo: "q/low", confidence: 0.6, text: THIN }, { repo: "q/high", confidence: 0.98, text: THIN },
      { repo: "q/nodoc", confidence: 0.7, text: null }, { repo: "q/held", confidence: 0.99, text: THIN, reason: COMPANY },
      { repo: "q/owned", confidence: 0.9, text: THIN, over: { claimedAt: new Date() } },
      // 화면 판정이 있으면(결정과 상관없이) 빠진다 — 글만 본 m1·grok 의 의견은 그대로 둔다
      { repo: "q/vision", confidence: 0.99, text: THIN }, { repo: "q/unsure", confidence: 0.99, text: THIN }, { repo: "q/m1", confidence: 0.5, text: THIN },
      // 사람이 정했거나 내려간 것은 대상이 아니다
      { repo: "q/kept", confidence: 0.99, text: THIN }, { repo: "q/banned", confidence: 0.99, text: THIN, over: { status: "banned" } }]);
    await hold("held");
    await opinion("vision", VISION, "reject", "qwen-vision-m1");
    await opinion("unsure", VISION, "needs_review", QWEN_VISION_AUTO_SOURCE);
    await opinion("m1", "qwen3.8-flash-next", "reject", "qwen-v2-auto");
    await db.update(productAuditItems).set({ humanDecision: "kept", humanBy: "jr", humanAt: sql`now()`, keepUntil: sql`now() + interval '90 days'` })
      .where(eq(productAuditItems.slug, "kept"));
    expect(await queued()).toEqual(["high", "owned", "nodoc", "low", "m1", "held"]);
    const rows = await screenReviewQueue();
    expect(rows.find((row) => row.slug === "nodoc")).toMatchObject({ textLength: null, pageText: null, held: false });
    expect(rows.find((row) => row.slug === "owned")).toMatchObject({ owned: true });
    expect(rows.find((row) => row.slug === "held")).toMatchObject({ held: true, heldAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      textLength: [...THIN].length, pageText: THIN, audit: { category: "company", confidence: 0.99 } });
    expect(rows.find((row) => row.slug === "m1")?.opinions).toEqual([expect.objectContaining({ source: "qwen-v2-auto", decision: "reject",
      reason: "earlier" })]);
    // 한 번에 몇 건·넘길 것
    expect(await queued({ limit: 2 })).toEqual(["high", "owned"]);
    expect(await queued({ limit: 2, skip: [(await item("high")).id] })).toEqual(["owned", "nodoc"]);
    expect(await screenReviewCounts()).toEqual({ screenWait: 6, screenWaitPublic: 5, split: 0 });
  });
});

describe("markScreenJudged", () => {
  it("화면 판정을 적으면 대기에서 빠진다 — 보류 중인 항목의 승인은 글만 본 m1 거절에 막히지 않고 보류를 푼다(작업 로그에 남긴다)", async () => {
    await judged([{ repo: "m/held", text: THIN, reason: COMPANY }, { repo: "m/reject", text: THIN }, { repo: "m/unsure", text: THIN },
      { repo: "m/rich" }]);
    await hold("held");
    // 글만 본 m1 의 거절 — 글이 적은 항목이라 보류에서 세지 않는다(세면 승인이 와도 풀리지 않는다)
    await opinion("held", "qwen3.8-flash-next", "reject", "qwen-v2-auto");
    expect(await queued()).toEqual(["reject", "unsure", "held"]);
    const floor = await auditFloor();
    // 미리 셈만 — 아무것도 적지 않는다
    const dry = await markScreenJudged([await judgement("held", "approve")], { source: QWEN_VISION_AUTO_SOURCE, dryRun: true });
    expect(dry).toMatchObject({ inserted: 1, released: 1, dryRun: true });
    expect(await queued()).toEqual(["reject", "unsure", "held"]);

    const result = await markScreenJudged([await judgement("held", "approve"), await judgement("reject", "reject"), await judgement("unsure", "needs_review"),
      // 글 충분한 항목에도 적을 수는 있다(대기가 아니었을 뿐)
      await judgement("rich", "approve")], { source: QWEN_VISION_AUTO_SOURCE, actor: "vision-judge" });
    expect(result).toMatchObject({ inserted: 4, updated: 0, released: 1 });
    expect(await queued()).toEqual([]);
    expect(await screenReviewCounts()).toMatchObject({ screenWait: 0 });
    const written = await db.select().from(productAuditSecondOpinions).where(eq(productAuditSecondOpinions.source, QWEN_VISION_AUTO_SOURCE));
    expect(written.map((row) => [row.model, row.decision, row.promptVersion]).sort()).toEqual([
      [VISION, "approve", "2026-10-22.vision1"], [VISION, "approve", "2026-10-22.vision1"], [VISION, "needs_review", "2026-10-22.vision1"],
      [VISION, "reject", "2026-10-22.vision1"]]);
    // 보류를 풀었다 — 옮겨 적기와 같은 길(second_approve), 사람이 정하지 않은 공개 목록 변화라 작업 로그에도
    const [held] = await db.select().from(products).where(eq(products.slug, "held"));
    expect(held.auditHoldAt).toBeNull();
    const releases = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, "audit.hold.release"));
    expect(releases.map((row) => [row.slug, row.actor, row.reason])).toEqual([["held", `import:${QWEN_VISION_AUTO_SOURCE}`, "second_approve"]]);
    expect(await auditRowsAfter(floor, "audit-hold-auto-release")).toMatchObject([{ actor: "vision-judge", actorKind: "model", target: "held",
      detail: { model: VISION, confidence: 0.95 } }]);
    // 다시 적으면 덮어쓴다((항목, 모델) 한 줄)
    expect(await markScreenJudged([await judgement("reject", "approve")], { source: QWEN_VISION_AUTO_SOURCE })).toMatchObject({ inserted: 0, updated: 1 });
  });

  it("모양이 틀리거나 화면 판정 출처가 아니거나 글만 본 m1 과 같은 모델이면 아무것도 적지 않고 던진다. DR fence 가 닫혀 있으면 적지 않는다", async () => {
    await judged([{ repo: "v/one", text: THIN }]);
    await expect(markScreenJudged([await judgement("one", "approve")], { source: "grok-cli-batch" })).rejects.toThrow("screen_source_unknown");
    await expect(markScreenJudged([await judgement("one", "approve")], { source: "qwen-v2-auto" })).rejects.toThrow("screen_source_unknown");
    await expect(markScreenJudged([await judgement("one", "approve", { model: "[gpu3090] qwen3.8-flash-next" })], { source: QWEN_VISION_AUTO_SOURCE }))
      .rejects.toThrow("screen_model_same_as_text_m1");
    for (const over of [{ decision: "maybe" }, { confidence: 1.5 }, { model: "  " }, { itemId: 0 }]) {
      await expect(markScreenJudged([await judgement("one", "approve", over)], { source: QWEN_VISION_AUTO_SOURCE }), JSON.stringify(over))
        .rejects.toThrow("screen_judgement_invalid");
    }
    fence.active = false;
    await expect(markScreenJudged([await judgement("one", "approve")], { source: QWEN_VISION_AUTO_SOURCE })).rejects.toBeInstanceOf(DrWriterFencedError);
    fence.active = true;
    expect(await db.select().from(productAuditSecondOpinions)).toEqual([]);
    expect(await queued()).toEqual(["one"]);
    // 열린 거절이 아니면(사람이 정함) 적지 않고 건너뛴 수로 센다
    await db.update(productAuditItems).set({ humanDecision: "removed", humanBy: "jr", humanAt: sql`now()` }).where(eq(productAuditItems.slug, "one"));
    expect(await markScreenJudged([await judgement("one", "approve")], { source: QWEN_VISION_AUTO_SOURCE }))
      .toMatchObject({ inserted: 0, skipped: { not_open: 1 } });
  });
});
