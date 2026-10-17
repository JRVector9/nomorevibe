import postgres from "postgres";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

/*
 * R4: 웹 쓰기 범위(runWebWrite)의 feedback TX 는 prelude(fence FOR SHARE)가 setFeedbackTransactionDeadline 보다 먼저 돌아,
 * fence 행이 잠겨 있으면 feedback 기한이 아니라 연결의 lock_timeout 만큼 기다렸다. 기한을 prelude 보다 먼저 걸어 그 대기도
 * 기한 안에서 끝나야 한다. 실제 PostgreSQL 의 실제 행 잠금으로 본다(seal·fence-old 의 fence UPDATE 를 흉내 낸다).
 */
// 연결의 lock_timeout 을 기한보다 넉넉히 길게 둔다 — 기한이 대기를 끊는지, 연결 설정이 끊는지 갈라 보이게(lib/db 첫 연결 전에 정한다)
vi.stubEnv("DB_LOCK_TIMEOUT_MS", "10000");
const blocker = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });

beforeAll(() => ensureSchema());
afterAll(async () => {
  vi.unstubAllEnvs();
  await blocker.end({ timeout: 5 });
  const g = globalThis as { pgClient?: { end: (options: { timeout: number }) => Promise<void> } };
  await g.pgClient?.end({ timeout: 5 });
});

it("a locked fence row is waited for only within the feedback deadline, not the connection lock_timeout", async () => {
  const { runWebWrite } = await import("@/lib/operations/dr/web-gate");
  const { feedbackDatabaseWrite } = await import("@/lib/domain/feedback/github/database");
  // 캐시 관문은 잠그지 않는 읽기라 먼저 통과시켜 둔다(5초 캐시)
  await runWebWrite(async () => {});
  let unlock!: () => void;
  const gate = new Promise<void>(resolve => { unlock = resolve; });
  let locked!: () => void;
  const ready = new Promise<void>(resolve => { locked = resolve; });
  const holding = blocker.begin(async tx => { await tx`SELECT id FROM dr_writer_fence WHERE id = 1 FOR UPDATE`; locked(); await gate; });
  void holding.catch(() => {});
  try {
    await Promise.race([ready, holding]);
    let wrote = false;
    const startedAt = Date.now();
    const outcome = await runWebWrite(() => feedbackDatabaseWrite(undefined, async tx => {
      wrote = true;
      await tx.execute(sql`select 1`);
    }, startedAt + 4_000)).then(() => "committed", (error: unknown) => error);
    const elapsed = Date.now() - startedAt;
    expect(outcome).not.toBe("committed");
    expect(wrote).toBe(false);
    // 기한(4초, 마지막 100ms 여유) 안에서 끝났다 — 연결의 lock_timeout(10초)까지 기다리지 않았다
    expect(elapsed).toBeLessThan(6_000);
  } finally {
    unlock();
    await holding;
  }
}, 30_000);
