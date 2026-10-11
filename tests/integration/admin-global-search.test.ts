import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, operationsAudit, products } from "@/lib/db/schema";
import { adminGlobalSearch } from "@/lib/operations/admin-search";
import { ensureSchema, resetTables } from "./setup";

/** 관리자 전역 검색(⌘K, ADM-05) — 실제 쿼리. 작업 로그는 지울 수 없어(0056) 실행마다 고유한 말로 찾는다 */
const TAG = `zq${Date.now().toString(36)}`;

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates).where(like(crawlCandidates.repo, "gsearch/%"));
});

async function product(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({ slug, name: slug, url: `https://${slug}.example`, tagline: "t", description: "d", category: "Dev",
    status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", ...values });
}

describe("adminGlobalSearch", () => {
  it("제품은 이름·slug·주소·저장소로, 꼭 맞는 이름 먼저 그다음 스타 순으로 찾는다", async () => {
    await product(`${TAG}-big`, { name: `${TAG} Big`, stars: 900 });
    await product(`${TAG}`, { name: TAG, stars: 1 });
    await product("by-repo", { repoUrl: `https://github.com/acme/${TAG}-repo`, stars: 5 });
    await product("unrelated");
    const result = await adminGlobalSearch(TAG.toUpperCase());
    expect(result.products.map((p) => p.slug)).toEqual([TAG, `${TAG}-big`, "by-repo"]);
    expect(result.products[0]).toMatchObject({ href: `/admin/products/${TAG}`, publicHref: `/p/${TAG}`, logHref: `/admin/activity?target=${TAG}` });
  });

  it("후보는 저장소·배포 주소로 찾고, 꼭 맞는 저장소 이름 먼저", async () => {
    await db.insert(crawlCandidates).values([
      { repo: `gsearch/${TAG}-tools`, state: "needs_review" },
      { repo: `gsearch/${TAG}`, state: "rejected" },
      { repo: "gsearch/other", state: "new", productUrl: `https://${TAG}.example` },
    ]);
    const result = await adminGlobalSearch(TAG);
    const repos = result.candidates.map((c) => c.repo);
    expect(repos[0]).toBe(`gsearch/${TAG}`);
    expect(repos.slice(1).sort()).toEqual([`gsearch/${TAG}-tools`, "gsearch/other"].sort());
    const rejected = result.candidates.find((c) => c.repo === `gsearch/${TAG}`)!;
    expect(rejected.href).toBe(`/admin/review?state=rejected&q=gsearch%2F${TAG}&focus=${rejected.id}#review-list`);
  });

  it("작업 로그는 대상마다 한 줄 — 건수와 마지막 시각", async () => {
    await db.insert(operationsAudit).values([
      { actor: "jr", action: "product-ban", target: `${TAG}-slug`, detail: {} },
      { actor: "jr", action: "product-unban", target: `${TAG}-slug`, detail: {} },
      { actor: "jr", action: "export", target: `export:${TAG}`, detail: {} },
    ]);
    const result = await adminGlobalSearch(TAG);
    const slugRow = result.targets.find((t) => t.target === `${TAG}-slug`);
    expect(slugRow).toMatchObject({ count: 2, href: `/admin/activity?target=${TAG}-slug` });
    expect(slugRow!.lastAt).toBeInstanceOf(Date);
    expect(result.targets).toHaveLength(2);
  });

  it("% _ 는 글자 그대로, 한 글자는 찾지 않는다", async () => {
    await product("percent-a", { name: "100% real" });
    await product("percent-b", { name: "1000 real" });
    expect((await adminGlobalSearch("0%")).products.map((p) => p.slug)).toEqual(["percent-a"]);
    expect(await adminGlobalSearch("x")).toEqual({ q: "x", products: [], candidates: [], targets: [] });
  });
});
