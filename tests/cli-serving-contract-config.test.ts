import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { claudeCliTokenBound, cliContractRouteId, type CliProvider } from "@/lib/llm/cli-serving-contract";
import { setServingContractSnapshotForTest, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { fakeToolDir } from "./fake-cli-path";

/*
 * CLI 계약 설정과 D7 cliVersion probe. 실제 claude/grok/codex 는 띄우지 않는다 — probe 대상은 가짜 CLI(tests/fixtures/fake-cli/fake.mjs)를 부르는 sh 래퍼다.
 * - 감사·소개 검수·분류(env 계약 route): 운영자가 넣는 CLI_SERVING_CONTRACTS 와 호출자가 띄울 명령(CLAUDE_CLI·CODEX_CLI 절대경로 래퍼)을 probe 한다.
 *   자식 PATH 는 빈 디렉터리다.
 * - 1차·2차 심사·Grok 로그인 유지(DB 계약 route, PR C1): 계약은 serving 계약 스냅숏의 `cli:<provider>:<route>` 행뿐이고 env 항목은 route_reads_db 다.
 *   버전은 PATH 의 도구 이름(claude·grok)을 probe 한다 — 시험은 래퍼를 그 이름으로 링크한 디렉터리를 PATH 로 쓴다. CLAUDE_CLI·GROK_CLI 는 읽지 않는다.
 * probe 결과는 프로세스 상태라 테스트마다 모듈을 새로 읽는다.
 */
type Contracts = typeof import("@/lib/llm/cli-serving-contract");
type Recorded = { mode: string; pid: number; argv: string[]; realCliOnPath: boolean; grandchild?: number };
type Key = { routeId: string; provider: string; model: string };
const PROCESS_TEST_MS = 20_000;
const shape = { maxTurns: 2, inputByteCap: 75_000, overheadTokenBound: 5_000, outputTokensPerTurn: 2_000 };
// env 계약 route
const audit = { version: 1, protocol: "cli-process-v1", routeId: "product-audit", provider: "claude-cli", model: "sonnet",
  cliVersion: "claude 9.9.9", totalTokenBound: claudeCliTokenBound(shape), costBoundUsdMicros: 150_000, boundProvenance: "derived", ...shape } as const;
const intro = { ...audit, routeId: "product-intro-check" } as const;
// 2026-11-09 부터 감사 경로(product-audit)의 Claude 계약은 DB 행이다 — env 계약의 세 번째 Claude 항목은 분류 route 의 Claude 다
const classifyClaude = { ...audit, routeId: "crawl-publish-classify" } as const;
const classify = { version: 1, protocol: "cli-process-v1", routeId: "crawl-publish-classify", provider: "codex-cli", model: "gpt-5.3-codex-spark",
  cliVersion: "codex 9.9.9", inputByteCap: 75_000, totalTokenBound: 120_000, costBoundUsdMicros: null, boundProvenance: "declared" } as const;
// DB 계약 route
const ai1 = { ...audit, routeId: "crawl-agent-review" } as const;
const ai2 = { version: 1, protocol: "cli-process-v1", routeId: "second-review", provider: "grok-cli", model: "grok-4.7",
  cliVersion: "grok 9.9.9", inputByteCap: 75_000, totalTokenBound: 120_000, costBoundUsdMicros: null, boundProvenance: "declared" } as const;
const session = { ...ai2, routeId: "grok-session-check", inputByteCap: 16_384, totalTokenBound: 32_768 } as const;
/** PATH 에 claude·grok 이 없을 때 DB 계약 route 의 도구 probe 보고(띄우지 못해 실패, 기록 없음) */
const TOOLS_ABSENT = (["claude-cli", "grok-cli"] as const).map(provider => ({ index: null, routeId: null, provider, model: null,
  status: "cli_version_probe_failed", observedVersion: null }));
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
  setServingContractSnapshotForTest(null);
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
/** 설정과 호출자가 띄울 명령을 세우고 모듈을 새로 읽는다. path 는 DB 계약 route 의 도구(claude·grok)를 찾을 PATH 다(없으면 빈 디렉터리) */
async function load(contracts: unknown, commands: { claude?: string; grok?: string; codex?: string; path?: string } = {}): Promise<Contracts> {
  // All DB contracts here are pinned snapshots; background reloads must not race the version probes.
  vi.stubEnv("MODEL_SERVING_CONTRACTS_DB", "0");
  vi.stubEnv("PATH", commands.path ?? empty); vi.stubEnv("FAKE_CLI_RECORD", records);
  vi.stubEnv("CLI_SERVING_CONTRACTS", contracts === undefined ? undefined : typeof contracts === "string" ? contracts : JSON.stringify(contracts));
  vi.stubEnv("CLAUDE_CLI", commands.claude ?? path.join(root, "absent-claude"));
  vi.stubEnv("GROK_CLI", commands.grok ?? path.join(root, "absent-grok"));
  vi.stubEnv("CODEX_CLI", commands.codex ?? path.join(root, "absent-codex"));
  vi.resetModules();
  return import("@/lib/llm/cli-serving-contract");
}
async function recorded(): Promise<Recorded[]> {
  const names = await readdir(records);
  return Promise.all(names.map(async name => JSON.parse(await readFile(path.join(records, name), "utf8")) as Recorded));
}
const resolved = (mod: Contracts, key: Key) => mod.resolveCliServingContract(key.routeId, key.provider as CliProvider, key.model);
const status = (mod: Contracts, key: Key) => mod.cliServingContractStatus(key.routeId, key.provider as CliProvider, key.model);
/** 「작업 ↔ 모델」 순위 저장이 만든 CLI 계약 행 — route_id 와 계약 JSON 의 routeId 는 `cli:<provider>:<route>` 다 */
function dbRow(contract: Key & Record<string, unknown>, change: Partial<{ routeId: string; model: string; contract: unknown }> = {}): StoredServingContract {
  const routeId = change.routeId ?? cliContractRouteId(contract.provider as CliProvider, contract.routeId);
  return { routeId, model: change.model ?? contract.model, contract: "contract" in change ? change.contract : { ...contract, routeId }, auth: "none",
    apiKey: null, transport: "direct" };
}
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
    expect(resolved(mod, intro)).toBeNull();
    expect(status(mod, intro)).toBe("probe_pending");
    // DB 계약 route 는 env 와 무관하게 행이 없으면 not_configured 다(probe 전에도)
    expect(status(mod, ai1)).toBe("not_configured");
    // env 계약이 없으면 env CLI 는 띄우지 않는다 — DB 계약 route 의 도구 probe 는 PATH(빈 디렉터리)에서 찾지 못해 실패로 보고된다
    expect(await mod.probeCliServingContracts()).toEqual(TOOLS_ABSENT);
    expect(resolved(mod, intro)).toBeNull();
    expect(status(mod, intro), JSON.stringify(value)).toBe("not_configured");
    expect(status(mod, ai1)).toBe("not_configured");
  }
  expect(await recorded()).toEqual([]);
}, PROCESS_TEST_MS);

it("정상 계약은 probe 가 cliVersion 을 맞춘 뒤에만 열리고, CLI 마다 --version 을 한 번만 띄운다", async () => {
  const mod = await load([intro, classifyClaude, classify], { claude: await cli("version", "claude 9.9.9"), codex: await cli("version", "codex 9.9.9") });
  expect(resolved(mod, intro)).toBeNull();
  const first = mod.probeCliServingContracts();
  expect(mod.probeCliServingContracts()).toBe(first);
  expect(await first).toEqual([...[intro, classifyClaude, classify].map((value, index) => ({ index, routeId: value.routeId, provider: value.provider,
    model: value.model, status: "ready", observedVersion: null })), ...TOOLS_ABSENT]);
  for (const value of [intro, classifyClaude, classify]) {
    expect(resolved(mod, value)).toEqual(value);
    expect(Object.isFrozen(resolved(mod, value))).toBe(true);
    expect(status(mod, value)).toBe("ready");
  }
  // 설정에 없는 route·provider·model 은 열리지 않는다
  for (const key of [{ ...intro, routeId: "crawl-publish-classify", model: "unlisted" }, { ...intro, model: "opus" }, { ...intro, provider: "grok-cli" },
    { ...intro, provider: "codex-cli" }, { ...classify, provider: "claude-cli" }]) {
    expect(resolved(mod, key)).toBeNull();
    expect(status(mod, key)).toBe("not_configured");
  }
  const spawned = await recorded();
  expect(spawned.map(value => [value.mode, value.argv, value.realCliOnPath])).toEqual([["version", ["--version"], false], ["version", ["--version"], false]]);
  await mod.probeCliServingContracts();
  expect(await recorded()).toHaveLength(2);
  // probe 한 명령과 지금 호출자가 띄울 명령이 다르면 그 버전 확인은 이 호출의 근거가 아니다
  vi.stubEnv("CLAUDE_CLI", path.join(root, "other-claude"));
  expect(resolved(mod, intro)).toBeNull();
  expect(status(mod, intro)).toBe("cli_command_changed");
  expect(resolved(mod, classify)).toEqual(classify);
  // env 계약 route 의 명령은 예전 그대로 env 경로다
  expect(mod.cliCommandFor("product-intro-check", "claude-cli")).toBe(path.join(root, "other-claude"));
}, PROCESS_TEST_MS);

it("항목 오류는 그 항목만 닫고 다른 항목을 열거나 닫지 않는다 — DB 계약 route 의 env 항목은 읽지 않는다(route_reads_db)", async () => {
  const { totalTokenBound: _bound, ...codexWithoutBound } = classify;
  expect(_bound).toBe(120_000);
  const entries: [unknown, string][] = [
    [intro, "ready"],
    [{ ...classifyClaude, totalTokenBound: audit.totalTokenBound - 1 }, "invalid_entry"],
    // Claude 는 derived 공식으로만, Grok·codex 는 declared bound 로만 들어온다
    [{ ...classify, routeId: "product-intro-check", provider: "claude-cli", model: "declared-claude" }, "invalid_entry"],
    [{ ...classify, boundProvenance: "derived" }, "invalid_entry"],
    [{ ...codexWithoutBound, model: "codex-nobound" }, "invalid_entry"],
    // 같은 route·provider·model 이 둘이면 어느 것도 고르지 않는다 — 한쪽이 오류여도 같다
    [{ ...classify, model: "codex-dup" }, "duplicate_entry"],
    [{ ...classify, model: "codex-dup", cliVersion: "codex 9.9.8" }, "duplicate_entry"],
    [{ ...intro, model: "dup-bad" }, "duplicate_entry"],
    [{ ...intro, model: "dup-bad", totalTokenBound: 1 }, "duplicate_entry"],
    // 장부 kind 가 받지 않는 route·CLI 조합과 모르는 route
    [{ ...classify, routeId: "product-intro-check", model: "codex-on-intro" }, "invalid_entry"],
    [{ ...ai2, routeId: "product-intro-check" }, "invalid_entry"],
    [{ ...intro, routeId: "constructor", model: "proto" }, "invalid_entry"],
    [{ ...intro, routeId: "crawl-publish", model: "classify" }, "invalid_entry"],
    [{ ...intro, model: "opus", extra: true }, "invalid_entry"],
    [{ ...intro, model: "padded", cliVersion: " claude 9.9.9" }, "invalid_entry"],
    ["not-an-object", "invalid_entry"],
    [null, "invalid_entry"],
    // 1차·2차·Grok 로그인 유지의 env 항목은 모양이 맞든 틀리든 읽지 않는다 — 계약은 순위 저장이 만든 DB 행뿐이다
    [ai1, "route_reads_db"], [ai2, "route_reads_db"], [session, "route_reads_db"], [{ ...ai1, model: "broken", extra: true }, "route_reads_db"],
    [{ ...ai1, model: "dup-db" }, "route_reads_db"], [{ ...ai1, model: "dup-db" }, "route_reads_db"],
    [{ ...classify, model: "gpt-5.4" }, "ready"],
  ];
  const mod = await load(entries.map(([value]) => value), { claude: await cli("version", "claude 9.9.9"), codex: await cli("version", "codex 9.9.9") });
  const reports = await mod.probeCliServingContracts();
  expect(reports.slice(0, entries.length).map(report => [report.index, report.status])).toEqual(entries.map(([, expected], index) => [index, expected]));
  expect(reports.slice(entries.length)).toEqual(TOOLS_ABSENT);
  expect(reports[15]).toEqual({ index: 15, routeId: null, provider: null, model: null, status: "invalid_entry", observedVersion: null });
  expect(reports[17]).toEqual({ index: 17, routeId: ai1.routeId, provider: ai1.provider, model: ai1.model, status: "route_reads_db", observedVersion: null });
  for (const [value, expected] of entries) {
    if (!value || typeof value !== "object") continue;
    const key = value as Key;
    expect(resolved(mod, key) === null, JSON.stringify(value)).toBe(expected !== "ready");
    if (expected === "ready") expect(resolved(mod, key)).toEqual(value);
    // DB 계약 route 는 DB 행만 본다 — 행이 없으니 not_configured 다
    else if (expected === "route_reads_db") expect(status(mod, key), JSON.stringify(value)).toBe("not_configured");
    // 오류 항목의 key 상태는 그 항목의 사유다 — 다만 오류 항목이 정상 항목의 key 를 쓰면 둘 다 닫힌다
    else expect(status(mod, key), JSON.stringify(value)).toBe(expected);
  }
  // 정상 env 항목의 CLI 만 probe 한다(DB 계약 route 의 도구는 PATH 에 없어 띄우지 못했다)
  expect((await recorded()).map(value => value.argv)).toEqual([["--version"], ["--version"]]);
}, PROCESS_TEST_MS);

it("설정 전체가 계약 JSON 배열이 아니면 아무 계약도 열지 않고 probe 도 띄우지 않는다", async () => {
  const claude = await cli("version", "claude 9.9.9");
  const tooMany = Array.from({ length: 33 }, (_, index) => ({ ...intro, model: `model-${index}` }));
  for (const value of ["{", "null", JSON.stringify(intro), JSON.stringify({ contracts: [intro] }), JSON.stringify(tooMany)]) {
    const mod = await load(value, { claude });
    expect(await mod.probeCliServingContracts()).toEqual([{ index: null, routeId: null, provider: null, model: null,
      status: "invalid_config", observedVersion: null }, ...TOOLS_ABSENT]);
    expect(resolved(mod, intro)).toBeNull();
    expect(status(mod, intro)).toBe("invalid_config");
    // 깨진 env 설정은 DB 계약 route 의 판정에 끼지 않는다
    expect(status(mod, ai1)).toBe("not_configured");
  }
  expect(await recorded()).toEqual([]);
}, PROCESS_TEST_MS);

it("D7: 설치된 CLI 의 --version 이 cliVersion 과 다르면 그 CLI 의 계약만 null 이고 관측 버전을 보고한다", async () => {
  const mod = await load([intro, classifyClaude, classify], { claude: await cli("version", "claude 9.9.10"), codex: await cli("version", "codex 9.9.9") });
  const reports = await mod.probeCliServingContracts();
  expect(reports.slice(0, 3).map(report => [report.index, report.status, report.observedVersion])).toEqual([
    [0, "cli_version_mismatch", "claude 9.9.10"], [1, "cli_version_mismatch", "claude 9.9.10"], [2, "ready", null]]);
  expect(resolved(mod, intro)).toBeNull();
  expect(resolved(mod, classifyClaude)).toBeNull();
  expect(status(mod, intro)).toBe("cli_version_mismatch");
  expect(resolved(mod, classify)).toEqual(classify);
  // 접두·대소문자·여러 줄은 같은 버전이 아니다. 계약 칸에 넣을 수 없는 출력은 관측 버전으로도 싣지 않는다
  for (const [output, observed] of [["claude 9.9.9 (beta)", "claude 9.9.9 (beta)"], ["Claude 9.9.9", "Claude 9.9.9"],
    ["claude 9.9.9\nextra", null], ["", null]] as const) {
    const again = await load([intro], { claude: await cli("version", output) });
    expect((await again.probeCliServingContracts()).slice(0, 1).map(report => [report.status, report.observedVersion]), JSON.stringify(output))
      .toEqual([["cli_version_mismatch", observed]]);
    expect(resolved(again, intro)).toBeNull();
  }
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("probe 가 제한 시간 안에 끝나지 않으면(멈춤·close 없는 exit) 계약은 null 이고 probe 는 제한 시간 뒤 곧 돌아온다", async () => {
  const mod = await load([intro, classify], { claude: await cli("hang"), codex: await cli("grandchild-hold") });
  const started = Date.now();
  try {
    const reports = await mod.probeCliServingContracts();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(mod.CLI_VERSION_PROBE_TIMEOUT_MS - 50);
    expect(elapsed).toBeLessThan(mod.CLI_VERSION_PROBE_TIMEOUT_MS + 2_000);
    expect(reports.map(report => report.status)).toEqual(["cli_version_probe_timeout", "cli_version_probe_timeout", ...TOOLS_ABSENT.map(row => row.status)]);
    expect(resolved(mod, intro)).toBeNull();
    expect(resolved(mod, classify)).toBeNull();
    expect(status(mod, classify)).toBe("cli_version_probe_timeout");
    // 멈춘 CLI 는 probe 가 죽인다
    const hung = (await recorded()).find(value => value.mode === "hang")!;
    for (let i = 0; i < 300 && alive(hung.pid); i++) await sleep(10);
    expect(alive(hung.pid)).toBe(false);
  } finally { await reap([(await recorded()).find(value => value.mode === "grandchild-hold")?.grandchild]); }
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("probe 가 실패하면(0 이 아닌 종료·출력 과다·실행 파일 없음·실행 권한 없음) 계약은 null 이다", async () => {
  for (const commands of [{ claude: await cli("stderr-only"), codex: await cli("flood") }, {},
    { claude: await cli("version", "claude 9.9.9", 0o644), codex: await cli("version", "codex 9.9.9", 0o644) }]) {
    const mod = await load([intro, classify], commands);
    expect((await mod.probeCliServingContracts()).slice(0, 2).map(report => report.status), JSON.stringify(commands))
      .toEqual(["cli_version_probe_failed", "cli_version_probe_failed"]);
    expect(resolved(mod, intro)).toBeNull();
    expect(resolved(mod, classify)).toBeNull();
  }
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("1차·2차·Grok 로그인 유지: 계약은 DB 행(cli:<provider>:<route>)에서만 오고, PATH 의 도구 버전을 probe 한 뒤에만 열린다", async () => {
  const tools = await fakeToolDir(path.join(root, "db-tools"), { claude: await cli("version", "claude 9.9.9"), grok: await cli("version", "grok 9.9.9") });
  // env 경로·env 계약은 읽지 않는다 — CLAUDE_CLI·GROK_CLI 는 없는 파일, CLI_SERVING_CONTRACTS 에는 같은 계약을 넣어 둔다
  const mod = await load([ai1, ai2], { path: tools });
  expect(mod.cliContractRouteId("claude-cli", "crawl-agent-review")).toBe("cli:claude-cli:crawl-agent-review");
  for (const routeId of ["crawl-agent-review", "second-review", "grok-session-check"]) {
    expect(mod.cliCommandFor(routeId, "claude-cli")).toBe("claude");
    expect(mod.cliCommandFor(routeId, "grok-cli")).toBe("grok");
  }
  // 감사 경로(product-audit)도 2026-11-09 부터 DB 계약 route 다 — PATH 의 도구 이름. 소개 검수는 env 경로 그대로
  expect(mod.cliCommandFor("product-audit", "claude-cli")).toBe("claude");
  expect(mod.cliCommandFor("product-intro-check", "claude-cli")).toBe(path.join(root, "absent-claude"));
  expect(mod.CLI_TOOL_COMMANDS).toEqual({ "claude-cli": "claude", "grok-cli": "grok", "codex-cli": "codex", "opencode-cli": "opencode" });
  // 행이 없으면 not_configured(probe 전에도)
  expect(status(mod, ai1)).toBe("not_configured");
  setServingContractSnapshotForTest([dbRow(ai1), dbRow(ai2), dbRow(session), dbRow({ ...ai1, model: "opus", cliVersion: "claude 9.9.8" })]);
  // probe 하지 않은 프로세스(웹)는 버전을 모른다 — 계약은 아직 닫혀 있다
  for (const value of [ai1, ai2, session]) {
    expect(status(mod, value)).toBe("probe_pending");
    expect(resolved(mod, value)).toBeNull();
  }
  expect(mod.cliServingContractDiagnosis(ai1.routeId, "claude-cli", ai1.model)).toEqual({ status: "probe_pending", observedVersion: null });
  expect(mod.observedCliToolVersion("claude-cli")).toBeNull();
  expect(await recorded()).toEqual([]);

  const reports = await mod.probeCliServingContracts();
  expect(reports).toEqual([
    { index: 0, routeId: ai1.routeId, provider: ai1.provider, model: ai1.model, status: "route_reads_db", observedVersion: null },
    { index: 1, routeId: ai2.routeId, provider: ai2.provider, model: ai2.model, status: "route_reads_db", observedVersion: null },
    // 도구 probe 의 보고는 routeId·model 없이 본 버전을 싣는다(운영자가 연결에 적을 버전)
    { index: null, routeId: null, provider: "claude-cli", model: null, status: "ready", observedVersion: "claude 9.9.9" },
    { index: null, routeId: null, provider: "grok-cli", model: null, status: "ready", observedVersion: "grok 9.9.9" },
  ]);
  // 계약 JSON 의 routeId 접두는 떼어 원래 route 의 계약으로 돌아온다
  for (const value of [ai1, ai2, session]) {
    expect(resolved(mod, value)).toEqual(value);
    expect(Object.isFrozen(resolved(mod, value))).toBe(true);
    expect(status(mod, value)).toBe("ready");
  }
  expect(mod.observedCliToolVersion("claude-cli")).toBe("claude 9.9.9");
  expect(mod.observedCliToolVersion("grok-cli")).toBe("grok 9.9.9");
  // 도구마다 PATH 의 이름으로 --version 을 한 번 띄웠다. 다시 불러도 더 띄우지 않는다
  expect((await recorded()).map(value => [value.mode, value.argv])).toEqual([["version", ["--version"]], ["version", ["--version"]]]);
  await mod.probeCliServingContracts();
  expect(await recorded()).toHaveLength(2);
  // 버전이 다른 행은 닫히고 이 프로세스가 본 버전을 함께 돌려준다
  expect(status(mod, { ...ai1, model: "opus" })).toBe("cli_version_mismatch");
  expect(mod.cliServingContractDiagnosis(ai1.routeId, "claude-cli", "opus")).toEqual({ status: "cli_version_mismatch", observedVersion: "claude 9.9.9" });
  // 행이 없는 모델·provider 는 not_configured 다
  for (const key of [{ ...ai1, model: "haiku" }, { ...ai2, provider: "claude-cli" }, { ...session, model: "grok-4.8" }]) {
    expect(resolved(mod, key)).toBeNull();
    expect(status(mod, key)).toBe("not_configured");
  }
  // env 경로가 바뀌어도 DB 계약 route 의 근거는 그대로다(PATH 의 도구 이름을 띄운다)
  vi.stubEnv("CLAUDE_CLI", path.join(root, "other-claude"));
  expect(resolved(mod, ai1)).toEqual(ai1);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("DB 계약 행이 계약 검사·route·provider·model 과 맞지 않으면 invalid_entry 로 닫는다", async () => {
  const tools = await fakeToolDir(path.join(root, "db-tools-invalid"), { claude: await cli("version", "claude 9.9.9"), grok: await cli("version", "grok 9.9.9") });
  const mod = await load(undefined, { path: tools });
  await mod.probeCliServingContracts();
  const claudeOnSecond = { ...ai1, routeId: "second-review", model: "claude-on-second" } as const;
  setServingContractSnapshotForTest([
    // 행의 provider(접두)와 계약의 provider 가 다르다
    dbRow(claudeOnSecond, { routeId: cliContractRouteId("grok-cli", "second-review") }),
    // 행의 model 과 계약의 model 이 다르다
    dbRow({ ...ai2, model: "contract-model" }, { model: "row-model" }),
    // 그 route 가 받지 않는 CLI(로그인 유지는 grok 만)
    dbRow({ ...ai1, routeId: "grok-session-check", model: "claude-session" }),
    // 계약 검사에 틀린 값(공식보다 작은 상한)·객체가 아닌 계약
    dbRow({ ...ai1, model: "under-bound", totalTokenBound: 1 }),
    dbRow({ ...ai1, model: "not-object" }, { contract: "not-an-object" }),
  ]);
  for (const key of [{ ...claudeOnSecond, provider: "grok-cli" }, { ...ai2, model: "row-model" }, { ...ai1, routeId: "grok-session-check", model: "claude-session" },
    { ...ai1, model: "under-bound" }, { ...ai1, model: "not-object" }]) {
    expect(status(mod, key), JSON.stringify(key)).toBe("invalid_entry");
    expect(resolved(mod, key)).toBeNull();
  }
  // 행 → 계약 해석(접두 떼기)은 DB 계약 route 의 행만 받는다
  expect(mod.cliContractFromRow({ routeId: cliContractRouteId("claude-cli", "product-intro-check"), model: intro.model,
    contract: { ...intro, routeId: cliContractRouteId("claude-cli", "product-intro-check") } })).toBeNull();
  expect(mod.cliContractFromRow({ routeId: cliContractRouteId("claude-cli", "product-audit"), model: audit.model,
    contract: { ...audit, routeId: cliContractRouteId("claude-cli", "product-audit") } })).toEqual(audit);
  expect(mod.cliContractFromRow({ routeId: "crawl-agent-review", model: ai1.model, contract: ai1 })).toBeNull();
  expect(mod.cliContractFromRow(dbRow(ai1))).toEqual(ai1);
}, PROCESS_TEST_MS);

it.skipIf(process.platform === "win32")("DB 계약 route 의 도구가 PATH 에 없으면 행이 있어도 probe 실패로 닫힌다", async () => {
  const mod = await load(undefined, { claude: await cli("version", "claude 9.9.9") });
  setServingContractSnapshotForTest([dbRow(ai1)]);
  expect(await mod.probeCliServingContracts()).toEqual(TOOLS_ABSENT);
  // CLAUDE_CLI 가 정상 CLI 를 가리켜도 DB 계약 route 는 그것을 띄우지 않는다
  expect(status(mod, ai1)).toBe("cli_version_probe_failed");
  expect(resolved(mod, ai1)).toBeNull();
  expect(await recorded()).toEqual([]);
}, PROCESS_TEST_MS);

// withRuntimeProcess 는 IPC 를 끊으므로 vitest 워커 안에서 부르지 않고, 운영처럼 tsx 로 띄운 별도 node 프로세스에서 확인한다
it.skipIf(process.platform === "win32")("reviewer 프로세스는 시작할 때 probe 를 마친 뒤에 일을 시작하고, 다른 역할은 probe 하지 않는다", async () => {
  const claude = await cli("version", "claude 9.9.9");
  // 운영 진입점(tsx scripts/worker.ts)처럼 CommonJS 로 읽는다. ESM -e 의 import 는 tsx 가 module.register 로 도는
  // Node(22.22.3·24.11.1 미만)에서 .ts 의 export 이름을 못 찾아 default 만 받는다.
  const script = `const { withRuntimeProcess } = require(${JSON.stringify(path.resolve("scripts/worker.ts"))});
const { resolveCliServingContract } = require(${JSON.stringify(path.resolve("lib/llm/cli-serving-contract.ts"))});
(async () => {
  for (const role of ["publisher", "reviewer"]) {
    const contract = await withRuntimeProcess(role, async () => resolveCliServingContract("product-intro-check", "claude-cli", "sonnet"));
    console.log(JSON.stringify({ event: "test.resolved", role, contract }));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(), timeout: 15_000, env: { ...process.env, PATH: empty, FAKE_CLI_RECORD: records,
      CLI_SERVING_CONTRACTS: JSON.stringify([intro]), CLAUDE_CLI: claude, GROK_CLI: path.join(root, "absent-grok") } });
  const lines = stdout.trim().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  // reviewer 는 env 계약의 CLI 와 DB 계약 route 의 도구(claude·grok — PATH 가 비어 실패)를 함께 probe 해 로그에 남긴다
  expect(lines.map(line => line.event === "test.resolved" ? [line.role, line.contract] : [line.event, line.status])).toEqual([
    ["publisher", null], ["cli_contract.probe", "ready"], ["cli_contract.probe", "cli_version_probe_failed"],
    ["cli_contract.probe", "cli_version_probe_failed"], ["reviewer", intro]]);
  expect(lines[1]).toMatchObject({ index: 0, routeId: intro.routeId, provider: intro.provider, model: intro.model, observedVersion: null });
  expect(lines[2]).toMatchObject({ index: null, routeId: null, provider: "claude-cli", model: null, observedVersion: null });
  expect(lines[3]).toMatchObject({ index: null, routeId: null, provider: "grok-cli", model: null, observedVersion: null });
  expect(await recorded()).toHaveLength(1);
}, PROCESS_TEST_MS);


it.skipIf(process.platform === "win32")("OpenCode worker contracts use the authenticated host version and never probe the local PATH binary", async () => {
  const contract = { ...ai2, routeId: "crawl-agent-review", provider: "opencode-cli", model: "opencode/deepseek-v4.1-flash", cliVersion: "1.19.5" };
  const tools = await fakeToolDir(path.join(root, "opencode-db-tools"), { opencode: await cli("version", contract.cliVersion) });
  const mod = await load(undefined, { path: tools });
  setServingContractSnapshotForTest([dbRow(contract), dbRow({ ...contract, model: "opencode/deepseek-v4.1-flash-free", cliVersion: "1.19.4" })]);
  expect(status(mod, contract)).toBe("probe_pending");
  expect(resolved(mod, contract)).toBeNull();
  expect(await mod.probeCliServingContracts()).not.toContainEqual(expect.objectContaining({ provider: "opencode-cli" }));
  expect(resolved(mod, contract)).toBeNull();
  mod.setCliHostObservedVersion("1.19.5");
  expect(resolved(mod, contract)).toEqual(contract);
  expect(status(mod, { ...contract, model: "opencode/deepseek-v4.1-flash-free" })).toBe("ready");
  expect(resolved(mod, { ...contract, model: "opencode/deepseek-v4.1-flash-free" })).toEqual({ ...contract, model: "opencode/deepseek-v4.1-flash-free", cliVersion: "1.19.5" });
  expect(await recorded()).toEqual([]);
}, PROCESS_TEST_MS);
