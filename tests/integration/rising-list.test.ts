import { beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import { products } from "@/lib/db/schema";
import { countProducts, listProducts, RISING_FRESH_DAYS, RISING_MAX_STARS } from "@/lib/domain/products/repository";
import { ensureSchema, resetTables } from "./setup";

/**
 * 검증 제품이 모자라 순위를 매길 수 없는 동안 홈 '추천'·'관심 많은 순'이 대신 쓰는 순서(app/page.tsx fallbackSort).
 */

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

// 급상승은 마지막 확인이 RISING_FRESH_DAYS 안인 것만 보므로 시각은 지금에서 잰다
const DAY = 86_400_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);
const earlier = daysAgo(2);
const later = daysAgo(1);

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

it("마지막 확인이 RISING_FRESH_DAYS 보다 오래된 제품은 목록에도 개수에도 없다 — 확인이 계속 실패해 얼어붙은 증가", async () => {
  // 창이 경계 앞에서 시작했어도 끝(마지막 확인)이 경계 안이면 든다
  await seed("fresh", { stars: 110, previous: 100, previousAt: daysAgo(RISING_FRESH_DAYS + 1), at: daysAgo(RISING_FRESH_DAYS - 0.5) });
  // 지워진 저장소: 마지막 성공이 오래전이라 그때의 큰 증가가 남아 있다
  await seed("frozen", { stars: 900, previous: 100, previousAt: daysAgo(RISING_FRESH_DAYS + 2), at: daysAgo(RISING_FRESH_DAYS + 0.5) });

  const rows = await listProducts({ statuses: ["seeded"], sort: "rising", rising: true, limit: 10 });
  expect(rows.map((row) => row.slug)).toEqual(["fresh"]);
  expect(await countProducts({ statuses: ["seeded"], rising: true })).toBe(1);
});

it("하루 평균 증가 순이다 — 간격이 긴 큰 합계보다 짧은 간격의 빠른 증가가 앞, 하루 미만 간격은 하루로 친다", async () => {
  // 운영 예: +249 / 3.2일(77.8/일) 이 +227 / 2.3일(98.7/일) 보다 앞에 있었다
  await seed("long-window", { stars: 1249, previous: 1000, previousAt: daysAgo(3.7), at: daysAgo(0.5) });
  await seed("short-window", { stars: 1227, previous: 1000, previousAt: daysAgo(2.8), at: daysAgo(0.5) });
  // 반나절 사이 +90 — 하루로 쳐서 90/일. 180/일로 부풀면 맨 앞에 선다
  await seed("half-day", { stars: 190, previous: 100, previousAt: daysAgo(1), at: daysAgo(0.5) });

  const rows = await listProducts({ statuses: ["seeded"], sort: "rising", rising: true, limit: 10 });
  expect(rows.map((row) => row.slug)).toEqual(["short-window", "half-day", "long-window"]);
});

it("관심 많은 순 대체 목록은 스타 많은 순이고 스타를 모르는 제품은 맨 뒤다", async () => {
  await seed("unknown", { stars: null });
  await seed("small", { stars: 3 });
  await seed("big", { stars: 30_000 });

  const rows = await listProducts({ statuses: ["seeded"], sort: "stars", limit: 10 });
  expect(rows.map((row) => row.slug)).toEqual(["big", "small", "unknown"]);
});
