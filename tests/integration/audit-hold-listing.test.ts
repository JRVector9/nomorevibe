import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));

const { db } = await import("@/lib/db");
const { crawlCandidates, crawlDocuments, products, productUpdates } = await import("@/lib/db/schema");
const { userSavedProducts } = await import("@/lib/db/me-schema");
const { publicUsers } = await import("@/lib/db/public-user-schema");
const { getDiscoveryList, getNewThisWeek, getPublicList, getUnclaimedList } = await import("@/lib/domain/products/view");
const { categoryCounts, countProducts, getRisingRank, listProductRows, listRecentlyDiscovered } = await import("@/lib/domain/products/repository");
const { getPopularGroups } = await import("@/lib/domain/products/popular");
const { loadHomePulse } = await import("@/lib/domain/products/home-pulse");
const { rankRelevance } = await import("@/lib/domain/products/relevance");
const { EMBEDDING_MODEL, vectorLiteral } = await import("@/lib/domain/products/embedding");
const { listIndexableSlugs, productIndexable } = await import("@/lib/domain/products/indexing");
const { productSitemapEntries, productSitemapRanges } = await import("@/lib/domain/products/sitemap");
const { getProductDetail, getProductIdentity } = await import("@/lib/domain/products/detail-view");
const { publicProductIdentity } = await import("@/lib/me/share");
const { listSaved } = await import("@/lib/me/saved");
const { clearAllMemos } = await import("@/lib/cache/memo");

/**
 * 감사 보류(0110) — 보류된 제품은 공개 목록·분야·검색·인기·급상승·피드·홈 집계·sitemap·색인에서 빠진다.
 * 상태는 그대로라 상세 주소는 열리고(noindex), 관리자 목록과 저장한 사람의 저장 목록에는 남는다.
 * 순위(ranking-view.test.ts)와 화제(social-talk.test.ts)는 그 파일들이 본다. 다른 갈래는 hidden-profiles.test.ts 와 같은 판이다.
 */
const QUERY = Array.from({ length: 1024 }, (_, k) => (k === 0 ? 1 : 0));

async function product(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({
    slug, url: `https://${slug}.example`, repoUrl: `https://github.com/acme/${slug}`, repoStatus: "ok", name: slug,
    tagline: "invoice tracker for freelancers", description: "invoice tracker for freelancers",
    category: "Productivity", status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "e",
    // 급상승(스타 2천 미만, 하루 사이 늚)에 든다. 인기 구간은 그 테스트에서 2천 위로 올린다
    stars: 1_500, starsAt: new Date(), starsPrevious: 1_400, starsPreviousAt: sql`now() - interval '1 day'` as unknown as Date,
    createdAt: sql`now() - interval '10 days'` as unknown as Date, ...values,
  }).returning({ id: products.id });
  const repo = `acme/${slug}`;
  await db.insert(crawlDocuments).values({ repo, repoMeta: { created_at: new Date(Date.now() - 10 * 86_400_000).toISOString() } });
  await db.insert(crawlCandidates).values({ repo, state: "published", publishedSlug: slug });
  await db.execute(sql`insert into product_embeddings (product_id, model, text_hash, embedding)
    values (${row.id}, ${EMBEDDING_MODEL}, 'h', ${vectorLiteral(QUERY)}::halfvec)`);
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
  await product("held-tool", { auditHoldAt: new Date() });
  await product("plain-tool");
});

const slugs = (rows: { slug: string }[]) => rows.map((row) => row.slug).sort();
const VISIBLE = ["plain-tool"];

describe("감사 보류된 제품은 공개 목록에서 빠진다", () => {
  it("홈 목록(최신·급상승·스타·이번 주)·주인 기다림·발견·RSS", async () => {
    expect(slugs(await getPublicList(20))).toEqual(VISIBLE);
    expect(slugs(await getPublicList(20, { sort: "rising", rising: true }))).toEqual(VISIBLE);
    expect(slugs(await getPublicList(20, { sort: "stars" }))).toEqual(VISIBLE);
    expect(slugs(await getNewThisWeek(20, new Date(Date.now() - 30 * 86_400_000)))).toEqual(VISIBLE);
    expect(slugs(await getUnclaimedList(20))).toEqual(VISIBLE);
    expect(slugs(await getDiscoveryList(20))).toEqual(VISIBLE);
    expect(slugs(await listRecentlyDiscovered(20))).toEqual(VISIBLE);
    // 상세 급상승 배지가 보는 순위
    expect(await getRisingRank("held-tool")).toBeNull();
    expect(await getRisingRank("plain-tool")).toBe(1);
  });

  it("분야 목록과 분야 칩·전체의 수", async () => {
    expect(slugs(await getPublicList(20, { category: "Productivity" }))).toEqual(VISIBLE);
    expect(await categoryCounts({ statuses: ["verified", "seeded"], excludeDown: true })).toEqual({ Productivity: 1 });
    expect(await countProducts({ statuses: ["verified", "seeded"], excludeDown: true })).toBe(1);
  });

  it("검색 — 낱말 검색과 의미 검색 모두", async () => {
    expect(slugs(await getPublicList(20, { query: "invoice tracker", sort: "relevance" }))).toEqual(VISIBLE);
    const ranked = await rankRelevance("invoice tracker", ["invoice tracker"], {},
      { embed: vi.fn(async () => QUERY), rerank: vi.fn(async (_q: string, docs: string[]) => docs.map((_, i) => -i)) });
    expect([...ranked.head].sort()).toEqual(VISIBLE);
  });

  it("인기 구간과 홈 집계", async () => {
    await db.update(products).set({ stars: 3_000 });
    const popular = await getPopularGroups();
    expect(slugs(popular.flatMap((group) => group.items))).toEqual(VISIBLE);
    expect(popular.reduce((sum, group) => sum + group.total, 0)).toBe(1);
    const pulse = await loadHomePulse(new Date());
    expect(pulse.total).toBe(1);
    expect(pulse.active.map((row) => row.slug)).toEqual(VISIBLE);
    expect(pulse.updates.projects).toBe(1);
  });

  it("sitemap 과 상세의 색인 — 주인이 있어 색인될 제품도 보류 중이면 빠지고, 풀리면 돌아온다", async () => {
    // 주인이 있는 제품은 AI 근거 없이도 색인된다(indexing.ts 3번) — 보류만 다르게 둔다
    await db.update(products).set({ source: "skill", status: "verified", verifiedAt: new Date() });
    expect(slugs(await listIndexableSlugs(100))).toEqual(VISIBLE);
    expect((await productSitemapEntries("ko", (await productSitemapRanges())[0])).map((entry) => entry.url))
      .toEqual([expect.stringContaining("/p/plain-tool")]);
    const held = await getProductIdentity("held-tool");
    expect(held).not.toBeNull();
    expect(productIndexable(held!)).toBe(false);
    expect(productIndexable((await getProductIdentity("plain-tool"))!)).toBe(true);

    await db.update(products).set({ auditHoldAt: null }).where(eq(products.slug, "held-tool"));
    expect(slugs(await listIndexableSlugs(100))).toEqual(["held-tool", "plain-tool"]);
    expect(productIndexable((await getProductIdentity("held-tool"))!)).toBe(true);
  });

  it("상세는 열리고, 배지·공유 카드는 내주지 않는다", async () => {
    expect((await getProductDetail("held-tool"))?.product.slug).toBe("held-tool");
    expect(await publicProductIdentity("held-tool")).toBeNull();
    expect((await publicProductIdentity("plain-tool"))?.slug).toBe("plain-tool");
  });

  it("관리자 목록과 저장한 사람의 저장 목록에는 남는다 — 지우지 않고 가리기만 한다", async () => {
    expect(slugs(await listProductRows({ statuses: ["seeded", "verified"], limit: 20 }))).toEqual(["held-tool", "plain-tool"]);
    const [user] = await db.insert(publicUsers).values({ displayName: "저장한 사람" }).returning();
    const [held] = await db.select({ id: products.id }).from(products).where(eq(products.slug, "held-tool"));
    await db.insert(userSavedProducts).values({ userId: user.id, productId: held.id });
    const saved = await listSaved(user.id, { sort: "recent", filter: "all", category: null, cursor: null }, "ko");
    expect(saved.items.map((item) => item.slug)).toEqual(["held-tool"]);
  });
});
