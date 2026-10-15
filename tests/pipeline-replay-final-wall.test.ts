import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";

// The native driver and authenticated hooks are boundaries here; the real
// guarded transaction is responsible for ordering and rollback/ack behavior.
const fake = vi.hoisted(() => ({
  open: vi.fn(), verify: vi.fn(), assert: vi.fn(), hooks: vi.fn(),
  before: vi.fn(), after: vi.fn(), finalWall: vi.fn(), commitAck: vi.fn(), rollback: vi.fn(),
  traces: [] as string[], commitError: undefined as Error | undefined,
}));
vi.mock("@/lib/operations/pipeline-replay-execution", () => ({ currentReplayTransactionHooks: fake.hooks }));
vi.mock("@/lib/operations/pipeline-replay-database", () => ({
  openVerifiedReplayHandlerDatabase: fake.open,
  assertVerifiedReplayHandlerDatabase: fake.assert,
  assertSameReplayHandlerDatabase: vi.fn(),
  verifyReplayDatabaseSession: fake.verify,
}));
import { db } from "@/lib/db";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";

const ticket = Object.freeze({ boundary: "final-wall" });
function database() {
  const raw = {
    unsafe: vi.fn(() => {
      fake.traces.push("query");
      return Object.assign(Promise.resolve([{ value: 1 }]), { values: async () => [[1]] });
    }),
    savepoint: vi.fn(),
  };
  return {
    client: {
      options: { parsers: {}, serializers: {} },
      begin: async (work: (tx: unknown) => Promise<unknown>) => {
        fake.traces.push("begin");
        try {
          const result = await work(raw);
          if (fake.commitError) throw fake.commitError;
          fake.traces.push("commit");
          return result;
        } catch (error) { fake.traces.push("rollback"); throw error; }
      },
    },
    close: async () => { fake.traces.push("close"); },
  };
}
beforeEach(() => {
  fake.open.mockImplementation(async () => database());
  fake.assert.mockImplementation(() => {});
  fake.verify.mockImplementation(async () => { fake.traces.push("verify"); });
  fake.before.mockImplementation(async () => { fake.traces.push("before"); return ticket; });
  fake.after.mockImplementation(async () => { fake.traces.push("flush"); });
  fake.finalWall.mockImplementation(async () => { fake.traces.push("final-wall"); });
  fake.commitAck.mockImplementation(async () => { fake.traces.push("ack"); });
  fake.hooks.mockReturnValue({ before: fake.before, after: fake.after, finalWall: fake.finalWall,
    commitAck: fake.commitAck, rollback: fake.rollback });
});
afterEach(() => {
  vi.resetAllMocks(); fake.traces.length = 0; fake.commitError = undefined;
});
const write = () => withReplayDatabaseScope("final-wall-unit", () => db.transaction(async tx => {
  await tx.execute(sql`select 1`);
}));

it("checks final authority after flush and the session verifier, then commits without another asynchronous verifier", async () => {
  await write();
  expect(fake.traces).toEqual(["begin", "verify", "before", "query", "flush", "verify", "final-wall", "commit", "ack", "close"]);
  expect(fake.finalWall).toHaveBeenCalledWith(expect.any(Object), ticket);
});

it("rolls the native transaction back without acknowledgment when post-flush authority expires", async () => {
  fake.finalWall.mockImplementation(async () => { fake.traces.push("final-wall"); throw new Error("job_lease_lost"); });
  await expect(write()).rejects.toThrow("job_lease_lost");
  expect(fake.traces).toEqual(["begin", "verify", "before", "query", "flush", "verify", "final-wall", "rollback", "close"]);
  expect(fake.rollback).toHaveBeenCalledWith(ticket);
  expect(fake.commitAck).not.toHaveBeenCalled();
});

it("does not finalize or acknowledge when flush or the final session verification fails", async () => {
  fake.after.mockRejectedValueOnce(new Error("flush_failed"));
  await expect(write()).rejects.toThrow("flush_failed");
  expect(fake.finalWall).not.toHaveBeenCalled();
  expect(fake.commitAck).not.toHaveBeenCalled();
  expect(fake.rollback).toHaveBeenCalledWith(ticket);

  fake.verify.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("session_drift"));
  await expect(write()).rejects.toThrow("session_drift");
  expect(fake.finalWall).not.toHaveBeenCalled();
  expect(fake.commitAck).not.toHaveBeenCalled();
  expect(fake.rollback).toHaveBeenCalledTimes(2);
});

it("does not confirm a failed native COMMIT", async () => {
  fake.commitError = new Error("native_commit_failed");
  await expect(write()).rejects.toThrow("native_commit_failed");
  expect(fake.traces).toContain("rollback");
  expect(fake.traces).not.toContain("commit");
  expect(fake.rollback).toHaveBeenCalledWith(ticket);
  expect(fake.commitAck).not.toHaveBeenCalled();
});

it("retains an unacknowledged native commit without running rollback cleanup", async () => {
  fake.commitAck.mockRejectedValueOnce(new Error("confirmation_failed"));
  await expect(write()).rejects.toThrow("confirmation_failed");
  expect(fake.traces).toContain("commit");
  expect(fake.traces).not.toContain("rollback");
  expect(fake.rollback).not.toHaveBeenCalled();
});

it("does not require final job authority for an ordinary transaction with no certified ticket", async () => {
  fake.before.mockResolvedValueOnce(undefined);
  await expect(write()).resolves.toBeUndefined();
  expect(fake.after).not.toHaveBeenCalled();
  expect(fake.finalWall).not.toHaveBeenCalled();
  expect(fake.commitAck).not.toHaveBeenCalled();
  expect(fake.traces).toEqual(["begin", "verify", "query", "verify", "commit", "close"]);
});
