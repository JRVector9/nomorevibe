// tests/integration/home-rows.test.ts
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

vi.mock("server-only", () => ({}));

import { db } from "@/lib/db";
import { productHealth, products, type ProductStatus } from "@/lib/db/schema";
import { getProductDetail } from "@/lib/domain/products/detail-view";
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

  it("동점도 홈 띠·피드의 자리와 같은 순위를 준다 — 같은 순위를 나눠 갖지 않는다", async () => {
    // 같은 하루 증가·같은 스타 — 그다음 키(등재 최신 → 주소)가 자리를 가른다
    await product("top", { stars: 900, starsPrevious: 100 });
    await product("tie-old", { stars: 300, starsPrevious: 200, createdAt: daysAgo(20) });
    await product("tie-new", { stars: 300, starsPrevious: 200, createdAt: daysAgo(10) });
    await product("tie-new-b", { stars: 300, starsPrevious: 200, createdAt: daysAgo(10) });
    await product("last", { stars: 150, starsPrevious: 100 });
    const strip = await getPublicList(2, { sort: "rising", rising: true });
    const feed = await getPublicList(10, { sort: "rising", rising: true, offset: 2 });
    const home = [...strip, ...feed].map((row) => row.slug);
    expect(home).toEqual(["top", "tie-new", "tie-new-b", "tie-old", "last"]);
    for (const [index, slug] of home.entries()) expect(await getRisingRank(slug)).toBe(index + 1);
  });

  it("20위 밖과 마지막 확인이 오래된 제품은 배지가 없다", async () => {
    for (let index = 0; index < 21; index++) await product(`p${String(index).padStart(2, "0")}`, { stars: 1000 - index, starsPrevious: 100 });
    await product("stale", { stars: 1900, starsPrevious: 1 });
    await db.update(products).set({ starsAt: daysAgo(10), starsPreviousAt: daysAgo(11) }).where(eq(products.slug, "stale"));
    expect(await getRisingRank("p00")).toBe(1);
    expect(await getRisingRank("p19")).toBe(20);
    expect(await getRisingRank("p20")).toBeNull();
    expect(await getRisingRank("stale")).toBeNull();
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

describe("상세 뷰모델", () => {
  it("급상승 순위·같은 분야 추천·README 발췌·도구 조사 상태를 준다", async () => {
    await product("me", { category: "Games", stars: 1180, starsPrevious: 1014 });
    await product("g1", { category: "Games", stars: 317, starsPrevious: 297 });
    await db.update(products).set({
      repoUrl: "https://github.com/willfaust/Madeira",
      searchReadme: "Madeira runs Windows games on iOS.\n\nIt combines FEX-Emu, Wine and DXMT into one app so that x86-64 titles start on a jailed device without a computer.",
    }).where(eq(products.slug, "me"));
    const detail = (await getProductDetail("me"))!;
    expect(detail.risingRank).toBe(1);
    expect(detail.related.map((row) => row.slug)).toEqual(["g1"]);
    expect(detail.readmeExcerpt).toContain("FEX-Emu");
    expect(detail.toolScan).toBe("none");
  });
});
