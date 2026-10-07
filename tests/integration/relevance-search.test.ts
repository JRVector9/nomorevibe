import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ensureSchema, resetTables } from "./setup";

const { db } = await import("@/lib/db");
const { products, productHealth } = await import("@/lib/db/schema");
const { rankRelevance, relevanceWindow } = await import("@/lib/domain/products/relevance");
const { nearestProductSlugs } = await import("@/lib/domain/products/repository");
const { EMBEDDING_MODEL, vectorLiteral } = await import("@/lib/domain/products/embedding");

/**
 * 관련도순 검색의 실제 조회 — 낱말 검색, 벡터 거리(halfvec, 하한·거르기), 앞쪽 뒤의 낱말 검색 꼬리.
 * 모델 서버는 가짜로 둔다(임베딩은 정해 둔 벡터, 재정렬은 들어온 순서).
 */

/** 첫 두 칸으로 방향만 정한 벡터 — 질의 [1, 0] 과의 코사인이 곧 cos(각) */
const direction = (x: number, y: number) => Array.from({ length: 1024 }, (_, k) => (k === 0 ? x : k === 1 ? y : 0));
const QUERY = direction(1, 0);

async function product(slug: string, text: string, vector: number[] | null, extra: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({
    slug, url: `https://${slug}.example`, name: slug, tagline: text, description: text,
    category: "Dev", status: "seeded", source: "crawler", verifyToken: `v-${slug}`, editTokenHash: "e", ...extra,
  }).returning({ id: products.id });
  if (vector) {
    await db.execute(sql`insert into product_embeddings (product_id, model, text_hash, embedding)
      values (${row.id}, ${EMBEDDING_MODEL}, 'h', ${vectorLiteral(vector)}::halfvec)`);
  }
}

const servers = {
  embed: vi.fn(async () => QUERY),
  rerank: vi.fn(async (_q: string, docs: string[]) => docs.map((_, i) => -i)),
};

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  vi.clearAllMocks();
});

describe("관련도순 검색", () => {
  it("낱말이 맞는 것과 뜻이 가까운 것을 함께 내고, 하한 아래·닿지 않는 제품·다른 카테고리는 뺀다", async () => {
    await product("word-match", "meeting minutes tool", direction(0, 1)); // 낱말만 맞음(직각)
    await product("close-meaning", "회의록을 정리해 줍니다", direction(0.9, 0.1)); // 뜻만 가까움
    await product("far-meaning", "날씨 앱", direction(0.4, 0.9)); // 코사인 약 0.41 — 하한 0.5 아래
    await product("down", "회의록 자동 정리", direction(1, 0));
    await db.insert(productHealth).values({ slug: "down", status: 503, failures: 3 });
    await product("other-category", "회의록 정리", direction(1, 0), { category: "Games" });

    const ranked = await rankRelevance("meeting minutes", ["meeting minutes"], { category: "Dev" }, servers);

    expect(ranked).toEqual({ head: ["word-match", "close-meaning"], total: 2, semantic: true, reranked: true });
    // 재정렬 모델은 임베딩한 것과 같은 글을 읽는다
    expect(servers.rerank).toHaveBeenCalledWith("meeting minutes", ["word-match\nmeeting minutes tool", "close-meaning\n회의록을 정리해 줍니다"]);
  });

  it("지금 모델로 임베딩한 벡터만 잰다", async () => {
    await product("current", "a", direction(1, 0));
    await product("stale", "b", direction(1, 0));
    await db.execute(sql`update product_embeddings set model = 'old' where product_id = (select id from products where slug = 'stale')`);
    expect(await nearestProductSlugs(QUERY, { statuses: ["seeded"], excludeDown: true }, 10, 0.5)).toEqual(["current"]);
  });

  it("앞쪽 뒤는 낱말 검색 순서에서 앞쪽에 나온 것을 빼고 이어진다 — 두 번 나오지도, 빠지지도 않는다", async () => {
    for (const slug of ["n1", "n2", "n3", "n4"]) await product(slug, "notes app", null);
    const ranked = { head: ["n3", "extra", "n1"], total: 5, semantic: true, reranked: true };
    const window = (start: number, count: number) => relevanceWindow(ranked, ["notes app"], {}, start, count);

    const all = await window(0, 10);
    expect(all.slice(0, 3)).toEqual(["n3", "extra", "n1"]);
    expect(new Set(all.slice(3))).toEqual(new Set(["n2", "n4"]));
    expect(all).toHaveLength(5);
    // 창을 나눠 받아도 같은 순서
    expect([...await window(0, 2), ...await window(2, 2), ...await window(4, 2)]).toEqual(all);
  });

  it("임베딩 서버가 없으면 낱말 검색만으로 낸다", async () => {
    await product("only-words", "notes app", direction(1, 0));
    await product("only-meaning", "다른 말", direction(1, 0));
    const ranked = await rankRelevance("notes app", ["notes app"], {}, { ...servers, embed: vi.fn(async () => { throw new Error("timeout"); }) });
    expect(ranked).toEqual({ head: ["only-words"], total: 1, semantic: false, reranked: true });
  });

  it("다른 정렬의 목록은 그대로 둔다 — 내려간 제품의 벡터가 남아 있어도 검색에서 빠진다", async () => {
    await product("banned", "회의록", direction(1, 0));
    await db.update(products).set({ status: "banned" }).where(eq(products.slug, "banned"));
    expect(await nearestProductSlugs(QUERY, { statuses: ["seeded", "verified"], excludeDown: true }, 10, 0.5)).toEqual([]);
  });
});
