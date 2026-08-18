import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clickEvents, rateLimits, productClickDaily } from "@/lib/db/schema";
import * as repo from "@/lib/domain/products/repository";
import {
  recordClick,
  clicksSince,
  clickMetrics,
  rollupDaily,
  pruneEvents,
} from "@/lib/domain/products/clicks";
import { getRankedList } from "@/lib/domain/products/view";
import { ensureSchema, resetTables } from "./setup";

async function product(slug = "app", url = "https://app.test") {
  await repo.insert({
    slug,
    url,
    name: slug,
    tagline: "소개",
    description: "설명",
    category: "Other",
    stack: [],
    status: "verified",
    source: "skill",
    verifyToken: `nmv_verify_${slug}`,
    editTokenHash: "x".repeat(64),
  });
}

const count = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(clickEvents))[0].n;

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(clickEvents);
  await db.delete(productClickDaily);
  await db.delete(rateLimits);
  await resetTables();
});

describe("클릭 집계", () => {
  it("클릭을 원천으로 쌓는다", async () => {
    await product();
    await recordClick("app", "1.1.1.1");
    expect(await count()).toBe(1);
  });

  it("같은 사람의 연타는 한 번으로 본다", async () => {
    // 한 번 누른 것과 백 번 누른 것이 같은 무게일 수는 없다
    await product();
    for (let i = 0; i < 5; i++) await recordClick("app", "1.1.1.1");
    expect(await count()).toBe(1);
  });

  it("다른 사람, 다른 제품은 따로 센다", async () => {
    await product();
    await recordClick("app", "1.1.1.1");
    await recordClick("app", "2.2.2.2");
    await recordClick("other", "1.1.1.1");
    expect(await count()).toBe(3);
  });

  it("묶는 창이 지나면 다시 센다", async () => {
    await product();
    await recordClick("app", "1.1.1.1");
    // 창을 지난 것으로 위조한다
    await db.update(rateLimits).set({ resetAt: sql`now() - interval '1 second'` });

    await recordClick("app", "1.1.1.1");

    expect(await count()).toBe(2);
  });

  it("창별로 센다 — 최근 24시간과 그 이전을 가른다", async () => {
    await product();
    await db.insert(clickEvents).values([
      { slug: "app", occurredAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      { slug: "app", occurredAt: new Date(Date.now() - 30 * 60 * 60 * 1000) },
      { slug: "app", occurredAt: new Date(Date.now() - 40 * 60 * 60 * 1000) },
    ]);

    const day = 24 * 60 * 60 * 1000;
    expect(await clicksSince("app", day)).toBe(1);
    expect(await clicksSince("app", day, day)).toBe(2);
  });

  it("기록이 실패해도 던지지 않는다 — 사용자는 제품으로 가는 중이다", async () => {
    // 없는 제품의 클릭도 기록 자체는 조용히 처리된다 (라우트가 존재 여부를 먼저 본다)
    await expect(recordClick("ghost", "1.1.1.1")).resolves.toBeUndefined();
  });
});

describe("집계와 랭킹", () => {
  it("최근 창의 클릭과 하루 전 대비 변화를 함께 준다", async () => {
    await product("a");
    const hours = (n: number) => new Date(Date.now() - n * 60 * 60 * 1000);
    await db.insert(clickEvents).values([
      { slug: "a", occurredAt: hours(1) },
      { slug: "a", occurredAt: hours(2) },
      { slug: "a", occurredAt: hours(30) },
    ]);

    const metrics = await clickMetrics(["a"]);

    expect(metrics.get("a")).toEqual({ clicks: 3, delta24h: 1 });
  });

  it("어제 클릭이 없으면 변화율은 말하지 않는다", async () => {
    // 0으로 적으면 "변화 없음"이 되어 아무것도 없던 것과 구분되지 않는다
    await product("a");
    await db.insert(clickEvents).values({ slug: "a", occurredAt: new Date() });

    expect((await clickMetrics(["a"]))?.get("a")).toEqual({ clicks: 1, delta24h: null });
  });

  it("굴리면 하루 단위로 남고 다시 굴려도 같은 값이다", async () => {
    await product("a");
    await db.insert(clickEvents).values([
      { slug: "a", occurredAt: new Date() },
      { slug: "a", occurredAt: new Date() },
    ]);

    await rollupDaily();
    await rollupDaily();

    const rows = await db.select().from(productClickDaily);
    expect(rows).toHaveLength(1);
    expect(rows[0].clicks).toBe(2);
  });

  it("오래된 원천만 지운다", async () => {
    await product("a");
    await db.insert(clickEvents).values([
      { slug: "a", occurredAt: new Date() },
      { slug: "a", occurredAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    ]);

    await pruneEvents();

    expect(await count()).toBe(1);
  });

  it("많이 눌린 순으로 목록을 세운다", async () => {
    await product("quiet", "https://quiet.test");
    await product("loud", "https://loud.test");
    await db.insert(clickEvents).values([
      { slug: "loud", occurredAt: new Date() },
      { slug: "loud", occurredAt: new Date() },
      { slug: "quiet", occurredAt: new Date() },
    ]);

    const list = await getRankedList(10, "popular");

    expect(list.map((p) => p.slug)).toEqual(["loud", "quiet"]);
    expect(list[0].metrics).toMatchObject({ clicks: 2 });
  });

  it("검증 여부가 클릭순을 덮지 않는다", async () => {
    // 클릭 0인 검증 제품이 클릭 5인 제품 위에 오면 "많이 눌린 순"이 거짓말이 된다
    await product("popular-one", "https://popular.test");
    await product("empty-one", "https://empty.test");
    await db.insert(clickEvents).values([
      { slug: "popular-one", occurredAt: new Date() },
      { slug: "popular-one", occurredAt: new Date() },
    ]);

    expect((await getRankedList(10, "popular")).map((p) => p.slug)).toEqual([
      "popular-one",
      "empty-one",
    ]);
  });

  it("클릭이 없어도 목록에서 사라지지 않는다", async () => {
    await product("silent", "https://silent.test");
    const list = await getRankedList(10, "popular");
    expect(list.map((p) => p.slug)).toEqual(["silent"]);
  });
});
