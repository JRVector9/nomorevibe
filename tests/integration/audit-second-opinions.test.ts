import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { cdnPurges, crawlSettings, productAuditCampaigns, productAuditItems, productAuditSecondOpinions, productEvidenceAudit, products } from "@/lib/db/schema";
import { importAuditSecondOpinions, type SecondOpinionLine } from "@/lib/crawl/audit-second-opinion-import";
import { getSettings, setAuditHold } from "@/lib/crawl/settings";
import { ensureSchema, resetTables, TEST_DATABASE_URL } from "./setup";

/** DR writer fence 가 닫힌 쓰기 거부만 바꿔 본다 — 나머지는 실제 DB */
const fence = vi.hoisted(() => ({ active: true }));
vi.mock("@/lib/operations/dr/epoch", async (original) => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(),
  writerSiteActive: async () => fence.active }));

/**
 * 두 번째 의견 옮겨 적기(0110) — grok 일괄 JSONL 을 product_audit_second_opinions 에 넣는다. 같은 (항목, 모델)은 덮어쓰고,
 * 오류·없는 항목·이제 열린 거절이 아닌 항목은 건너뛰며, --dry-run 은 아무것도 쓰지 않는다.
 */
beforeAll(() => ensureSchema());
beforeEach(async () => {
  fence.active = true;
  // 보류 설정은 기본값(켬·두 번째 거절 셈)에서 시작한다
  await db.delete(crawlSettings);
  await db.delete(productAuditItems);
  await db.delete(productAuditCampaigns);
  await resetTables();
});

let sequence = 0;
/** 감사 항목 하나 — 기본은 열린 거절(사람이 아직 정하지 않았고 제품이 떠 있다) */
async function auditItem(slug: string, over: { decision?: "reject" | "approve"; human?: "kept"; status?: "seeded" | "banned" } = {}) {
  const [product] = await db.insert(products).values({ slug, url: `https://${slug}.test`, name: slug, tagline: "t", description: "d",
    category: "Dev", status: over.status ?? "seeded", source: "crawler", verifyToken: `v-${++sequence}`, editTokenHash: "e" }).returning();
  let [campaign] = await db.select().from(productAuditCampaigns).limit(1);
  campaign ??= (await db.insert(productAuditCampaigns).values({ startedBy: "jr", reason: "감사", promptVersion: "p", rulesVersion: "r",
    provider: "abcllm", model: "m", status: "done" }).returning())[0];
  const [row] = await db.insert(productAuditItems).values({ campaignId: campaign.id, productId: product.id, slug,
    aiDecision: over.decision ?? "reject", aiConfidence: 0.97, aiReason: "x", humanDecision: over.human ?? null }).returning();
  return { itemId: row.id, productId: product.id };
}
const line = (target: { itemId: number; productId: number }, over: Partial<SecondOpinionLine> = {}): SecondOpinionLine => ({
  auditResultId: target.itemId, productId: target.productId, grokDecision: "reject", grokConfidence: 0.9, grokReason: "a design agency site",
  model: "grok-4-fast", inputHash: "a".repeat(64), error: null, ...over,
});
const opinions = () => db.select().from(productAuditSecondOpinions).orderBy(asc(productAuditSecondOpinions.itemId));
const run = (lines: SecondOpinionLine[], dryRun = false) => importAuditSecondOpinions(db, lines, { dryRun, source: "grok-cli-batch" });

describe("두 번째 의견 옮겨 적기", () => {
  it("열린 거절에만 넣고 나머지는 까닭별로 센다 — 같은 파일의 같은 (항목, 모델)은 뒤의 것만", async () => {
    const [open, other, kept, approved, banned] = [await auditItem("open"), await auditItem("other"), await auditItem("kept", { human: "kept" }),
      await auditItem("approved", { decision: "approve" }), await auditItem("banned", { status: "banned" })];
    const result = await run([
      line(open, { grokDecision: "approve" }), line(open), line(other, { grokDecision: "needs_review", grokConfidence: null, grokReason: "x".repeat(3_000) }),
      line(kept), line(approved), line(banned),
      line({ itemId: 999_999, productId: open.productId }), line({ itemId: other.itemId, productId: open.productId }, { model: "grok-other" }),
      line(open, { error: "timeout" }), line(open, { grokDecision: "maybe" }), line(open, { grokConfidence: 2 }), {},
    ]);
    expect(result).toEqual({ read: 12, inserted: 2, updated: 0, released: 0, dryRun: false,
      skipped: { error: 1, invalid: 3, duplicate: 1, missing: 1, product_mismatch: 1, not_open: 3 } });
    const rows = await opinions();
    expect(rows.map((row) => [row.itemId, row.productId, row.model, row.decision, row.confidence, row.source])).toEqual([
      [open.itemId, open.productId, "grok-4-fast", "reject", 0.9, "grok-cli-batch"],
      [other.itemId, other.productId, "grok-4-fast", "needs_review", null, "grok-cli-batch"],
    ]);
    expect(rows[1].reason).toHaveLength(2_000);
  });

  it("다시 옮겨 적어도 같다 — 같은 (항목, 모델)은 덮어써 한 줄이고, 다른 모델은 따로 한 줄", async () => {
    const target = await auditItem("again");
    expect(await run([line(target)])).toMatchObject({ inserted: 1, updated: 0 });
    expect(await run([line(target)])).toMatchObject({ inserted: 0, updated: 1 });
    expect(await run([line(target, { grokDecision: "approve", grokConfidence: 0.6 })])).toMatchObject({ inserted: 0, updated: 1 });
    expect((await opinions()).map((row) => [row.model, row.decision, row.confidence])).toEqual([["grok-4-fast", "approve", 0.6]]);
    expect(await run([line(target, { model: "grok-5" })])).toMatchObject({ inserted: 1 });
    expect(await opinions()).toHaveLength(2);
  });

  it("dry-run 은 넣을 것·덮어쓸 것·건너뛸 것을 세기만 하고 아무것도 쓰지 않는다", async () => {
    const [fresh, existing] = [await auditItem("fresh"), await auditItem("existing")];
    await run([line(existing, { grokDecision: "approve" })]);
    const before = await opinions();
    expect(await run([line(fresh), line(existing), line(fresh, { error: "boom" })], true)).toEqual({ read: 3, inserted: 1, updated: 1, released: 0, dryRun: true,
      skipped: { error: 1, invalid: 0, duplicate: 0, missing: 0, product_mismatch: 0, not_open: 0 } });
    expect(await opinions()).toEqual(before);
  });

  it("DR writer fence 가 닫혀 있으면 쓰지 않고 멈춘다", async () => {
    const target = await auditItem("fenced");
    fence.active = false;
    await expect(run([line(target)])).rejects.toThrow();
    expect(await opinions()).toEqual([]);
  });

  it("항목이 지워지면 그 의견도 함께 지운다(on delete cascade)", async () => {
    const target = await auditItem("gone");
    await run([line(target)]);
    await db.delete(productAuditItems).where(eq(productAuditItems.id, target.itemId));
    expect(await opinions()).toEqual([]);
  });
});

describe("승인 의견이 보류를 푼다", () => {
  /** 그 항목으로 보류된 제품 — 보류는 늘 시스템이 건다(product-audit-hold.ts). 여기서는 걸린 상태만 만든다 */
  const hold = (target: { itemId: number; productId: number }) =>
    db.update(products).set({ auditHoldAt: new Date(), auditHoldItemId: target.itemId }).where(eq(products.id, target.productId));
  const product = async (id: number) => (await db.select().from(products).where(eq(products.id, id)))[0];
  const releases = () => db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.action, "audit.hold.release"));

  it("이미 보류된 회사 소개 항목에 승인을 옮겨 적으면 같은 트랜잭션에서 풀고 다시 걸지 않게 적는다 — dry-run 은 풀 수만 센다", async () => {
    const held = await auditItem("held-company");
    const other = await auditItem("not-held");
    await hold(held);

    expect(await run([line(held, { grokDecision: "approve" }), line(other, { grokDecision: "approve" })], true)).toMatchObject({ released: 1, inserted: 2 });
    expect((await product(held.productId)).auditHoldAt).toBeInstanceOf(Date);
    expect(await releases()).toEqual([]);

    expect(await run([line(held, { grokDecision: "approve" }), line(other, { grokDecision: "approve" })])).toMatchObject({ released: 1, inserted: 2 });
    expect(await product(held.productId)).toMatchObject({ auditHoldAt: null, auditHoldItemId: null, status: "seeded" });
    const [item] = await db.select().from(productAuditItems).where(eq(productAuditItems.id, held.itemId));
    expect(item).toMatchObject({ humanDecision: null });
    expect(item.holdReleasedAt).toBeInstanceOf(Date);
    expect((await releases()).map((row) => [row.slug, row.actor, row.reason, row.metadata.itemId]))
      .toEqual([["held-company", "import:grok-cli-batch", "second_approve", held.itemId]]);
    expect(await db.select({ slug: cdnPurges.slug, reason: cdnPurges.reason }).from(cdnPurges)).toEqual([{ slug: "held-company", reason: "audit_release" }]);
    // 다시 옮겨 적어도 풀 것이 없다
    expect(await run([line(held, { grokDecision: "approve" })])).toMatchObject({ released: 0, updated: 1 });
  });

  it("두 번째 거절로 걸린 항목은 다른 모델이 승인해도 거절이 남아 있는 동안 풀지 않는다 — 그 거절이 승인으로 바뀌면 푼다", async () => {
    const target = await auditItem("held-by-vote");
    expect(await run([line(target, { model: "grok-4-fast", grokDecision: "reject" })])).toMatchObject({ inserted: 1, released: 0 });
    await hold(target);
    expect(await run([line(target, { model: "grok-5", grokDecision: "approve" })], true)).toMatchObject({ released: 0 });
    expect(await run([line(target, { model: "grok-5", grokDecision: "approve" })])).toMatchObject({ inserted: 1, released: 0 });
    expect((await product(target.productId)).auditHoldAt).toBeInstanceOf(Date);

    expect(await run([line(target, { model: "grok-4-fast", grokDecision: "approve" })], true)).toMatchObject({ released: 1 });
    expect(await run([line(target, { model: "grok-4-fast", grokDecision: "approve" })])).toMatchObject({ updated: 1, released: 1 });
    expect((await product(target.productId)).auditHoldAt).toBeNull();
  });

  it("푸는지는 덮어쓴 뒤의 의견과 지금 설정으로 보류 조건을 다시 갈라 정한다 — 두 번째 거절을 세지 않게 꺼 두었으면 거절이 남아도 승인이 푼다", async () => {
    const target = await auditItem("gate");
    await run([line(target, { model: "grok-4-fast", grokDecision: "reject" })]);
    await hold(target);
    const expected = (await getSettings()).auditHold;
    expect(await setAuditHold({ next: { ...expected, secondOpinionReject: false }, expected, actor: "jr" })).toMatchObject({ ok: true });
    // 사유 'x' 는 허용 갈래가 아니다(기타) — 두 번째 거절을 세지 않으면 이 보류의 까닭이 남지 않는다
    expect(await run([line(target, { model: "grok-5", grokDecision: "approve" })], true)).toMatchObject({ released: 1 });
    expect(await run([line(target, { model: "grok-5", grokDecision: "approve" })])).toMatchObject({ released: 1 });
    expect((await product(target.productId)).auditHoldAt).toBeNull();
  });

  it("판단 보류 의견은 풀지 않고, 다른 항목으로 걸린 보류도 풀지 않는다", async () => {
    const unsure = await auditItem("unsure");
    await hold(unsure);
    expect(await run([line(unsure, { grokDecision: "needs_review" })])).toMatchObject({ released: 0 });
    // 같은 제품이지만 보류의 까닭은 다른(옛) 항목이다 — 이 승인으로는 풀지 않는다
    const other = await auditItem("older");
    await db.update(products).set({ auditHoldAt: new Date(), auditHoldItemId: other.itemId + 1000 }).where(eq(products.id, other.productId));
    expect(await run([line(other, { grokDecision: "approve" })])).toMatchObject({ released: 0 });
    expect((await product(unsure.productId)).auditHoldAt).toBeInstanceOf(Date);
    expect((await product(other.productId)).auditHoldAt).toBeInstanceOf(Date);
    expect(await releases()).toEqual([]);
  });
});

describe("옮겨 적기 명령(scripts/ops/import-audit-second-opinions.ts)", () => {
  const exec = promisify(execFile);
  const root = path.resolve(__dirname, "../..");
  const script = (args: string[], env: Record<string, string>) => exec(process.execPath, ["--import", "tsx", "scripts/ops/import-audit-second-opinions.ts", ...args],
    { cwd: root, env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", ...env } as NodeJS.ProcessEnv, timeout: 60_000 });

  it("--dry-run 은 수만 내고 쓰지 않는다. 다음 실행이 넣고, 한 번 더 돌리면 덮어쓴다", async () => {
    const target = await auditItem("cli");
    const dir = await mkdtemp(path.join(tmpdir(), "second-opinions-"));
    const file = path.join(dir, "grok.jsonl");
    await writeFile(file, `${JSON.stringify(line(target))}\nnot json\n\n${JSON.stringify(line(target, { error: "timeout" }))}\n`);
    const env = { AUDIT_SECOND_OPINIONS_DATABASE_URL: TEST_DATABASE_URL };

    const dry = JSON.parse((await script([file, "--dry-run"], env)).stdout);
    expect(dry).toMatchObject({ command: "import-audit-second-opinions", source: "grok-cli-batch", dryRun: true, read: 3, inserted: 1, updated: 0,
      skipped: { error: 1, invalid: 1 } });
    expect(await opinions()).toEqual([]);

    expect(JSON.parse((await script([file], env)).stdout)).toMatchObject({ dryRun: false, inserted: 1, updated: 0 });
    expect(JSON.parse((await script([file, "--source=grok-rerun"], env)).stdout)).toMatchObject({ inserted: 0, updated: 1 });
    expect((await opinions()).map((row) => [row.itemId, row.decision, row.source])).toEqual([[target.itemId, "reject", "grok-rerun"]]);
    // 사유 문장은 출력하지 않는다
    expect((await script([file, "--dry-run"], env)).stdout).not.toContain("design agency");
  }, 120_000);

  it("DB 주소는 전용 환경변수로만 받는다 — 없으면 고정 code 로 끝나고 주소를 쓰지 않는다", async () => {
    const failed = await script(["missing.jsonl", "--dry-run"], {}).catch((error: { code: number; stderr: string }) => error);
    expect(failed).toMatchObject({ code: 1 });
    expect(JSON.parse((failed as { stderr: string }).stderr)).toEqual({ code: "explicit_AUDIT_SECOND_OPINIONS_DATABASE_URL_required" });
    const usage = await script(["--dry-run"], { AUDIT_SECOND_OPINIONS_DATABASE_URL: TEST_DATABASE_URL }).catch((error: { stderr: string }) => error);
    expect(JSON.parse((usage as { stderr: string }).stderr)).toEqual({ code: "second_opinions_usage" });
  }, 60_000);
});
