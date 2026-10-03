// tests/integration/home-rows.test.ts
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { productHealth, products, type ProductStatus } from "@/lib/db/schema";
import { DOWN_THRESHOLD } from "@/lib/domain/products/health";
import { getRisingRank } from "@/lib/domain/products/repository";
import { getNewThisWeek, getPublicList, getRelatedRising } from "@/lib/domain/products/view";
import { ensureSchema, resetTables } from "./setup";

const DAY = 86_400_000;
const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

/** 공개 제품 하나 — 스타는 "어제 → 오늘" 두 번 확인한 값으로 넣는다(starGain 이 계산되게) */
async function product(slug: string, options: {
  category?: string; status?: ProductStatus; createdAt?: Date; stars?: number; starsPrevious?: number;
} = {}) {
  await db.insert(products).values({
    slug, url: `https://${slug}.example`, name: slug, tagline: "t", description: "d",
    category: options.category ?? "Dev", status: options.status ?? "seeded", source: "crawler",
    verifyToken: `v-${slug}`, editTokenHash: "a".repeat(64),
    createdAt: options.createdAt ?? daysAgo(30),
    stars: options.stars ?? null, starsAt: options.stars === undefined ? null : daysAgo(0),
    starsPrevious: options.starsPrevious ?? null, starsPreviousAt: options.starsPrevious === undefined ? null : daysAgo(1),
  });
}

beforeAll(ensureSchema);
beforeEach(resetTables);

describe("이번 주 새로 공개된 프로젝트", () => {
  it("최근 7일에 등재됐고 스타가 기준 이상인 것만, 최신순", async () => {
    await product("old", { createdAt: daysAgo(10), stars: 500, starsPrevious: 500 });
    await product("new-small", { createdAt: daysAgo(2), stars: 10, starsPrevious: 10 });
    await product("new-a", { createdAt: daysAgo(3), stars: 120, starsPrevious: 120 });
    await product("new-b", { createdAt: daysAgo(1), stars: 80, starsPrevious: 80 });
    const rows = await getNewThisWeek(5, daysAgo(7));
    expect(rows.map((row) => row.slug)).toEqual(["new-b", "new-a"]);
  });
});

describe("급상승 순위", () => {
  it("스타 2천 미만에서 증가폭 순서의 자리를 준다", async () => {
    await product("first", { stars: 990, starsPrevious: 1 });
    await product("second", { stars: 1512, starsPrevious: 1273 });
    await product("third", { stars: 819, starsPrevious: 622 });
    await product("big", { stars: 40_000, starsPrevious: 30_000 });
    await product("flat", { stars: 100, starsPrevious: 100 });
    expect(await getRisingRank("second")).toBe(2);
    expect(await getRisingRank("third")).toBe(3);
    expect(await getRisingRank("big")).toBeNull();
    expect(await getRisingRank("flat")).toBeNull();
    expect(await getRisingRank("missing")).toBeNull();
  });

  it("닿지 않는 제품은 홈 목록처럼 순위에서 빠지고 남의 자리도 밀지 않는다", async () => {
    await product("down", { stars: 1500, starsPrevious: 1 });
    await product("alive", { stars: 300, starsPrevious: 100 });
    await db.insert(productHealth).values({ slug: "down", status: 0, failures: DOWN_THRESHOLD, downSince: daysAgo(2) });
    expect(await getRisingRank("down")).toBeNull();
    expect(await getRisingRank("alive")).toBe(1);
  });
});

describe("같은 분야에서 뜨는", () => {
  it("자기 자신을 빼고 같은 분야의 급상승을 준다", async () => {
    await product("me", { category: "Games", stars: 1180, starsPrevious: 1014 });
    await product("g1", { category: "Games", stars: 317, starsPrevious: 297 });
    await product("g2", { category: "Games", stars: 405, starsPrevious: 391 });
    await product("dev", { category: "Dev", stars: 500, starsPrevious: 1 });
    const rows = await getRelatedRising("me", "Games", 5);
    expect(rows.map((row) => row.slug)).toEqual(["g1", "g2"]);
  });
});

describe("급상승 띠와 피드의 이어짐", () => {
  it("offset 으로 띠 다음부터 받는다", async () => {
    for (const [slug, gain] of [["a", 50], ["b", 40], ["c", 30], ["d", 20]] as const) {
      await product(slug, { stars: 100 + gain, starsPrevious: 100 });
    }
    const strip = await getPublicList(2, { sort: "rising", rising: true });
    const feed = await getPublicList(10, { sort: "rising", rising: true, offset: 2 });
    expect(strip.map((row) => row.slug)).toEqual(["a", "b"]);
    expect(feed.map((row) => row.slug)).toEqual(["c", "d"]);
  });
});
