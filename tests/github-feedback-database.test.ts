import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), assertLease: vi.fn(), execute: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction }, onPrimary: (work: () => Promise<unknown>) => work() }));
vi.mock("@/lib/db/pool", () => ({ dbPoolConfig: () => ({ connectSeconds: 1 }), withDbDeadline: (_deadline: number, work: () => Promise<unknown>) => work() }));
vi.mock("@/lib/jobs/control", () => ({ assertJobLease: mocks.assertLease,
  withJobLeaseWrite: (lease: unknown, write: (tx: unknown) => Promise<unknown>) => mocks.transaction(async (tx: unknown) => {
    const result = await write(tx);
    if (lease) await mocks.assertLease(tx, lease);
    return result;
  }) }));

describe("feedback deadline transaction commit fence", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.execute.mockResolvedValue([{}, {}]); });

  it("awaits a late lease assertion and rolls back instead of committing after its deadline", async () => {
    const { feedbackDatabaseWrite } = await import("@/lib/domain/feedback/github/database");
    let now = Date.now();
    const deadlineAt = now + 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const lifecycle: string[] = [];
    const tx = { execute: mocks.execute };
    mocks.transaction.mockImplementation(async (write: (transaction: unknown) => Promise<unknown>) => {
      lifecycle.push("begin");
      try { const value = await write(tx); lifecycle.push("commit"); return value; }
      catch (error) { lifecycle.push("rollback"); throw error; }
    });
    mocks.assertLease.mockImplementation(async () => {
      await Promise.resolve();
      now = deadlineAt + 1;
      lifecycle.push("lease-returned");
    });
    try {
      await expect(feedbackDatabaseWrite({ name: "github-feedback-delivery", token: "lease", requestedVersion: 1 }, async () => {
        now = deadlineAt - 200;
        lifecycle.push("write");
      }, deadlineAt)).rejects.toThrow("feedback_database_deadline");
      expect(lifecycle).toEqual(["begin", "write", "lease-returned", "rollback"]);
      expect(mocks.assertLease).toHaveBeenCalledOnce();
    } finally { clock.mockRestore(); }
  });
});
