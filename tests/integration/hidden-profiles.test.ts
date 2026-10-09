import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { ensureSchema, resetTables } from "./setup";

const { db } = await import("@/lib/db");
const { crawlCandidates, crawlDocuments, products, productUpdates } = await import("@/lib/db/schema");
const { getDiscoveryList, getNewThisWeek, getPublicList, getUnclaimedList } = await import("@/lib/domain/products/view");
const { categoryCounts, countProducts, listProductRows, listRecentlyDiscovered } = await import("@/lib/domain/products/repository");
const { getPopularGroups } = await import("@/lib/domain/products/popular");
const { loadHomePulse } = await import("@/lib/domain/products/home-pulse");
const { rankRelevance } = await import("@/lib/domain/products/relevance");
const { EMBEDDING_MODEL, vectorLiteral } = await import("@/lib/domain/products/embedding");
const { clearAllMemos } = await import("@/lib/cache/memo");

/**
 * UX-22(운영자 결정 D2) — 주인 없는 개인 프로필은 공개 목록·분야·검색·인기·피드·홈 집계에 없다. 주인이 등록했거나 클레임한 것은 있다.
 */
const QUERY = Array.from({ length: 1024 }, (_, k) => (k === 0 ? 1 : 0));

async function product(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({
    slug, url: `https://${slug}.example`, name: slug, tagline: "portfolio of a designer", description: "portfolio of a designer",
    category: "Profile", status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "e",
    // 급상승(스타 2천 미만, 하루 사이 늚)에 든다. 인기 구간은 그 테스트에서 2천 위로 올린다
    stars: 1_500, starsAt: new Date(), starsPrevious: 1_400, starsPreviousAt: sql`now() - interval '1 day'` as unknown as Date,
    createdAt: sql`now() - interval '10 days'` as unknown as Date, ...values,
  }).returning({ id: products.id });
  await db.execute(sql`insert into product_embeddings (product_id, model, text_hash, embedding)
    values (${row.id}, ${EMBEDDING_MODEL}, 'h', ${vectorLiteral(QUERY)}::halfvec)`);
  // 홈 '이번 주 새 버전' 집계에 들 새 릴리스
  await db.insert(productUpdates).values({ slug, sourceKind: "github_release", dedupeKey: `${slug}:v1`, title: "v1",
    observedAt: sql`now() - interval '3 days'` as unknown as Date, publishedAt: sql`now() - interval '3 days'` as unknown as Date });
  return row.id;
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  clearAllMemos();
  await product("hidden-profile");
  // 주인이 있는 프로필 — 메이커가 등록해 검증했거나, 우리가 올린 것을 클레임했다
  await product("registered-profile", { source: "skill", status: "verified", verifiedAt: sql`now() - interval '10 days'` as unknown as Date });
  await product("claimed-profile", { claimedAt: new Date() });
  // 다른 분야의 주인 없는 제품은 그대로
  await product("plain-tool", { category: "Dev" });
});

const slugs = (rows: { slug: string }[]) => rows.map((row) => row.slug).sort();
const VISIBLE = ["claimed-profile", "plain-tool", "registered-profile"];

describe("주인 없는 개인 프로필은 공개 목록에서 빠진다", () => {
  it("홈 목록(최신·급상승·스타·이번 주)·발견·RSS", async () => {
    expect(slugs(await getPublicList(20))).toEqual(VISIBLE);
    expect(slugs(await getPublicList(20, { sort: "rising", rising: true }))).toEqual(VISIBLE);
    expect(slugs(await getPublicList(20, { sort: "stars" }))).toEqual(VISIBLE);
    expect(slugs(await getNewThisWeek(20, new Date(Date.now() - 30 * 86_400_000)))).toEqual(VISIBLE);
    // 상태가 seeded 인 목록 — 클레임한 프로필은 주인이 있어 남는다
    expect(slugs(await getUnclaimedList(20))).toEqual(["claimed-profile", "plain-tool"]);
    expect(slugs(await getDiscoveryList(20))).toEqual(VISIBLE);
    expect(slugs(await listRecentlyDiscovered(20))).toEqual(VISIBLE);
  });

  it("분야 목록과 분야 칩의 수", async () => {
    expect(slugs(await getPublicList(20, { category: "Profile" }))).toEqual(["claimed-profile", "registered-profile"]);
    expect(await categoryCounts({ statuses: ["verified", "seeded"], excludeDown: true })).toEqual({ Profile: 2, Dev: 1 });
    expect(await countProducts({ statuses: ["verified", "seeded"], excludeDown: true })).toBe(3);
  });

  it("검색 — 낱말 검색과 의미 검색 모두", async () => {
    expect(slugs(await getPublicList(20, { query: "portfolio designer", sort: "relevance" }))).toEqual(VISIBLE);
    const ranked = await rankRelevance("designer portfolio", ["designer portfolio"], {},
      { embed: vi.fn(async () => QUERY), rerank: vi.fn(async (_q: string, docs: string[]) => docs.map((_, i) => -i)) });
    expect([...ranked.head].sort()).toEqual(VISIBLE);
  });

  it("인기 구간과 홈 집계", async () => {
    await db.update(products).set({ stars: 3_000 });
    const popular = await getPopularGroups();
    expect(slugs(popular.flatMap((group) => group.items))).toEqual(VISIBLE);
    expect(popular.reduce((sum, group) => sum + group.total, 0)).toBe(3);
    const pulse = await loadHomePulse(new Date());
    expect(pulse.total).toBe(3);
    expect(pulse.categories).toEqual(expect.arrayContaining([expect.objectContaining({ key: "Profile", total: 2 })]));
    expect(pulse.active.map((row) => row.slug).sort()).toEqual(VISIBLE);
    expect(pulse.updates.projects).toBe(3);
  });

  it("상세와 관리자 목록은 그대로 닿는다 — 지우지 않고 가리기만 한다", async () => {
    expect(slugs(await listProductRows({ statuses: ["seeded", "verified"], limit: 20 }))).toEqual([...VISIBLE, "hidden-profile"].sort());
  });
});
