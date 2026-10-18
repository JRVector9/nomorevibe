import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { evidenceProgress } from "@/lib/operations/worker-progress-query";
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

const { db, onReplica, readReplicaOnly } = await import("@/lib/db");
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

/** 복제본 전용 읽기(운영센터 v8 PR3) — 테스트 DB 를 복제본 자리에 넘기는 fixture 로 본다 */
describe("복제본 전용 읽기 연결", () => {
  it("readReplicaOnly 는 복제본 풀에서 읽고, 넘긴 실행기도 복제본 풀이다", async () => {
    const result = await readReplicaOnly(async replica => [await appName(),
      (await replica.execute<{ name: string }>(sql`select current_setting('application_name') as name`))[0].name]);
    expect(result).toEqual({ ok: true, value: ["nomorevibe:web-replica", "nomorevibe:web-replica"] });
    expect(await appName()).not.toBe("nomorevibe:web-replica");
  });

  it("근거 읽기는 주 DB 실행기(관문)와 복제본 실행기에서 같은 결과를 낸다", async () => {
    const now = new Date();
    const gate = await evidenceProgress(db, DEFAULT_CRAWL_SETTINGS, now, false, null);
    expect(gate.map(row => row.key)).toEqual(["evidence", "agent-evidence", "ai-level"]);
    expect(await readReplicaOnly(replica => evidenceProgress(replica, DEFAULT_CRAWL_SETTINGS, now, false, null)))
      .toEqual({ ok: true, value: gate });
  });
});
