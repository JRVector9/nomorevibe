import { expect, it, vi } from "vitest";
import { modelDispatchReleaseEvidenceSchema } from "@/lib/llm/capacity";
import { parsePromotionCliArgs } from "@/scripts/ops/dr/promotion";

// PR15b: batch 역할 관문 · 장부 회수 근거 모양 · 운영 CLI. 실제 DB 경로는 tests/integration/dr-followups.test.ts 가 본다.
const fence = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: fence.transaction }, onPrimary: <T>(load: () => T) => load() }));

const lineage = "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11", boot = "0a6bd6a3-6c2a-4f6e-9a39-2d6f7b0e5c21";
const fencedRow = { lineage_id: lineage, writer_epoch: 3, state: "fenced", reason: "operator_fence", promotion_id: null,
  fenced_db: { systemIdentifier: "7000000000000000001", databaseOid: "16384", databaseName: "nomorevibe" } };
const candidate = { role: "translation" as const, instanceId: "oracle-1", bootId: boot, release: "r1", kind: "primary" as const,
  batchVersion: 1 as const, host: "oracle-osaka-smoke" as const };

it("never acquires or renews a versioned batch role on a fenced writer site, and checks the fence before the batch lock", async () => {
  const sqlTexts: string[] = [];
  const tx = { execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
    sqlTexts.push(JSON.stringify(query.queryChunks ?? query)); return [fencedRow]; }),
    select: vi.fn(() => { throw new Error("batch_lock_before_fence"); }), insert: vi.fn(), update: vi.fn() };
  fence.transaction.mockImplementation((body: (value: unknown) => Promise<unknown>) => body(tx));
  const { acquireBatchRole, renewBatchRole } = await import("@/lib/jobs/batch-repository");
  expect(await acquireBatchRole(candidate)).toBeNull();
  expect(await renewBatchRole({ ...candidate, epoch: 4, batchEpoch: 2 })).toBe(false);
  expect(tx.execute).toHaveBeenCalledTimes(2);
  expect(tx.select).not.toHaveBeenCalled(); expect(tx.insert).not.toHaveBeenCalled(); expect(tx.update).not.toHaveBeenCalled();
  expect(sqlTexts.every(text => text.includes("dr_writer_fence") && text.includes("FOR SHARE"))).toBe(true);
});

it("fails closed when the writer fence row is missing (migration before code)", async () => {
  const tx = { execute: vi.fn(async () => []), select: vi.fn(() => { throw new Error("batch_lock_before_fence"); }) };
  fence.transaction.mockImplementation((body: (value: unknown) => Promise<unknown>) => body(tx));
  const { acquireBatchRole, renewBatchRole } = await import("@/lib/jobs/batch-repository");
  await expect(acquireBatchRole(candidate)).rejects.toThrow("dr_writer_fence_missing");
  await expect(renewBatchRole({ ...candidate, epoch: 4, batchEpoch: 2 })).rejects.toThrow("dr_writer_fence_missing");
  expect(tx.select).not.toHaveBeenCalled();
});

const at = (ms: number) => new Date(ms).toISOString(), T0 = Date.parse("2026-10-17T00:00:00.000Z");
const common = { version: 1, requestId: "3f0c8a52-91c4-4d1e-9a51-6b8f9d3c2e10", owner: { instanceId: "m3-reviewer", bootId: boot },
  fromState: "dispatched", bindingHash: null, operator: "root" };
const processExit = { ...common, kind: "process_group_exit", dispatchAt: at(T0), termination: "provider_bound", hardDeadlineMs: 60_000,
  skewBoundMs: 1_000, reference: "gateway hard timeout", exits: [{ seq: 1, runId: lineage, pid: 4242, exitedAt: at(T0 + 5_000) }],
  notBefore: at(T0 + 66_000), evaluatedAt: at(T0 + 66_000) };
const drain = { ...common, kind: "dr_call_drain", dispatchAt: null, promotionId: lineage, writerEpoch: 2, scope: "model:acct",
  notBefore: at(T0), evaluatedAt: at(T0 + 1) };

it("accepts only release evidence that is due, bound to a proven deadline and to one fixed kind", () => {
  expect(modelDispatchReleaseEvidenceSchema.safeParse(processExit).success).toBe(true);
  expect(modelDispatchReleaseEvidenceSchema.safeParse(drain).success).toBe(true);
  // 기한 전, 기한 없는 provider_bound, client_bound 에 기한, dispatch 시각 없는 프로세스 근거, 빈 종료 목록은 근거가 아니다.
  for (const change of [{ evaluatedAt: at(T0 + 65_999) }, { hardDeadlineMs: null }, { termination: "client_bound" }, { dispatchAt: null },
    { exits: [] }, { kind: "lease_expired" }, { fromState: "reserved" }, { extra: true }])
    expect(modelDispatchReleaseEvidenceSchema.safeParse({ ...processExit, ...change }).success).toBe(false);
  expect(modelDispatchReleaseEvidenceSchema.safeParse({ ...processExit, termination: "client_bound", hardDeadlineMs: null }).success).toBe(true);
  for (const change of [{ scope: "http" }, { writerEpoch: 0 }, { promotionId: "x" }, { evaluatedAt: at(T0 - 1) }])
    expect(modelDispatchReleaseEvidenceSchema.safeParse({ ...drain, ...change }).success).toBe(false);
});

it("parses the two release commands with stdin URL, explicit operator and dry-run by default", () => {
  const reclaim = parsePromotionCliArgs(["process-reclaim", "--instance=m3-reviewer", `--boot=${boot}`, "--deadline=acct:60000",
    "--client-bound=local", "--skew-ms=500", "--reference=gateway hard timeout", "--operator=root", "--database-url-stdin"]);
  expect(reclaim).toEqual({ command: "process-reclaim", apply: false, instanceId: "m3-reviewer", bootId: boot, operator: "root",
    policies: new Map([["acct", { termination: "provider_bound", hardDeadlineMs: 60_000, skewBoundMs: 500, reference: "gateway hard timeout" }],
      ["local", { termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 500, reference: "gateway hard timeout" }]]) });
  expect(() => parsePromotionCliArgs(["process-reclaim", "--instance=m3-reviewer", `--boot=${boot}`, "--operator=root", "--database-url-stdin"]))
    .toThrow("dr_cli_missing_reference");
  expect(parsePromotionCliArgs(["release-drained", `--promotion=${lineage}`, "--operator=root", "--apply", "--database-url-stdin"]))
    .toEqual({ command: "release-drained", apply: true, promotionId: lineage, operator: "root" });
  expect(() => parsePromotionCliArgs(["release-drained", `--promotion=${lineage}`, "--operator=root"])).toThrow("dr_cli_database_url_stdin_required");
  expect(() => parsePromotionCliArgs(["release-drained", `--promotion=${lineage}`, "--operator=root", "--ttl=1", "--database-url-stdin"]))
    .toThrow("dr_cli_unknown_option");
});
