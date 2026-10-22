import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, crawlSettings, productAuditCampaigns, productAuditItems, productAuditPolicyRunItems, productAuditPolicyRuns,
  productAuditSecondOpinions, productEvidenceAudit, products } from "@/lib/db/schema";
import { productMakerMembers } from "@/lib/db/me-schema";
import { publicUsers } from "@/lib/db/public-user-schema";
import { applyAuditPolicyChunk, listPolicyRuns, policyRunExceptions, policyRunProgress, previewAuditPolicy, startAuditPolicyRun,
  startAuditPolicyUndo, undoAuditPolicyChunk, POLICY_CDN_ROOM } from "@/lib/crawl/audit-policy";
import { EMPTY_POLICY_FILTER, type PolicyAction, type PolicyFilter } from "@/lib/crawl/audit-policy-filter";
import { DrWriterFencedError } from "@/lib/operations/dr/epoch";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));
/** DR writer fence 가 닫힌 쓰기 거부만 바꿔 본다 — 나머지는 실제 DB */
const fence = vi.hoisted(() => ({ active: true }));
vi.mock("@/lib/operations/dr/epoch", async (original) => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(),
  writerSiteActive: async () => fence.active }));

/** 사유 갈래 — 회사 소개·빈 화면 */
const COMPANY = 'pageText: "Acme Studio" — a marketing site for a design agency, not a usable product';
const EMPTY = "The page text is empty; only shows a title and a JavaScript bundle";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  fence.active = true;
  // product_audit_campaigns 를 CASCADE 로 비운다 — 다른 파일이 남긴 시도(product_audit_attempts)까지
  await resetTables();
  await db.delete(crawlSettings);
});

let sequence = 0;
async function campaign(status: "done" | "running" = "done") {
  const [row] = await db.insert(productAuditCampaigns).values({ startedBy: "jr", reason: "감사", promptVersion: "p", rulesVersion: "r",
    provider: "abcllm", model: "[MLX] gpt-oss-120b", status }).returning();
  return row;
}
type Finding = { confidence?: number; reason?: string; held?: boolean; waitDays?: number; human?: "kept" | "removed";
  product?: Partial<typeof products.$inferInsert>; campaignId?: number; provider?: string; model?: string };
/** 열린 감사 거절 하나 — 제품과 항목. held 면 그 항목으로 보류된 상태(보류는 시스템이 건다 — 여기서는 걸린 상태만 만든다) */
async function finding(slug: string, over: Finding = {}) {
  const campaignId = over.campaignId ?? (await db.select().from(productAuditCampaigns).orderBy(asc(productAuditCampaigns.id))).at(-1)!.id;
  const [product] = await db.insert(products).values({ slug, url: `https://${slug}.test`, name: `이름 ${slug}`, tagline: "t", description: "d",
    category: "Dev", status: "seeded", source: "crawler", verifyToken: `v-${++sequence}`, editTokenHash: "e", ...over.product }).returning();
  const [item] = await db.insert(productAuditItems).values({ campaignId, productId: product.id, slug, aiDecision: "reject",
    aiConfidence: over.confidence ?? 0.97, aiReason: over.reason ?? COMPANY, attempts: 1, humanDecision: over.human ?? null,
    aiProvider: over.provider ?? null, aiModel: over.model ?? null,
    reviewedAt: sql`now() - ${over.waitDays ?? 1} * interval '1 day'` }).returning();
  if (over.held) await db.update(products).set({ auditHoldAt: sql`now() - interval '3 hours'`, auditHoldItemId: item.id }).where(eq(products.id, product.id));
  return { itemId: item.id, productId: product.id, slug };
}
const opinion = (target: { itemId: number; productId: number }, decision: "approve" | "reject", over: { model?: string; source?: string; confidence?: number } = {}) =>
  db.insert(productAuditSecondOpinions).values({ itemId: target.itemId, productId: target.productId, model: over.model ?? "grok-4-fast", decision,
    confidence: over.confidence ?? 0.9, reason: "r", source: over.source ?? "grok-cli-batch" });
const filterOf = (over: Partial<PolicyFilter> = {}): PolicyFilter => ({ ...EMPTY_POLICY_FILTER, ...over });
const productOf = async (id: number) => (await db.select().from(products).where(eq(products.id, id)))[0];
const itemOf = async (id: number) => (await db.select().from(productAuditItems).where(eq(productAuditItems.id, id)))[0];
const start = (action: PolicyAction, expected: number, filter = filterOf(), keepDays: 90 | 180 | 365 = 90) =>
  startAuditPolicyRun({ filter, action, expected, note: "적체 정리", keepDays, by: "jr" });
/** 끝날 때까지 나눠 적용 — 몇 번 불렀는지 돌려준다 */
async function applyAll(runId: number, limit?: number) {
  let calls = 0;
  for (;;) {
    const progress = (await applyAuditPolicyChunk({ runId, by: "jr", limit }))!;
    calls += 1;
    if (progress.done || calls > 50) return { progress, calls };
  }
}
async function undoAll(runId: number) {
  expect(await startAuditPolicyUndo({ runId, by: "jr" })).toMatchObject({ ok: true });
  for (let calls = 0; ; calls++) {
    const progress = (await undoAuditPolicyChunk({ runId, by: "jr" }))!;
    if (progress.done || calls > 50) return progress;
  }
}

describe("거르기 → 미리보기", () => {
  it("열린 거절만 대상이고, 거르기마다 수가 맞으며, 내리기는 지금 묶어 내리기의 문턱으로 건너뛸 것과 까닭을 센다", async () => {
    const old = await campaign();
    const oldOpen = await finding("old-open", { campaignId: old.id }); // 지난 감사 · 보류 아님 → 대상 아님
    const oldHeld = await finding("old-held", { campaignId: old.id, held: true }); // 지난 감사의 항목으로 보류 중 → 대상
    await campaign();
    await finding("plain");
    await finding("low", { confidence: 0.92, reason: EMPTY });
    await finding("owned", { product: { claimedAt: new Date() } });
    await finding("verified", { product: { status: "verified", verifiedAt: new Date() } });
    const agreed = await finding("agreed", { held: true, waitDays: 9 });
    await opinion(agreed, "reject");
    const split = await finding("split");
    await opinion(split, "approve");
    await finding("decided", { human: "kept" });
    await finding("banned", { product: { status: "banned" } });
    void oldOpen;

    const all = await previewAuditPolicy({ filter: filterOf(), action: "remove", seed: "s" });
    expect(all.matched).toBe(7); // old-held, plain, low, owned, verified, agreed, split
    expect(all.eligible).toBe(3); // old-held, plain, agreed
    expect(all.eligibleHeld).toBe(2);
    expect(Object.fromEntries(all.skipped.map((group) => [group.reason, group.count]))).toEqual({ owned: 2, low_confidence: 1, split: 1 });
    expect(all.skipped.find((group) => group.reason === "owned")!.examples.map((row) => row.slug).sort()).toEqual(["owned", "verified"]);
    expect(all.byBranch).toEqual(expect.arrayContaining([
      expect.objectContaining({ branch: "company", matched: 6, eligible: 3 }), expect.objectContaining({ branch: "placeholder", matched: 1, eligible: 0 })]));
    expect(all.sample.map((row) => row.slug).sort()).toEqual(["agreed", "old-held", "plain"]);
    expect(all.sample.find((row) => row.slug === "agreed")).toMatchObject({ held: true, waitDays: 9,
      second: [expect.objectContaining({ model: "grok-4-fast", decision: "reject" })] });
    expect(all.oldestWaitDays).toBe(9);

    // 유지는 건너뛰지 않는다 — 거르기에 든 것 전부
    expect((await previewAuditPolicy({ filter: filterOf(), action: "keep" })).eligible).toBe(7);
    const count = async (filter: Partial<PolicyFilter>) => (await previewAuditPolicy({ filter: filterOf(filter), action: "keep" })).matched;
    expect(await count({ confidenceMin: 0.9, confidenceBelow: 0.95 })).toBe(1);
    expect(await count({ held: "held" })).toBe(2);
    expect(await count({ held: "not_held" })).toBe(5);
    expect(await count({ second: "agreed" })).toBe(1);
    expect(await count({ second: "approve" })).toBe(1);
    expect(await count({ second: "none" })).toBe(5);
    expect(await count({ second: "reject", secondSource: "grok-cli-batch" })).toBe(1);
    expect(await count({ second: "reject", secondSource: "qwen-vision-m1" })).toBe(0);
    expect(await count({ owner: "owned" })).toBe(2);
    expect(await count({ owner: "unowned" })).toBe(5);
    expect(await count({ branches: ["placeholder"] })).toBe(1);
    expect(await count({ waitMinDays: 7 })).toBe(1);
    expect(await count({ waitMaxDays: 7 })).toBe(6);
    expect(await count({ statuses: ["verified"] })).toBe(1);
    expect(await count({ reviewers: ["abcllm|[MLX] gpt-oss-120b"] })).toBe(7);
    expect(await count({ reviewers: ["qwen-direct|qwen3.8-flash-next"] })).toBe(0);
    expect(oldHeld).toBeTruthy();
  });

  it("표본은 손댈 것에서 갈래마다 수에 비례해 스무 건까지 — 같은 seed 면 같은 표본", async () => {
    await campaign();
    for (let index = 0; index < 30; index++) await finding(`company-${index}`);
    for (let index = 0; index < 10; index++) await finding(`empty-${index}`, { reason: EMPTY });
    const preview = await previewAuditPolicy({ filter: filterOf(), action: "remove", seed: "abc" });
    expect(preview.sample).toHaveLength(20);
    expect(preview.sample.filter((row) => row.branch === "company")).toHaveLength(15);
    expect(preview.sample.filter((row) => row.branch === "placeholder")).toHaveLength(5);
    const again = await previewAuditPolicy({ filter: filterOf(), action: "remove", seed: "abc" });
    expect(again.sample.map((row) => row.itemId)).toEqual(preview.sample.map((row) => row.itemId));
  });
});

describe("적용 — 수를 적고, 나눠서, 한 번만", () => {
  it("적은 수가 지금 수와 다르면 만들지 않고, 적용·되돌리기 중인 실행은 한 번에 하나다", async () => {
    await campaign();
    await finding("a");
    await finding("b");
    expect(await start("remove", 3)).toMatchObject({ ok: false, error: expect.stringContaining("2건") });
    const first = await start("remove", 2);
    expect(first).toMatchObject({ ok: true, planned: 2 });
    expect(await start("keep", 2)).toMatchObject({ ok: false, error: expect.stringContaining("다른 정책 실행") });
    expect(await db.select().from(productAuditPolicyRuns)).toHaveLength(1);
  });

  it("내리기 — 묶음마다 한도만큼, 같은 차단·사람 결정으로. 다 끝나면 작업 로그에 한 줄이고, 다시 불러도 아무것도 바뀌지 않는다", async () => {
    await campaign();
    const targets = [await finding("r1"), await finding("r2"), await finding("r3", { held: true }), await finding("r4"), await finding("r5")];
    const floor = await auditFloor();
    const run = await start("remove", 5);
    if (!run.ok) throw new Error(run.error);
    const first = (await applyAuditPolicyChunk({ runId: run.runId, by: "jr", limit: 2 }))!;
    expect(first).toMatchObject({ status: "applying", applied: 2, pending: 3, done: false });
    const { progress, calls } = await applyAll(run.runId, 2);
    expect(calls).toBe(2);
    expect(progress).toMatchObject({ status: "applied", applied: 5, pending: 0, skipped: 0, done: true });

    for (const target of targets) {
      expect(await productOf(target.productId)).toMatchObject({ status: "banned", auditHoldAt: null });
      expect(await itemOf(target.itemId)).toMatchObject({ humanDecision: "removed", humanBy: "jr", humanNote: `정책 #${run.runId} · 적체 정리` });
    }
    const [ban] = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, "r1"));
    expect(ban).toMatchObject({ action: "admin.product.ban", actor: "jr", reason: "not_product · audit:company" });
    expect(ban.metadata).toMatchObject({ source: "product-audit", policyRunId: run.runId, itemId: targets[0].itemId });
    const logs = await auditRowsAfter(floor, "audit-policy-apply");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ actor: "jr", target: `policy-run:${run.runId}`, ok: true });
    expect(logs[0].detail).toMatchObject({ policy: "remove", planned: 5, applied: 5, skipped: 0, filterText: "열린 거절 전체", note: "적체 정리" });

    // 다시 불러도(두 번 누른 창·되살아난 요청) 바뀌는 것이 없다
    const evidence = (await db.select().from(productEvidenceAudit)).length;
    expect(await applyAuditPolicyChunk({ runId: run.runId, by: "jr" })).toMatchObject({ status: "applied", applied: 5 });
    expect((await db.select().from(productEvidenceAudit)).length).toBe(evidence);
    expect(await auditRowsAfter(floor, "audit-policy-apply")).toHaveLength(1);
  });

  it("미리본 뒤 바뀐 것은 건너뛴다 — 사람이 정함·주인이 생김·두 번째 모델이 승인함", async () => {
    await campaign();
    const [decided, claimed, approved, fine] = [await finding("decided"), await finding("claimed"), await finding("approved"), await finding("fine")];
    const run = await start("remove", 4);
    if (!run.ok) throw new Error(run.error);
    await db.update(productAuditItems).set({ humanDecision: "kept", humanBy: "someone", humanAt: new Date() }).where(eq(productAuditItems.id, decided.itemId));
    await db.update(products).set({ claimedAt: new Date() }).where(eq(products.id, claimed.productId));
    await opinion(approved, "approve");
    const { progress } = await applyAll(run.runId);
    expect(progress).toMatchObject({ applied: 1, skipped: 3, status: "applied" });
    expect(Object.fromEntries((await policyRunExceptions(run.runId)).map((row) => [row.slug, row.reason]))).toEqual({
      decided: "changed", claimed: "owned", approved: "split" });
    expect((await productOf(claimed.productId)).status).toBe("seeded");
    expect((await productOf(fine.productId)).status).toBe("banned");
  });

  it("주인 있는 제품(클레임·검증·메이커 권한)은 거르기를 '주인 있음'으로 골라도 묶어서 내리지 않는다", async () => {
    await campaign();
    await finding("claimed", { product: { claimedAt: new Date() } });
    await finding("verified", { product: { status: "verified", verifiedAt: new Date() } });
    const member = await finding("member");
    const [user] = await db.insert(publicUsers).values({ displayName: "메이커" }).returning();
    await db.insert(productMakerMembers).values({ productId: member.productId, userId: user.id, role: "owner", method: "github_repo_owner" });
    const preview = await previewAuditPolicy({ filter: filterOf({ owner: "owned" }), action: "remove" });
    expect(preview).toMatchObject({ matched: 3, eligible: 0 });
    expect(await start("remove", 3, filterOf({ owner: "owned" }))).toMatchObject({ ok: false });
    // 유지는 막지 않는다 — 내리지 않는다
    expect((await previewAuditPolicy({ filter: filterOf({ owner: "owned" }), action: "keep" })).eligible).toBe(3);
  });

  it("유지 — 사람의 유지와 같은 결정·기한이고 보류를 풀며, 제품마다가 아니라 묶음마다 목록 지우기 줄 하나만 적는다", async () => {
    await campaign();
    const held = await finding("held", { held: true });
    const open = await finding("open");
    const run = await start("keep", 2, filterOf(), 365);
    if (!run.ok) throw new Error(run.error);
    await applyAll(run.runId);
    const item = await itemOf(held.itemId);
    expect(item).toMatchObject({ humanDecision: "kept", humanBy: "jr", holdReleasedAt: null });
    const [{ days }] = await db.execute<{ days: number }>(sql`select round(extract(epoch from (keep_until - human_at)) / 86400)::int as days
      from product_audit_items where id = ${held.itemId}`);
    expect(days).toBe(365);
    expect(await productOf(held.productId)).toMatchObject({ status: "seeded", auditHoldAt: null, auditHoldItemId: null });
    expect((await itemOf(open.itemId)).humanDecision).toBe("kept");
    expect(await db.select({ slug: cdnPurges.slug, reason: cdnPurges.reason }).from(cdnPurges)).toEqual([{ slug: "", reason: "audit_release" }]);
    const [release] = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, "audit.hold.release"));
    expect(release).toMatchObject({ slug: "held", reason: "kept", actor: "jr" });
    expect(release.metadata).toMatchObject({ policyRunId: run.runId });
  });

  it("Cloudflare 지우기 줄이 지난 60초에 한 번 몫을 넘으면 내리기는 기다리고, 유지는 기다리지 않는다", async () => {
    await campaign();
    await finding("x");
    await db.insert(cdnPurges).values(Array.from({ length: POLICY_CDN_ROOM }, (_, index) => ({ slug: `s${index}`, reason: "banned" })));
    const run = await start("remove", 1);
    if (!run.ok) throw new Error(run.error);
    expect(await applyAuditPolicyChunk({ runId: run.runId, by: "jr" })).toMatchObject({ applied: 0, pending: 1, waiting: { reason: "cdn" } });
    await db.update(cdnPurges).set({ createdAt: sql`now() - interval '2 minutes'` });
    expect(await applyAuditPolicyChunk({ runId: run.runId, by: "jr" })).toMatchObject({ applied: 1, done: true, waiting: null });
  });

  it("DR writer fence 가 닫혀 있으면 실행을 만들지도 적용하지도 않는다", async () => {
    await campaign();
    const target = await finding("fenced");
    fence.active = false;
    await expect(start("remove", 1)).rejects.toBeInstanceOf(DrWriterFencedError);
    expect(await db.select().from(productAuditPolicyRuns)).toEqual([]);
    fence.active = true;
    const run = await start("remove", 1);
    if (!run.ok) throw new Error(run.error);
    fence.active = false;
    await expect(applyAuditPolicyChunk({ runId: run.runId, by: "jr" })).rejects.toBeInstanceOf(DrWriterFencedError);
    expect((await productOf(target.productId)).status).toBe("seeded");
    expect(await policyRunProgress(run.runId)).toMatchObject({ pending: 1, applied: 0 });
    await expect(startAuditPolicyUndo({ runId: run.runId, by: "jr" })).rejects.toBeInstanceOf(DrWriterFencedError);
  });
});

describe("되돌리기", () => {
  it("내리기를 되돌린다 — 차단을 풀고 사람 결정을 지우고 보류를 원래 시각·항목으로 다시 건다. 그 뒤에 바뀐 것은 손대지 않고 까닭을 남긴다", async () => {
    await campaign();
    const held = await finding("held", { held: true });
    const plain = await finding("plain");
    const reBanned = await finding("rebanned");
    const redecided = await finding("redecided");
    const heldBefore = (await db.execute<{ at: string }>(sql`select audit_hold_at::text as at from products where id = ${held.productId}`))[0].at;
    const run = await start("remove", 4);
    if (!run.ok) throw new Error(run.error);
    await applyAll(run.runId);
    // 그 뒤에 바뀜: 누가 풀었다 다시 내림 · 사람 결정이 다른 것으로 바뀜
    const { setStatusWithAudit } = await import("@/lib/domain/products/repository");
    await setStatusWithAudit({ id: reBanned.productId, slug: "rebanned", status: "seeded", action: "admin.product.unban", actor: "other" });
    await setStatusWithAudit({ id: reBanned.productId, slug: "rebanned", status: "banned", action: "admin.product.ban", actor: "other" });
    await db.update(productAuditItems).set({ humanAt: sql`now() + interval '1 minute'`, humanBy: "other" }).where(eq(productAuditItems.id, redecided.itemId));
    const floor = await auditFloor();

    const progress = await undoAll(run.runId);
    expect(progress).toMatchObject({ status: "undone", undone: 2, blocked: 2, done: true });
    expect(await productOf(held.productId)).toMatchObject({ status: "seeded", auditHoldItemId: held.itemId });
    expect((await db.execute<{ at: string }>(sql`select audit_hold_at::text as at from products where id = ${held.productId}`))[0].at).toBe(heldBefore);
    expect(await itemOf(held.itemId)).toMatchObject({ humanDecision: null, humanBy: null, humanAt: null, humanNote: null, holdReleasedAt: null });
    expect(await productOf(plain.productId)).toMatchObject({ status: "seeded", auditHoldAt: null });
    expect((await itemOf(plain.itemId)).humanDecision).toBeNull();
    expect((await productOf(reBanned.productId)).status).toBe("banned");
    expect((await itemOf(redecided.itemId)).humanDecision).toBe("removed");
    expect(Object.fromEntries((await policyRunExceptions(run.runId)).map((row) => [row.slug, row.reason]))).toEqual({
      rebanned: "status_changed", redecided: "decision_changed" });
    const unban = (await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, "plain"))).find((row) => row.action === "admin.product.unban");
    expect(unban).toMatchObject({ actor: "jr", reason: "audit_policy_undo" });
    const rehold = (await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, "held")).orderBy(asc(productEvidenceAudit.id))).at(-1);
    expect(rehold).toMatchObject({ action: "audit.hold", reason: "policy_undo" });
    const logs = await auditRowsAfter(floor, "audit-policy-undo");
    expect(logs).toHaveLength(1);
    expect(logs[0].detail).toMatchObject({ undone: 2, blocked: 2, blockReasons: { status_changed: 1, decision_changed: 1 } });
    // 다시 되돌려도 바뀌지 않는다
    expect(await startAuditPolicyUndo({ runId: run.runId, by: "jr" })).toMatchObject({ ok: false });
  });

  it("유지를 되돌린다 — 결정·기한을 지우고 풀었던 보류와 '풀었음'을 되돌린다. 기한이 연장됐거나 주인이 생긴 것은 그대로 둔다", async () => {
    await campaign();
    const held = await finding("held", { held: true });
    const extended = await finding("extended");
    const claimed = await finding("claimed", { held: true });
    const run = await start("keep", 3);
    if (!run.ok) throw new Error(run.error);
    await applyAll(run.runId);
    await db.update(productAuditItems).set({ keepUntil: sql`keep_until + interval '90 days'` }).where(eq(productAuditItems.id, extended.itemId));
    await db.update(products).set({ claimedAt: new Date() }).where(eq(products.id, claimed.productId));

    expect(await undoAll(run.runId)).toMatchObject({ status: "undone", undone: 1, blocked: 2 });
    expect(await itemOf(held.itemId)).toMatchObject({ humanDecision: null, keepUntil: null, holdReleasedAt: null });
    expect(await productOf(held.productId)).toMatchObject({ auditHoldItemId: held.itemId });
    expect((await productOf(held.productId)).auditHoldAt).toBeInstanceOf(Date);
    expect((await itemOf(extended.itemId)).humanDecision).toBe("kept");
    expect((await itemOf(claimed.itemId)).humanDecision).toBe("kept");
    expect(Object.fromEntries((await policyRunExceptions(run.runId)).map((row) => [row.slug, row.reason]))).toEqual({
      extended: "keep_changed", claimed: "owned_now" });
    expect(await db.select({ slug: cdnPurges.slug, reason: cdnPurges.reason }).from(cdnPurges).orderBy(asc(cdnPurges.id)))
      .toEqual([{ slug: "", reason: "audit_release" }, { slug: "", reason: "audit_hold" }]);
  });

  it("적용 중에 되돌리면 남은 것은 취소하고 적용한 것만 되돌린다", async () => {
    await campaign();
    for (const slug of ["a", "b", "c"]) await finding(slug);
    const run = await start("keep", 3);
    if (!run.ok) throw new Error(run.error);
    await applyAuditPolicyChunk({ runId: run.runId, by: "jr", limit: 1 });
    expect(await undoAll(run.runId)).toMatchObject({ status: "undone", undone: 1, cancelled: 2, blocked: 0 });
    expect((await db.select().from(productAuditItems)).every((item) => item.humanDecision === null)).toBe(true);
    const [runRow] = await listPolicyRuns();
    expect(runRow).toMatchObject({ id: run.runId, status: "undone", counts: { undone: 1, cancelled: 2 } });
    expect(await db.select().from(productAuditPolicyRunItems).where(eq(productAuditPolicyRunItems.state, "pending"))).toEqual([]);
  });
});
