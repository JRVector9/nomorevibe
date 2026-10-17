import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  scope: vi.fn(), transaction: vi.fn(), update: vi.fn(), role: vi.fn(),
  batch:vi.fn(), traces: [] as string[], heartbeat: undefined as Promise<unknown> | undefined,
}));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: fake.scope }));
vi.mock("@/lib/operations/dr/epoch", async original => ({ ...await original<typeof import("@/lib/operations/dr/epoch")>(), writerSiteActive: async () => true })); // PR15c: fence는 dr-fence-paths 테스트가 본다(이 fixture의 tx 순서 불변)
vi.mock("@/lib/db", () => ({ db: { transaction: fake.transaction, update: fake.update } }));
vi.mock("@/lib/jobs/role-leader", () => ({ assertRoleLease: fake.role, RoleLeaseLostError: class extends Error {} }));
vi.mock("@/lib/jobs/batch-repository",()=>({assertJobBatchAdmission:fake.batch,batchResultObservation:()=>null,JobBatchBlockedError:class extends Error{}}));
vi.mock("@/lib/observability/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
import { runJob } from "@/lib/jobs/runner";

beforeEach(() => {
  fake.scope.mockReturnValue({});
  fake.batch.mockResolvedValue(null);
  fake.transaction.mockImplementation(async (work: (tx: unknown) => Promise<unknown>) => {
    fake.traces.push("transaction");
    return work({
      insert: () => ({ values: () => ({ onConflictDoNothing: async () => {}, onConflictDoUpdate: async () => {} }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [{ cursor: null, requestedVersion: 1, name: "crawl-agent-review" }] }) }) }),
    });
  });
  fake.update.mockImplementation(() => ({ set: (values: Record<string, unknown>) => ({ where: () => {
    if (values.workerSeenAt) return { returning: () => { fake.traces.push("heartbeat"); return fake.heartbeat ?? Promise.resolve([{ name: "crawl-agent-review" }]); } };
    fake.traces.push("failure-write");
    return Promise.resolve([]);
  } }) }));
});
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks(); fake.traces.length = 0; fake.heartbeat = undefined; });

it.each(["crawl-fetch", "crawl-judge", "crawl-publish", "ranking-refresh", "unknown"])("rejects replay job %s before any claim", async name => {
  fake.transaction.mockRejectedValueOnce(new Error("claim_must_not_run"));
  await expect(runJob(name, async () => ({ done: true }))).rejects.toThrow("replay_job_not_allowed");
  expect(fake.transaction).not.toHaveBeenCalled();
});

it.each(["crawl-agent-review", "second-review"])("rejects role leadership on replay %s before claim", async name => {
  fake.transaction.mockRejectedValueOnce(new Error("claim_must_not_run"));
  await expect(runJob(name, async () => ({ done: true }), {
    roleLease: { role: "reviewer", token: "lease", holderId: "holder" } as never,
  })).rejects.toThrow("replay_role_lease_rejected");
  expect(fake.transaction).not.toHaveBeenCalled();
  expect(fake.role).not.toHaveBeenCalled();
});

it("checks replay restrictions even for an already stopped signal", async () => {
  const stopped = new AbortController(); stopped.abort();
  await expect(runJob("crawl-publish", async () => ({ done: true }), { signal: stopped.signal }))
    .rejects.toThrow("replay_job_not_allowed");
  expect(fake.transaction).not.toHaveBeenCalled();
});

it.each(["crawl-agent-review", "second-review"])("keeps the real claim and completion transactions for %s", async name => {
  const handler = vi.fn(async () => ({ done: true }));
  await expect(runJob(name, handler)).resolves.toMatchObject({ status: "completed", done: true });
  expect(handler).toHaveBeenCalledWith(expect.objectContaining({ lease: expect.objectContaining({ name, requestedVersion: 1 }), hasBudget: expect.any(Function) }));
  expect(fake.transaction).toHaveBeenCalledTimes(2);
});

it("does not change ordinary jobs outside a replay database scope", async () => {
  fake.scope.mockReturnValue(undefined);
  await expect(runJob("crawl-fetch", async () => ({ done: true }))).resolves.toMatchObject({ status: "completed" });
  expect(fake.transaction).toHaveBeenCalledTimes(2);
  expect(fake.batch).toHaveBeenCalledOnce();
});

it.each([false, true])("awaits an in-flight real heartbeat before finishing (handler throws=%s)", async failure => {
  vi.useFakeTimers();
  let releaseHeartbeat!: (rows: unknown[]) => void, releaseHandler!: () => void;
  fake.heartbeat = new Promise(resolve => { releaseHeartbeat = resolve; });
  const held = new Promise<void>(resolve => { releaseHandler = resolve; });
  const handler = vi.fn(async () => { await held; if (failure) throw new Error("handler_failed"); return { done: true }; });
  let finished = false;
  const run = runJob("crawl-agent-review", handler).finally(() => { finished = true; });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(fake.traces).toEqual(["transaction", "heartbeat"]);
  releaseHandler();
  await vi.advanceTimersByTimeAsync(45_000);
  expect(finished).toBe(false);
  expect(fake.traces).toEqual(["transaction", "heartbeat"]);
  releaseHeartbeat([{ name: "crawl-agent-review" }]);
  await expect(run).resolves.toMatchObject({ status: failure ? "failed" : "completed" });
  expect(vi.getTimerCount()).toBe(0);
  expect(fake.traces).toEqual(["transaction", "heartbeat", failure ? "failure-write" : "transaction"]);
});

it("does not fall back to claims when an inherited replay scope is stale", async () => {
  fake.scope.mockImplementation(() => { throw new Error("replay_database_scope_closed"); });
  await expect(runJob("crawl-agent-review", async () => ({ done: true }))).rejects.toThrow("replay_database_scope_closed");
  expect(fake.transaction).not.toHaveBeenCalled();
});
