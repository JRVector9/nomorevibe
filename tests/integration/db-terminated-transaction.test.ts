import { spawn } from "node:child_process";
import postgres from "postgres";
import { sql as drizzleSql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDbClient, dbPoolConfig } from "@/lib/db/pool";
import { TEST_DATABASE_URL, ensureSchema } from "./setup";

/**
 * 2026-11-01 운영 장애(15:22·15:28Z pg_terminate_backend 57P01 파도)의 드라이버 경로.
 * postgres 3.4.9 는 TX 중 연결이 끊기면 socket 을 null 로 만든 뒤 진행 중 문장을 거절하고, 그 거절을 받은 begin scope 가 같은 연결에
 * rollback 을 쓰면 setImmediate 안에서 TypeError("reading 'write'")가 던져져 프로세스가 죽었다. lib/db/pool.ts 는 그 문장을 보내지 않고 거절한다.
 */
const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const clients: ReturnType<typeof createDbClient>[] = [];
beforeAll(() => ensureSchema());
afterAll(async () => {
  await Promise.all(clients.map(client => client.end({ timeout: 1 }).catch(() => {})));
  await admin.end({ timeout: 5 });
});

const terminate = (applicationName: string) => admin`SELECT count(*)::int AS n FROM (SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE application_name = ${applicationName} AND pid <> pg_backend_pid()) t`;
async function untilSleeping(applicationName: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await admin`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = ${applicationName} AND query LIKE '%pg_sleep%' AND state = 'active'`;
    if (row.n > 0) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("statement never started");
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setTimeout(resolve, 50)); };

it("control: plain postgres 3.4.9 crashes its process when a transaction connection is terminated mid-statement", async () => {
  // 고쳐진 드라이버로 올리면 이 대조가 실패한다 — 그때 lib/db/pool.ts 의 닫힌 TX 연결 가드를 다시 본다
  const script = `
    const postgres = require('postgres');
    const url = ${JSON.stringify(TEST_DATABASE_URL)};
    const sql = postgres(url, { max: 2, connection: { application_name: 'dbterm-raw' } });
    const admin = postgres(url, { max: 1 });
    (async () => {
      for (let i = 0; i < 10; i++) {
        const tx = sql.begin(async t => { await t\`select 1\`; await t\`select pg_sleep(5)\`; }).catch(() => {});
        await new Promise(r => setTimeout(r, 300));
        await admin\`select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'dbterm-raw'\`;
        await tx;
        await new Promise(r => setTimeout(r, 50));
      }
      await sql.end({ timeout: 1 }); await admin.end({ timeout: 1 });
    })();`;
  const child = spawn(process.execPath, ["-e", script], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", data => { stderr += String(data); });
  const code = await new Promise<number | null>(resolve => child.once("exit", resolve));
  expect(code, stderr).not.toBe(0);
  expect(stderr).toContain("Cannot read properties of null (reading 'write')");
}, 30_000);

it("the pool rejects the late rollback of a terminated transaction instead of crashing, and serves the next query", async () => {
  const applicationName = "dbterm-pool";
  const client = createDbClient(TEST_DATABASE_URL, { ...dbPoolConfig({ DB_POOL_MAX: "2" }), applicationName, waitMs: 3_000 });
  clients.push(client);
  const db = drizzle(client);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => { uncaught.push(error); };
  process.on("uncaughtException", onUncaught);
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      // 운영 코드가 쓰는 drizzle TX 와 드라이버 begin 을 번갈아 본다
      const tx = attempt % 2 === 0
        ? client.begin(async t => { await t`select 1`; await t`select pg_sleep(5)`; })
        : db.transaction(async t => { await t.execute(drizzleSql`select 1`); await t.execute(drizzleSql`select pg_sleep(5)`); });
      const failure = tx.then(() => null, (error: unknown) => error);
      await untilSleeping(applicationName);
      expect((await terminate(applicationName))[0].n).toBeGreaterThanOrEqual(1);
      const error = await failure as { code?: string; cause?: { code?: string } } | null;
      expect(error).not.toBeNull();
      expect(["CONNECTION_CLOSED", "57P01"]).toContain(error?.code ?? error?.cause?.code);
      await settle();
      expect(uncaught).toEqual([]);
      // 같은 파도에 끊긴 다른 유휴 연결은 다음 문장 한 번을 57P01 로 돌려줄 수 있다 — 풀이 다시 붙어 곧 응답한다
      let answered = false;
      for (let retry = 0; retry < 3 && !answered; retry++) {
        answered = await client`select 1 as one`.then(rows => rows[0].one === 1, () => false);
      }
      expect(answered).toBe(true);
    }
    // 끊긴 뒤에도 새 TX 가 그대로 commit 된다
    expect(await client.begin(async t => (await t`select 2 as two`)[0].two)).toBe(2);
    await settle();
    expect(uncaught).toEqual([]);
  } finally {
    process.removeListener("uncaughtException", onUncaught);
  }
}, 60_000);
