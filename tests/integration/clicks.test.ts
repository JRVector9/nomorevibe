import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clickEvents, rateLimits } from "@/lib/db/schema";
import * as repo from "@/lib/domain/products/repository";
import { recordClick, clicksSince } from "@/lib/domain/products/clicks";
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
