import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings, productAuditCampaigns, productAuditItems, products } from "@/lib/db/schema";
import * as crawl from "@/lib/crawl/repository";
import { createReviewInput } from "@/lib/crawl/agent-review-contract";
import { applyAuditPolicyChunk, AUDIT_BACKLOG_OVERDUE_DAYS, auditThroughput, expiringKeepCount, openBacklogStats, policyRunExceptions, previewKeepExtend,
  startAuditPolicyUndo, startKeepExtendRun, undoAuditPolicyChunk } from "@/lib/crawl/audit-policy";
import { auditSettings, auditSourceHash, keptContentStatus } from "@/lib/crawl/product-audit";
import { getSettings } from "@/lib/crawl/settings";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlSettings);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.insert(productAuditCampaigns).values({ startedBy: "jr", reason: "감사", promptVersion: "p", rulesVersion: "r", provider: "abcllm",
    model: "[MLX] gpt-oss-120b", status: "done" });
});

let sequence = 0;
/** 공개 제품 — source 면 수집 원본(후보·문서)까지 */
async function product(slug: string, over: { status?: "seeded" | "banned"; source?: boolean } = {}) {
  const url = `https://${slug}.test`;
  const [row] = await db.insert(products).values({ slug, url, name: `이름 ${slug}`, tagline: "t", description: "d", category: "Dev",
    status: over.status ?? "seeded", source: "crawler", verifyToken: `v-${++sequence}`, editTokenHash: "e" }).returning();
  if (over.source !== false) {
    const repo = `n/${slug}`;
    await crawl.putDocument({ repo, productUrl: url, pageStatus: 200,
      repoMeta: { description: "레포", stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: "User" } },
      pageMeta: { title: slug, textSample: "쓸 수 있는 앱" } });
    await db.insert(crawlCandidates).values({ repo, productUrl: url, state: "published", reason: "passed", decidedBy: "auto",
      publishedSlug: slug, judgedAt: new Date(), decidedAt: new Date() });
  }
  return row;
}
/** 지금 수집 원본의 해시 — 유지할 때 그 페이지를 봤다 */
async function currentHash(slug: string) {
  const [row] = await db.select({ candidate: crawlCandidates, document: crawlDocuments }).from(crawlCandidates)
    .innerJoin(crawlDocuments, eq(crawlDocuments.repo, crawlCandidates.repo)).where(eq(crawlCandidates.publishedSlug, slug));
  return auditSourceHash(createReviewInput(row.candidate, row.document, auditSettings(await getSettings()), { scan: null, observations: [] }));
}
type ItemInsert = typeof productAuditItems.$inferInsert;
async function item(productId: number, slug: string, over: { [K in keyof ItemInsert]?: ItemInsert[K] | SQL } = {}) {
  const [campaign] = await db.select().from(productAuditCampaigns).limit(1);
  const [row] = await db.insert(productAuditItems).values({ campaignId: campaign.id, productId, slug, aiDecision: "reject", aiConfidence: 0.97,
    aiReason: "agency", attempts: 1, reviewedAt: sql`now() - interval '1 day'`, ...over }).returning();
  return row;
}
const kept = async (slug: string, keepInDays: number, hash: string | null, over: { status?: "seeded" | "banned"; source?: boolean } = {}) => {
  const p = await product(slug, over);
  const sourceHash = hash === "current" ? await currentHash(slug) : hash;
  return item(p.id, slug, { humanDecision: "kept", humanBy: "jr", humanAt: sql`now() - interval '80 days'`, sourceHash,
    keepUntil: sql`now() + ${keepInDays} * interval '1 day'` });
};

describe("처리 속도·적체", () => {
  it("열린 거절의 수·보류·7일 넘은 것·가장 오래 기다린 날 — 닫은 것·내려간 것은 세지 않는다", async () => {
    const a = await product("a");
    const b = await product("b");
    const c = await product("c");
    const d = await product("d", { status: "banned" });
    await item(a.id, "a", { reviewedAt: sql`now() - interval '12 days'` });
    const held = await item(b.id, "b", { reviewedAt: sql`now() - interval '2 days'` });
    await db.update(products).set({ auditHoldAt: new Date(), auditHoldItemId: held.id }).where(eq(products.id, b.id));
    await item(c.id, "c", { humanDecision: "kept", humanAt: new Date(), reviewedAt: sql`now() - interval '30 days'` });
    await item(d.id, "d", { reviewedAt: sql`now() - interval '40 days'` });
    expect(await openBacklogStats()).toEqual({ open: 2, held: 1, overdue: 1, oldestWaitDays: 12 });
    expect(AUDIT_BACKLOG_OVERDUE_DAYS).toBe(7);
  });

  it("날마다 닫은 수와 들어온 수(한국 날짜), 어제까지 7일 평균 — 줄지 않으면 다 닫는 날이 없고, 줄면 남은 수 ÷ 하루 순감", async () => {
    // 어제까지 7일 동안 하루 2건씩 들어오고(14), 3일 전 하루에 21건 닫음 → 평균 닫음 3·들어옴 2 → 순감 1/일
    for (let day = 1; day <= 7; day++) {
      for (let index = 0; index < 2; index++) {
        const p = await product(`in-${day}-${index}`, { source: false });
        await item(p.id, p.slug, { reviewedAt: sql`now() - ${day} * interval '1 day'` });
      }
    }
    for (let index = 0; index < 21; index++) {
      const p = await product(`done-${index}`, { source: false });
      await item(p.id, p.slug, { reviewedAt: sql`now() - interval '20 days'`, humanDecision: "removed", humanAt: sql`now() - interval '3 days'` });
    }
    const t = await auditThroughput();
    expect(t.days).toHaveLength(14);
    expect(t.days.reduce((sum, day) => sum + day.incoming, 0)).toBe(14);
    expect(t.days.reduce((sum, day) => sum + day.closed, 0)).toBe(21);
    expect(t.closedPerDay).toBeCloseTo(3, 5);
    expect(t.incomingPerDay).toBeCloseTo(2, 5);
    expect(t.open).toBe(14);
    expect(t.daysToClear).toBe(14);
    // 닫은 것을 지우면(가정) 줄지 않음
    await db.update(productAuditItems).set({ humanAt: sql`now() - interval '30 days'` }).where(eq(productAuditItems.humanDecision, "removed"));
    expect((await auditThroughput()).daysToClear).toBeNull();
  });
});

describe("유지 연장", () => {
  it("곧 끝나는 유지 — 페이지 그대로·바뀜·원본 없음을 가르고, 기본은 그대로인 것만 연장한다", async () => {
    const same = await kept("same", 10, "current");
    await kept("changed", 12, "f".repeat(64));
    await kept("nosource", 5, "e".repeat(64), { source: false });
    await kept("later", 60, "current");
    await kept("gone", 3, "current", { status: "banned" });
    expect(await expiringKeepCount()).toBe(3);
    const status = await keptContentStatus([{ itemId: same.id, productId: same.productId, sourceHash: same.sourceHash }]);
    expect(status.get(same.id)).toBe("same");
    expect(await previewKeepExtend({ unchangedOnly: true })).toMatchObject({ expiring: 3, same: 1, changed: 1, noSource: 1, eligible: 1 });
    expect((await previewKeepExtend({ unchangedOnly: false })).eligible).toBe(3);
  });

  it("연장 — 적은 수가 같을 때만, 만들 때의 기한이 그대로인 것만 늦추고, 되돌리면 원래 기한으로. 그 뒤 기한이 또 바뀐 것은 그대로 둔다", async () => {
    const a = await kept("a", 10, "current");
    const b = await kept("b", 20, "current");
    const c = await kept("c", 25, "current");
    expect(await startKeepExtendRun({ days: 90, unchangedOnly: true, expected: 2, note: "", by: "jr" })).toMatchObject({ ok: false });
    const run = await startKeepExtendRun({ days: 90, unchangedOnly: true, expected: 3, note: "연장", by: "jr" });
    if (!run.ok) throw new Error(run.error);
    // 만든 뒤 사람이 c 를 다시 정함(기한 바뀜) → 건너뜀
    await db.update(productAuditItems).set({ keepUntil: sql`now() + interval '200 days'` }).where(eq(productAuditItems.id, c.id));
    let progress;
    do progress = (await applyAuditPolicyChunk({ runId: run.runId, by: "jr" }))!; while (!progress.done);
    expect(progress).toMatchObject({ applied: 2, skipped: 1 });
    const daysLeft = async (id: number) => (await db.execute<{ d: number }>(sql`select round(extract(epoch from (keep_until - now())) / 86400)::int as d
      from product_audit_items where id = ${id}`))[0].d;
    expect(await daysLeft(a.id)).toBe(100);
    expect(await daysLeft(b.id)).toBe(110);
    expect(await daysLeft(c.id)).toBe(200);
    // b 는 그 뒤 또 바뀜 → 되돌리지 않는다
    await db.update(productAuditItems).set({ keepUntil: sql`keep_until + interval '1 day'` }).where(eq(productAuditItems.id, b.id));
    expect(await startAuditPolicyUndo({ runId: run.runId, by: "jr" })).toMatchObject({ ok: true });
    do progress = (await undoAuditPolicyChunk({ runId: run.runId, by: "jr" }))!; while (!progress.done);
    expect(progress).toMatchObject({ undone: 1, blocked: 1 });
    expect(await daysLeft(a.id)).toBe(10);
    expect(await daysLeft(b.id)).toBe(111);
    expect(Object.fromEntries((await policyRunExceptions(run.runId)).map((row) => [row.slug, row.reason]))).toEqual({ b: "keep_changed", c: "changed" });
  });
});
