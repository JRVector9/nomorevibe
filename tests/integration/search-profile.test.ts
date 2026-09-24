import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";

const { db } = await import("@/lib/db");
const { jobs, products, productSearchProfiles, textTranslations } = await import("@/lib/db/schema");
const { SLOW_CALL_MS, writeSearchProfiles } = await import("@/lib/jobs/products/search-profile");
const { refreshProductSearchDocuments } = await import("@/lib/jobs/products/search-refresh");
const { runJob } = await import("@/lib/jobs/runner");
const { listProducts } = await import("@/lib/domain/products/repository");
const { resolveSearchQuery } = await import("@/lib/domain/products/search-translation");
const { ensureSchema, resetTables } = await import("./setup");

async function seed(slug: string, values: Partial<typeof products.$inferInsert> = {}) {
  const [row] = await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.test`, tagline: slug, description: slug,
    category: "Productivity", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e", ...values,
  }).returning({ id: products.id });
  return row.id;
}

const answer = (en: string[], ko: string[]) =>
  ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ keywords_en: en, keywords_ko: ko }) } }] }) }) as unknown as Response;

const tick = () => runJob("product-search-profile", writeSearchProfiles);
const ctx = { cursor: null, save: async () => {}, hasBudget: () => true, log: () => {} };

async function find(query: string): Promise<string[]> {
  const resolved = await resolveSearchQuery(query);
  return (await listProducts({ statuses: ["seeded", "verified"], sort: "relevance", limit: 10, query: resolved.queries })).map((row) => row.slug);
}

const gateway = vi.fn();

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(productSearchProfiles);
  await db.delete(jobs);
  await db.delete(textTranslations).where(eq(textTranslations.targetLang, "en"));
  vi.stubEnv("ABCLLM_API_KEY", "test-key");
  gateway.mockReset();
  vi.stubGlobal("fetch", gateway);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("검색 키워드 잡", () => {
  it("키워드를 지어 원본과 색인용 사본을 같이 적는다", async () => {
    const id = await seed("coche", { name: "Coche", tagline: "Local-first shopping list", description: "Local-first shopping list" });
    gateway.mockResolvedValue(answer(["grocery list", "shopping list"], ["장보기 목록", "쇼핑 리스트"]));

    expect(await tick()).toMatchObject({ status: "completed", done: true });

    const [profile] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    expect(profile).toMatchObject({ keywordsEn: ["grocery list", "shopping list"], keywordsKo: ["장보기 목록", "쇼핑 리스트"], errorCode: null });
    const [row] = await db.select({ keywords: products.searchKeywords }).from(products).where(eq(products.id, id));
    expect(row.keywords).toBe("grocery list · shopping list · 장보기 목록 · 쇼핑 리스트");
  });

  it("한국어로 영어 제품을, 영어로 한국어 제품을 찾는다 — 번역 없이", async () => {
    await seed("coche", { name: "Coche", tagline: "Local-first shopping list", description: "Local-first shopping list" });
    await seed("club-season", { name: "Club Season", tagline: "스쿼드를 만들고 리그를 오르는 축구 클럽 매니저", description: "스쿼드를 만들고 리그를 오르는 축구 클럽 매니저" });
    gateway
      .mockResolvedValueOnce(answer(["soccer club manager", "football manager game"], ["축구 매니저 게임"]))
      .mockResolvedValueOnce(answer(["grocery list"], ["장보기 목록"]));
    await tick();

    // 번역을 부르지 않게 키를 뗀다 — 색인의 키워드만으로 찾혀야 한다
    vi.stubEnv("ABCLLM_API_KEY", "");
    expect(await find("장보기 목록")).toContain("coche");
    expect(await find("football manager game")).toContain("club-season");
  });

  it("지은 지 30일이 지나도 글이 그대로면 다시 부르지 않는다", async () => {
    const id = await seed("coche", { name: "Coche", tagline: "Local-first shopping list", description: "Local-first shopping list" });
    gateway.mockResolvedValue(answer(["grocery list"], ["장보기"]));
    await tick();
    await db.update(productSearchProfiles).set({ updatedAt: sql`now() - interval '31 days'` }).where(eq(productSearchProfiles.productId, id));
    gateway.mockClear();

    await tick();

    expect(gateway).not.toHaveBeenCalled();
    const [profile] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    expect(Date.now() - profile.updatedAt.getTime()).toBeLessThan(24 * 3600_000);
  });

  it("실패는 다시 볼 시각을 달고 남는다 — 색인용 사본은 비운 채로", async () => {
    const id = await seed("coche");
    gateway.mockResolvedValue({ ok: false, status: 502 } as Response);

    await tick();

    const [profile] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id));
    expect(profile).toMatchObject({ errorCode: "http_502", attempts: 1 });
    expect(profile.retryAt).not.toBeNull();
    const [row] = await db.select({ keywords: products.searchKeywords }).from(products).where(eq(products.id, id));
    expect(row.keywords).toBeNull();
  });

  it("한 건이 오래 걸리면 그 틱을 접는다 — 게이트웨이가 밀릴 때 1차 심사에 자리를 준다", async () => {
    for (const slug of ["first", "second", "third", "fourth"]) await seed(slug);
    vi.useFakeTimers({ toFake: ["Date"] });
    // 첫 호출만 느리다 — 동시에 나간 둘은 답을 받고, 그다음은 부르지 않는다
    let calls = 0;
    gateway.mockImplementation(async () => {
      if (calls++ === 0) vi.setSystemTime(Date.now() + SLOW_CALL_MS);
      return answer(["grocery list"], ["장보기"]);
    });

    expect(await tick()).toMatchObject({ status: "completed", done: true });

    // 받은 답은 버리지 않고, 남은 것은 다음 틱으로 미룬다
    expect(gateway).toHaveBeenCalledTimes(2);
    expect(await db.select().from(productSearchProfiles)).toHaveLength(2);
  });

  it("공개되지 않은 제품은 짓지 않는다", async () => {
    await seed("hidden", { status: "banned" });
    await tick();
    expect(gateway).not.toHaveBeenCalled();
  });
});

describe("카테고리 색인", () => {
  it("카테고리의 한국어 이름으로도 찾는다", async () => {
    await seed("rookies-revenge", { name: "Rookie's Revenge", tagline: "A daily chess roguelike", description: "A daily chess roguelike", category: "Games" });
    await refreshProductSearchDocuments(ctx);

    const [row] = await db.select({ category: products.searchCategory }).from(products).where(eq(products.slug, "rookies-revenge"));
    expect(row.category).toBe("Games 게임");
    vi.stubEnv("ABCLLM_API_KEY", "");
    // 소개에 "game"이 없어도 카테고리가 잇는다
    expect(await find("chess game")).toContain("rookies-revenge");
    expect(await find("게임")).toContain("rookies-revenge");
  });
});
