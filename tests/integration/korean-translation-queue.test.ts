import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productKoreanTaglines } from "@/lib/db/schema";
import { koreanTaglineQueue, pendingKoreanTaglines } from "@/lib/domain/products/korean-taglines";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

async function seed(slug: string, cache?: Partial<typeof productKoreanTaglines.$inferInsert>,
  overrides: Partial<typeof products.$inferInsert> = {}) {
  const tagline = `Track tasks with ${slug}`;
  const [row] = await db.insert(products).values({ slug, name: slug, url: `https://${slug}.test`, tagline,
    description: "d", category: "Dev", status: "seeded", source: "crawler", verifyToken: "v", editTokenHash: "e",
    createdAt: sql`now() - interval '30 days'` as unknown as Date, ...overrides,
  }).returning({ id: products.id });
  if (cache) await db.insert(productKoreanTaglines).values({ productId: row.id, sourceTagline: tagline, ...cache });
  return row.id;
}

describe("한국어 번역 운영 집계와 실제 선택의 경계", () => {
  it("현재 원문·재시도 시각·일반4회/홈6회·공개/한국어 조건을 같은 큐로 나눈다", async () => {
    const fresh = await seed("fresh");
    const changed = await seed("changed", { sourceTagline: "Old source", errorCode: "rejected:empty",
      qualityRejections: 9, attempts: 12, retryAt: new Date("2100-01-01") });
    await seed("done", { taglineKo: "현재 원문을 옮긴 한국어 소개", errorCode: null, qualityRejections: 6 });
    const due = await seed("due", { errorCode: "http_502", attempts: 30, retryAt: new Date("2000-01-01") });
    await seed("future", { errorCode: "http_502", retryAt: new Date("2100-01-01") });
    await seed("normal-four", { errorCode: "rejected:empty", qualityRejections: 4 });
    const homeFour = await seed("home-four", { errorCode: "rejected:empty", qualityRejections: 4 });
    await seed("home-five", { errorCode: "rejected:too_long", qualityRejections: 5, retryAt: new Date("2100-01-01") });
    await seed("home-six", { errorCode: "http_502", qualityRejections: 6 });
    await seed("normal-five", { errorCode: "http_502", qualityRejections: 5 });
    await seed("private", undefined, { status: "banned" });
    await seed("korean", undefined, { tagline: "이미 한국어로 쓰인 제품 소개" });
    await seed("empty", undefined, { tagline: " " });
    const home = ["home-four", "home-five", "home-six"];
    const queue = await koreanTaglineQueue(home);
    expect(queue).toMatchObject({ eligible: 10, done: 1, ready: 4, retryScheduled: 2, blocked: 3, lastHour: 1 });
    expect(Number.isFinite(Date.parse(queue.measuredAt))).toBe(true);
    const pending = await pendingKoreanTaglines(20, home);
    expect(pending.map((row) => row.productId).sort((a, b) => a - b)).toEqual([fresh, changed, due, homeFour].sort((a, b) => a - b));
    expect(pending).toHaveLength(queue.ready);
    expect(pending.find((row) => row.productId === changed)).toMatchObject({ attempts: 0, lastError: null });
    expect(pending.find((row) => row.productId === due)).toMatchObject({ attempts: 30, lastError: "http_502" });
    expect(queue.done + queue.ready + queue.retryScheduled + queue.blocked).toBe(queue.eligible);
    expect(await koreanTaglineQueue([])).toMatchObject({ eligible: 10, done: 1, ready: 3, retryScheduled: 1, blocked: 5 });
  });

  it("빈 큐도 집계 시각과 실제 0을 돌려준다", async () => {
    expect(await koreanTaglineQueue([])).toMatchObject({ eligible: 0, done: 0, ready: 0, retryScheduled: 0, blocked: 0, lastHour: 0 });
    expect(await pendingKoreanTaglines(8, [])).toEqual([]);
  });
});
