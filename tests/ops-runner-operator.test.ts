import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, lstatSync, rmSync } from "node:fs";
import { join } from "node:path";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), save: vi.fn(), capacity: vi.fn(), admission: vi.fn(), quiet: vi.fn(), request: vi.fn(), release: vi.fn(), files: vi.fn(), handoff: vi.fn() }));
// The managed test namespace maps immutable / and /home to overflow uid 65534.
// Model a private installation instead of the group-writable worktree; production trust checks remain unchanged.
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: (path: string) => {
    const info = fs.lstatSync(path);
    return path === "/" || path === "/home" || path === process.cwd() ? new Proxy(info, {
      get: (object, key) => key === "uid" ? (path === process.cwd() ? process.getuid?.() : 0)
        : key === "mode" ? info.mode & ~0o022 : Reflect.get(object, key),
    }) : info;
  } };
});
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("@/lib/operations/ops-runner/repository", () => ({ saveModelOpsState: mocks.save }));
vi.mock("@/lib/operations/ops-runner/control", () => ({ capacityPin: mocks.capacity, controlOpsAdmission: mocks.admission, assertOpsQuiescent: mocks.quiet,
  readOpsRequest: mocks.request, handOffOpsDrain: mocks.handoff }));
vi.mock("@/lib/operations/dr/provider-boundary-release", () => ({ releaseProviderBoundaryRequest: mocks.release }));
vi.mock("@/scripts/ops/model-provider-boundary-release", () => ({ readBoundaryReleaseFiles: mocks.files }));
import { runPreparedModelOps, readOperatorProfile, callOpsAdapter, opsRootHandoffPath } from "@/lib/operations/ops-runner/operator";
import { initialOpsState } from "@/lib/operations/ops-runner/contract";
import { boundaryFixture } from "./fixtures/provider-boundary-release";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
let dir: string, profileFile: string, profile: Record<string, unknown>, phaseOutputs: Record<string, unknown>;
const fixture = boundaryFixture();
const state = () => initialOpsState({ id: "ad2b84de-4ddf-4b2e-9dbd-605c64f7d728", action: "request-release", targetId: fixture.plan.request.requestId,
  confirmed: true, reason: "synthetic local test" }, "admin");
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-24T18:13:00.000Z"));
  // Tiny private fixtures; no device/network/DB activity. All new paths are owned by this test.
  dir = mkdtempSync(join(process.cwd(), ".ops-runner-test-"));
  const adapter = join(dir, "adapter.py"); writeFileSync(adapter, "# synthetic adapter\n", { mode: 0o600 });
  profileFile = join(dir, "profile.json");
  profile = { version: 1, jobId: state().id, action: "request-release", targetId: state().targetId, requiresSudo: false,
    adapter: { path: adapter, sha256: sha("# synthetic adapter\n") }, artifactDirectory: dir };
  writeFileSync(profileFile, JSON.stringify(profile), { mode: 0o600 });
  const planPath = join(dir, "plan.json"), receiptPath = join(dir, "receipt.json");
  writeFileSync(planPath, JSON.stringify(fixture.plan), { mode: 0o600 }); writeFileSync(receiptPath, JSON.stringify(fixture.receipt), { mode: 0o600 });
  phaseOutputs = { plan: { ok: true, plan: fixture.plan }, prepare: { ok: true, configurationHash: "a".repeat(64) }, stop: { ok: false, code: "exit_fact_missing_launchdUnloaded" },
    "verify-stop": { ok: true, ...fixture, hash: undefined, releaseFiles: { plan: planPath, planSha: sha(JSON.stringify(fixture.plan)), receipt: receiptPath } },
    restore: { ok: true }, "verify-restored": { ok: true, configurationHash: "a".repeat(64) } };
  mocks.exec.mockImplementation((_exe, args, _options, callback) => {
    callback(null, JSON.stringify(phaseOutputs[args[2]] ?? { ok: false }), ""); return { stdin: { end: vi.fn() } };
  });
  let pin = { ...fixture.plan.control, mode: "open" };
  mocks.capacity.mockImplementation(async () => pin);
  mocks.admission.mockImplementation(async (_state, to) => { pin = { ...fixture.plan.control, mode: to }; return { ok: true }; });
  mocks.request.mockResolvedValue(fixture.plan.request);
  mocks.files.mockReturnValue({ plan: fixture.plan, receipt: fixture.receipt, operator: "admin", reference: "test", expectedPlanHash: fixture.receipt.planHash });
  mocks.release.mockResolvedValue({ kind: "released" });
});
afterEach(() => { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); });
it("native bootout의 failed verify-stop을 native verify로 재확인하고 근거 확인 뒤에만 canonical release 한다", async () => {
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true);
  const result = await runPreparedModelOps(prepared, profileFile, dir, false);
  expect(result.status).toBe("completed"); expect(mocks.release).toHaveBeenCalledTimes(1);
  const phases = mocks.exec.mock.calls.map(call => call[1][2]);
  expect(phases).toEqual(["prepare", "plan", "stop", "verify-stop", "verify-stop", "restore", "verify-restored"]);
  expect(mocks.exec.mock.calls.every(call => call[0] === "/usr/bin/python3" && call[2].shell === undefined)).toBe(true);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
});
it("native verify 재확인 실패는 stop에서 멈추며 해제하지 않는다", async () => {
  phaseOutputs["verify-stop"] = { ok: false, code: "exit_unproven" };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true);
  expect(await runPreparedModelOps(prepared, profileFile, dir, false)).toMatchObject({ status: "blocked", step: "stop" });
  expect(mocks.release).not.toHaveBeenCalled();
});
it("명시한 sudo 단계는 Python·SSH·DRAIN 전에 사람 작업으로 표시한다", async () => {
  profile.requiresSudo = true; writeFileSync(profileFile, JSON.stringify(profile));
  expect(await runPreparedModelOps(state(), profileFile, dir, true)).toMatchObject({ status: "manual", code: "human_on_device_sudo_stop_restore_required" });
  expect(mocks.exec).not.toHaveBeenCalled(); expect(mocks.admission).not.toHaveBeenCalled();
});
it("종료 근거가 없으면 canonical release를 호출하지 않는다", async () => {
  phaseOutputs.stop = { ok: true }; phaseOutputs["verify-stop"] = { ok: false };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true);
  expect(await runPreparedModelOps(prepared, profileFile, dir, false)).toMatchObject({ step: "verify-stop", code: "termination_evidence_missing" });
  expect(mocks.release).not.toHaveBeenCalled();
});
it("원래 설정 복원 실패는 OPEN을 막는다", async () => {
  phaseOutputs.stop = { ok: true }; phaseOutputs["verify-restored"] = { ok: true, configurationHash: "b".repeat(64) };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true);
  expect(await runPreparedModelOps(prepared, profileFile, dir, false)).toMatchObject({ step: "verify-restored", status: "blocked" });
  expect(mocks.admission.mock.calls.map(call => call[1])).toEqual(["draining"]);
});
it("검토 후 바뀐 어댑터·다른 대상·성공 JSON과 모순되는 실패 종료 코드를 거절한다", async () => {
  const reviewed = readOperatorProfile(profileFile, state()).profile;
  mocks.exec.mockImplementation((_exe, _args, _options, callback) => {
    callback(Object.assign(new Error("synthetic_exit_failure"), { code: 1 }), JSON.stringify({ ok: true }), ""); return { stdin: { end: vi.fn() } };
  });
  await expect(callOpsAdapter(reviewed, "prepare", state(), {})).rejects.toThrow("adapter_outcome_unknown");
  expect(() => readOperatorProfile(profileFile, { ...state(), targetId: "11111111-1111-4111-8111-111111111111" })).toThrow("profile_target_mismatch");
  writeFileSync((profile.adapter as { path: string }).path, "changed"); expect(() => readOperatorProfile(profileFile, state())).toThrow("adapter_not_reviewed");
});
it("해제 커밋 뒤 응답 유실은 기존 영수증으로 확정하고 새 종료/복원을 중복 요청하지 않는다", async () => {
  mocks.release.mockRejectedValueOnce(new Error("connection_lost_after_commit")).mockResolvedValue({ kind: "already_released" });
  mocks.request.mockResolvedValueOnce(fixture.plan.request).mockRejectedValueOnce(new Error("request_now_withdrawn"));
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true);
  const failed = await runPreparedModelOps(prepared, profileFile, dir, false);
  expect(failed).toMatchObject({ status: "blocked", step: "release" });
  expect((await runPreparedModelOps(failed, profileFile, dir, false)).status).toBe("completed");
  expect(mocks.exec.mock.calls.filter(call => call[1][2] === "stop")).toHaveLength(1);
  expect(mocks.exec.mock.calls.filter(call => call[1][2] === "refresh-evidence")).toHaveLength(0);
  expect(mocks.release).toHaveBeenCalledTimes(2);
});
it("다른 request/control의 영수증을 종료 근거로 받아들이지 않는다", async () => {
  phaseOutputs.stop = { ok: true };
  phaseOutputs["verify-stop"] = { ok: true, ...fixture, hash: undefined, plan: { ...fixture.plan, request: { ...fixture.plan.request, requestId: "11111111-1111-4111-8111-111111111111" } },
    releaseFiles: { plan: join(dir, "plan.json"), planSha: "a".repeat(64), receipt: join(dir, "receipt.json") } };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true);
  expect(await runPreparedModelOps(prepared, profileFile, dir, false)).toMatchObject({ step: "verify-stop", status: "blocked" });
  expect(mocks.release).not.toHaveBeenCalled();
});
it("중간 stop 실패 후 이어가기는 이미 시도한 stop을 다시 보내지 않는다", async () => {
  const successful = phaseOutputs["verify-stop"];
  phaseOutputs["verify-stop"] = { ok: false, code: "exit_unproven" };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true);
  const blocked = await runPreparedModelOps(prepared, profileFile, dir, false);
  expect(blocked.step).toBe("stop");
  phaseOutputs["verify-stop"] = successful; phaseOutputs["resume-stop"] = { ok: true };
  expect((await runPreparedModelOps(blocked, profileFile, dir, false)).status).toBe("completed");
  expect(mocks.exec.mock.calls.filter(call => call[1][2] === "stop")).toHaveLength(1);
  expect(mocks.exec.mock.calls.filter(call => call[1][2] === "resume-stop")).toHaveLength(1);
});

it("Supa root argv는 private 준비 파일에만 기록하고 root 결과 대기는 해제·OPEN을 막는다", async () => {
  const commands = [{ target: "jr@supa", phase: "stop", taskPath: join(dir, "root-task.json"), taskSha256: "d".repeat(64),
    stagingPath: "/var/tmp/nmv-supa-root-fixture.json", resultPath: "/var/lib/nmv-admin-models-root/results/fixture.json",
    executable: "/usr/bin/python3", args: ["-I", "/usr/local/libexec/nmv-admin-models/systemd_handoff.py", "execute", "/var/tmp/nmv-supa-root-fixture.json", "d".repeat(64)] }];
  phaseOutputs.prepare = { ok: true, configurationHash: "a".repeat(64), rootCommands: commands };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true);
  expect(prepared.status).toBe("queued"); expect(mocks.admission).not.toHaveBeenCalled();
  const path = opsRootHandoffPath(dir, state().id);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ phase: "prepare", commands });
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  phaseOutputs.stop = { ok: false, manual: true, code: "supa_root_result_required", rootCommands: commands };
  const waiting = await runPreparedModelOps(prepared, profileFile, dir, false);
  expect(waiting).toMatchObject({ status: "manual", step: "stop", code: "supa_root_result_required" });
  expect(mocks.release).not.toHaveBeenCalled(); expect(mocks.admission.mock.calls.map(call => call[1])).toEqual(["draining"]);
  expect(JSON.stringify(mocks.save.mock.calls)).not.toContain("rootCommands");
  expect(JSON.stringify(mocks.save.mock.calls)).not.toContain("systemd_handoff.py");
  phaseOutputs["resume-stop"] = { ok: true };
  expect((await runPreparedModelOps(waiting, profileFile, dir, false)).status).toBe("completed");
  expect(mocks.exec.mock.calls.filter(call => call[1][2] === "stop")).toHaveLength(1);
});

it("root 결과 파일의 fresh cgroup 재검증 실패 이유를 보존하고 해제하지 않는다", async () => {
  phaseOutputs.stop = { ok: true };
  phaseOutputs["verify-stop"] = { ok: false, code: "supa_full_cgroup_exit_unproved" };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true);
  expect(await runPreparedModelOps(prepared, profileFile, dir, false)).toMatchObject({ status: "blocked", step: "verify-stop", code: "supa_full_cgroup_exit_unproved" });
  expect(mocks.release).not.toHaveBeenCalled();
});

it("profile의 DRAIN 인계는 해제·복원 확인 뒤 자기 DRAIN 핀으로만 handoff하고 OPEN을 요청하지 않는다", async () => {
  profile.finalAdmission = "draining"; writeFileSync(profileFile, JSON.stringify(profile));
  mocks.handoff.mockResolvedValue({ ok: true });
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true);
  expect(prepared.finalAdmission).toBe("draining");
  const result = await runPreparedModelOps(prepared, profileFile, dir, false);
  expect(result).toMatchObject({ status: "completed", finalAdmission: "draining", steps: { handoff: "done" } });
  expect(mocks.admission.mock.calls.map(call => call[1])).toEqual(["draining"]);
  expect(mocks.handoff).toHaveBeenCalledTimes(1);
  expect(mocks.handoff.mock.calls[0][1]).toEqual({ ...fixture.plan.control, mode: "draining" });
  expect(mocks.release).toHaveBeenCalledTimes(1);
});
it("DRAIN 인계 선택은 접수 작업에 쓸 수 없고 시작 뒤 profile에서 빼거나 바꿀 수 없다", async () => {
  profile.finalAdmission = "draining"; writeFileSync(profileFile, JSON.stringify(profile));
  expect(() => readOperatorProfile(profileFile, { ...state(), finalAdmission: undefined })).not.toThrow();
  const admission = { ...profile, action: "admission-open", targetId: "model-capacity" }; writeFileSync(profileFile, JSON.stringify(admission));
  expect(() => readOperatorProfile(profileFile, { ...state(), action: "admission-open", targetId: "model-capacity" })).toThrow("final_admission_denied");
  delete profile.finalAdmission; writeFileSync(profileFile, JSON.stringify(profile));
  expect(() => readOperatorProfile(profileFile, { ...state(), finalAdmission: "draining" })).toThrow("profile_changed");
});
