import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { claudeCliTokenBound, type CliProvider } from "@/lib/llm/cli-serving-contract";

/*
 * 운영자가 넣는 CLI 계약 설정(CLI_SERVING_CONTRACTS)과 D7 cliVersion probe. probe 대상은 가짜 CLI(tests/fixtures/fake-cli/fake.mjs)를
 * 부르는 절대경로 sh 래퍼이고 자식 PATH 는 빈 디렉터리다 — 실제 claude/grok/codex 는 띄우지 않는다.
 * probe 결과는 프로세스 상태라 테스트마다 모듈을 새로 읽는다.
 */
type Contracts = typeof import("@/lib/llm/cli-serving-contract");
type Recorded = { mode: string; pid: number; argv: string[]; realCliOnPath: boolean; grandchild?: number };
type Key = { routeId: string; provider: string; model: string };
const PROCESS_TEST_MS = 20_000;
const shape = { maxTurns: 2, inputByteCap: 75_000, overheadTokenBound: 5_000, outputTokensPerTurn: 2_000 };
const ai1 = { version: 1, protocol: "cli-process-v1", routeId: "crawl-agent-review", provider: "claude-cli", model: "sonnet",
  cliVersion: "claude 9.9.9", totalTokenBound: claudeCliTokenBound(shape), costBoundUsdMicros: 150_000, boundProvenance: "derived", ...shape } as const;
const intro = { ...ai1, routeId: "product-intro-check" } as const;
const ai2 = { version: 1, protocol: "cli-process-v1", routeId: "second-review", provider: "grok-cli", model: "grok-4.7",
  cliVersion: "grok 9.9.9", inputByteCap: 75_000, totalTokenBound: 120_000, costBoundUsdMicros: null, boundProvenance: "declared" } as const;
let root = "", empty = "", records = "", fake = "", wrappers = 0;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "nmv-cli-contract-"));
  empty = path.join(root, "empty-path"); records = path.join(root, "records");
  await mkdir(empty); await mkdir(records);
  fake = path.resolve("tests/fixtures/fake-cli/fake.mjs");
  for (const value of [root, fake, process.execPath]) expect(value).not.toContain("'");
});
afterAll(() => rm(root, { recursive: true, force: true }));
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const name of await readdir(records)) await rm(path.join(records, name));
});

/** 모드와 --version 출력을 고정한 가짜 CLI — 한 probe 안에서 provider 마다 다르게 끝나게 한다 */
async function cli(mode: string, version = "", permissions = 0o755): Promise<string> {
  expect(version).not.toContain("'");
  const file = path.join(root, `cli-${++wrappers}`);
  await writeFile(file, `#!/bin/sh\nFAKE_CLI_MODE='${mode}' FAKE_CLI_VERSION='${version}' exec '${process.execPath}' '${fake}' "$@"\n`);
  await chmod(file, permissions);
  return file;
}
/** 설정과 호출자가 띄울 명령을 세우고 모듈을 새로 읽는다 */
async function load(contracts: unknown, commands: { claude?: string; grok?: string } = {}): Promise<Contracts> {
  vi.stubEnv("PATH", empty); vi.stubEnv("FAKE_CLI_RECORD", records);
  vi.stubEnv("CLI_SERVING_CONTRACTS", contracts === undefined ? undefined : typeof contracts === "string" ? contracts : JSON.stringify(contracts));
  vi.stubEnv("CLAUDE_CLI", commands.claude ?? path.join(root, "absent-claude"));
  vi.stubEnv("GROK_CLI", commands.grok ?? path.join(root, "absent-grok"));
  vi.resetModules();
  return import("@/lib/llm/cli-serving-contract");
}
async function recorded(): Promise<Recorded[]> {
  const names = await readdir(records);
  return Promise.all(names.map(async name => JSON.parse(await readFile(path.join(records, name), "utf8")) as Recorded));
}
const resolved = (mod: Contracts, key: Key) => mod.resolveCliServingContract(key.routeId, key.provider as CliProvider, key.model);
const status = (mod: Contracts, key: Key) => mod.cliServingContractStatus(key.routeId, key.provider as CliProvider, key.model);
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}
async function reap(pids: (number | undefined)[]) {
  for (const pid of pids) if (pid) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  for (const pid of pids) if (pid) { for (let i = 0; i < 300 && alive(pid); i++) await sleep(10); expect(alive(pid)).toBe(false); }
}

it("설정이 없으면 probe 는 아무것도 띄우지 않고 모든 계약이 null 이다", async () => {
  const claude = await cli("version", "claude 9.9.9");
  for (const value of [undefined, "", "  ", "[]"]) {
    const mod = await load(value, { claude });
    expect(resolved(mod, ai1)).toBeNull();
    expect(status(mod, ai1)).toBe("probe_pending");
    expect(await mod.probeCliServingContracts()).toEqual([]);
    expect(resolved(mod, ai1)).toBeNull();
    expect(status(mod, ai1), JSON.stringify(value)).toBe("not_configured");
  }
  expect(await recorded()).toEqual([]);
}, PROCESS_TEST_MS);

it("정상 계약은 probe 가 cliVersion 을 맞춘 뒤에만 열리고, CLI 마다 --version 을 한 번만 띄운다", async () => {
  const mod = await load([ai1, intro, ai2], { claude: await cli("version", "claude 9.9.9"), grok: await cli("version", "grok 9.9.9") });
  expect(resolved(mod, ai1)).toBeNull();
  const first = mod.probeCliServingContracts();
  expect(mod.probeCliServingContracts()).toBe(first);
  expect(await first).toEqual([ai1, intro, ai2].map((value, index) => ({ index, routeId: value.routeId, provider: value.provider,
    model: value.model, status: "ready", observedVersion: null })));
  for (const value of [ai1, intro, ai2]) {
    expect(resolved(mod, value)).toEqual(value);
    expect(Object.isFrozen(resolved(mod, value))).toBe(true);
    expect(status(mod, value)).toBe("ready");
  }
  // 설정에 없는 route·provider·model 은 열리지 않는다
  for (const key of [{ ...ai1, routeId: "second-review" }, { ...ai1, model: "opus" }, { ...ai1, provider: "grok-cli" }, { ...ai1, provider: "codex-cli" }]) {
    expect(resolved(mod, key)).toBeNull();
    expect(status(mod, key)).toBe("not_configured");
  }
  const spawned = await recorded();
  expect(spawned.map(value => [value.mode, value.argv, value.realCliOnPath])).toEqual([["version", ["--version"], false], ["version", ["--version"], false]]);
  await mod.probeCliServingContracts();
  expect(await recorded()).toHaveLength(2);
  // probe 한 명령과 지금 호출자가 띄울 명령이 다르면 그 버전 확인은 이 호출의 근거가 아니다
  vi.stubEnv("CLAUDE_CLI", path.join(root, "other-claude"));
  expect(resolved(mod, ai1)).toBeNull();
  expect(status(mod, ai1)).toBe("cli_command_changed");
  expect(resolved(mod, ai2)).toEqual(ai2);
}, PROCESS_TEST_MS);

it("항목 오류는 그 항목만 닫고 다른 항목을 열거나 닫지 않는다", async () => {
  const { totalTokenBound: _bound, ...grokWithoutBound } = ai2;
  expect(_bound).toBe(120_000);
  const entries: [unknown, string][] = [
    [ai1, "ready"],
    [{ ...intro, totalTokenBound: intro.totalTokenBound - 1 }, "invalid_entry"],
    // Claude 는 derived 공식으로만, Grok·codex 는 declared bound 로만 들어온다
    [{ ...ai2, routeId: "product-audit", provider: "claude-cli", model: "sonnet" }, "invalid_entry"],
    [{ ...ai2, boundProvenance: "derived" }, "invalid_entry"],
    [{ ...grokWithoutBound, model: "grok-nobound" }, "invalid_entry"],
    // 같은 route·provider·model 이 둘이면 어느 것도 고르지 않는다 — 한쪽이 오류여도 같다
    [{ ...ai2, model: "grok-dup" }, "duplicate_entry"],
    [{ ...ai2, model: "grok-dup", cliVersion: "grok 9.9.8" }, "duplicate_entry"],
    [{ ...ai1, model: "dup-bad" }, "duplicate_entry"],
    [{ ...ai1, model: "dup-bad", totalTokenBound: 1 }, "duplicate_entry"],
    // 장부 kind 가 받지 않는 route·CLI 조합과 모르는 route
    [{ ...ai2, routeId: "product-audit" }, "invalid_entry"],
    [{ ...ai2, routeId: "crawl-agent-review", provider: "codex-cli", model: "gpt-5.3-codex-spark" }, "invalid_entry"],
    [{ ...ai1, routeId: "constructor", model: "proto" }, "invalid_entry"],
    [{ ...ai1, routeId: "crawl-publish", model: "classify" }, "invalid_entry"],
    [{ ...ai1, model: "opus", extra: true }, "invalid_entry"],
    [{ ...ai1, model: "padded", cliVersion: " claude 9.9.9" }, "invalid_entry"],
    ["not-an-object", "invalid_entry"],
    [null, "invalid_entry"],
    [{ ...ai2, model: "grok-4.8" }, "ready"],
  ];
  const mod = await load(entries.map(([value]) => value), { claude: await cli("version", "claude 9.9.9"), grok: await cli("version", "grok 9.9.9") });
  const reports = await mod.probeCliServingContracts();
  expect(reports.map(report => [report.index, report.status])).toEqual(entries.map(([, expected], index) => [index, expected]));
  expect(reports[15]).toEqual({ index: 15, routeId: null, provider: null, model: null, status: "invalid_entry", observedVersion: null });
  for (const [value, expected] of entries) {
    if (!value || typeof value !== "object") continue;
    const key = value as Key;
    expect(resolved(mod, key) === null, JSON.stringify(value)).toBe(expected !== "ready");
    if (expected === "ready") expect(resolved(mod, key)).toEqual(value);
    // 오류 항목의 key 상태는 그 항목의 사유다 — 다만 오류 항목이 정상 항목의 key 를 쓰면 둘 다 닫힌다
    else expect(status(mod, key), JSON.stringify(value)).toBe(expected);
  }
  // 정상 항목의 CLI 만 probe 한다
  expect((await recorded()).map(value => value.argv)).toEqual([["--version"], ["--version"]]);
}, PROCESS_TEST_MS);

it("설정 전체가 계약 JSON 배열이 아니면 아무 계약도 열지 않고 probe 도 띄우지 않는다", async () => {
  const claude = await cli("version", "claude 9.9.9");
  const tooMany = Array.from({ length: 33 }, (_, index) => ({ ...ai1, model: `model-${index}` }));
  for (const value of ["{", "null", JSON.stringify(ai1), JSON.stringify({ contracts: [ai1] }), JSON.stringify(tooMany)]) {
    const mod = await load(value, { claude });
    expect(await mod.probeCliServingContracts()).toEqual([{ index: null, routeId: null, provider: null, model: null,
      status: "invalid_config", observedVersion: null }]);
    expect(resolved(mod, ai1)).toBeNull();
    expect(status(mod, ai1)).toBe("invalid_config");
  }
  expect(await recorded()).toEqual([]);
}, PROCESS_TEST_MS);

it("D7: 설치된 CLI 의 --version 이 cliVersion 과 다르면 그 CLI 의 계약만 null 이고 관측 버전을 보고한다", async () => {
  const mod = await load([ai1, intro, ai2], { claude: await cli("version", "claude 9.9.10"), grok: await cli("version", "grok 9.9.9") });
  const reports = await mod.probeCliServingContracts();
  expect(reports.map(report => [report.index, report.status, report.observedVersion])).toEqual([
    [0, "cli_version_mismatch", "claude 9.9.10"], [1, "cli_version_mismatch", "claude 9.9.10"], [2, "ready", null]]);
  expect(resolved(mod, ai1)).toBeNull();
  expect(resolved(mod, intro)).toBeNull();
  expect(status(mod, ai1)).toBe("cli_version_mismatch");
  expect(resolved(mod, ai2)).toEqual(ai2);
  // 접두·대소문자·여러 줄은 같은 버전이 아니다. 계약 칸에 넣을 수 없는 출력은 관측 버전으로도 싣지 않는다
  for (const [output, observed] of [["claude 9.9.9 (beta)", "claude 9.9.9 (beta)"], ["Claude 9.9.9", "Claude 9.9.9"],
    ["claude 9.9.9\nextra", null], ["", null]] as const) {
    const again = await load([ai1], { claude: await cli("version", output) });
    expect((await again.probeCliServingContracts()).map(report => [report.status, report.observedVersion]), JSON.stringify(output))
      .toEqual([["cli_version_mismatch", observed]]);
    expect(resolved(again, ai1)).toBeNull();
  }
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("probe 가 제한 시간 안에 끝나지 않으면(멈춤·close 없는 exit) 계약은 null 이고 probe 는 제한 시간 뒤 곧 돌아온다", async () => {
  const mod = await load([ai1, ai2], { claude: await cli("hang"), grok: await cli("grandchild-hold") });
  const started = Date.now();
  try {
    const reports = await mod.probeCliServingContracts();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(mod.CLI_VERSION_PROBE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(mod.CLI_VERSION_PROBE_TIMEOUT_MS + 2_000);
    expect(reports.map(report => report.status)).toEqual(["cli_version_probe_timeout", "cli_version_probe_timeout"]);
    expect(resolved(mod, ai1)).toBeNull();
    expect(resolved(mod, ai2)).toBeNull();
    expect(status(mod, ai2)).toBe("cli_version_probe_timeout");
    // 멈춘 CLI 는 probe 가 죽인다
    const hung = (await recorded()).find(value => value.mode === "hang")!;
    for (let i = 0; i < 300 && alive(hung.pid); i++) await sleep(10);
    expect(alive(hung.pid)).toBe(false);
  } finally { await reap([(await recorded()).find(value => value.mode === "grandchild-hold")?.grandchild]); }
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("probe 가 실패하면(0 이 아닌 종료·출력 과다·실행 파일 없음·실행 권한 없음) 계약은 null 이다", async () => {
  for (const commands of [{ claude: await cli("stderr-only"), grok: await cli("flood") }, {},
    { claude: await cli("version", "claude 9.9.9", 0o644), grok: await cli("version", "grok 9.9.9", 0o644) }]) {
    const mod = await load([ai1, ai2], commands);
    expect((await mod.probeCliServingContracts()).map(report => report.status), JSON.stringify(commands))
      .toEqual(["cli_version_probe_failed", "cli_version_probe_failed"]);
    expect(resolved(mod, ai1)).toBeNull();
    expect(resolved(mod, ai2)).toBeNull();
  }
}, PROCESS_TEST_MS);

// withRuntimeProcess 는 IPC 를 끊으므로 vitest 워커 안에서 부르지 않고, 운영처럼 tsx 로 띄운 별도 node 프로세스에서 확인한다
it.skipIf(process.platform === "win32")("reviewer 프로세스는 시작할 때 probe 를 마친 뒤에 일을 시작하고, 다른 역할은 probe 하지 않는다", async () => {
  const claude = await cli("version", "claude 9.9.9");
  const script = `const { withRuntimeProcess } = await import(${JSON.stringify(path.resolve("scripts/worker.ts"))});
const { resolveCliServingContract } = await import(${JSON.stringify(path.resolve("lib/llm/cli-serving-contract.ts"))});
for (const role of ["publisher", "reviewer"]) {
  const contract = await withRuntimeProcess(role, async () => resolveCliServingContract("crawl-agent-review", "claude-cli", "sonnet"));
  console.log(JSON.stringify({ event: "test.resolved", role, contract }));
}`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), timeout: 15_000, env: { ...process.env, PATH: empty, FAKE_CLI_RECORD: records,
      CLI_SERVING_CONTRACTS: JSON.stringify([ai1]), CLAUDE_CLI: claude, GROK_CLI: path.join(root, "absent-grok") } });
  const lines = stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  expect(lines.map(line => line.event === "test.resolved" ? [line.role, line.contract] : [line.event, line.status])).toEqual([
    ["publisher", null], ["cli_contract.probe", "ready"], ["reviewer", ai1]]);
  expect(lines[1]).toMatchObject({ index: 0, routeId: ai1.routeId, provider: ai1.provider, model: ai1.model, observedVersion: null });
  expect(await recorded()).toHaveLength(1);
}, PROCESS_TEST_MS);
