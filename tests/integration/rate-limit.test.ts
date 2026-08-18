import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { rateLimit } from "@/lib/rate-limit";
import { ensureSchema } from "./setup";

/**
 * 한도를 DB에 두는 이유는 인스턴스가 여럿일 때 하나로 유지하기 위함이다.
 * 그 성질은 여기서만 확인할 수 있다 — 인메모리였을 때는 프로세스 안에서만 맞았다.
 */
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(rateLimits);
});

describe("rateLimit", () => {
  it("한도까지 허용하고 초과분을 막는다", async () => {
    for (let i = 0; i < 3; i++) expect(await rateLimit("register:1.1.1.1", 3, 60_000)).toBe(true);
    expect(await rateLimit("register:1.1.1.1", 3, 60_000)).toBe(false);
  });

  it("키가 다르면 버킷이 분리된다", async () => {
    expect(await rateLimit("register:1.1.1.1", 1, 60_000)).toBe(true);
    expect(await rateLimit("register:1.1.1.1", 1, 60_000)).toBe(false);
    // 다른 클라이언트도, 같은 클라이언트의 다른 행위도 별개다
    expect(await rateLimit("register:2.2.2.2", 1, 60_000)).toBe(true);
    expect(await rateLimit("verify:1.1.1.1", 1, 60_000)).toBe(true);
  });

  it("창이 지나면 다시 센다", async () => {
    expect(await rateLimit("edit:1.1.1.1", 1, 60_000)).toBe(true);
    expect(await rateLimit("edit:1.1.1.1", 1, 60_000)).toBe(false);

    // 창을 지난 것으로 위조한다 (실제로 기다리면 테스트가 느려진다)
    await db.update(rateLimits).set({ resetAt: sql`now() - interval '1 second'` });

    expect(await rateLimit("edit:1.1.1.1", 1, 60_000)).toBe(true);
  });

  it("동시에 들어와도 한도를 넘기지 않는다", async () => {
    // 읽고 쓰기를 나누면 여기서 한도를 넘긴다 — 증가와 판정이 한 문장이어야 한다
    const results = await Promise.all(
      Array.from({ length: 10 }, () => rateLimit("register:3.3.3.3", 4, 60_000)),
    );

    expect(results.filter(Boolean)).toHaveLength(4);
  });

  it("행은 키마다 하나만 쓴다 — 요청 수만큼 늘지 않는다", async () => {
    for (let i = 0; i < 5; i++) await rateLimit("register:4.4.4.4", 100, 60_000);

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(rateLimits);
    expect(count).toBe(1);
  });
});
