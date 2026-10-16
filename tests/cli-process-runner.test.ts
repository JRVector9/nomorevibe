import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { cliFailure, reviewCliArgs, runReviewCli, type ReviewCliResult } from "@/lib/crawl/agent-review";
import { grokReviewAgentDefinition, grokReviewArgs, runGrokCli } from "@/lib/crawl/agent-review-grok";
import { claudeCliTokenBound, EMPTY_SHA256, type CliServingContract } from "@/lib/llm/cli-serving-contract";
import { CLI_CLOSE_GRACE_MS, CLI_KILL_GRACE_MS, prepareCliCall, readCliProcessTerminal, runReservedCliCall, settleCliNotStarted,
  type CliCallInput, type PreparedCliCall } from "@/lib/llm/cli-process-runner";

/*
 * 가짜 CLI(tests/fixtures/fake-cli/fake.mjs)를 실제 자식 프로세스로 띄워 물리 종료 근거를 실증한다. 실제 claude/grok/codex 는
 * 부르지 않는다 — 명령은 절대경로 sh 래퍼이고, 자식의 PATH 는 빈 디렉터리다(가짜가 PATH 에서 실제 CLI 를 못 찾았는지 기록한다).
 */
const fixture = vi.hoisted(() => ({ contracts: [] as CliServingContract[] }));
vi.mock("@/lib/llm/cli-serving-contract", async original => ({
  ...await original<typeof import("@/lib/llm/cli-serving-contract")>(),
  resolveCliServingContract: (routeId: string, provider: string, model: string) =>
    fixture.contracts.find(value => value.routeId === routeId && value.provider === provider && value.model === model) ?? null,
}));
const model = "fake-model", PROCESS_TEST_MS = 20_000;
const claudeShape = { maxTurns: 2, inputByteCap: 200_000, overheadTokenBound: 20_000, outputTokensPerTurn: 2_000 };
const claudeContract: CliServingContract = { version: 1, protocol: "cli-process-v1", routeId: "crawl-agent-review", provider: "claude-cli",
  model, cliVersion: "fake 0.0.0", totalTokenBound: claudeCliTokenBound(claudeShape), costBoundUsdMicros: 150_000,
  boundProvenance: "derived", ...claudeShape };
const grokContract: CliServingContract = { version: 1, protocol: "cli-process-v1", routeId: "second-review", provider: "grok-cli", model,
  cliVersion: "fake 0.0.0", inputByteCap: 200_000, totalTokenBound: 300_000, costBoundUsdMicros: null, boundProvenance: "declared" };
let root = "", bin = "", noexec = "", empty = "", records = "";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
  fixture.contracts = [claudeContract, grokContract];
  root = await mkdtemp(path.join(os.tmpdir(), "nmv-fake-cli-"));
  empty = path.join(root, "empty-path"); records = path.join(root, "records");
  await mkdir(empty); await mkdir(records);
  const fake = path.resolve("tests/fixtures/fake-cli/fake.mjs");
  for (const value of [root, fake, process.execPath]) expect(value).not.toContain("'");
  const script = `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`;
  bin = path.join(root, "fake-cli"); noexec = path.join(root, "fake-cli-noexec");
  await writeFile(bin, script); await chmod(bin, 0o755);
  await writeFile(noexec, script); await chmod(noexec, 0o644);
});
afterAll(() => rm(root, { recursive: true, force: true }));
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const name of await readdir(records)) await rm(path.join(records, name));
});

type Recorded = { mode: string; pid: number; argv: string[]; env: Record<string, string | null>; realCliOnPath: boolean; stdin?: string; grandchild?: number };
async function recorded(): Promise<Recorded[]> {
  const names = await readdir(records);
  return Promise.all(names.map(async name => JSON.parse(await readFile(path.join(records, name), "utf8")) as Recorded));
}
async function clearRecords() { for (const name of await readdir(records)) await rm(path.join(records, name)); }
async function waitForRecord(): Promise<Recorded> {
  for (let i = 0; i < 300; i++) { const [value] = await recorded(); if (value) return value; await sleep(10); }
  throw new Error("fake_cli_not_started");
}
const comparable = (values: Recorded[]) => values.map(value => ({ ...value, pid: 0, grandchild: undefined }));
function stubFake(mode: string, command = bin) {
  vi.stubEnv("PATH", empty); vi.stubEnv("FAKE_CLI_MODE", mode); vi.stubEnv("FAKE_CLI_RECORD", records);
  vi.stubEnv("CLAUDECODE", "1"); vi.stubEnv("CLAUDE_CLI", command); vi.stubEnv("GROK_CLI", command);
}
/** legacy runReviewCli 가 자식에게 주는 env 와 같은 값 */
function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2000" };
  delete env.CLAUDECODE;
  return env;
}
function claudeCall(stdin: string, change: Partial<CliCallInput> = {}): CliCallInput {
  return { routeId: "crawl-agent-review", provider: "claude-cli", model, command: bin, args: reviewCliArgs(model), stdin, cwd: root,
    env: claudeEnv(), boundEnvKeys: ["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], timeoutMs: 5_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 16 * 1024, ...change };
}
function prepared(input: CliCallInput): PreparedCliCall {
  const call = prepareCliCall(input);
  if (call.kind !== "prepared") throw new Error("fixture_not_prepared");
  return call;
}
const ref = (call: PreparedCliCall) => ({ requestId: randomUUID(), transport: call.transport });
async function native(input: CliCallInput, options: { signal?: AbortSignal } = {}) {
  const call = prepared(input), dispatch = ref(call), started = Date.now();
  const outcome = await runReservedCliCall(call, dispatch, options);
  return { ...outcome, dispatch, elapsed: Date.now() - started, evidence: readCliProcessTerminal(outcome.terminal) };
}
/** 같은 명령·argv·stdin·env 로 legacy 와 native 를 차례로 돌려 결과와 자식이 받은 입력을 byte 단위로 맞춘다 */
async function compareClaude(mode: string, stdin: string, options: { timeoutMs?: number; command?: string } = {}) {
  stubFake(mode, options.command ?? bin);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const legacy = await runReviewCli(reviewCliArgs(model), stdin, { timeoutMs });
  const legacyRecords = await recorded(); await clearRecords();
  const run = await native(claudeCall(stdin, { timeoutMs, command: options.command ?? bin }));
  const nativeRecords = await recorded();
  expect(run.result).toEqual(legacy);
  if (legacy.kind === "exit" && run.result.kind === "exit") {
    expect(Buffer.from(run.result.stdout, "utf8").equals(Buffer.from(legacy.stdout, "utf8"))).toBe(true);
    expect(Buffer.from(run.result.stderr, "utf8").equals(Buffer.from(legacy.stderr, "utf8"))).toBe(true);
  }
  expect(comparable(nativeRecords)).toEqual(comparable(legacyRecords));
  for (const value of nativeRecords) expect(value.realCliOnPath).toBe(false);
  return { legacy, run, legacyRecords, nativeRecords };
}
const stdoutOf = (result: ReviewCliResult) => result.kind === "exit" ? result.stdout : "";
const pgid = (pid: number) => execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim();
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
/** 테스트가 남긴 손자를 지우고 ESRCH 까지 확인한다(launchd 가 거둔다) */
async function reap(pids: (number | undefined)[]) {
  for (const pid of pids) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  for (const pid of pids) if (pid) { for (let i = 0; i < 300 && alive(pid); i++) await sleep(10); expect(alive(pid)).toBe(false); }
}

it.skipIf(process.platform === "win32")("정상 종료: exit 0 과 close 를 둘 다 본 뒤 terminal 을 내고, 결과·argv·stdin·env 는 legacy 와 byte 단위로 같다", async () => {
  const stdin = `<untrusted_evidence_json>\n{"제품":"\\u003cx\\u003e 한글 ✓"}\n</untrusted_evidence_json>`;
  const { run, nativeRecords } = await compareClaude("ok", stdin);
  expect(run.result).toMatchObject({ kind: "exit", code: 0 });
  expect(nativeRecords).toHaveLength(1);
  expect(Buffer.from(nativeRecords[0].stdin!, "base64").equals(Buffer.from(stdin, "utf8"))).toBe(true);
  expect(nativeRecords[0].argv).toEqual(reviewCliArgs(model));
  expect(nativeRecords[0].env).toEqual({ PATH: empty, CLAUDE_CODE_MAX_OUTPUT_TOKENS: "2000", CLAUDECODE: null });
  expect(run.indeterminate).toBeNull();
  const stdout = stdoutOf(run.result);
  expect(run.evidence).toEqual({ version: 1, kind: "cli_process_terminal", requestId: run.dispatch.requestId, transport: run.dispatch.transport,
    totalTokenBound: claudeContract.totalTokenBound, ending: "exited", exitCode: 0, signal: null, killReason: null,
    stdoutHash: sha(stdout), stderrHash: EMPTY_SHA256, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0,
    actualUsage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 }, provenance: "cli_reported", reportedCostUsdMicros: 2_100 });
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("Grok 모양(stdin 없음·prompt 파일)도 legacy runGrokCli 와 같은 결과이고, runner 가 쓴 파일 원문이 inputHash 에 묶인다", async () => {
  stubFake("ok");
  const directory = await mkdtemp(path.join(root, "grok-")), promptFile = path.join(directory, "prompt.txt");
  const prompt = "<untrusted_evidence_json>\n{\"a\":1}\n</untrusted_evidence_json>";
  const env = { ...process.env, GROK_HOME: path.join(directory, "home"), GROK_AUTH_PATH: path.join(directory, "auth.json"), RUST_LOG: "off", NO_COLOR: "1" };
  await mkdir(path.join(directory, "home", "agents"), { recursive: true });
  await writeFile(promptFile, prompt); await writeFile(path.join(directory, "home", "agents", "nmv-review.md"), grokReviewAgentDefinition());
  const legacy = await runGrokCli(grokReviewArgs(model, promptFile, "low"), { cwd: directory, env, timeoutMs: 5_000 });
  const legacyRecords = await recorded(); await clearRecords();
  await rm(directory, { recursive: true }); await mkdir(directory);
  const input: CliCallInput = { routeId: "second-review", provider: "grok-cli", model, command: bin, args: grokReviewArgs(model, promptFile, "low"),
    stdin: null, files: [{ path: "prompt.txt", content: prompt }, { path: "home/agents/nmv-review.md", content: grokReviewAgentDefinition() }],
    cwd: directory, env, boundEnvKeys: ["NO_COLOR", "RUST_LOG"], timeoutMs: 5_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 16 * 1024 };
  const run = await native(input);
  expect(run.result).toEqual(legacy);
  expect(legacy).toMatchObject({ kind: "exit", code: 0 });
  expect(comparable(await recorded())).toEqual(comparable(legacyRecords));
  expect(await readFile(promptFile, "utf8")).toBe(prompt);
  expect(run.evidence).toMatchObject({ ending: "exited", exitCode: 0, provenance: "cli_reported", totalTokenBound: grokContract.totalTokenBound });
  const changed = prepared({ ...input, files: [{ path: "prompt.txt", content: `${prompt} ` }, input.files![1]] });
  expect(changed.transport.inputHash).not.toBe(run.dispatch.transport.inputHash);
  expect(changed.transport.argvHash).toBe(run.dispatch.transport.argvHash);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("비0 종료: exit 1 도 exit+close 면 terminal 이고, parser 는 legacy 와 같은 stdout 으로 rate_limited 를 낸다", async () => {
  const { run } = await compareClaude("fail", "{}");
  expect(run.result).toMatchObject({ kind: "exit", code: 1 });
  expect(cliFailure(JSON.parse(stdoutOf(run.result)))).toBe("rate_limited");
  expect(run.evidence).toMatchObject({ ending: "exited", exitCode: 1, signal: null, killReason: null, provenance: "cli_reported" });
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("시그널 종료: 자식이 스스로 SIGTERM 으로 끝나도 exit+close 면 terminal 이고 runner 의 kill 로 적지 않는다", async () => {
  const { run } = await compareClaude("signal", "{}");
  expect(run.result).toEqual({ kind: "exit", code: null, stdout: "partial", stderr: "" });
  expect(run.evidence).toMatchObject({ ending: "exited", exitCode: null, signal: "SIGTERM", killReason: null, actualUsage: null, provenance: "unknown" });
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("timeout kill: 기한에 SIGKILL 하고 exit+close 를 본 뒤 killed/timeout terminal, 전체 시간은 timeout+유예 안이다", async () => {
  const { run } = await compareClaude("hang", "{}", { timeoutMs: 300 });
  expect(run.result).toEqual({ kind: "timeout" });
  expect(run.evidence).toMatchObject({ ending: "killed", exitCode: null, signal: "SIGKILL", killReason: "timeout", stdoutBytes: 0 });
  expect(run.elapsed).toBeGreaterThanOrEqual(290);
  expect(run.elapsed).toBeLessThan(300 + CLI_KILL_GRACE_MS + CLI_CLOSE_GRACE_MS);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("abort kill: 실행 중 abort 는 killed/cancelled terminal 이고, 자식은 워커 프로세스 그룹에 남는다(D4 detached:false)", async () => {
  stubFake("hang");
  const legacyController = new AbortController();
  const legacyRun = runReviewCli(reviewCliArgs(model), "{}", { timeoutMs: 5_000, signal: legacyController.signal });
  await waitForRecord(); legacyController.abort();
  const legacy = await legacyRun; await clearRecords();
  const controller = new AbortController();
  const pending = native(claudeCall("{}"), { signal: controller.signal });
  const child = await waitForRecord();
  expect(pgid(child.pid)).toBe(pgid(process.pid));
  controller.abort();
  const run = await pending;
  expect(legacy).toEqual({ kind: "cancelled" });
  expect(run.result).toEqual(legacy);
  expect(run.evidence).toMatchObject({ ending: "killed", exitCode: null, signal: "SIGKILL", killReason: "cancelled" });
  expect(alive(child.pid)).toBe(false);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("ENOENT: pid 없이 끝난 spawn 은 spawn_failed terminal(호출 0 의 증명)이고 결과는 legacy 와 같은 missing_cli", async () => {
  const { run, nativeRecords } = await compareClaude("ok", "{}", { command: path.join(root, "missing-cli") });
  expect(run.result).toEqual({ kind: "missing_cli" });
  expect(nativeRecords).toEqual([]);
  expect(run.evidence).toMatchObject({ ending: "spawn_failed", exitCode: null, signal: null, killReason: null, stdoutBytes: 0,
    stdoutHash: EMPTY_SHA256, actualUsage: null, provenance: "unknown" });
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("권한 없음: 실행 비트 없는 명령(EACCES)도 spawn_failed terminal 이고 결과는 legacy 와 같은 cli_error", async () => {
  const { run, nativeRecords } = await compareClaude("ok", "{}", { command: noexec });
  expect(run.result).toEqual({ kind: "cli_error" });
  expect(nativeRecords).toEqual([]);
  expect(run.evidence).toMatchObject({ ending: "spawn_failed", exitCode: null, signal: null });
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("stdout 대용량: 64KiB 를 넘으면 legacy 처럼 output_too_large 로 죽이고 killed terminal, 보관분은 상한 이하다", async () => {
  const { run } = await compareClaude("flood", "{}");
  expect(run.result).toEqual({ kind: "output_too_large" });
  expect(run.evidence).toMatchObject({ ending: "killed", signal: "SIGKILL", killReason: "output_too_large", actualUsage: null });
  expect(run.evidence!.stdoutBytes).toBeLessThanOrEqual(64 * 1024);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("pipe 쥔 손자: 부모 exit 뒤 close 가 유예 안에 오지 않으면 terminal 없이 process_exit, 출력은 버리고 제때 돌아온다", async () => {
  // legacy 는 이 경우 손자가 끝날 때까지 돌아오지 않는다(설계 R3) — 그래서 여기서는 legacy 를 부르지 않는다.
  stubFake("grandchild-hold");
  const run = await native(claudeCall("{}", { timeoutMs: 10_000 }));
  const [child] = await recorded();
  try {
    expect(run.result).toEqual({ kind: "cli_error" });
    expect(run.terminal).toBeNull();
    expect(run.indeterminate).toBe("process_exit");
    expect(run.elapsed).toBeGreaterThanOrEqual(CLI_CLOSE_GRACE_MS - 50);
    expect(run.elapsed).toBeLessThan(10_000);
    expect(alive(child.pid)).toBe(false);
    expect(alive(child.grandchild!)).toBe(true);
  } finally { await reap([child?.grandchild]); }
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("setsid 손자(알려진 한계): 새 세션으로 빠져 stdio 를 닫은 손자는 exit+close 로 보이지 않아 terminal 이 발급된다", async () => {
  const { run, legacyRecords, nativeRecords } = await compareClaude("setsid-grandchild", "{}");
  const grandchildren = [...legacyRecords, ...nativeRecords].map(value => value.grandchild);
  try {
    expect(run.evidence).toMatchObject({ ending: "exited", exitCode: 0, signal: null });
    const escaped = nativeRecords[0].grandchild!;
    expect(alive(escaped)).toBe(true);
    // 워커 그룹 밖이다 — 슈퍼바이저의 그룹 kill 도, 이 runner 의 exit+close 도 이 손자를 보지 못한다(D4 한계).
    expect(pgid(escaped)).not.toBe(pgid(process.pid));
  } finally { await reap(grandchildren); }
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("exit 후 늦은 close: 손자가 유예 안에 pipe 를 닫으면 legacy 와 같은 전체 출력과 terminal 을 낸다", async () => {
  const { run } = await compareClaude("late-close", "{}");
  expect(run.result).toEqual({ kind: "exit", code: 0, stdout: "earlylate", stderr: "" });
  expect(run.evidence).toMatchObject({ ending: "exited", exitCode: 0, stdoutHash: sha("earlylate"), stdoutBytes: 9 });
  expect(run.elapsed).toBeGreaterThanOrEqual(250);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("stderr 만: stdout 이 비고 stderr 만 있어도 legacy 와 같은 결과, 증거는 각 hash·크기를 따로 남긴다", async () => {
  const { run } = await compareClaude("stderr-only", "{}");
  expect(run.result).toEqual({ kind: "exit", code: 2, stdout: "", stderr: "fatal: fake failure\n" });
  expect(run.evidence).toMatchObject({ ending: "exited", exitCode: 2, stdoutHash: EMPTY_SHA256, stdoutBytes: 0,
    stderrHash: sha("fatal: fake failure\n"), stderrBytes: 20, actualUsage: null, provenance: "unknown" });
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("빈 출력: exit 0·출력 없음도 exit+close 면 terminal 이고 usage 는 unknown 이다", async () => {
  const { run } = await compareClaude("empty", "{}");
  expect(run.result).toEqual({ kind: "exit", code: 0, stdout: "", stderr: "" });
  expect(run.evidence).toMatchObject({ ending: "exited", exitCode: 0, stdoutHash: EMPTY_SHA256, stderrHash: EMPTY_SHA256,
    stdoutBytes: 0, stderrBytes: 0, actualUsage: null, provenance: "unknown", reportedCostUsdMicros: null });
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("spawn 전 포기: 이미 abort 된 호출과 틱 여유 부족은 spawn 0 의 one-use 증명으로 not_started 를 낸다(D5)", async () => {
  stubFake("ok");
  const controller = new AbortController(); controller.abort();
  const legacy = await runReviewCli(reviewCliArgs(model), "{}", { timeoutMs: 5_000, signal: controller.signal });
  const aborted = await native(claudeCall("{}"), { signal: controller.signal });
  expect(legacy).toEqual({ kind: "cancelled" });
  expect(aborted.result).toEqual(legacy);
  expect(aborted.evidence).toMatchObject({ ending: "not_started", requestId: aborted.dispatch.requestId, exitCode: null, signal: null,
    killReason: null, stdoutHash: EMPTY_SHA256, stdoutBytes: 0, actualUsage: null });
  const call = prepared(claudeCall("{}")), dispatch = ref(call);
  const terminal = settleCliNotStarted(call, dispatch);
  expect(readCliProcessTerminal(terminal)).toMatchObject({ ending: "not_started", requestId: dispatch.requestId, transport: call.transport });
  await expect(runReservedCliCall(call, ref(call))).rejects.toThrow("cli_call_mismatch");
  expect(settleCliNotStarted(call, ref(call))).toBeNull();
  expect(await recorded()).toEqual([]);
  // 이미 spawn 한 호출은 not_started 로 닫을 수 없다
  const ran = prepared(claudeCall("{}"));
  await runReservedCliCall(ran, ref(ran));
  expect(settleCliNotStarted(ran, ref(ran))).toBeNull();
  expect(await recorded()).toHaveLength(1);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("같은 prepared·같은 requestId 재사용, 다른 transport, 사본 prepared 는 spawn 없이 거절한다", async () => {
  stubFake("ok");
  const call = prepared(claudeCall("{}")), other = prepared(claudeCall("{}")), dispatch = ref(call);
  await expect(runReservedCliCall(other, { requestId: randomUUID(), transport: { ...other.transport, timeoutMs: 1 } })).rejects.toThrow("cli_call_mismatch");
  await expect(runReservedCliCall(other, { requestId: "not-a-uuid", transport: other.transport })).rejects.toThrow("cli_call_mismatch");
  await expect(runReservedCliCall({ ...other }, ref(other))).rejects.toThrow("cli_call_mismatch");
  expect(await recorded()).toEqual([]);
  await runReservedCliCall(call, dispatch);
  await expect(runReservedCliCall(call, ref(call))).rejects.toThrow("cli_call_mismatch");
  await expect(runReservedCliCall(other, { requestId: dispatch.requestId, transport: other.transport })).rejects.toThrow("cli_call_mismatch");
  expect(() => settleCliNotStarted(other, { requestId: dispatch.requestId, transport: other.transport })).toThrow("cli_call_mismatch");
  expect(await recorded()).toHaveLength(1);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("terminal 은 원래 객체만 권한이다 — JSON 사본·펼친 사본·위조는 null 이고 증거는 얼어 있다", async () => {
  stubFake("ok");
  const run = await native(claudeCall("{}"));
  expect(run.evidence).not.toBeNull();
  expect(Object.isFrozen(run.terminal)).toBe(true);
  expect(Object.isFrozen(run.evidence)).toBe(true);
  expect(Object.isFrozen(run.evidence!.transport)).toBe(true);
  expect(readCliProcessTerminal(JSON.parse(JSON.stringify(run.terminal)))).toBeNull();
  expect(readCliProcessTerminal({ ...run.terminal })).toBeNull();
  expect(readCliProcessTerminal({ kind: "cli_process_terminal" })).toBeNull();
  expect(readCliProcessTerminal(JSON.parse(JSON.stringify(run.evidence)))).toBeNull();
  expect(readCliProcessTerminal(null)).toBeNull();
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("보고된 usage 가 C 를 넘으면 계약 모순 — terminal 없이 transport_unknown 이고 출력은 parser 에 넘기지 않는다", async () => {
  stubFake("usage-over");
  const run = await native(claudeCall("{}"));
  expect(run).toMatchObject({ result: { kind: "cli_error" }, terminal: null, indeterminate: "transport_unknown" });
}, PROCESS_TEST_MS);

it("production resolver 는 null 이라 어떤 CLI 호출도 준비되지 않는다", async () => {
  const leaf = await vi.importActual<typeof import("@/lib/llm/cli-serving-contract")>("@/lib/llm/cli-serving-contract");
  for (const provider of ["claude-cli", "grok-cli", "codex-cli"] as const) expect(leaf.resolveCliServingContract("crawl-agent-review", provider, model)).toBeNull();
  const saved = fixture.contracts;
  fixture.contracts = [];
  try { expect(prepareCliCall(claudeCall("{}"))).toEqual({ kind: "unsupported", reason: "provider_contract_unavailable" }); }
  finally { fixture.contracts = saved; }
});

it("계약과 실제 argv·env·입력 크기가 어긋나면 준비하지 않는다 — 공식 C 는 실제 호출 모양에 묶일 때만 증거다", () => {
  const args = reviewCliArgs(model);
  const replace = (flag: string, value: string) => args.map((item, index) => index === args.indexOf(flag) + 1 ? value : item);
  expect(prepareCliCall(claudeCall("{}")).kind).toBe("prepared");
  for (const change of [
    { model: "other-model" }, { args: replace("--model", "other-model") }, { args: replace("--max-turns", "3") },
    { args: [...args, "--max-turns=5"] }, { args: [...args, "--model", model] }, { args: replace("--max-budget-usd", "0.5") },
    { env: { ...claudeEnv(), CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8000" } }, { env: { ...claudeEnv(), CLAUDE_CODE_MAX_OUTPUT_TOKENS: undefined } },
    { boundEnvKeys: [] }, { stdin: "x".repeat(claudeContract.inputByteCap) }, { timeoutMs: 0 }, { maxStdoutBytes: 0 },
    { cwd: "relative/dir" }, { files: [{ path: "../escape.txt", content: "x" }] }, { files: [{ path: "/abs.txt", content: "x" }] },
  ] satisfies Partial<CliCallInput>[]) expect(prepareCliCall(claudeCall("{}", change)).kind, JSON.stringify(Object.keys(change))).toBe("unsupported");
});
