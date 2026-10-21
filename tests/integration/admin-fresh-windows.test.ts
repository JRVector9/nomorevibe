import { beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlFrontier, products } from "@/lib/db/schema";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { signalYields, todayPublications } from "@/lib/operations/dashboard";
import { kstDayStart } from "@/lib/operations/windows";
import { ensureSchema, resetTables } from "./setup";

/**
 * 굴러가는 합계 옆의 짧은 창 — "최근 1시간"과 "오늘(한국 0시부터)". 시각 열은 시간대 없는 UTC 벽시계라
 * 한국 0시도 UTC 벽시계로 돌려 견줘야 한다. 세션 시간대가 무엇이든 같아야 한다.
 */
const product = (slug: string, createdAt: Date): typeof products.$inferInsert => ({
  slug, url: `https://${slug}.example`, name: slug, tagline: "test", description: "test", category: "Productivity",
  status: "seeded", source: "crawler", verifyToken: `verify-${slug}`, editTokenHash: "h".repeat(64), createdAt,
});

beforeAll(ensureSchema);
beforeAll(resetTables);

it("한국 0시를 UTC 벽시계 timestamp 로 돌려준다 — 세션 시간대와 상관없이", async () => {
  const start = (value: string) => db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL TIME ZONE 'America/New_York'`);
    const [row] = await tx.execute<{ at: string }>(sql`SELECT to_char(${kstDayStart(sql`${value}::timestamp`)}, 'YYYY-MM-DD HH24:MI:SS') AS at`);
    return row.at;
  });
  // 10-21 00:10 KST → 그날 0시는 10-20 15:00 UTC
  expect(await start("2026-10-20 15:10:00")).toBe("2026-10-20 15:00:00");
  // 10-20 23:59 KST → 아직 10-20 이라 0시는 10-19 15:00 UTC
  expect(await start("2026-10-20 14:59:59")).toBe("2026-10-19 15:00:00");
  // 정확히 0시
  expect(await start("2026-10-20 15:00:00")).toBe("2026-10-20 15:00:00");
});

it("최근 24시간 발행 옆의 1시간·오늘은 한국 0시에서 끊는다", async () => {
  await db.insert(products).values([
    product("after-midnight", new Date("2026-10-20T15:05:00Z")),
    product("before-midnight", new Date("2026-10-20T14:55:00Z")),
    product("morning-utc", new Date("2026-10-20T01:00:00Z")),
    product("yesterday", new Date("2026-10-19T14:00:00Z")),
  ]);
  const now = new Date("2026-10-20T15:10:00Z");
  expect(await todayPublications(now, 0)).toEqual({ total24h: 3, korean24h: 0, windows: { hour: 2, today: 1 }, latest: [] });
  // 하루 뒤 같은 시각 — 하나도 24시간 안에 없다
  expect(await todayPublications(new Date("2026-10-21T15:10:00Z"), 0)).toMatchObject({ total24h: 0, windows: { hour: 0, today: 0 } });
});

it("수동 새로고침(fresh)은 1분 캐시를 건너뛰어 방금 들어온 것을 센다", async () => {
  await db.delete(crawlFrontier);
  // 다른 파일이 담은 7일 값과 섞이지 않게 3일 창으로 센다
  const before = await signalYields(DEFAULT_CRAWL_SETTINGS, 3);
  await db.insert(crawlFrontier).values({ repo: "fresh/one", signal: "fresh-signal", discoveredAt: new Date() });
  expect(await signalYields(DEFAULT_CRAWL_SETTINGS, 3)).toEqual(before);
  const fresh = await signalYields(DEFAULT_CRAWL_SETTINGS, 3, { fresh: true });
  expect(fresh.find((row) => row.signal === "fresh-signal")).toMatchObject({ enqueued: 1, enqueuedWindows: { hour: 1, today: 1 } });
  // 새로 센 값을 캐시에 다시 썼다 — 다음 자동 갱신도 그 값
  expect(await signalYields(DEFAULT_CRAWL_SETTINGS, 3)).toEqual(fresh);
});
