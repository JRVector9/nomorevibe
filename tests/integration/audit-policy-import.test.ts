import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, crawlSettings, productAuditCampaigns, productAuditItems, productAuditPolicyRuns, productAuditSecondOpinions, productEvidenceAudit,
  products } from "@/lib/db/schema";
import { applyAuditPolicyChunk, policyRunExceptions, previewAuditPolicy, startAuditPolicyRun, startAuditPolicyUndo, undoAuditPolicyChunk } from "@/lib/crawl/audit-policy";
import { EMPTY_POLICY_FILTER, type PolicyFilter } from "@/lib/crawl/audit-policy-filter";
import { IMPORT_SOURCES, QWEN_VISION_M1_SOURCE } from "@/lib/crawl/audit-import-sources";
import { discardImport, previewImport, stageImportLines, startImportApply } from "@/lib/crawl/audit-second-opinion-upload";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));
const fence = vi.hoisted(() => ({ active: true }));
vi.mock("@/lib/operations/dr/epoch", async (original) => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(),
  writerSiteActive: async () => fence.active }));

const EMPTY = "The page text is empty; only shows a title and a JavaScript bundle";
const VISION_MODEL = IMPORT_SOURCES[QWEN_VISION_M1_SOURCE].model;

beforeAll(() => ensureSchema());
beforeEach(async () => {
  fence.active = true;
  // product_audit_campaigns 를 CASCADE 로 비운다 — 다른 파일이 남긴 시도(product_audit_attempts)까지
  await resetTables();
  await db.delete(crawlSettings);
  await db.insert(productAuditCampaigns).values({ startedBy: "jr", reason: "감사", promptVersion: "p", rulesVersion: "r", provider: "abcllm",
    model: "[MLX] gpt-oss-120b", status: "done" });
});

let sequence = 0;
/** 빈 화면 갈래(보류 허용 갈래)의 열린 거절 — held 면 그 항목으로 보류된 상태 */
async function finding(slug: string, over: { held?: boolean; human?: "kept"; grokReject?: boolean } = {}) {
  const [campaign] = await db.select().from(productAuditCampaigns).limit(1);
  const [product] = await db.insert(products).values({ slug, url: `https://${slug}.test`, name: `이름 ${slug}`, tagline: "t", description: "d", category: "Dev",
    status: "seeded", source: "crawler", verifyToken: `v-${++sequence}`, editTokenHash: "e" }).returning();
  const [item] = await db.insert(productAuditItems).values({ campaignId: campaign.id, productId: product.id, slug, aiDecision: "reject", aiConfidence: 0.97,
    aiReason: EMPTY, attempts: 1, humanDecision: over.human ?? null, reviewedAt: sql`now() - interval '2 days'` }).returning();
  if (over.held) await db.update(products).set({ auditHoldAt: sql`now() - interval '5 hours'`, auditHoldItemId: item.id }).where(eq(products.id, product.id));
  if (over.grokReject) {
    await db.insert(productAuditSecondOpinions).values({ itemId: item.id, productId: product.id, model: "grok-4-fast", decision: "reject", confidence: 0.9,
      reason: "title only", source: "grok-cli-batch" });
  }
  return { itemId: item.id, productId: product.id, slug };
}
const line = (target: { itemId: number; slug: string }, over: Record<string, unknown> = {}) => JSON.stringify({ slug: target.slug, itemId: target.itemId,
  name: "x", url: "https://x.test", before: 3, after: 900, shot: true, ms: 40_000, decision: "approve", confidence: 0.95, reason: "a working web app", ...over });
const stage = async (lines: string[], runId: number | null = null, final = true) => {
  const result = await stageImportLines({ runId, source: QWEN_VISION_M1_SOURCE, lines, final, by: "jr" });
  if (!result.ok) throw new Error(result.error);
  return result;
};
const preview = async (runId: number, supersede: boolean) => {
  const result = await previewImport({ runId, supersede });
  if (!result.ok) throw new Error(result.error);
  return result.preview;
};
async function applyAll(runId: number) {
  for (let calls = 0; calls < 20; calls++) {
    const progress = (await applyAuditPolicyChunk({ runId, by: "jr" }))!;
    if (progress.done) return progress;
  }
  throw new Error("not done");
}
async function undoAll(runId: number) {
  expect(await startAuditPolicyUndo({ runId, by: "jr" })).toMatchObject({ ok: true });
  for (let calls = 0; calls < 20; calls++) {
    const progress = (await undoAuditPolicyChunk({ runId, by: "jr" }))!;
    if (progress.done) return progress;
  }
  throw new Error("not done");
}
const productOf = async (id: number) => (await db.select().from(products).where(eq(products.id, id)))[0];
const opinionsOf = async (itemId: number) => db.select().from(productAuditSecondOpinions).where(eq(productAuditSecondOpinions.itemId, itemId))
  .orderBy(asc(productAuditSecondOpinions.model));

describe("두 번째 의견 올리기 — 검사", () => {
  it("줄을 검사해 까닭별로 세고 받은 줄만 둔다 — 같은 항목은 뒤의 것, 묶음을 넘어도. 이 단계는 아무것도 적지 않는다", async () => {
    const a = await finding("a", { held: true });
    const b = await finding("b");
    const c = await finding("c");
    // 같은 파일의 같은 항목은 뒤의 것만 — a 는 두 번(뒤의 승인), 제품 slug 가 다른 줄(c)은 제품 다름
    const first = await stage([line(a, { decision: "reject" }), line(b), "{broken", JSON.stringify({ slug: "x", itemId: 1, error: "qwen_invalid_json" }),
      line({ itemId: 999_999, slug: "ghost" }), line({ itemId: c.itemId, slug: "renamed" }), line(a)], null, false);
    expect(first.status).toBe("staging");
    expect(first.summary).toEqual({ read: 7, stored: 2, error: 1, invalid: 1, duplicate: 1, missing: 1, product_mismatch: 1, model_mismatch: 0 });
    const second = await stage([line(b, { decision: "reject" })], first.runId, true);
    expect(second).toMatchObject({ status: "staged", summary: { read: 8, stored: 2, duplicate: 2 } });
    expect(await db.select().from(productAuditSecondOpinions)).toEqual([]);
    expect((await productOf(a.productId)).auditHoldAt).toBeInstanceOf(Date);
    // 끝난 올리기에 더 보내지 않는다, 다른 출처를 섞지 않는다
    expect(await stageImportLines({ runId: first.runId, source: QWEN_VISION_M1_SOURCE, lines: [line(a)], final: true, by: "jr" })).toMatchObject({ ok: false });
    const other = await stage([line(a)], null, false);
    expect(await stageImportLines({ runId: other.runId, source: "grok-cli-batch", lines: [], final: true, by: "jr" })).toMatchObject({ ok: false });
    expect(await discardImport({ runId: other.runId })).toBe(true);
    expect(await discardImport({ runId: other.runId })).toBe(false);
  });

  it("grok 일괄 파일은 한 올리기에 모델 하나 — 다른 모델 줄은 모델이 다름으로 센다", async () => {
    const a = await finding("a");
    const b = await finding("b");
    const grok = (target: { itemId: number; productId: number }, model: string) => JSON.stringify({ auditResultId: target.itemId, productId: target.productId,
      grokDecision: "reject", grokConfidence: 0.9, grokReason: "agency", model });
    const result = await stageImportLines({ runId: null, source: "grok-cli-batch", lines: [grok(a, "grok-4-fast"), grok(b, "grok-other")], final: true, by: "jr" });
    expect(result).toMatchObject({ ok: true, summary: { stored: 1, model_mismatch: 1 } });
  });

  it("DR writer fence 가 닫혀 있으면 받지도 않는다", async () => {
    const a = await finding("a");
    fence.active = false;
    await expect(stageImportLines({ runId: null, source: QWEN_VISION_M1_SOURCE, lines: [line(a)], final: true, by: "jr" })).rejects.toBeInstanceOf(DrWriterFencedError);
    expect(await db.select().from(productAuditPolicyRuns)).toEqual([]);
  });
});

describe("미리보기·적용·대체", () => {
  /** 보류 다섯 가지 — 승인만(풀림)·글만 본 grok 거절 + 승인(대체 대상)·하한 아래 승인·스크린샷 없는 승인 / 보류 아닌 거절 / 사람이 정한 것 */
  async function scene() {
    const alone = await finding("alone", { held: true });
    const blocked = await finding("blocked", { held: true, grokReject: true });
    const low = await finding("low", { held: true, grokReject: true });
    const noShot = await finding("noshot", { held: true, grokReject: true });
    const unheld = await finding("unheld");
    const decided = await finding("decided", { human: "kept" });
    const staged = await stage([line(alone), line(blocked), line(low, { confidence: 0.85 }), line(noShot, { shot: false }),
      line(unheld, { decision: "reject", confidence: 1 }), line(decided)]);
    return { alone, blocked, low, noShot, unheld, decided, runId: staged.runId };
  }

  it("미리보기 — 적을 수·풀릴 보류·대체가 더 풀 항목 전부(꺼져 있어도)·그래도 남는 보류와 막는 의견", async () => {
    const { runId, blocked } = await scene();
    const off = await preview(runId, false);
    expect(off).toMatchObject({ writable: 5, inserted: 5, updated: 0, notOpen: 1, decisions: { approve: 4, reject: 1 }, heldApprovals: 4,
      releaseByGate: 1, releaseBySupersede: 1, blocked: 3, unheldRejects: 1, supersede: false });
    expect(off.supersedeRows).toEqual([expect.objectContaining({ itemId: blocked.itemId, superseded: [{ model: "grok-4-fast", source: "grok-cli-batch", confidence: 0.9 }] })]);
    expect(Object.fromEntries(off.blockedRows.map((row) => [row.slug, row.blockers]))).toEqual({
      blocked: [{ kind: "reject", model: "grok-4-fast", source: "grok-cli-batch", confidence: 0.9 }],
      low: [{ kind: "reject", model: "grok-4-fast", source: "grok-cli-batch", confidence: 0.9 }, { kind: "category", category: "placeholder" }],
      noshot: [{ kind: "reject", model: "grok-4-fast", source: "grok-cli-batch", confidence: 0.9 }],
    });
    const on = await preview(runId, true);
    expect(on).toMatchObject({ releaseByGate: 1, releaseBySupersede: 1, blocked: 2, supersede: true });
    expect(await db.select().from(productAuditSecondOpinions)).toHaveLength(3); // 미리보기는 쓰지 않는다(grok 셋 그대로)
  });

  it("대체 꺼짐 — 남은 거절이 없는 것만 풀고, 의견은 출처·모델·글의 판과 함께 적는다. 되돌리면 의견을 지우고 보류를 원래대로 다시 건다", async () => {
    const { runId, alone, blocked, unheld } = await scene();
    expect(await startImportApply({ runId, supersede: false, expected: 6, by: "jr" })).toMatchObject({ ok: false });
    expect(await startImportApply({ runId, supersede: false, expected: 5, by: "jr" })).toMatchObject({ ok: true, planned: 6 });
    const floor = await auditFloor();
    expect(await applyAll(runId)).toMatchObject({ status: "applied", applied: 5, skipped: 1 });
    expect(await policyRunExceptions(runId)).toEqual([expect.objectContaining({ slug: "decided", reason: "not_open" })]);
    expect(await productOf(alone.productId)).toMatchObject({ auditHoldAt: null });
    expect((await productOf(blocked.productId)).auditHoldAt).toBeInstanceOf(Date);
    expect(await opinionsOf(alone.itemId)).toEqual([expect.objectContaining({ model: VISION_MODEL, decision: "approve", source: QWEN_VISION_M1_SOURCE,
      promptVersion: "2026-10-21.v2+shot1", confidence: 0.95 })]);
    expect((await opinionsOf(unheld.itemId))[0]).toMatchObject({ decision: "reject", confidence: 1 });
    const [release] = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, "audit.hold.release"));
    expect(release).toMatchObject({ slug: "alone", reason: "second_approve", actor: `import:${QWEN_VISION_M1_SOURCE}` });
    expect(release.metadata).toMatchObject({ policyRunId: runId, by: "jr" });
    expect((await auditRowsAfter(floor, "audit-policy-apply"))[0].detail).toMatchObject({ kind: "import", applied: 5, skipped: 1 });

    expect(await undoAll(runId)).toMatchObject({ status: "undone", undone: 5, blocked: 0 });
    expect(await db.select().from(productAuditSecondOpinions).where(eq(productAuditSecondOpinions.source, QWEN_VISION_M1_SOURCE))).toEqual([]);
    expect(await productOf(alone.productId)).toMatchObject({ auditHoldItemId: alone.itemId });
    expect((await productOf(alone.productId)).auditHoldAt).toBeInstanceOf(Date);
    const [item] = await db.select().from(productAuditItems).where(eq(productAuditItems.id, alone.itemId));
    expect(item.holdReleasedAt).toBeNull();
    expect(await opinionsOf(blocked.itemId)).toEqual([expect.objectContaining({ model: "grok-4-fast", decision: "reject" })]);
  });

  it("대체 켬 — 스크린샷까지 본 승인이 글만 본 grok 거절을 대신해 푼다. 거절 의견은 남고, 풀림 줄에 무엇을 대신했는지 적는다", async () => {
    const { runId, blocked, low, noShot } = await scene();
    expect(await startImportApply({ runId, supersede: true, expected: 5, by: "jr" })).toMatchObject({ ok: true });
    await applyAll(runId);
    expect(await productOf(blocked.productId)).toMatchObject({ auditHoldAt: null });
    expect((await productOf(low.productId)).auditHoldAt).toBeInstanceOf(Date);
    expect((await productOf(noShot.productId)).auditHoldAt).toBeInstanceOf(Date);
    expect((await opinionsOf(blocked.itemId)).map((row) => [row.model, row.decision])).toEqual([["grok-4-fast", "reject"], [VISION_MODEL, "approve"]]);
    const release = (await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, "blocked"))).find((row) => row.action === "audit.hold.release");
    expect(release).toMatchObject({ reason: "supersede" });
    expect(release!.metadata).toMatchObject({ superseded: [{ model: "grok-4-fast", source: "grok-cli-batch", confidence: 0.9 }] });
    // 정책 거르기 — m1 승인 출처로 고른다
    const m1Approve = await previewAuditPolicy({ filter: { ...EMPTY_POLICY_FILTER, second: "approve", secondSource: QWEN_VISION_M1_SOURCE }, action: "keep" });
    expect(m1Approve.matched).toBe(4);
    // 두 번째 모델 승인이 있으면 내리기는 건너뛴다
    const remove = await previewAuditPolicy({ filter: { ...EMPTY_POLICY_FILTER, second: "approve", secondSource: QWEN_VISION_M1_SOURCE }, action: "remove" });
    expect(remove.eligible).toBe(0);
  });

  it("되돌리기 — 그 뒤 의견이 다시 적힌 항목은 손대지 않고 까닭을 남긴다", async () => {
    const { runId, alone, blocked } = await scene();
    await startImportApply({ runId, supersede: true, expected: 5, by: "jr" });
    await applyAll(runId);
    await db.update(productAuditSecondOpinions).set({ createdAt: sql`now() + interval '1 minute'`, confidence: 0.99 })
      .where(sql`${productAuditSecondOpinions.itemId} = ${alone.itemId} and ${productAuditSecondOpinions.model} = ${VISION_MODEL}`);
    expect(await undoAll(runId)).toMatchObject({ undone: 4, blocked: 1 });
    expect(await policyRunExceptions(runId)).toEqual(expect.arrayContaining([expect.objectContaining({ slug: "alone", state: "undo_blocked", reason: "opinion_changed" })]));
    expect(await productOf(alone.productId)).toMatchObject({ auditHoldAt: null });
    expect((await productOf(blocked.productId)).auditHoldItemId).toBe(blocked.itemId);
  });

  it("덮어쓴 의견을 되돌리면 덮어쓰기 전 값으로 돌아간다", async () => {
    const a = await finding("a");
    await db.insert(productAuditSecondOpinions).values({ itemId: a.itemId, productId: a.productId, model: VISION_MODEL, decision: "reject", confidence: 0.91,
      reason: "old", source: QWEN_VISION_M1_SOURCE, createdAt: new Date("2026-10-20T00:00:00Z") });
    const { runId } = await stage([line(a)]);
    expect(await preview(runId, false)).toMatchObject({ updated: 1, inserted: 0 });
    await startImportApply({ runId, supersede: false, expected: 1, by: "jr" });
    await applyAll(runId);
    expect((await opinionsOf(a.itemId))[0]).toMatchObject({ decision: "approve" });
    await undoAll(runId);
    expect((await opinionsOf(a.itemId))[0]).toMatchObject({ decision: "reject", confidence: expect.closeTo(0.91, 5), reason: "old",
      createdAt: new Date("2026-10-20T00:00:00Z") });
  });
});

describe("보류 풀기(보류 모두 풀기의 고른 판)", () => {
  const filterOf = (over: Partial<PolicyFilter> = {}): PolicyFilter => ({ ...EMPTY_POLICY_FILTER, ...over });

  it("고른 보류만 풀어 목록에 돌려놓고 다시 걸지 않게 적는다 — 사람 결정은 남기지 않고, 되돌리면 원래 시각·항목으로 다시 보류한다", async () => {
    const one = await finding("one", { held: true });
    const two = await finding("two", { held: true });
    await finding("open");
    const all = await previewAuditPolicy({ filter: filterOf(), action: "release" });
    expect(all).toMatchObject({ matched: 3, eligible: 2 });
    expect(all.skipped).toEqual([expect.objectContaining({ reason: "not_held", count: 1 })]);
    const run = await startAuditPolicyRun({ filter: filterOf({ held: "held" }), action: "release", expected: 2, note: "문턱 잘못", keepDays: 90, by: "jr" });
    if (!run.ok) throw new Error(run.error);
    await applyAll(run.runId);
    for (const target of [one, two]) {
      expect(await productOf(target.productId)).toMatchObject({ auditHoldAt: null, status: "seeded" });
      const [item] = await db.select().from(productAuditItems).where(eq(productAuditItems.id, target.itemId));
      expect(item).toMatchObject({ humanDecision: null });
      expect(item.holdReleasedAt).toBeInstanceOf(Date);
    }
    expect(await db.select({ slug: cdnPurges.slug, reason: cdnPurges.reason }).from(cdnPurges)).toEqual([{ slug: "", reason: "audit_release" }]);
    const [release] = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, "one"));
    expect(release).toMatchObject({ action: "audit.hold.release", reason: "policy_release", actor: "jr" });
    // 그 뒤 하나는 사람이 유지로 정함 → 되돌리지 않는다
    await db.update(productAuditItems).set({ humanDecision: "kept", humanBy: "other", humanAt: new Date() }).where(eq(productAuditItems.id, two.itemId));
    expect(await undoAll(run.runId)).toMatchObject({ undone: 1, blocked: 1 });
    expect(await productOf(one.productId)).toMatchObject({ auditHoldItemId: one.itemId });
    const [item] = await db.select().from(productAuditItems).where(eq(productAuditItems.id, one.itemId));
    expect(item.holdReleasedAt).toBeNull();
    expect((await productOf(two.productId)).auditHoldAt).toBeNull();
    expect(await policyRunExceptions(run.runId)).toEqual([expect.objectContaining({ slug: "two", reason: "decision_changed" })]);
  });
});

describe("확신 하한 — m1 거절은 0.90 이상만 '두 모델 모두 거절'로 센다(보류 쓸기·감사 화면과 같은 셈)", () => {
  it("0.85 m1 거절은 두 모델 모두 거절이 아니고, 0.95 는 그렇다", async () => {
    const weak = await finding("weak", { held: true });
    const strong = await finding("strong", { held: true });
    for (const [target, confidence] of [[weak, 0.85], [strong, 0.95]] as const) {
      await db.insert(productAuditSecondOpinions).values({ itemId: target.itemId, productId: target.productId, model: VISION_MODEL, decision: "reject",
        confidence, reason: "r", source: QWEN_VISION_M1_SOURCE });
    }
    const agreed = await previewAuditPolicy({ filter: { ...EMPTY_POLICY_FILTER, second: "agreed" }, action: "keep" });
    expect(agreed.sample.map((row) => row.slug)).toEqual(["strong"]);
  });
});
