// tests/integration/detail-related.test.ts
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * 8시간 급상승 읽기 — 기본은 실제 구현(회차가 없는 테스트 DB = 운영의 회차 누락과 같은 빈 결과),
 * 회차가 있는 경우만 테스트가 결과를 바꿔 끼운다. 회차 표는 resetTables 가 비우지 않아 실제로 심지 않는다.
 */
const growth = vi.hoisted(() => ({ override: null as null | ((options: unknown) => Promise<unknown>) }));
vi.mock("@/lib/domain/products/star-growth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/domain/products/star-growth")>();
  return {
    ...actual,
    getStarGrowthPage: (options: Parameters<typeof actual.getStarGrowthPage>[0]) =>
      growth.override ? growth.override(options) : actual.getStarGrowthPage(options),
  };
});

import { db } from "@/lib/db";
import { products, type ProductStatus } from "@/lib/db/schema";
import { getProductDetail } from "@/lib/domain/products/detail-view";
import { getPublicList, getPublicListBySlugs } from "@/lib/domain/products/view";
import { ensureSchema, resetTables } from "./setup";

const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

async function product(slug: string, options: {
  category?: string; status?: ProductStatus; aiLevel?: 1 | 2 | 3 | null; createdAt?: Date;
} = {}) {
  await db.insert(products).values({
    slug, url: `https://${slug}.example`, name: slug, tagline: "t", description: "d",
    category: options.category ?? "Games", status: options.status ?? "seeded", source: "crawler",
    verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64),
    createdAt: options.createdAt ?? daysAgo(30),
    aiLevel: options.aiLevel === undefined ? 1 : options.aiLevel,
  });
}

beforeAll(ensureSchema);
beforeEach(async () => {
  growth.override = null;
  await resetTables();
});

describe("상세 끝 '같은 분야' 줄", () => {
  it("8시간 회차가 없어도(회차 누락) 같은 분야의 다른 공개 AI 제작 프로젝트로 채운다", async () => {
    await product("me");
    await product("g-old", { createdAt: daysAgo(20) });
    await product("g-new", { createdAt: daysAgo(2) });
    // 분야 기본 목록(AI로 제작)과 공개 조건에 들지 않는 것 — 다른 분야, AI 근거 없음, 차단
    await product("dev-ai", { category: "Dev", createdAt: daysAgo(1) });
    await product("g-plain", { aiLevel: null, createdAt: daysAgo(1) });
    await product("g-banned", { status: "banned", createdAt: daysAgo(1) });

    const detail = (await getProductDetail("me"))!;
    expect(detail.related.map((row) => row.slug)).toEqual(["g-new", "g-old"]);
    // '모두 보기'가 여는 분야 기본 목록(AI로 제작·최근 등록순)의 앞부분과 같다
    const categoryList = await getPublicList(6, { category: "Games", aiLevels: [1, 2, 3], sort: "recent" });
    expect(detail.related.map((row) => row.slug)).toEqual(categoryList.map((row) => row.slug).filter((slug) => slug !== "me"));
    expect(detail.relatedBasis).toBe("category");
    // 급상승 수가 아니므로 숫자 없이 '모두 보기'
    expect(detail.relatedTotal).toBeNull();
    // 회차가 없으니 급상승 순위는 여전히 주장하지 않는다
    expect(detail.risingRank).toBeNull();
  });

  it("8시간 회차에 같은 분야에서 는 프로젝트가 있으면 그것과 그 수를 그대로 쓴다", async () => {
    await product("me");
    await product("g-rising");
    await product("g-other", { createdAt: daysAgo(1) });
    const items = await getPublicListBySlugs(["g-rising", "me"]);
    growth.override = async (options) => (options as { category?: string }).category === "Games"
      ? { items, total: 2 }
      : { items: [], total: 0 };

    const detail = (await getProductDetail("me"))!;
    expect(detail.related.map((row) => row.slug)).toEqual(["g-rising"]);
    expect(detail.relatedBasis).toBe("growth");
    expect(detail.relatedTotal).toBe(2);
  });

  it("8시간 회차에 자기 자신만 있으면 같은 분야의 다른 프로젝트로 채운다", async () => {
    await product("me");
    await product("g-other");
    const items = await getPublicListBySlugs(["me"]);
    growth.override = async (options) => (options as { category?: string }).category === "Games"
      ? { items, total: 1 }
      : { items: [], total: 0 };

    const detail = (await getProductDetail("me"))!;
    expect(detail.related.map((row) => row.slug)).toEqual(["g-other"]);
    expect(detail.relatedBasis).toBe("category");
    expect(detail.relatedTotal).toBeNull();
  });
});
