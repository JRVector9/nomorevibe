import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, lstatSync, rmSync, symlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), save: vi.fn(), capacity: vi.fn(), admission: vi.fn(), quiet: vi.fn(), request: vi.fn(), release: vi.fn(), files: vi.fn(), handoff: vi.fn(),
  lstat: new Map<string, { uid: number; mode?: number }>() }));
// Owner/mode of chosen ancestors as another host would show them (e.g. a sandbox mapping / and /home to 65534).
// Empty unless a test sets it; every other path reports the real lstat.
vi.mock("node:fs", async original => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, lstatSync: (path: string) => {
    const info = fs.lstatSync(path), seen = mocks.lstat.get(path);
    return seen ? new Proxy(info, { get: (object, key) => key === "uid" ? seen.uid
      : key === "mode" ? seen.mode ?? info.mode : Reflect.get(object, key) }) : info;
  } };
});
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
vi.mock("@/lib/operations/ops-runner/repository", () => ({ saveModelOpsState: mocks.save }));
vi.mock("@/lib/operations/ops-runner/control", () => ({ capacityPin: mocks.capacity, controlOpsAdmission: mocks.admission, assertOpsQuiescent: mocks.quiet,
  readOpsRequest: mocks.request, handOffOpsDrain: mocks.handoff }));
vi.mock("@/lib/operations/dr/provider-boundary-release", () => ({ releaseProviderBoundaryRequest: mocks.release }));
vi.mock("@/scripts/ops/model-provider-boundary-release", () => ({ readBoundaryReleaseFiles: mocks.files }));
import { runPreparedModelOps, readOperatorProfile, callOpsAdapter, opsRootHandoffPath, trustedOpsPath, operatorOwner,
  type OpsPathTrust } from "@/lib/operations/ops-runner/operator";
import { initialOpsState } from "@/lib/operations/ops-runner/contract";
import { boundaryFixture } from "./fixtures/provider-boundary-release";
const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
let dir: string, profileFile: string, profile: Record<string, unknown>, phaseOutputs: Record<string, unknown>;
const fixture = boundaryFixture();
// The private test directory is the trust root, so ancestors outside this test (/, /home, the worktree) do not decide the result.
const trust = (): OpsPathTrust => ({ root: dir });
const state = () => initialOpsState({ id: "ad2b84de-4ddf-4b2e-9dbd-605c64f7d728", action: "request-release", targetId: fixture.plan.request.requestId,
  confirmed: true, reason: "synthetic local test" }, "admin");
beforeEach(() => {
  vi.resetAllMocks(); mocks.lstat.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-24T18:13:00.000Z"));
  // Tiny private fixtures; no device/network/DB activity. All new paths are owned by this test.
  dir = mkdtempSync(join(tmpdir(), "ops-runner-test-"));
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
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true, trust());
  const result = await runPreparedModelOps(prepared, profileFile, dir, false, trust());
  expect(result.status).toBe("completed"); expect(mocks.release).toHaveBeenCalledTimes(1);
  const phases = mocks.exec.mock.calls.map(call => call[1][2]);
  expect(phases).toEqual(["prepare", "plan", "stop", "verify-stop", "verify-stop", "restore", "verify-restored"]);
  expect(mocks.exec.mock.calls.every(call => call[0] === "/usr/bin/python3" && call[2].shell === undefined)).toBe(true);
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
});
it("native verify 재확인 실패는 stop에서 멈추며 해제하지 않는다", async () => {
  phaseOutputs["verify-stop"] = { ok: false, code: "exit_unproven" };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true, trust());
  expect(await runPreparedModelOps(prepared, profileFile, dir, false, trust())).toMatchObject({ status: "blocked", step: "stop" });
  expect(mocks.release).not.toHaveBeenCalled();
});
it("명시한 sudo 단계는 Python·SSH·DRAIN 전에 사람 작업으로 표시한다", async () => {
  profile.requiresSudo = true; writeFileSync(profileFile, JSON.stringify(profile));
  expect(await runPreparedModelOps(state(), profileFile, dir, true, trust())).toMatchObject({ status: "manual", code: "human_on_device_sudo_stop_restore_required" });
  expect(mocks.exec).not.toHaveBeenCalled(); expect(mocks.admission).not.toHaveBeenCalled();
});
it("종료 근거가 없으면 canonical release를 호출하지 않는다", async () => {
  phaseOutputs.stop = { ok: true }; phaseOutputs["verify-stop"] = { ok: false };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true, trust());
  expect(await runPreparedModelOps(prepared, profileFile, dir, false, trust())).toMatchObject({ step: "verify-stop", code: "termination_evidence_missing" });
  expect(mocks.release).not.toHaveBeenCalled();
});
it("원래 설정 복원 실패는 OPEN을 막는다", async () => {
  phaseOutputs.stop = { ok: true }; phaseOutputs["verify-restored"] = { ok: true, configurationHash: "b".repeat(64) };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true, trust());
  expect(await runPreparedModelOps(prepared, profileFile, dir, false, trust())).toMatchObject({ step: "verify-restored", status: "blocked" });
  expect(mocks.admission.mock.calls.map(call => call[1])).toEqual(["draining"]);
});
it("검토 후 바뀐 어댑터·다른 대상·성공 JSON과 모순되는 실패 종료 코드를 거절한다", async () => {
  const reviewed = readOperatorProfile(profileFile, state(), trust()).profile;
  mocks.exec.mockImplementation((_exe, _args, _options, callback) => {
    callback(Object.assign(new Error("synthetic_exit_failure"), { code: 1 }), JSON.stringify({ ok: true }), ""); return { stdin: { end: vi.fn() } };
  });
  await expect(callOpsAdapter(reviewed, "prepare", state(), {}, trust())).rejects.toThrow("adapter_outcome_unknown");
  expect(() => readOperatorProfile(profileFile, { ...state(), targetId: "11111111-1111-4111-8111-111111111111" }, trust())).toThrow("profile_target_mismatch");
  writeFileSync((profile.adapter as { path: string }).path, "changed"); expect(() => readOperatorProfile(profileFile, state(), trust())).toThrow("adapter_not_reviewed");
});
it("해제 커밋 뒤 응답 유실은 기존 영수증으로 확정하고 새 종료/복원을 중복 요청하지 않는다", async () => {
  mocks.release.mockRejectedValueOnce(new Error("connection_lost_after_commit")).mockResolvedValue({ kind: "already_released" });
  mocks.request.mockResolvedValueOnce(fixture.plan.request).mockRejectedValueOnce(new Error("request_now_withdrawn"));
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true, trust());
  const failed = await runPreparedModelOps(prepared, profileFile, dir, false, trust());
  expect(failed).toMatchObject({ status: "blocked", step: "release" });
  expect((await runPreparedModelOps(failed, profileFile, dir, false, trust())).status).toBe("completed");
  expect(mocks.exec.mock.calls.filter(call => call[1][2] === "stop")).toHaveLength(1);
  expect(mocks.exec.mock.calls.filter(call => call[1][2] === "refresh-evidence")).toHaveLength(0);
  expect(mocks.release).toHaveBeenCalledTimes(2);
});
it("다른 request/control의 영수증을 종료 근거로 받아들이지 않는다", async () => {
  phaseOutputs.stop = { ok: true };
  phaseOutputs["verify-stop"] = { ok: true, ...fixture, hash: undefined, plan: { ...fixture.plan, request: { ...fixture.plan.request, requestId: "11111111-1111-4111-8111-111111111111" } },
    releaseFiles: { plan: join(dir, "plan.json"), planSha: "a".repeat(64), receipt: join(dir, "receipt.json") } };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true, trust());
  expect(await runPreparedModelOps(prepared, profileFile, dir, false, trust())).toMatchObject({ step: "verify-stop", status: "blocked" });
  expect(mocks.release).not.toHaveBeenCalled();
});
it("중간 stop 실패 후 이어가기는 이미 시도한 stop을 다시 보내지 않는다", async () => {
  const successful = phaseOutputs["verify-stop"];
  phaseOutputs["verify-stop"] = { ok: false, code: "exit_unproven" };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true, trust());
  const blocked = await runPreparedModelOps(prepared, profileFile, dir, false, trust());
  expect(blocked.step).toBe("stop");
  phaseOutputs["verify-stop"] = successful; phaseOutputs["resume-stop"] = { ok: true };
  expect((await runPreparedModelOps(blocked, profileFile, dir, false, trust())).status).toBe("completed");
  expect(mocks.exec.mock.calls.filter(call => call[1][2] === "stop")).toHaveLength(1);
  expect(mocks.exec.mock.calls.filter(call => call[1][2] === "resume-stop")).toHaveLength(1);
});

it("Supa root argv는 private 준비 파일에만 기록하고 root 결과 대기는 해제·OPEN을 막는다", async () => {
  const commands = [{ target: "jr@supa", phase: "stop", taskPath: join(dir, "root-task.json"), taskSha256: "d".repeat(64),
    stagingPath: "/var/tmp/nmv-supa-root-fixture.json", resultPath: "/var/lib/nmv-admin-models-root/results/fixture.json",
    executable: "/usr/bin/python3", args: ["-I", "/usr/local/libexec/nmv-admin-models/systemd_handoff.py", "execute", "/var/tmp/nmv-supa-root-fixture.json", "d".repeat(64)] }];
  phaseOutputs.prepare = { ok: true, configurationHash: "a".repeat(64), rootCommands: commands };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true, trust());
  expect(prepared.status).toBe("queued"); expect(mocks.admission).not.toHaveBeenCalled();
  const path = opsRootHandoffPath(dir, state().id);
  expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ phase: "prepare", commands });
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
  phaseOutputs.stop = { ok: false, manual: true, code: "supa_root_result_required", rootCommands: commands };
  const waiting = await runPreparedModelOps(prepared, profileFile, dir, false, trust());
  expect(waiting).toMatchObject({ status: "manual", step: "stop", code: "supa_root_result_required" });
  expect(mocks.release).not.toHaveBeenCalled(); expect(mocks.admission.mock.calls.map(call => call[1])).toEqual(["draining"]);
  expect(JSON.stringify(mocks.save.mock.calls)).not.toContain("rootCommands");
  expect(JSON.stringify(mocks.save.mock.calls)).not.toContain("systemd_handoff.py");
  phaseOutputs["resume-stop"] = { ok: true };
  expect((await runPreparedModelOps(waiting, profileFile, dir, false, trust())).status).toBe("completed");
  expect(mocks.exec.mock.calls.filter(call => call[1][2] === "stop")).toHaveLength(1);
});

it("root 결과 파일의 fresh cgroup 재검증 실패 이유를 보존하고 해제하지 않는다", async () => {
  phaseOutputs.stop = { ok: true };
  phaseOutputs["verify-stop"] = { ok: false, code: "supa_full_cgroup_exit_unproved" };
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true, trust());
  expect(await runPreparedModelOps(prepared, profileFile, dir, false, trust())).toMatchObject({ status: "blocked", step: "verify-stop", code: "supa_full_cgroup_exit_unproved" });
  expect(mocks.release).not.toHaveBeenCalled();
});

it("profile의 DRAIN 인계는 해제·복원 확인 뒤 자기 DRAIN 핀으로만 handoff하고 OPEN을 요청하지 않는다", async () => {
  profile.finalAdmission = "draining"; writeFileSync(profileFile, JSON.stringify(profile));
  mocks.handoff.mockResolvedValue({ ok: true });
  const prepared = await runPreparedModelOps(state(), profileFile, dir, true, trust());
  expect(prepared.finalAdmission).toBe("draining");
  const result = await runPreparedModelOps(prepared, profileFile, dir, false, trust());
  expect(result).toMatchObject({ status: "completed", finalAdmission: "draining", steps: { handoff: "done" } });
  expect(mocks.admission.mock.calls.map(call => call[1])).toEqual(["draining"]);
  expect(mocks.handoff).toHaveBeenCalledTimes(1);
  expect(mocks.handoff.mock.calls[0][1]).toEqual({ ...fixture.plan.control, mode: "draining" });
  expect(mocks.release).toHaveBeenCalledTimes(1);
});
it("DRAIN 인계 선택은 접수 작업에 쓸 수 없고 시작 뒤 profile에서 빼거나 바꿀 수 없다", async () => {
  profile.finalAdmission = "draining"; writeFileSync(profileFile, JSON.stringify(profile));
  expect(() => readOperatorProfile(profileFile, { ...state(), finalAdmission: undefined }, trust())).not.toThrow();
  const admission = { ...profile, action: "admission-open", targetId: "model-capacity" }; writeFileSync(profileFile, JSON.stringify(admission));
  expect(() => readOperatorProfile(profileFile, { ...state(), action: "admission-open", targetId: "model-capacity" }, trust())).toThrow("final_admission_denied");
  delete profile.finalAdmission; writeFileSync(profileFile, JSON.stringify(profile));
  expect(() => readOperatorProfile(profileFile, { ...state(), finalAdmission: "draining" }, trust())).toThrow("profile_changed");
});
it("주입한 신뢰 루트 아래에서도 symlink·쓰기 가능·다른 소유자·루트 밖 경로를 거절한다", () => {
  const file = join(dir, "profile.json");
  expect(trustedOpsPath(file, false, trust())).toBe(file);
  const link = join(dir, "link.json"); symlinkSync(file, link);
  expect(() => trustedOpsPath(link, false, trust())).toThrow("ops_runner_untrusted_path");
  const writable = join(dir, "writable.json"); writeFileSync(writable, "{}", { mode: 0o600 }); chmodSync(writable, 0o620);
  expect(() => trustedOpsPath(writable, false, trust())).toThrow("ops_runner_untrusted_path");
  // Only the current uid is a non-root owner here; refusing it models a file owned by another account.
  expect(() => trustedOpsPath(file, false, { root: dir, trustedOwner: uid => uid === 0 })).toThrow("ops_runner_untrusted_path");
  mocks.lstat.set(file, { uid: 65534 });
  expect(() => trustedOpsPath(file, false, trust())).toThrow("ops_runner_untrusted_path");
  mocks.lstat.clear();
  expect(() => trustedOpsPath(file, false, { root: join(dir, "elsewhere") })).toThrow("ops_runner_untrusted_path");
  expect(() => trustedOpsPath(file, false, { root: "relative" })).toThrow("ops_runner_untrusted_path");
  expect(() => trustedOpsPath(dir, false, trust())).toThrow("ops_runner_untrusted_path");
});
it("운영 기본값(신뢰 루트 없음)은 상위 디렉터리 하나가 65534 소유로 보이면 거절한다", async () => {
  const file = join(dir, "profile.json"), ancestors: string[] = [];
  for (let current = dirname(dir); ; current = dirname(current)) { ancestors.push(current); if (current === parse(current).root) break; }
  // Clean private installation first: root-owned, not group/world writable ancestors. The default walk accepts it.
  for (const path of ancestors) mocks.lstat.set(path, { uid: 0, mode: lstatSync(path).mode & ~0o022 });
  expect(trustedOpsPath(file)).toBe(file);
  expect(operatorOwner(0)).toBe(true); expect(operatorOwner(65534)).toBe(process.getuid?.() === 65534);
  // The same tree with / shown as overflow uid 65534 (a sandbox UID mapping), and then /home-like middle ancestors.
  for (const path of ancestors) {
    const clean = mocks.lstat.get(path)!; mocks.lstat.set(path, { ...clean, uid: 65534 });
    expect(() => trustedOpsPath(file)).toThrow("ops_runner_untrusted_path");
    expect(() => readOperatorProfile(file, state())).toThrow("ops_runner_untrusted_path");
    await expect(runPreparedModelOps(state(), file, dir, true)).rejects.toThrow("ops_runner_untrusted_path");
    mocks.lstat.set(path, clean);
  }
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.exec).not.toHaveBeenCalled();
});
