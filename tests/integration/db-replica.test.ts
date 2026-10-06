import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { TEST_DATABASE_URL, ensureSchema } from "./setup";

/**
 * 공개 읽기는 복제본 연결로 간다(lib/db/replica.ts). 테스트에는 복제본이 없어 같은 DB 를 다른 연결 풀로 붙여 본다 —
 * 연결 이름(application_name)으로 어느 풀에서 읽었는지 가린다.
 */
const globalForDb = globalThis as unknown as { readDb?: unknown };

beforeAll(() => {
  ensureSchema();
  process.env.READ_DATABASE_URL = TEST_DATABASE_URL;
  globalForDb.readDb = undefined;
});
afterAll(() => {
  delete process.env.READ_DATABASE_URL;
  globalForDb.readDb = undefined;
});

const { db, onReplica } = await import("@/lib/db");
const appName = async () => (await db.execute<{ name: string }>(sql`select current_setting('application_name') as name`))[0].name;

describe("복제본 읽기 연결", () => {
  it("onReplica 안에서는 복제본 풀로, 밖에서는 주 DB 풀로 읽는다", async () => {
    expect(await appName()).not.toBe("nomorevibe:web-replica");
    expect(await onReplica(appName)).toBe("nomorevibe:web-replica");
    // 함께 띄운 조회도 같은 풀을 쓴다
    const both = await onReplica(() => Promise.all([appName(), appName()]));
    expect(both).toEqual(["nomorevibe:web-replica", "nomorevibe:web-replica"]);
    expect(await appName()).not.toBe("nomorevibe:web-replica");
  });

  it("복제본이 아닌 DB 에서도 지연 확인이 통과한다(따라잡음 = 0)", async () => {
    expect(await onReplica(async () => 1)).toBe(1);
  });
});
