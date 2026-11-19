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

    expect(ranked).toMatchObject({ head: ["word-match", "close-meaning"], total: 2, semantic: true, reranked: true });
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
    expect(ranked).toMatchObject({ head: ["only-words"], total: 1, semantic: false, reranked: true });
  });

  it("다른 정렬의 목록은 그대로 둔다 — 내려간 제품의 벡터가 남아 있어도 검색에서 빠진다", async () => {
    await product("banned", "회의록", direction(1, 0));
    await db.update(products).set({ status: "banned" }).where(eq(products.slug, "banned"));
    expect(await nearestProductSlugs(QUERY, { statuses: ["seeded", "verified"], excludeDown: true }, 10, 0.5)).toEqual([]);
  });
});

it("serves zero results immediately on a cold multilingual query and uses cached English terms on the next search", async () => {
  const raw = "音声認識";
  const english = "speech recognition";
  await product("speech-app", english, null);
  const { resolveSearchQuery, multilingualQueryTranslationTarget } = await import("@/lib/domain/products/search-translation");
  const { searchRelevance } = await import("@/lib/domain/products/relevance");
  const { textTranslations } = await import("@/lib/db/schema");
  const options = { waitForTranslation: false, mode: "lexical" as const };
  const translate = vi.fn(async () => { throw new Error("unexpected translation wait"); });
  const rank: typeof rankRelevance = (query, plan, filters) => rankRelevance(query, plan, filters, servers);

  expect(await searchRelevance(raw, await resolveSearchQuery(raw, options), {}, translate, rank)).toMatchObject({ total: 0, translated: null });
  expect(translate).not.toHaveBeenCalled();
  const { cacheKey } = multilingualQueryTranslationTarget(raw)!;
  await db.insert(textTranslations).values({ sourceHash: cacheKey, targetLang: "en", status: "done", translated: english, model: "fixture" });
  expect(await searchRelevance(raw, await resolveSearchQuery(raw, options), {}, translate, rank))
    .toMatchObject({ head: ["speech-app"], total: 1, translated: english });
  expect(translate).not.toHaveBeenCalled();
  expect(servers.embed.mock.calls).toHaveLength(2);
  expect(servers.rerank.mock.calls[0]?.[0]).toBe(raw);
});

it("searches with the legacy Chinese cache while the new translation is pending", async () => {
  const raw = "程式碼編輯器";
  const english = "code editor";
  await product("code-editor", english, null);
  const { resolveSearchQuery, queryTranslationKey } = await import("@/lib/domain/products/search-translation");
  const { searchRelevance } = await import("@/lib/domain/products/relevance");
  const { textTranslations } = await import("@/lib/db/schema");
  await db.insert(textTranslations).values({
    sourceHash: queryTranslationKey(raw), targetLang: "en", status: "done", translated: english, model: "legacy",
  });
  const rank: typeof rankRelevance = (query, plan, filters, _deps, multilingual) =>
    rankRelevance(query, plan, filters, servers, multilingual);
  const translate = vi.fn();
  for (const mode of ["lexical", "full"] as const) {
    const resolved = await resolveSearchQuery(raw, { mode, waitForTranslation: false });
    expect(resolved).toMatchObject({ translated: english, translationPending: true, translationCache: "miss" });
    expect(await searchRelevance(raw, resolved, {}, translate, rank)).toMatchObject({
      head: ["code-editor"], total: 1, translated: english, modelWork: { embeddingCalls: 1 },
    });
  }
  expect(translate).not.toHaveBeenCalled();
});

it("uses both vectors in the same scope and keeps a legacy-only leader without double-counting the tail", async () => {
  const raw = "代码编辑器";
  const english = "code editor";
  const category = "Dev";
  const { resolveSearchQuery, multilingualQueryTranslationTarget, queryTranslationKey } = await import("@/lib/domain/products/search-translation");
  const { searchRelevance } = await import("@/lib/domain/products/relevance");
  const { listProductSlugs } = await import("@/lib/domain/products/repository");
  const { textTranslations } = await import("@/lib/db/schema");
  await db.insert(textTranslations).values([
    { sourceHash: queryTranslationKey(raw), targetLang: "en", status: "done", translated: "markdown editor", model: "legacy" },
    { sourceHash: multilingualQueryTranslationTarget(raw)!.cacheKey, targetLang: "en", status: "done", translated: english, model: "fixture" },
  ]);
  await db.insert(products).values(Array.from({ length: 204 }, (_, index) => ({
    slug: `code-editor-${index}`, url: `https://editor-${index}.example`, name: `Editor ${index}`, tagline: english, description: english,
    category, status: "seeded" as const, source: "crawler" as const, verifyToken: "v", editTokenHash: "e",
  })));
  await product("legacy-leader", "markdown editor", null);
  await product("vector-shared", "semantic match", direction(1, 1));
  await product("translated-only", "semantic match", direction(0, 1));
  await product("raw-only", "semantic match", direction(1, 0));
  await product("excluded-by-category", english, direction(1, 1), { category: "Games" });
  await product("hidden", english, direction(1, 1), { status: "banned" });
  await product("down-full", english, direction(1, 1));
  await db.insert(productHealth).values({ slug: "down-full", status: 503, failures: 3 });

  const resolved = await resolveSearchQuery(raw, { mode: "full" });
  const filters = { category } as const;
  const [tailMatch] = await listProductSlugs({ ...filters, statuses: ["seeded"], excludeDown: true,
    query: resolved.queries, sort: "relevance", limit: 1, offset: 201 });
  expect(tailMatch).toBeTruthy();
  await db.execute(sql`insert into product_embeddings (product_id, model, text_hash, embedding)
    select id, ${EMBEDDING_MODEL}, 'h', ${vectorLiteral(direction(1, 1))}::halfvec from products where slug = ${tailMatch}`);
  const embed = vi.fn(async (text: string) => text === raw ? QUERY : direction(0, 1));
  const rerank = vi.fn(async (text: string, docs: string[]) => docs.map((doc) => text === raw && doc.startsWith("legacy-leader") ? 0 : -1));
  const translate = vi.fn(async () => { throw new Error("unexpected translation wait"); });
  const rank: typeof rankRelevance = (text, plan, scope, _deps, multilingual) =>
    rankRelevance(text, plan, scope, { embed, rerank }, multilingual);
  const result = await searchRelevance(raw, resolved, filters, translate, rank);
  expect(translate).not.toHaveBeenCalled();
  expect(result.head[0]).toBe("legacy-leader");
  expect(result.total).toBe(208);
  expect(result.head).toContain(tailMatch);
  expect(embed.mock.calls.map(([text]) => text)).toEqual([raw, english]);
  expect(rerank.mock.calls.map(([text]) => text)).toEqual([`${raw} / ${english}`, raw]);

  const windows = await Promise.all([0, 15, 195, 205].map((start, index) =>
    relevanceWindow(result, result.plan, filters, start, [15, 180, 10, 10][index])));
  const all = windows.flat();
  expect(all).toHaveLength(result.total);
  expect(new Set(all).size).toBe(all.length);
  expect(all).toEqual(expect.arrayContaining(["legacy-leader", tailMatch, "vector-shared", "translated-only", "raw-only"]));
  for (const excluded of ["excluded-by-category", "hidden", "down-full"]) expect(all).not.toContain(excluded);
});
