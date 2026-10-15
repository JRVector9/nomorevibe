import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

const fake = vi.hoisted(() => ({ open: vi.fn(), verify: vi.fn(), assert: vi.fn(), traces: [] as string[] }));
vi.mock("@/lib/operations/pipeline-replay-database", () => ({
  openVerifiedReplayHandlerDatabase: fake.open,
  assertVerifiedReplayHandlerDatabase: fake.assert,
  verifyReplayDatabaseSession: fake.verify,
}));
import { db, onPrimary, onReplica } from "@/lib/db";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";

type Global = { db?: unknown; readDb?: unknown; pgClient?: unknown };
const globals = globalThis as Global;
let previous: Global;
let nextSession = 0;
function pending(rows: unknown[]) {
  return Object.assign(Promise.resolve(rows), { values: () => Promise.resolve(rows.map(row => Object.values(row as object))) });
}
function handle(path: string) {
  const client = {
    options: { parsers: {}, serializers: {} },
    begin: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const id = ++nextSession;
      const session = {
        id,
        unsafe: vi.fn(() => { fake.traces.push(`${path}:query:${id}`); return pending([{ path, id }]); }),
        savepoint: vi.fn(async (load: (tx: unknown) => Promise<unknown>) => load(session)),
      };
      fake.traces.push(`${path}:begin:${id}`);
      try { const result = await work(session); fake.traces.push(`${path}:commit:${id}`); return result; }
      catch (error) { fake.traces.push(`${path}:rollback:${id}`); throw error; }
    }),
  };
  return { client, close: vi.fn(async () => { fake.traces.push(`${path}:close`); }) };
}
beforeEach(() => {
  previous = { db: globals.db, readDb: globals.readDb, pgClient: globals.pgClient };
  const poison = new Proxy({}, { get() { throw new Error("global_database_access_canary"); } });
  globals.db = poison; globals.readDb = poison; globals.pgClient = poison;
  fake.open.mockImplementation(async (path: string) => handle(path));
  fake.assert.mockImplementation(() => {});
  fake.verify.mockImplementation(async (tx: { id: number }) => { fake.traces.push(`verify:${tx.id}`); });
});
afterEach(() => { Object.assign(globals, previous); vi.resetAllMocks(); fake.traces.length = 0; });

it("routes primary, replica and ordinary reads only through the owned handler database", async () => {
  await withReplayDatabaseScope("identity-a", async () => {
    const [direct] = await db.execute<{ path: string }>(sql`select 1`);
    expect(direct.path).toBe("identity-a");
    expect((await onReplica(() => onPrimary(() => db.execute<{ path: string }>(sql`select 1`))))[0].path).toBe("identity-a");
    expect(await db.select({ path: sql<string>`'identity-a'` }).from(sql`probe`)).toEqual([{ path: "identity-a" }]);
    expect(() => db.$client).toThrow("replay_raw_client_rejected");
  });
  expect(fake.open).toHaveBeenCalledTimes(1);
  expect(fake.traces.at(-1)).toBe("identity-a:close");
});

it("verifies before and after each statement on the exact reserved transaction connection", async () => {
  await withReplayDatabaseScope("identity-a", async () => { await db.execute(sql`select 1`); });
  const begin = fake.traces.find(row => row.startsWith("identity-a:begin:"))!;
  const id = begin.split(":").at(-1);
  expect(fake.traces).toEqual([begin, `verify:${id}`, `identity-a:query:${id}`, `verify:${id}`, `identity-a:commit:${id}`, "identity-a:close"]);
});

it("verifies explicit transactions and savepoints on their actual connection and rolls back verifier failure", async () => {
  await withReplayDatabaseScope("identity-a", async () => {
    await db.transaction(async tx => {
      await tx.execute(sql`select 1`);
      await tx.transaction(async inner => { await inner.execute(sql`select 2`); });
    });
  });
  expect(fake.verify).toHaveBeenCalledTimes(4);
  expect(new Set(fake.verify.mock.calls.map(([tx]) => tx.id)).size).toBe(1);
  fake.traces.length = 0;
  fake.verify.mockRejectedValueOnce(new Error("privilege_drift_canary"));
  await expect(withReplayDatabaseScope("identity-b", async () => { await db.execute(sql`select 1`); }))
    .rejects.toMatchObject({ cause: { message: "privilege_drift_canary" } });
  expect(fake.traces.some(row => row.includes(":query:"))).toBe(false);
  expect(fake.traces.some(row => row.includes(":rollback:"))).toBe(true);
  expect(fake.traces.at(-1)).toBe("identity-b:close");
});

it("allows same-identity nesting, rejects cross-identity nesting before opening another connection", async () => {
  await withReplayDatabaseScope("identity-a", async () => {
    await withReplayDatabaseScope("identity-a", async () => { await db.execute(sql`select 1`); });
    await expect(withReplayDatabaseScope("identity-b", async () => {})).rejects.toThrow("replay_database_scope_conflict");
    await db.execute(sql`select 2`);
  });
  expect(fake.open).toHaveBeenCalledTimes(1);
});

it("keeps parallel root scopes separate and rejects a builder moved into another scope", async () => {
  await Promise.all(["identity-a", "identity-b"].map(path => withReplayDatabaseScope(path, async () => {
    await Promise.resolve();
    expect((await db.execute<{ path: string }>(sql`select 1`))[0].path).toBe(path);
  })));
  let builder: PromiseLike<unknown>;
  await withReplayDatabaseScope("identity-a", async () => { builder = db.select({ n: sql`1` }).from(sql`probe`); });
  const before = fake.traces.filter(row => row.includes(":query:")).length;
  await withReplayDatabaseScope("identity-b", async () => {
    await expect(Promise.resolve(builder!)).rejects.toMatchObject({ cause: { message: "replay_database_scope_closed" } });
  });
  expect(fake.traces.filter(row => row.includes(":query:"))).toHaveLength(before);
});

it("revokes captured methods, transaction executors and inherited async callbacks at scope exit", async () => {
  let execute: typeof db.execute;
  let txExecute: typeof db.execute;
  let afterExit!: () => void;
  const released = new Promise<void>(resolve => { afterExit = resolve; });
  let descendant!: Promise<unknown>;
  await withReplayDatabaseScope("identity-a", async () => {
    execute = db.execute;
    await db.transaction(async tx => { txExecute = tx.execute.bind(tx); });
    await expect(Promise.resolve().then(() => txExecute!(sql`select 1`)))
      .rejects.toMatchObject({ cause: { message: "replay_transaction_closed" } });
    descendant = released.then(() => onPrimary(() => onReplica(() => db.execute(sql`select 1`))));
  });
  await expect(Promise.resolve().then(() => execute!(sql`select 1`))).rejects.toThrow("replay_database_scope_closed");
  afterExit();
  await expect(descendant).rejects.toThrow("replay_database_scope_closed");
});

it("closes the exclusively owned handle even when the callback fails", async () => {
  await expect(withReplayDatabaseScope("identity-a", async () => { throw new Error("callback_failed"); })).rejects.toThrow("callback_failed");
  expect(fake.traces).toEqual(["identity-a:close"]);
});

it("rejects an inherited primary callback before executing any of its work after exit", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const load = vi.fn(async () => 1);
  let child!: Promise<number>;
  await withReplayDatabaseScope("identity-a", async () => { child = wait.then(() => onPrimary(load)); });
  release();
  await expect(child).rejects.toThrow("replay_database_scope_closed");
  expect(load).not.toHaveBeenCalled();
});

it("revokes an unawaited transaction even if its callback waits indefinitely", async () => {
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { resume = resolve; });
  let background!: Promise<unknown>;
  const run = withReplayDatabaseScope("identity-a", async () => {
    background = db.transaction(async () => { entered(); await wait; });
    void background.catch(() => {});
    await started;
  });
  const completion = run.then(() => "unexpected_success", error => error.message as string);
  const observed = await Promise.race([completion, new Promise<string>(resolve => setTimeout(() => resolve("drain_hung"), 50))]);
  // Always release the test fixture even when the regression fails.
  resume();
  await completion;
  expect(observed).toBe("replay_database_work_not_awaited");
  await expect(background).rejects.toThrow("replay_database_scope_closed");
  expect(fake.traces.some(row => row.includes(":rollback:"))).toBe(true);
  expect(fake.traces.at(-1)).toBe("identity-a:close");
});

it("does not let an unawaited nested transaction outlive its parent commit boundary", async () => {
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { resume = resolve; });
  let child!: Promise<unknown>;
  await withReplayDatabaseScope("identity-a", async () => {
    const parent = db.transaction(async tx => {
      child = tx.transaction(async inner => { entered(); await wait; await inner.execute(sql`select 1`); });
      void child.catch(() => {});
      await started;
    });
    // A correct parent rejects and rolls back without waiting for the child callback.
    const status = await Promise.race([parent.then(() => "committed", error => error.message as string),
      new Promise<string>(resolve => setTimeout(() => resolve("parent_hung"), 50))]);
    resume();
    await parent.catch(() => {});
    await child.catch(() => {});
    expect(status).toBe("replay_transaction_work_not_awaited");
    expect(fake.traces.some(row => row.includes(":query:"))).toBe(false);
  });
});
