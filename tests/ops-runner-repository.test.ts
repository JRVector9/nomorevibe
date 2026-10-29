import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ execute: vi.fn(), insert: vi.fn(), values: vi.fn(), audit: vi.fn(), fence: vi.fn(), readFence: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute: mocks.execute, transaction: (fn: (tx: unknown) => unknown) => fn({ execute: mocks.execute, insert: mocks.insert }) }, onPrimary: (fn: () => unknown) => fn() }));
vi.mock("@/lib/operations/admin-log", () => ({ adminAuditRow: mocks.audit }));
vi.mock("@/lib/operations/dr/epoch", () => ({ writerSiteActive: mocks.fence, readWriterFence: mocks.readFence }));
import { submitModelOpsCommand, saveModelOpsState } from "@/lib/operations/ops-runner/repository";
import { initialOpsState } from "@/lib/operations/ops-runner/contract";
const command = { id: "ad2b84de-4ddf-4b2e-9dbd-605c64f7d728", action: "request-release" as const,
  targetId: "161d7780-5b1f-4ce8-be8d-baed927b28e8", reason: "test", confirmed: true as const };
beforeEach(() => {
  vi.resetAllMocks(); mocks.fence.mockResolvedValue(true); mocks.readFence.mockResolvedValue({ state: "active" }); mocks.insert.mockReturnValue({ values: mocks.values }); mocks.audit.mockImplementation(async (_actor, entry) => entry);
});
it("접수와 단계별 결과를 기존 append-only 감사 장부에 남긴다", async () => {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ request_id: command.targetId }]);
  const state = await submitModelOpsCommand(command, "admin");
  expect(state.status).toBe("queued");
  expect(mocks.audit).toHaveBeenCalledWith("admin", expect.objectContaining({ action: "ops-runner-state", target: command.id }));
  await saveModelOpsState({ ...state, step: "verify-stop", status: "blocked", code: "termination_evidence_missing" });
  expect(mocks.audit).toHaveBeenLastCalledWith("admin", expect.objectContaining({ ok: false, error: "termination_evidence_missing" }));
});
it("같은 접수 응답이 유실돼도 같은 ID를 다시 제출하면 중복 작업을 만들지 않는다", async () => {
  const existing = initialOpsState(command, "admin");
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ detail: existing }]);
  expect(await submitModelOpsCommand(command, "admin")).toEqual(existing); expect(mocks.insert).not.toHaveBeenCalled();
});
it("미완료 작업이 있으면 다른 작업과 OPEN을 직렬화하여 거절한다", async () => {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ detail: initialOpsState(command, "admin") }]);
  await expect(submitModelOpsCommand({ ...command, id: "bd2b84de-4ddf-4b2e-9dbd-605c64f7d728", action: "admission-open", targetId: "model-capacity" }, "admin"))
    .rejects.toThrow("unfinished_operation");
  expect(mocks.insert).not.toHaveBeenCalled();
});
it("fenced DB에서는 접수·감사 쓰기를 하지 않는다", async () => {
  mocks.fence.mockResolvedValue(false);
  await expect(submitModelOpsCommand(command, "admin")).rejects.toThrow("dr_writer_site_fenced"); expect(mocks.insert).not.toHaveBeenCalled();
});
it("같은 ID를 다른 대상에 재사용하거나 이미 끝난 요청을 새 해제 대상으로 접수하지 않는다", async () => {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ detail: initialOpsState(command, "admin") }]);
  await expect(submitModelOpsCommand({ ...command, reason: "other" }, "admin")).rejects.toThrow("id_conflict");
  mocks.execute.mockResolvedValue([]);
  await expect(submitModelOpsCommand(command, "admin")).rejects.toThrow("request_not_indeterminate");
});
it("DRAIN 전 수동 단계는 다른 모델의 복구를 영구 차단하지 않는다", async () => {
  const manual = { ...initialOpsState(command, "admin"), status: "manual", step: "prepare" };
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ detail: manual }]).mockResolvedValueOnce([{ request_id: command.targetId }]);
  expect(await submitModelOpsCommand({ ...command, id: "bd2b84de-4ddf-4b2e-9dbd-605c64f7d728" }, "admin")).toMatchObject({ status: "queued" });
});
it("진행 조회의 감사 번호는 detail 내부 값 대신 실제 행 id를 사용한다", async () => {
  const { readModelOpsState, readModelOpsStates } = await import("@/lib/operations/ops-runner/repository");
  const detail = { ...initialOpsState(command, "admin"), auditId: 1 };
  mocks.execute.mockResolvedValue([{ id: 20940, detail }]);
  expect(await readModelOpsState(command.id)).toMatchObject({ auditId: 20940 });
  expect(await readModelOpsStates()).toMatchObject([{ auditId: 20940 }]);
});
it("운영자 셸 접수는 웹과 같은 잠금·검사·감사 행을 쓰고 웹 로그인 방식을 주장하지 않는다", async () => {
  mocks.audit.mockImplementation(async (_actor, entry) => ({ ...entry, actorKind: "github" }));
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ request_id: command.targetId }]);
  expect(await submitModelOpsCommand(command, "jr", "cli")).toMatchObject({ status: "queued", actor: "jr" });
  expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({ action: "ops-runner-state", target: command.id, actorKind: null }));
});
it("운영자 셸 미리 보기는 READ ONLY로 같은 거절 사유를 보이고 쓰지 않는다", async () => {
  const { previewModelOpsCommand } = await import("@/lib/operations/ops-runner/repository");
  const transaction = vi.fn(async (fn: (tx: unknown) => unknown, config?: unknown) => { expect(config).toEqual({ accessMode: "read only" }); return fn({ execute: mocks.execute, insert: mocks.insert }); });
  const { db } = await import("@/lib/db"); const original = db.transaction; (db as { transaction: unknown }).transaction = transaction;
  try {
    mocks.execute.mockResolvedValueOnce([{ detail: initialOpsState({ ...command, id: "bd2b84de-4ddf-4b2e-9dbd-605c64f7d728" }, "jr") }])
      .mockResolvedValueOnce([{ state: "indeterminate", routeId: "crawl-agent-review", groupId: "supa", providerBudgetId: "supa", ownerInstanceId: "reviewer-m3" }]);
    expect(await previewModelOpsCommand(command, "jr")).toMatchObject({ blocked: ["ops_runner_unfinished_operation"], existing: null, request: { groupId: "supa" } });
    mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ state: "withdrawn", routeId: "r", groupId: "g", providerBudgetId: "b", ownerInstanceId: null }]);
    expect((await previewModelOpsCommand(command, "jr")).blocked).toEqual(["ops_runner_request_not_indeterminate"]);
    mocks.execute.mockResolvedValueOnce([{ detail: initialOpsState(command, "jr") }]).mockResolvedValueOnce([{ state: "indeterminate" }]);
    expect(await previewModelOpsCommand(command, "jr")).toMatchObject({ blocked: [], existing: { id: command.id } });
    mocks.execute.mockResolvedValueOnce([{ detail: initialOpsState(command, "jr") }]).mockResolvedValueOnce([{ state: "indeterminate" }]);
    expect((await previewModelOpsCommand(command, "other")).blocked).toEqual(["ops_runner_id_conflict"]);
    // READ ONLY TX에서는 FOR SHARE 잠금(writerSiteActive)을 쓸 수 없다(25006). 잠그지 않는 fence 읽기만 쓴다.
    mocks.readFence.mockResolvedValueOnce({ state: "fenced" });
    mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([{ state: "indeterminate" }]);
    expect((await previewModelOpsCommand(command, "jr")).blocked).toEqual(["dr_writer_site_fenced"]);
    expect(mocks.fence).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(5); expect(mocks.insert).not.toHaveBeenCalled();
  } finally { (db as { transaction: unknown }).transaction = original; }
});
