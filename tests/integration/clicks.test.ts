import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clickEvents, rateLimits, productClickDaily } from "@/lib/db/schema";
import * as repo from "@/lib/domain/products/repository";
import {
  isBotAgent,
  visitorId,
  recordClick,
  clicksSince,
  clickMetrics,
  rollupDaily,
  pruneEvents,
  topClickedSince,
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

describe("누구의 클릭인가", () => {
  it("방문자 쿠키가 다르면 따로 센다", async () => {
    // 예전에는 IP로 묶었는데 TRUSTED_PROXY_HOPS 기본값(0)에서는 모두 "direct"라
    // 전 세계 방문자가 한 버킷에 들어가 제품당 10분에 한 번만 세지고 있었다
    await product();
    await recordClick("app", "11111111-1111-1111-1111-111111111111");
    await recordClick("app", "22222222-2222-2222-2222-222222222222");

    expect(await count()).toBe(2);
  });

  it("같은 쿠키의 연타는 한 번으로 본다", async () => {
    await product();
    for (let i = 0; i < 4; i++) await recordClick("app", "11111111-1111-1111-1111-111111111111");
    expect(await count()).toBe(1);
  });

  it("쿠키가 없거나 형식이 이상하면 새로 만든다", () => {
    expect(visitorId(undefined)).toMatch(/^[a-f0-9-]{36}$/);
    expect(visitorId("' OR 1=1")).toMatch(/^[a-f0-9-]{36}$/);
    // 멀쩡한 값은 그대로 쓴다 (같은 방문자로 묶여야 하므로)
    const id = "11111111-1111-1111-1111-111111111111";
    expect(visitorId(id)).toBe(id);
  });

  it("봇은 세지 않는다 — 랭킹이 크롤 빈도순이 되면 안 된다", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "Twitterbot/1.0",
      "curl/8.4.0",
      "python-requests/2.31.0",
    ]) {
      expect(isBotAgent(ua), ua).toBe(true);
    }
    // 사람 브라우저는 통과한다
    expect(
      isBotAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36",
      ),
    ).toBe(false);
    expect(isBotAgent(null)).toBe(false);
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

describe("지표는 부가물이다", () => {
  it("지표 조회가 실패해도 목록은 그대로 나간다", async () => {
    // 주석은 그렇게 적혀 있었지만 실제로는 예외가 올라가 홈이 통째로 "불러올 수 없습니다"가 됐다
    await product("app", "https://app.test");
    const original = db.select;
    let restored = false;
    // clickMetrics의 select만 실패시킨다
    (db as unknown as { select: unknown }).select = (...args: unknown[]) => {
      if (!restored) {
        restored = true;
        throw new Error("click_events 조회 실패");
      }
      return (original as (...a: unknown[]) => unknown).apply(db, args);
    };

    try {
      const list = await getRankedList(10, "recent");
      expect(list.map((p) => p.slug)).toEqual(["app"]);
      expect(list[0].metrics).toBeUndefined();
    } finally {
      (db as unknown as { select: unknown }).select = original;
    }
  });
});

describe("굴린 집계를 읽는다", () => {
  it("30일 창의 제품별 합을 많이 눌린 순으로 준다", async () => {
    // 원천은 35일이면 지워지므로 오래된 구간은 이 표로만 답할 수 있다
    await product("loud", "https://loud.test");
    await product("quiet", "https://quiet.test");
    await db.insert(productClickDaily).values([
      { slug: "loud", day: "2026-08-10", clicks: 5 },
      { slug: "loud", day: "2026-08-11", clicks: 3 },
      { slug: "quiet", day: "2026-08-11", clicks: 2 },
    ]);

    expect(await topClickedSince(30)).toEqual([
      { slug: "loud", clicks: 8 },
      { slug: "quiet", clicks: 2 },
    ]);
  });

  it("창 밖의 날짜는 세지 않는다", async () => {
    await product("old", "https://old.test");
    await db.insert(productClickDaily).values({ slug: "old", day: "2020-01-01", clicks: 99 });

    expect(await topClickedSince(30)).toEqual([]);
  });
});

describe("제품을 지우면 딸린 기록도 지운다", () => {
  it("slug가 재활용돼도 지워진 제품의 지표를 물려받지 않는다", async () => {
    await product("app", "https://app.test");
    await recordClick("app", "11111111-1111-1111-1111-111111111111");
    await db.insert(productClickDaily).values({ slug: "app", day: "2026-08-11", clicks: 4 });

    const found = await repo.findBySlug("app");
    await repo.remove(found!.id);
    await repo.removeTraces("app");

    expect(await count()).toBe(0);
    expect(await topClickedSince(3650)).toEqual([]);
  });
});
