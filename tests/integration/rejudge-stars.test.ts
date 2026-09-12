import { beforeAll, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlSettings } from "@/lib/db/schema";
import { saveSettings } from "@/lib/crawl/settings";
import { applyStarRejudge, planStarRejudge, revertStarRejudge, type StarRejudgeReceipt } from "@/lib/crawl/rejudge";
import { ensureSchema } from "./setup";

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlSettings);
  await saveSettings({ judge: { maxStars: 2000, excludeOrganizations: false } }, "test");
});

let serial = 0;
async function seed(stars: unknown, patch: Partial<typeof crawlCandidates.$inferInsert> = {}, status = 200) {
  const repo = `star-test/product-${++serial}`;
  const productUrl = `https://product-${serial}.example`;
  await db.insert(crawlDocuments).values({ repo, productUrl, pageStatus: status,
    repoMeta: { stargazers_count: stars, owner: { type: "User" }, description: "A useful application", pushed_at: new Date().toISOString() },
    pageMeta: { title: "Star Product", description: "An application for daily work" } });
  const [row] = await db.insert(crawlCandidates).values({ repo, productUrl, state: "rejected", reason: "large_oss",
    decidedBy: "auto", signals: { preserved: true }, ...patch }).returning();
  // DB가 보관한 마이크로초까지 보존해야 한다. JS Date 왕복으로는 이 값이 잘린다.
  await db.execute(sql`update crawl_candidates set updated_at = '2026-09-12 12:34:56.123456'::timestamp where id = ${row.id}`);
  return row;
}
async function state(id: number) {
  const [row] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, id));
  return row;
}
async function widen() {
  await saveSettings({ judge: { maxStars: 99999 } }, "test");
}

it("읽기 전용 계획은 네 구간의 자동 거부만 고르고 10만 이상과 사람 결정을 보존한다", async () => {
  for (const stars of [1999, 2000, 4999, 5000, 9999, 10000, 29999, 30000, 99999, 100000, 100001, null, "5000", 5000.5]) await seed(stars);
  await seed(5000, { decidedBy: "admin" });
  await seed(5000, { decidedAt: new Date() });
  await seed(5000, { publishedSlug: "already-published" });
  await seed(5000, { state: "needs_review" });
  await seed(5000, { reason: "not_a_product" });
  await seed(5000, {}, 404);
  const before = await db.select().from(crawlCandidates);
  const plan = await planStarRejudge();
  expect(plan.entries.map(e => e.stars)).toEqual([2000, 4999, 5000, 9999, 10000, 29999, 30000, 99999]);
  expect(plan.fromMaxStars).toBe(2000);
  expect(plan.toMaxStars).toBe(99999);
  expect(plan.entries.every(e => e.preview.reason !== "large_oss")).toBe(true);
  expect(await db.select().from(crawlCandidates)).toEqual(before);
});

it("상한을 바꾸기 전, 다른 설정이 바뀐 뒤, 다른 DB 계획은 적용하지 않는다", async () => {
  await seed(5000);
  const plan = await planStarRejudge();
  await expect(applyStarRejudge(plan, () => {})).rejects.toThrow(/설정/);
  await widen();
  await expect(applyStarRejudge({ ...plan, database: "0".repeat(32) }, () => {})).rejects.toThrow(/DB/);
  await saveSettings({ judge: { minStars: 10 } }, "test");
  await expect(applyStarRejudge(plan, () => {})).rejects.toThrow(/설정/);
});

it("변경된 후보·원본을 건너뛰고 new만 기록하며 재실행으로 다시 바꾸지 않는다", async () => {
  const a = await seed(5000), b = await seed(6000), c = await seed(7000);
  const plan = await planStarRejudge();
  await widen();
  await db.update(crawlCandidates).set({ decidedBy: "admin" }).where(eq(crawlCandidates.id, b.id));
  await db.update(crawlDocuments).set({ pageStatus: 404 }).where(eq(crawlDocuments.repo, c.repo));
  let saved: StarRejudgeReceipt | undefined;
  const receipt = await applyStarRejudge(plan, r => { saved = r; });
  expect(saved).toEqual(receipt);
  expect(receipt.entries.map(e => e.id)).toEqual([a.id]);
  expect(receipt.skipped).toBe(2);
  expect(await state(a.id)).toMatchObject({ state: "new", reason: "large_oss", signals: { preserved: true } });
  expect(await state(b.id)).toMatchObject({ state: "rejected", decidedBy: "admin" });
  expect((await state(c.id)).state).toBe("rejected");
  expect((await applyStarRejudge(plan, () => {})).entries).toHaveLength(0);
});

it("영수증을 저장하지 못하면 변경 전체를 롤백한다", async () => {
  const a = await seed(5000);
  const plan = await planStarRejudge();
  await widen();
  await expect(applyStarRejudge(plan, () => { throw new Error("disk full"); })).rejects.toThrow("disk full");
  expect((await state(a.id)).state).toBe("rejected");
});

it("실제 적용분 중 아직 처리되지 않은 행만 원래 시각까지 되돌린다", async () => {
  const a = await seed(5000), b = await seed(6000), c = await seed(7000);
  const plan = await planStarRejudge();
  await widen();
  const receipt = await applyStarRejudge(plan, () => {});
  await db.update(crawlCandidates).set({ state: "needs_review", reason: "ambiguous" }).where(eq(crawlCandidates.id, b.id));
  await db.update(crawlDocuments).set({ pageStatus: 404 }).where(eq(crawlDocuments.repo, c.repo));
  expect(await revertStarRejudge(receipt)).toEqual({ reverted: 1, skipped: 2 });
  expect((await state(a.id)).state).toBe("rejected");
  const [exact] = await db.execute<{ stamp: string }>(sql`select updated_at::text stamp from crawl_candidates where id = ${a.id}`);
  expect(exact.stamp).toBe("2026-09-12 12:34:56.123456");
  expect((await state(b.id)).state).toBe("needs_review");
  expect((await state(c.id)).state).toBe("new");
  expect(await revertStarRejudge(receipt)).toEqual({ reverted: 0, skipped: 3 });
});

it("중복 ID·변조한 범위의 계획과 계획을 가장한 영수증을 거부한다", async () => {
  await seed(5000);
  const plan = await planStarRejudge();
  await widen();
  await expect(applyStarRejudge({ ...plan, entries: [...plan.entries, ...plan.entries] }, () => {})).rejects.toThrow();
  await expect(applyStarRejudge({ ...plan, toMaxStars: 100000 }, () => {})).rejects.toThrow();
  await expect(revertStarRejudge(plan)).rejects.toThrow();
});
