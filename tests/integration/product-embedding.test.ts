import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ensureSchema, resetTables } from "./setup";

const { db } = await import("@/lib/db");
const { products, productEmbeddings } = await import("@/lib/db/schema");
const { refreshProductEmbeddings } = await import("@/lib/jobs/products/embedding-refresh");
const { EMBEDDING_MODEL, EmbeddingUnavailableError } = await import("@/lib/domain/products/embedding");

/** 의미 검색의 제품 벡터 — 공개 제품만, 글이나 모델이 바뀐 것만 다시 임베딩한다 */
const ctx = { cursor: null, save: async () => {}, hasBudget: () => true, log: vi.fn() };

async function product(slug: string, status: "seeded" | "verified" | "banned", extra: Partial<typeof products.$inferInsert> = {}) {
  await db.insert(products).values({
    slug, url: `https://${slug}.example`, name: slug, tagline: `${slug} 소개`, description: `${slug} 소개`,
    category: "Dev", status, source: "crawler", verifyToken: `nmv_verify_${slug}`, editTokenHash: "x".repeat(64), ...extra,
  });
}

/** 글마다 첫 칸에 순번을 적은 가짜 벡터 — 어느 글이 어느 행에 갔는지 본다 */
function fakeEmbed() {
  const seen: string[][] = [];
  const embed = vi.fn(async (texts: string[]) => {
    seen.push(texts);
    return texts.map((_, i) => Array.from({ length: 1024 }, (__, k) => (k === 0 ? i + 1 : 0.5)));
  });
  return { embed, seen };
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  ctx.log.mockClear();
});

describe("제품 벡터 채우기", () => {
  it("공개 제품의 이름·소개·키워드를 임베딩하고, 공개되지 않은 제품은 건너뛴다", async () => {
    await product("open-one", "seeded", { searchKeywords: "meeting notes · 회의록", searchCategory: "Dev 개발" });
    await product("open-two", "verified", { description: "소개와 다른 설명" });
    await product("hidden", "banned");
    const { embed, seen } = fakeEmbed();

    await refreshProductEmbeddings(ctx, { embed });

    expect(embed).toHaveBeenCalledTimes(1);
    // 최신 제품부터 — 설명이 소개와 같으면 빼고, 카테고리·키워드를 줄바꿈으로 잇는다
    expect(seen[0]).toEqual(["open-two\nopen-two 소개\n소개와 다른 설명", "open-one\nopen-one 소개\nDev 개발\nmeeting notes · 회의록"]);
    const rows = await db.execute<{ slug: string; model: string; first: number }>(sql`
      select p.slug, e.model, (e.embedding::real[])[1] as first
        from product_embeddings e join products p on p.id = e.product_id order by p.slug`);
    expect([...rows]).toEqual([
      { slug: "open-one", model: EMBEDDING_MODEL, first: 2 },
      { slug: "open-two", model: EMBEDDING_MODEL, first: 1 },
    ]);
  });

  it("다 채운 뒤에는 부르지 않고, 글이 바뀐 제품만 다시 임베딩한다", async () => {
    await product("stays", "seeded");
    await product("edited", "seeded");
    await refreshProductEmbeddings(ctx, { embed: fakeEmbed().embed });
    const before = await db.select().from(productEmbeddings);

    const idle = fakeEmbed();
    expect(await refreshProductEmbeddings(ctx, { embed: idle.embed })).toEqual({ done: true });
    expect(idle.embed).not.toHaveBeenCalled();

    await db.update(products).set({ tagline: "새 소개" }).where(eq(products.slug, "edited"));
    const again = fakeEmbed();
    await refreshProductEmbeddings(ctx, { embed: again.embed });
    expect(again.seen).toEqual([["edited\n새 소개\nedited 소개"]]);
    const after = await db.select().from(productEmbeddings);
    const hash = (rows: typeof before, slugId: number) => rows.find((row) => row.productId === slugId)?.textHash;
    expect(hash(after, 1)).toBe(hash(before, 1));
    expect(hash(after, 2)).not.toBe(hash(before, 2));
  });

  it("모델이 바뀌면 전부 다시 임베딩한다", async () => {
    await product("old-model", "seeded");
    await refreshProductEmbeddings(ctx, { embed: fakeEmbed().embed });
    await db.update(productEmbeddings).set({ model: "previous-model" });

    const again = fakeEmbed();
    await refreshProductEmbeddings(ctx, { embed: again.embed });
    expect(again.embed).toHaveBeenCalledTimes(1);
    const [row] = await db.select().from(productEmbeddings);
    expect(row.model).toBe(EMBEDDING_MODEL);
  });

  it("임베딩 서버가 없으면 실패하지 않고 다음 틱으로 넘긴다", async () => {
    await product("waiting", "seeded");
    const embed = vi.fn(async () => { throw new EmbeddingUnavailableError("timeout"); });

    expect(await refreshProductEmbeddings(ctx, { embed })).toEqual({ done: true });
    expect(ctx.log).toHaveBeenCalledWith("product_embedding.unavailable", { written: 0, reason: "timeout" });
    expect(await db.select().from(productEmbeddings)).toEqual([]);
  });
});
