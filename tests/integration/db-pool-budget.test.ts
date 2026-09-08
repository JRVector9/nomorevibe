import { expect, it } from "vitest";
import { createDbClient, dbPoolConfig, DbPoolWaitTimeoutError } from "@/lib/db/pool";
import { TEST_DATABASE_URL } from "./setup";

function latch() {
  let release!: () => void;
  return { promise:new Promise<void>(resolve => { release=resolve; }), release:() => release() };
}
function client() {
  return createDbClient(TEST_DATABASE_URL, dbPoolConfig({
    WORKER_ROLE:"web",DB_POOL_MAX:"1",DB_POOL_WAIT_MS:"100",DB_STATEMENT_TIMEOUT_MS:"1000",DB_LOCK_TIMEOUT_MS:"500",
  }));
}

it("removes a write that exceeds pool wait rather than executing it after the connection is released", async () => {
  const sql = client(), entered = latch(), release = latch();
  let held: Promise<unknown> | undefined;
  try {
    await sql.unsafe("create temporary table pool_wait_probe (value integer)");
    held = sql.begin(async () => { entered.release(); await release.promise; });
    await entered.promise;
    await expect(sql.unsafe("insert into pool_wait_probe values (1)")).rejects.toBeInstanceOf(DbPoolWaitTimeoutError);
    release.release();
    await held;
    const rows = await sql.unsafe("select count(*)::int as count from pool_wait_probe");
    expect(rows[0].count).toBe(0);
  } finally { release.release(); await held?.catch(() => {}); await sql.end({timeout:2}); }
});

it("cancels queued BEGIN before its callback runs and allows subsequent transactions", async () => {
  const sql = client(), entered = latch(), release = latch();
  let held: Promise<unknown> | undefined, callbackRan = false;
  try {
    await sql.unsafe("select 1");
    held = sql.begin(async () => { entered.release(); await release.promise; });
    await entered.promise;
    await expect(sql.begin(async () => {callbackRan=true;})).rejects.toBeInstanceOf(DbPoolWaitTimeoutError);
    release.release();
    await held;
    expect(callbackRan).toBe(false);
    expect(await sql.begin(async tx => (await tx.unsafe("select 7 as value"))[0].value)).toBe(7);
    expect(callbackRan).toBe(false);
  } finally { release.release(); await held?.catch(() => {}); await sql.end({timeout:2}); }
});

it("does not report executing SQL as a pool timeout and applies the server statement limit", async () => {
  const sql = createDbClient(TEST_DATABASE_URL, dbPoolConfig({
    DB_POOL_MAX:"1",DB_POOL_WAIT_MS:"100",DB_STATEMENT_TIMEOUT_MS:"300",DB_LOCK_TIMEOUT_MS:"100",
  }));
  try {
    await sql.unsafe("select 1");
    await expect(sql.unsafe("select pg_sleep(0.15)")).resolves.toHaveLength(1);
    await expect(sql.unsafe("select pg_sleep(1)")).rejects.toMatchObject({code:"57014"});
    const settings = await sql.unsafe("select current_setting('application_name') as name,current_setting('lock_timeout') as lock");
    expect(settings[0]).toMatchObject({name:"nomorevibe:web",lock:"100ms"});
  } finally { await sql.end({timeout:2}); }
});
