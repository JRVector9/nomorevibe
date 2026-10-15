import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

const fake = vi.hoisted(() => ({ open: vi.fn(), verify: vi.fn(), assert: vi.fn(), same: vi.fn(),
  hooks: vi.fn(), before: vi.fn(), after: vi.fn(), finalWall: vi.fn(), commitAck: vi.fn(), rollback: vi.fn(), traces: [] as string[] }));
vi.mock("@/lib/operations/pipeline-replay-execution", () => ({ currentReplayTransactionHooks: fake.hooks }));
vi.mock("@/lib/operations/pipeline-replay-database", () => ({
  openVerifiedReplayHandlerDatabase: fake.open,
  assertVerifiedReplayHandlerDatabase: fake.assert,
  assertSameReplayHandlerDatabase: fake.same,
  verifyReplayDatabaseSession: fake.verify,
}));
import { db, onPrimary, onReplica } from "@/lib/db";
import { assertReplayDatabaseScopeIdentity, withReplayDatabaseScope } from "@/lib/db/replay-scope";
import type { VerifiedReplayDatabase } from "@/lib/operations/pipeline-replay-database";

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
  fake.hooks.mockReturnValue({ before: fake.before, after: fake.after, finalWall: fake.finalWall,
    commitAck: fake.commitAck, rollback: fake.rollback });
  fake.before.mockResolvedValue(undefined);
  fake.after.mockResolvedValue(undefined);
  fake.finalWall.mockResolvedValue(undefined);
  fake.commitAck.mockResolvedValue(undefined);
  fake.rollback.mockResolvedValue(undefined);
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

it("binds the ledger handle to the active scope through the private verified identity", async () => {
  const ledger = {} as VerifiedReplayDatabase;
  expect(() => assertReplayDatabaseScopeIdentity(ledger)).toThrow("replay_database_scope_required");
  await withReplayDatabaseScope("identity-a", async () => {
    assertReplayDatabaseScopeIdentity(ledger);
    const owned = await fake.open.mock.results.at(-1)!.value;
    expect(fake.same).toHaveBeenCalledWith(owned, ledger);
    fake.same.mockImplementationOnce(() => { throw new Error("replay_database_identity_mismatch"); });
    expect(() => assertReplayDatabaseScopeIdentity(ledger)).toThrow("replay_database_identity_mismatch");
  });
});

it("rejects inherited identity checks before consulting handles after scope exit", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let child!: Promise<void>;
  await withReplayDatabaseScope("identity-a", async () => {
    child = wait.then(() => assertReplayDatabaseScopeIdentity({} as VerifiedReplayDatabase));
  });
  release();
  await expect(child).rejects.toThrow("replay_database_scope_closed");
  expect(fake.same).not.toHaveBeenCalled();
});

it("flushes certified transaction facts before native commit and confirms only after commit resolves", async () => {
  const ticket = Object.freeze({ transaction: "certified" });
  fake.before.mockImplementation(async (tx: { id: number }) => { fake.traces.push(`before:${tx.id}`); return ticket; });
  fake.after.mockImplementation(async (tx: { id: number }, received: unknown) => {
    expect(received).toBe(ticket); fake.traces.push(`after:${tx.id}`);
  });
  fake.commitAck.mockImplementation(async (received: unknown) => {
    expect(received).toBe(ticket); fake.traces.push("commit-confirmed");
  });
  await withReplayDatabaseScope("identity-a", () => db.transaction(async tx => { await tx.execute(sql`select 1`); }));
  const commit = fake.traces.findIndex(row => row.startsWith("identity-a:commit:"));
  expect(fake.before).toHaveBeenCalledTimes(1);
  expect(fake.after).toHaveBeenCalledTimes(1);
  expect(fake.traces.findIndex(row => row.startsWith("before:"))).toBeLessThan(fake.traces.findIndex(row => row.includes(":query:")));
  expect(fake.traces.findIndex(row => row.startsWith("after:"))).toBeLessThan(commit);
  expect(fake.traces.indexOf("commit-confirmed")).toBeGreaterThan(commit);
  expect(fake.rollback).not.toHaveBeenCalled();
});

it("never confirms rolled-back writes and rolls back when the final journal flush fails", async () => {
  const ticket = Object.freeze({ transaction: "will-rollback" });
  fake.before.mockResolvedValue(ticket);
  fake.after.mockRejectedValue(new Error("journal_flush_failed"));
  await expect(withReplayDatabaseScope("identity-a", () => db.transaction(async tx => { await tx.execute(sql`select 1`); })))
    .rejects.toThrow("journal_flush_failed");
  expect(fake.traces.some(row => row.includes(":rollback:"))).toBe(true);
  expect(fake.traces.some(row => row.includes(":commit:"))).toBe(false);
  expect(fake.commitAck).not.toHaveBeenCalled();
  expect(fake.rollback).toHaveBeenCalledWith(ticket);
});

it("passes the parent ticket to reject certified savepoints before child SQL", async () => {
  const ticket = Object.freeze({ transaction: "outer" });
  fake.before.mockImplementation(async (_tx: unknown, parent: unknown) => {
    if (parent) throw new Error("replay_certified_savepoint_rejected");
    return ticket;
  });
  await expect(withReplayDatabaseScope("identity-a", () => db.transaction(async tx => {
    await tx.transaction(async inner => { await inner.execute(sql`select 1`); });
  }))).rejects.toThrow("replay_certified_savepoint_rejected");
  expect(fake.traces.some(row => row.includes(":query:"))).toBe(false);
  expect(fake.commitAck).not.toHaveBeenCalled();
  expect(fake.rollback).toHaveBeenCalledWith(ticket);
});
