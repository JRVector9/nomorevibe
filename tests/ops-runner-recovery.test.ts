import { beforeEach, expect, it, vi } from "vitest";
import { initialOpsState, opsCommandSchema, opsStepsFor, OPS_STEPS, type OpsState } from "@/lib/operations/ops-runner/contract";
import { runModelOpsRunner, type OpsDriver } from "@/lib/operations/ops-runner/runner";
const mocks = vi.hoisted(() => ({ release: vi.fn() }));
vi.mock("@/lib/operations/dr/reclaim", () => ({ releaseEvidencedDispatches: mocks.release }));
const command = { id: "ad2b84de-4ddf-4b2e-9dbd-605c64f7d728", action: "request-release" as const,
  targetId: "161d7780-5b1f-4ce8-be8d-baed927b28e8", reason: "시험 복구", confirmed: true as const };
let state: OpsState, events: OpsState[], driver: OpsDriver;
beforeEach(() => {
  state = initialOpsState(command, "admin"); events = [];
  driver = { save: vi.fn(async s => { events.push(structuredClone(s)); }), execute: vi.fn(async () => ({ ok: true })), reconcile: vi.fn(async () => ({ ok: true })) };
});
it("허용 목록 밖 동작·명령 주입·추가 필드·미확인을 거절한다", () => {
  for (const patch of [{ action: "shell" }, { targetId: "x;sudo reboot" }, { command: "ssh" }, { confirmed: false }])
    expect(opsCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false);
});
it("DRAIN → 종료 → 종료 근거 → 정식 해제 → 복원 → OPEN 순서와 모든 단계의 의도/결과를 기록한다", async () => {
  const result = await runModelOpsRunner({ state, driver });
  expect(result.status).toBe("completed");
  expect(vi.mocked(driver.execute).mock.calls.map(([step]) => step)).toEqual(OPS_STEPS);
  expect(events.filter(row => row.status === "running" && row.steps[row.step] === "running").map(row => row.step)).toEqual(OPS_STEPS);
  expect(events.at(-1)?.steps).toEqual(Object.fromEntries(OPS_STEPS.map(step => [step, "done"])));
});
it("종료 근거가 없으면 해제·복원·OPEN에 도달하지 않고 이유와 멈춘 위치를 보존한다", async () => {
  vi.mocked(driver.execute).mockImplementation(async step => step === "verify-stop" ? { ok: false, code: "termination_evidence_missing" } : { ok: true });
  const result = await runModelOpsRunner({ state, driver });
  expect(result).toMatchObject({ status: "blocked", step: "verify-stop", code: "termination_evidence_missing" });
  expect(vi.mocked(driver.execute).mock.calls.map(([step]) => step)).not.toContain("release");
});
it("sudo 단계는 사람이 장비에서 할 일로 기록하고 이후 단계를 실행하지 않는다", async () => {
  vi.mocked(driver.execute).mockResolvedValue({ ok: false, code: "human_on_device_sudo_stop_restore_required", manual: true });
  expect(await runModelOpsRunner({ state, driver })).toMatchObject({ status: "manual", step: "prepare" });
  expect(driver.execute).toHaveBeenCalledTimes(1);
});
it("중간 실패 후 같은 작업을 이어가며 완료한 해제는 다시 하지 않는다", async () => {
  let first = true;
  vi.mocked(driver.execute).mockImplementation(async step => { if (step === "verify-restored" && first) { first = false; return { ok: false }; } return { ok: true }; });
  const failed = await runModelOpsRunner({ state, driver });
  expect(failed.step).toBe("verify-restored");
  expect((await runModelOpsRunner({ state: failed, driver })).status).toBe("completed");
  expect(vi.mocked(driver.execute).mock.calls.filter(([step]) => step === "release")).toHaveLength(1);
});
it.each(["stop", "restore", "drain", "open"] as (typeof OPS_STEPS)[number][])("응답 미확인 %s는 읽기 재확인하고 변이를 재요청하지 않는다", async step => {
  state.steps = Object.fromEntries(OPS_STEPS.slice(0, OPS_STEPS.indexOf(step)).map(s => [s, "done"])); state.steps[step] = "running";
  vi.mocked(driver.reconcile).mockResolvedValue({ ok: false, code: "readback_unproven" });
  expect(await runModelOpsRunner({ state, driver })).toMatchObject({ status: "blocked", step });
  expect(driver.reconcile).toHaveBeenCalledWith(step, expect.anything()); expect(driver.execute).not.toHaveBeenCalled();
});
it("감사 기록 실패는 외부 작업 전에 멈춘다", async () => {
  vi.mocked(driver.save).mockRejectedValue(new Error("audit_failed"));
  await expect(runModelOpsRunner({ state, driver })).rejects.toThrow("audit_failed"); expect(driver.execute).not.toHaveBeenCalled();
});
it("모델 재시작은 해제를 건너뛰고 복원 확인 뒤에만 OPEN 한다", async () => {
  state.action = "model-restart";
  await runModelOpsRunner({ state, driver });
  expect(vi.mocked(driver.execute).mock.calls.map(([step]) => step)).toEqual(OPS_STEPS.filter(step => step !== "release"));
});
it("검토된 profile이 DRAIN 인계를 정하면 OPEN 대신 handoff로 끝나고 OPEN 변이를 부르지 않는다", async () => {
  state.finalAdmission = "draining";
  expect((await runModelOpsRunner({ state, driver })).status).toBe("completed");
  const steps = vi.mocked(driver.execute).mock.calls.map(([step]) => step);
  expect(steps).toEqual([...OPS_STEPS.slice(0, -1), "handoff"]); expect(steps).not.toContain("open");
  expect(events.at(-1)?.steps).toMatchObject({ "verify-restored": "done", handoff: "done" });
  expect(opsStepsFor({ action: "admission-open", finalAdmission: "draining" })).toEqual(["prepare", "open"]);
});
it("handoff 실패는 이어가기에서 다시 확인만 하며 다른 단계를 반복하지 않는다", async () => {
  state.finalAdmission = "draining";
  vi.mocked(driver.execute).mockImplementation(async step => step === "handoff" ? { ok: false, code: "handoff_drain_changed" } : { ok: true });
  const blocked = await runModelOpsRunner({ state, driver });
  expect(blocked).toMatchObject({ status: "blocked", step: "handoff", code: "handoff_drain_changed" });
  vi.mocked(driver.execute).mockClear(); vi.mocked(driver.execute).mockResolvedValue({ ok: true });
  expect((await runModelOpsRunner({ state: blocked, driver })).status).toBe("completed");
  expect(vi.mocked(driver.execute).mock.calls.map(([step]) => step)).toEqual(["handoff"]); expect(driver.reconcile).not.toHaveBeenCalled();
});
it("접수 버튼의 작업도 같은 실행기를 통과한다", async () => {
  state.action = "admission-pause";
  await runModelOpsRunner({ state, driver });
  expect(vi.mocked(driver.execute).mock.calls.map(([step]) => step)).toEqual(["prepare", "drain"]);
});
it("자동 회수도 같은 함수에서 기존 DB lock/종료 증거 판정과 선언 budget 경계를 보존한다", async () => {
  mocks.release.mockResolvedValue({ rows: [{ requestId: command.targetId, released: false, reason: "unproven" }] });
  const policies = new Map([["supa", { termination: "provider_bound" as const, hardDeadlineMs: 55000, skewBoundMs: 10000, reference: "actual enforcement" }]]), audit = vi.fn();
  const result = await runModelOpsRunner({ automatic: true, policies, operator: "auto-reclaim:worker", audit });
  expect(mocks.release).toHaveBeenCalledWith({ policies, operator: "auto-reclaim:worker", onlyDeclaredBudgets: true }, true);
  expect(result.rows[0].released).toBe(false); expect(audit).toHaveBeenCalledTimes(2);
});

it("취소된 작업은 실행기가 다시 잡아도 한 단계도 돌리지 않는다(2026-11-07 시작 전 취소)", async () => {
  const cancelled: OpsState = { ...state, status: "cancelled", code: "operator_cancelled", cancelledBy: "jr", cancelReason: "시험" };
  expect(await runModelOpsRunner({ state: cancelled, driver })).toEqual(cancelled);
  expect(driver.save).not.toHaveBeenCalled(); expect(driver.execute).not.toHaveBeenCalled();
});
