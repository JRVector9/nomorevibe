import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { claudeCliTokenBound, type CliServingContract } from "@/lib/llm/cli-serving-contract";
import { CLI_CLOSE_GRACE_MS, CLI_KILL_GRACE_MS, prepareCliCall, readCliProcessTerminal, runReservedCliCall,
  type CliCallInput } from "@/lib/llm/cli-process-runner";

/*
 * 실제 프로세스로는 만들 수 없는 끝(SIGKILL 이 듣지 않음, spawn 이 동기 예외, exit 없는 close)을 가짜 ChildProcess 로 확인한다.
 * 실제 프로세스 실증은 cli-process-runner.test.ts 가 맡는다.
 */
const fake = vi.hoisted(() => ({ spawn: null as null | (() => unknown) }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: vi.fn(() => fake.spawn!()),
}));
const shape = { maxTurns: 2, inputByteCap: 200_000, overheadTokenBound: 20_000, outputTokensPerTurn: 2_000 };
const contract: CliServingContract = { version: 1, protocol: "cli-process-v1", routeId: "crawl-agent-review", provider: "claude-cli",
  model: "fake-model", cliVersion: "fake 0.0.0", totalTokenBound: claudeCliTokenBound(shape), costBoundUsdMicros: null,
  boundProvenance: "derived", ...shape };
vi.mock("@/lib/llm/cli-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/cli-serving-contract")>(), resolveCliServingContract: () => contract,
}));
class FakeChild extends EventEmitter {
  pid = 424_242; stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough(); kills: string[] = [];
  constructor(private onKill: (child: FakeChild) => void = () => {}) { super(); }
  kill(signal: string) { this.kills.push(signal); this.onKill(this); return true; }
}
const input: CliCallInput = { routeId: "crawl-agent-review", provider: "claude-cli", model: "fake-model", command: "/nonexistent/fake-cli",
  args: ["-p", "--max-turns", "2", "--model", "fake-model"], stdin: "{}", cwd: "/", env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2000" },
  boundEnvKeys: ["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], timeoutMs: 50, maxStdoutBytes: 64 * 1024, maxStderrBytes: 16 * 1024 };
async function run() {
  const call = prepareCliCall(input);
  if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
  const started = Date.now(), outcome = await runReservedCliCall(call, { requestId: randomUUID(), transport: call.transport });
  return { ...outcome, elapsed: Date.now() - started, evidence: readCliProcessTerminal(outcome.terminal) };
}
afterEach(() => { fake.spawn = null; });

it("kill 뒤 exit 가 유예 안에 오지 않으면 terminal 없이 transport_unknown, 결과는 기존 kind(timeout)이고 pipe 는 닫는다", async () => {
  const child = new FakeChild();
  fake.spawn = () => child;
  const outcome = await run();
  expect(outcome).toMatchObject({ result: { kind: "timeout" }, terminal: null, indeterminate: "transport_unknown" });
  expect(child.kills).toEqual(["SIGKILL"]);
  expect(outcome.elapsed).toBeGreaterThanOrEqual(50 + CLI_KILL_GRACE_MS - 20);
  expect(outcome.elapsed).toBeLessThan(50 + CLI_KILL_GRACE_MS + CLI_CLOSE_GRACE_MS);
  expect([child.stdin.destroyed, child.stdout.destroyed, child.stderr.destroyed]).toEqual([true, true, true]);
}, 10_000);

it("kill 뒤 exit 는 왔지만 close 가 없으면 terminal 없이 process_exit, 결과는 기존 kind(timeout)를 지킨다", async () => {
  const child = new FakeChild(self => setImmediate(() => self.emit("exit", null, "SIGKILL")));
  fake.spawn = () => child;
  const outcome = await run();
  expect(outcome).toMatchObject({ result: { kind: "timeout" }, terminal: null, indeterminate: "process_exit" });
  expect(outcome.elapsed).toBeGreaterThanOrEqual(50 + CLI_CLOSE_GRACE_MS - 20);
  expect(outcome.elapsed).toBeLessThan(50 + CLI_KILL_GRACE_MS + CLI_CLOSE_GRACE_MS);
}, 10_000);

it("exit 없이 온 close 는 종료 근거가 아니다 — terminal 없이 transport_unknown", async () => {
  const child = new FakeChild();
  fake.spawn = () => { setImmediate(() => child.emit("close", 0, null)); return child; };
  const outcome = await run();
  expect(outcome).toMatchObject({ result: { kind: "cli_error" }, terminal: null, indeterminate: "transport_unknown" });
});

it("spawn 뒤 error 가 먼저 오면 결과는 legacy 처럼 그 kind 지만, 뒤이은 kill 의 사유는 killed 증거에 남는다", async () => {
  const child = new FakeChild(self => setImmediate(() => { self.emit("exit", null, "SIGKILL"); self.emit("close", null, "SIGKILL"); }));
  fake.spawn = () => { setImmediate(() => child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }))); return child; };
  const outcome = await run();
  expect(outcome.result).toEqual({ kind: "cli_error" });
  expect(outcome.evidence).toMatchObject({ ending: "killed", exitCode: null, signal: "SIGKILL", killReason: "timeout" });
});

it("spawn 이 동기 예외로 끝나면 프로세스가 없으므로 spawn_failed terminal, 결과는 legacy 호출자가 받던 cli_error", async () => {
  fake.spawn = () => { throw Object.assign(new Error("spawn E2BIG"), { code: "E2BIG" }); };
  const outcome = await run();
  expect(outcome.result).toEqual({ kind: "cli_error" });
  expect(outcome.evidence).toMatchObject({ ending: "spawn_failed", exitCode: null, signal: null, stdoutBytes: 0 });
});
