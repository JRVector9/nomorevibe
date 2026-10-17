import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, it } from "vitest";
import { evaluateLocalCallEnded, judgeModelReclaim, type ProcessGroupEvent } from "@/lib/operations/dr/call-drain";
import { processAttestationSchema, readProcessAttestation, sameProcessNamespace, successorExitMatches, successorProbeEnabled,
  SUCCESSOR_EXIT_METHOD } from "@/lib/operations/dr/process-attestation";
import { roleWorkerProcessGroup } from "@/scripts/role-worker";

// PR15f: supervisor 가 child 와 함께 죽은 boot 를 같은 커널·같은 PID namespace 의 후속 boot 가 대신 관측한 종료(ESRCH)의 순수 판정.
// 실제 DB·실제 자식 프로세스 그룹은 tests/integration/dr-successor-exit.test.ts 가 본다.
const T0 = Date.parse("2026-10-17T00:00:00.000Z");
const oldBoot = "0a6bd6a3-6c2a-4f6e-9a39-2d6f7b0e5c21", observer = "5b1e2d3c-4a5b-4c6d-8e7f-90a1b2c3d4e5", runId = "6d7f0f53-4d39-4b9d-a5a6-3a4a8f0c1b11";
const attestation = { version: 1 as const, kernelBootId: "9f0e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f", pidNamespace: 4026531836 };
const successor = (detail: unknown = { version: 1, observerBootId: observer, kernelBootId: attestation.kernelBootId, pidNamespace: attestation.pidNamespace }) =>
  ({ kind: "group_exited" as const, seq: 1, runId, pid: 4242, recordedAtMs: T0 + 9_000, method: SUCCESSOR_EXIT_METHOD, detail });
const opened = (detail: unknown = attestation): ProcessGroupEvent => ({ kind: "owner_opened", seq: 0, runId: null, pid: null, recordedAtMs: T0, method: null, detail });
const intent: ProcessGroupEvent = { kind: "spawn_intent", seq: 1, runId, pid: null, recordedAtMs: T0 + 100 };
const spawned: ProcessGroupEvent = { kind: "spawned", seq: 1, runId, pid: 4242, recordedAtMs: T0 + 200 };
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
function procRoot(files: { bootId?: string; pidLink?: string }) {
  const root = mkdtempSync(path.join(tmpdir(), "pr15f-proc-")); roots.push(root);
  if (files.bootId !== undefined) { mkdirSync(path.join(root, "sys/kernel/random"), { recursive: true }); writeFileSync(path.join(root, "sys/kernel/random/boot_id"), files.bootId); }
  if (files.pidLink !== undefined) { mkdirSync(path.join(root, "self/ns"), { recursive: true }); symlinkSync(files.pidLink, path.join(root, "self/ns/pid")); }
  return root;
}

it("flag: unset or 0 is off, exactly 1 is on, anything else is a configuration error", () => {
  expect(successorProbeEnabled({})).toBe(false);
  expect(successorProbeEnabled({ PROCESS_GROUP_SUCCESSOR_PROBE: "0" })).toBe(false);
  expect(successorProbeEnabled({ PROCESS_GROUP_SUCCESSOR_PROBE: "1" })).toBe(true);
  for (const value of ["true", "yes", " 1", "2", ""]) expect(() => successorProbeEnabled({ PROCESS_GROUP_SUCCESSOR_PROBE: value })).toThrow("invalid_process_group_successor_probe");
});

it("attestation: kernel boot id and PID namespace inode come from procfs; anything unreadable or malformed is no attestation", () => {
  expect(readProcessAttestation(procRoot({ bootId: `${attestation.kernelBootId}\n`, pidLink: "pid:[4026531836]" }))).toEqual(attestation);
  expect(readProcessAttestation(procRoot({ bootId: "9f0e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f\n", pidLink: "pid:[4026532211]" })))
    .toEqual({ ...attestation, pidNamespace: 4026532211 });
  expect(readProcessAttestation(procRoot({ pidLink: "pid:[4026531836]" }))).toBeNull();
  expect(readProcessAttestation(procRoot({ bootId: attestation.kernelBootId }))).toBeNull();
  expect(readProcessAttestation(procRoot({ bootId: attestation.kernelBootId.toUpperCase(), pidLink: "pid:[4026531836]" }))).toBeNull();
  expect(readProcessAttestation(procRoot({ bootId: "not-a-uuid", pidLink: "pid:[4026531836]" }))).toBeNull();
  expect(readProcessAttestation(procRoot({ bootId: attestation.kernelBootId, pidLink: "net:[4026531836]" }))).toBeNull();
  expect(readProcessAttestation(procRoot({ bootId: attestation.kernelBootId, pidLink: "pid:[0]" }))).toBeNull();
  expect(readProcessAttestation(procRoot({ bootId: attestation.kernelBootId, pidLink: "pid:[4294967296]" }))).toBeNull();
  expect(readProcessAttestation(path.join(tmpdir(), "pr15f-missing-proc-root"))).toBeNull();
  expect(() => processAttestationSchema.parse({ ...attestation, extra: 1 })).toThrow();
});

it.skipIf(process.platform !== "linux")("attestation: the real Linux procfs gives this process an attestation", () => {
  const real = readProcessAttestation();
  expect(real).not.toBeNull();
  expect(real!.pidNamespace).toBeGreaterThan(0);
});

it("same namespace: both the kernel boot and the PID namespace inode must match", () => {
  expect(sameProcessNamespace(attestation, { ...attestation })).toBe(true);
  expect(sameProcessNamespace(attestation, { ...attestation, kernelBootId: observer })).toBe(false);
  expect(sameProcessNamespace(attestation, { ...attestation, pidNamespace: 4026532211 })).toBe(false);
  expect(successorExitMatches(successor().detail, attestation)).toBe(true);
  expect(successorExitMatches({ ...successor().detail as object, pidNamespace: 4026532211 }, attestation)).toBe(false);
  expect(successorExitMatches({ version: 1, kernelBootId: attestation.kernelBootId, pidNamespace: attestation.pidNamespace }, attestation)).toBe(false);
  expect(successorExitMatches(null, attestation)).toBe(false);
});

it("judge: a successor-observed exit counts only when it was observed in the old owner's attested kernel boot and PID namespace", () => {
  const events = (open: ProcessGroupEvent, exit: ProcessGroupEvent) => [open, intent, spawned, exit];
  expect(evaluateLocalCallEnded(events(opened(), successor()), T0 + 500)).toEqual({ ended: true, lastExitAtMs: T0 + 9_000 });
  // 다른 커널·다른 namespace 에서 본 ESRCH 는 그 그룹에 대한 사실이 아니다
  expect(evaluateLocalCallEnded(events(opened(), successor({ version: 1, observerBootId: observer, kernelBootId: observer, pidNamespace: attestation.pidNamespace })), T0 + 500))
    .toEqual({ ended: false, reason: "exit_unverified:1" });
  expect(evaluateLocalCallEnded(events(opened(), successor({ version: 1, observerBootId: observer, kernelBootId: attestation.kernelBootId, pidNamespace: 1 })), T0 + 500))
    .toEqual({ ended: false, reason: "exit_unverified:1" });
  // 옛 owner 가 attestation 을 남기지 않았으면(flag 꺼진 boot·옛 코드) 후속 관측은 근거가 아니다
  expect(evaluateLocalCallEnded(events(opened(null), successor()), T0 + 500)).toEqual({ ended: false, reason: "exit_unverified:1" });
  expect(evaluateLocalCallEnded(events(opened(), successor(null)), T0 + 500)).toEqual({ ended: false, reason: "exit_unverified:1" });
  // supervisor 가 직접 남긴 종료는 attestation 과 무관하게 그대로다
  const supervisor: ProcessGroupEvent = { kind: "group_exited", seq: 1, runId, pid: 4242, recordedAtMs: T0 + 900, method: "pgid_esrch_after_sigkill", detail: null };
  expect(evaluateLocalCallEnded(events(opened(null), supervisor), T0 + 500)).toEqual({ ended: true, lastExitAtMs: T0 + 900 });
  // 회수 판정은 같은 정책을 따른다: 근거 kind 는 process_group_exit, 기준 시각은 후속 boot 의 기록 시각
  const owner = { instanceId: "oracle-reviewer", bootId: oldBoot };
  const facts = { state: "dispatched" as const, dispatchAtMs: T0 + 500, bindingHash: null, owner, events: events(opened(), successor()), localEnd: null };
  expect(judgeModelReclaim(facts, { termination: "client_bound", hardDeadlineMs: null, skewBoundMs: 1 }, T0 + 9_001))
    .toEqual({ status: "reclaimable", evidence: "process_group_exit", reason: null, notBeforeMs: T0 + 9_001 });
  expect(judgeModelReclaim(facts, { termination: "provider_bound", hardDeadlineMs: 60_000, skewBoundMs: 1 }, T0 + 9_001))
    .toEqual({ status: "waiting", evidence: "process_group_exit", reason: "waiting", notBeforeMs: T0 + 69_001 });
  expect(judgeModelReclaim(facts, undefined, T0 + 10 ** 9))
    .toEqual({ status: "policy_blocked", evidence: "process_group_exit", reason: "provider_deadline_unknown", notBeforeMs: null });
});

it("role-worker: the flag is off by default; on, a readable attestation gives the recorder a predecessor probe; unreadable means no probe", () => {
  const owner = { instanceId: "oracle-reviewer", bootId: oldBoot };
  const off = roleWorkerProcessGroup(owner, {}, () => attestation);
  expect(off.attestation).toBeNull(); expect(off.recorder.probePredecessors).toBeUndefined(); expect(off.recorder.owner).toEqual(owner);
  const on = roleWorkerProcessGroup(owner, { PROCESS_GROUP_SUCCESSOR_PROBE: "1" }, () => attestation);
  expect(on.attestation).toEqual(attestation); expect(typeof on.recorder.probePredecessors).toBe("function");
  const unreadable = roleWorkerProcessGroup(owner, { PROCESS_GROUP_SUCCESSOR_PROBE: "1" }, () => null);
  expect(unreadable.attestation).toBeNull(); expect(unreadable.recorder.probePredecessors).toBeUndefined();
  let read = 0;
  expect(() => roleWorkerProcessGroup(owner, { PROCESS_GROUP_SUCCESSOR_PROBE: "on" }, () => { read++; return attestation; })).toThrow("invalid_process_group_successor_probe");
  expect(read).toBe(0);
});
