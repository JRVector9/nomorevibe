import { beforeEach, expect, it, vi } from "vitest";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";

// PR15c: 남은 쓰기 경로(runJob claim, requestDueJobs, source claim, 모델 장부 control)가 DR writer fence 를 첫 lock 으로 잡는지.
// 실제 DB 의 쓰기 0·교착 없음은 tests/integration/dr-fence-paths.test.ts 가 본다.
const fake = vi.hoisted(() => ({ transaction: vi.fn(), replay: vi.fn((): unknown => undefined) }));
vi.mock("@/lib/db", () => ({ db: { transaction: fake.transaction }, onPrimary: <T>(load: () => T) => load() }));
vi.mock("@/lib/db/replay-scope", () => ({ currentReplayDb: fake.replay }));

const lineage = "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11", boot = "0a6bd6a3-6c2a-4f6e-9a39-2d6f7b0e5c21";
const activeRow = { lineage_id: lineage, writer_epoch: 1, state: "active", reason: null, fenced_db: null, promotion_id: null };
const fencedRow = { lineage_id: lineage, writer_epoch: 1, state: "fenced", reason: "operator_fence", promotion_id: null,
  fenced_db: { systemIdentifier: "7000000000000000001", databaseOid: "16384", databaseName: "nomorevibe" } };
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { engine: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: "pr15c-route", provider: "fixture", model: "m", providerBudgetId: "account", groupId: "engine" }] };
const control = (patch: Record<string, unknown> = {}) => ({ id: 1, mode: "open", epoch: 1, revision: 1, policy, policyHash: modelCapacityPolicyHash(policy),
  cursor: 0, updatedAt: new Date(), ...patch });

/** 모든 SQL 접근을 순서대로 적는다. fence 는 execute(dr_writer_fence … FOR SHARE), 나머지 lock 은 select…for(), 쓰기는 insert/update 다. */
function fakeTx(fence: unknown[], rows: Record<string, unknown[]> = {}) {
  const calls: string[] = [];
  const text = (query: { queryChunks?: unknown[] }) => JSON.stringify(query.queryChunks ?? query);
  const tx = {
    execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
      const value = text(query);
      calls.push(value.includes("dr_writer_fence") && value.includes("FOR SHARE") ? "fence" : "execute");
      return value.includes("dr_writer_fence") ? fence : [];
    }),
    select: vi.fn(() => ({ from: (table: object) => {
      const name = String(Reflect.get(table, Symbol.for("drizzle:Name")));
      if (!(name in rows)) { calls.push(`lock:${name}`); throw new Error(`${name}_after_fence`); }
      type Chain = { where: () => Chain; orderBy: () => Chain; limit: () => Promise<unknown[]>; for: (lock: string) => Promise<unknown[]>;
        then: (resolve: (value: unknown[]) => unknown) => unknown };
      const chain: Chain = { where: () => chain, orderBy: () => { calls.push(`order:${name}`); return chain; },
        limit: async () => { calls.push(`read:${name}`); return rows[name]; },
        for: async lock => { calls.push(`${lock}:${name}`); return rows[name]; },
        then: resolve => { calls.push(`read:${name}`); return resolve(rows[name]); } };
      return chain;
    } })),
    insert: vi.fn(() => { calls.push("insert"); throw new Error("insert_after_fence"); }),
    update: vi.fn(() => { calls.push("update"); throw new Error("update_after_fence"); }),
  };
  fake.transaction.mockImplementation((body: (value: unknown) => Promise<unknown>) => body(tx));
  return { tx, calls };
}

beforeEach(() => { vi.clearAllMocks(); fake.replay.mockReturnValue(undefined); });

it("runJob: a fenced site claims nothing — the fence is the claim TX's first lock, before batch/role/job rows", async () => {
  const { runJob } = await import("@/lib/jobs/runner");
  const handler = vi.fn(async () => ({ done: true }));
  let probe = fakeTx([fencedRow]);
  expect(await runJob("crawl-fetch", handler)).toEqual({ status: "skipped", reason: "stopping" });
  expect(probe.calls).toEqual(["fence"]);
  expect(handler).not.toHaveBeenCalled();
  // active: fence 다음에야 기존 batch SHARE 가 온다(기존 순서는 그대로).
  probe = fakeTx([activeRow]);
  await expect(runJob("crawl-fetch", handler)).rejects.toThrow("job_batch_control_after_fence");
  expect(probe.calls).toEqual(["fence", "lock:job_batch_control"]);
  // 0095 이전(행 없음)은 fail-closed: 아무것도 잠그거나 쓰지 않고 오류다.
  probe = fakeTx([]);
  await expect(runJob("crawl-fetch", handler)).rejects.toThrow("dr_writer_fence_missing");
  expect(probe.calls).toEqual(["fence"]);
});

it("runJob: a verified replay scope keeps its fixed profile (no fence, like the skipped batch admission)", async () => {
  const { runJob } = await import("@/lib/jobs/runner");
  fake.replay.mockReturnValue({});
  const probe = fakeTx([fencedRow]);
  await expect(runJob("second-review", async () => ({ done: true }))).rejects.toThrow("insert_after_fence");
  expect(probe.calls).toEqual(["insert"]);
});

it("requestDueJobs: a fenced scheduler requests nothing; otherwise the fence precedes the batch SHARE", async () => {
  const { requestDueJobs } = await import("@/lib/jobs/control");
  let probe = fakeTx([fencedRow]);
  expect(await requestDueJobs()).toBe(0);
  expect(probe.calls).toEqual(["fence"]);
  probe = fakeTx([activeRow]);
  await expect(requestDueJobs()).rejects.toThrow("job_batch_control_after_fence");
  expect(probe.calls).toEqual(["fence", "lock:job_batch_control"]);
  probe = fakeTx([]);
  await expect(requestDueJobs()).rejects.toThrow("dr_writer_fence_missing");
  expect(probe.calls).toEqual(["fence"]);
});

it("source claim: a fenced site hands out no canonical source (typed admission refusal), fence before the batch SHARE", async () => {
  const { claimCanonicalEvidenceSource } = await import("@/lib/domain/evidence/source-claims");
  const { JobBatchBlockedError } = await import("@/lib/jobs/batch-repository");
  const owner = { instanceId: "pr15c-site", bootId: boot };
  let probe = fakeTx([fencedRow]);
  await expect(claimCanonicalEvidenceSource({ owner })).rejects.toBeInstanceOf(JobBatchBlockedError);
  expect(probe.calls).toEqual(["fence"]);
  probe = fakeTx([activeRow]);
  await expect(claimCanonicalEvidenceSource({ owner })).rejects.toThrow("job_batch_control_after_fence");
  expect(probe.calls).toEqual(["fence", "lock:job_batch_control"]);
});

it("model ledger: the fence precedes the control lock and a fenced site is draining, never the disabled (uncapped) transport", async () => {
  const ledger = await import("@/lib/llm/capacity-repository");
  for (const raw of [control(), control({ mode: "disabled", policy: null, policyHash: null })]) {
    const probe = fakeTx([fencedRow], { model_capacity_control: [raw] });
    expect(await ledger.readModelCapacityCallerControl()).toMatchObject({ mode: "draining", epoch: 1, revision: 1 });
    expect(probe.calls).toEqual(["fence", "share:model_capacity_control"]);
  }
  const active = fakeTx([activeRow], { model_capacity_control: [control({ mode: "disabled", policy: null, policyHash: null })] });
  expect(await ledger.readModelCapacityCallerControl()).toMatchObject({ mode: "disabled" });
  expect(active.calls).toEqual(["fence", "share:model_capacity_control"]);
});

it("model ledger: fenced admission returns the existing refusals before any expiry, row lock or write", async () => {
  const ledger = await import("@/lib/llm/capacity-repository");
  const owner = { instanceId: "pr15c-model", bootId: boot };
  const request = { requestId: "3f0c8a52-91c4-4d1e-9a51-6b8f9d3c2e10", workKey: "pr15c:work", owner, class: "background" as const,
    pool: "text" as const, routeId: "pr15c-unmapped", provider: "fixture", model: "m" };
  const handle = { requestId: request.requestId, owner, token: lineage, epoch: 1, revision: 1, policyHash: modelCapacityPolicyHash(policy) };
  const empty = { model_capacity_control: [control()], model_capacity_requests: [] };
  let probe = fakeTx([fencedRow], empty);
  expect(await ledger.requestModelSlot(request)).toEqual({ kind: "deferred", reason: "draining" });
  expect(probe.calls).toEqual(["fence", "update:model_capacity_control"]);
  probe = fakeTx([fencedRow], empty);
  expect(await ledger.beginModelDispatch(handle as never)).toEqual({ kind: "ownership_lost" });
  expect(probe.calls).toEqual(["fence", "update:model_capacity_control"]);
  // active open: 기존 경로 그대로 요청 행을 읽고 판정한다(이 route 는 policy 에 없어 unmapped).
  probe = fakeTx([activeRow], empty);
  expect(await ledger.requestModelSlot(request)).toEqual({ kind: "deferred", reason: "unmapped" });
  expect(probe.calls.slice(0, 3)).toEqual(["fence", "update:model_capacity_control", "read:model_capacity_requests"]);
  expect(probe.calls).not.toContain("insert"); expect(probe.calls).not.toContain("update");
  probe = fakeTx([], empty);
  await expect(ledger.requestModelSlot(request)).rejects.toThrow("dr_writer_fence_missing");
  expect(probe.calls).toEqual(["fence"]);
});

it("model ledger: on a fenced site an owner may still settle its own row, but nobody else's rows are expired", async () => {
  const ledger = await import("@/lib/llm/capacity-repository");
  const handle = { requestId: "3f0c8a52-91c4-4d1e-9a51-6b8f9d3c2e10", owner: { instanceId: "pr15c-model", bootId: boot }, token: lineage,
    epoch: 1, revision: 1, policyHash: modelCapacityPolicyHash(policy) };
  const empty = { model_capacity_control: [control()], model_capacity_requests: [] };
  let probe = fakeTx([fencedRow], empty);
  expect(await ledger.cancelReservedModelSlot(handle as never)).toBe(false);
  expect(probe.calls).toEqual(["fence", "update:model_capacity_control", "update:model_capacity_requests"]);
  // active: 기존대로 만료 정리(queue 순서 lock)가 owner 행 lock 보다 먼저다.
  probe = fakeTx([activeRow], empty);
  expect(await ledger.cancelReservedModelSlot(handle as never)).toBe(false);
  expect(probe.calls).toEqual(["fence", "update:model_capacity_control", "order:model_capacity_requests", "update:model_capacity_requests",
    "update:model_capacity_requests"]);
});
