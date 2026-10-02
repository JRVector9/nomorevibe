import { beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { countProducts, listProducts, RISING_MAX_STARS } from "@/lib/domain/products/repository";
import { ensureSchema, resetTables } from "./setup";

/**
 * 검증 제품이 모자라 순위를 매길 수 없는 동안 홈 '추천'·'관심 많은 순'이 대신 쓰는 순서(app/page.tsx fallbackSort).
 */

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

const earlier = new Date("2026-10-01T00:00:00.000Z");
const later = new Date("2026-10-02T00:00:00.000Z");

async function seed(slug: string, stars: { stars?: number | null; previous?: number | null; previousAt?: Date | null; at?: Date | null }) {
  await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.test`, tagline: slug, description: slug,
    category: "Dev", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e",
    stars: stars.stars ?? null, starsPrevious: stars.previous ?? null, starsPreviousAt: stars.previousAt ?? null, starsAt: stars.at ?? null,
  });
}

it("추천 대체 목록은 마지막 확인 사이에 는 스타 순이다 — 안 는 것·확인 못 한 것·2천 이상은 없다", async () => {
  await seed("gained-most", { stars: 150, previous: 50, previousAt: earlier, at: later });
  // 같은 증가면 스타 많은 쪽이 앞이다
  await seed("gained-ten-big", { stars: 1900, previous: 1890, previousAt: earlier, at: later });
  await seed("gained-ten-small", { stars: 400, previous: 390, previousAt: earlier, at: later });
  await seed("flat", { stars: 10, previous: 10, previousAt: earlier, at: later });
  await seed("lost", { stars: 10, previous: 12, previousAt: earlier, at: later });
  await seed("never-checked-before", { stars: 10, previous: null, previousAt: null, at: later });
  await seed("reversed-observations", { stars: 20, previous: 5, previousAt: later, at: earlier });
  await seed("in-star-tiers", { stars: RISING_MAX_STARS, previous: 1000, previousAt: earlier, at: later });

  const rows = await listProducts({ statuses: ["seeded"], sort: "rising", rising: true, limit: 10 });
  expect(rows.map((row) => row.slug)).toEqual(["gained-most", "gained-ten-big", "gained-ten-small"]);
  // 목록과 개수는 같은 조건이다
  expect(await countProducts({ statuses: ["seeded"], rising: true })).toBe(3);
});

it("관심 많은 순 대체 목록은 스타 많은 순이고 스타를 모르는 제품은 맨 뒤다", async () => {
  await seed("unknown", { stars: null });
  await seed("small", { stars: 3 });
  await seed("big", { stars: 30_000 });

  const rows = await listProducts({ statuses: ["seeded"], sort: "stars", limit: 10 });
  expect(rows.map((row) => row.slug)).toEqual(["big", "small", "unknown"]);
});
