import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { claudeCliTokenBound, cliProcessTerminalEvidenceSchema, cliServingContractHash, cliServingContractSchema, EMPTY_SHA256,
  resolveCliServingContract, type CliServingContract } from "@/lib/llm/cli-serving-contract";

// 설계 2.3 의 AI1 예: 입력 약 75KB, --max-turns 2, 2,000 토큰/턴. overhead 는 root 결정(D6) 전이라 시험값이다.
const derived = { version: 1, protocol: "cli-process-v1", routeId: "crawl-agent-review", provider: "claude-cli", model: "sonnet",
  cliVersion: "claude 2.1.263", inputByteCap: 75_000, totalTokenBound: 166_000, costBoundUsdMicros: 150_000,
  boundProvenance: "derived", maxTurns: 2, outputTokensPerTurn: 2_000, overheadTokenBound: 5_000 } as const;
const declared = { version: 1, protocol: "cli-process-v1", routeId: "second-review", provider: "grok-cli", model: "grok-4.7",
  cliVersion: "grok 1.0.46", inputByteCap: 75_000, totalTokenBound: 120_000, costBoundUsdMicros: null, boundProvenance: "declared" } as const;
const ok = (value: unknown) => cliServingContractSchema.safeParse(value).success;

it("Claude derived 계약은 turns·(입력+overhead) + Σk·출력 이상이어야 한다", () => {
  expect(claudeCliTokenBound(derived)).toBe(2 * (75_000 + 5_000) + 3 * 2_000);
  expect(ok(derived)).toBe(true);
  expect(ok({ ...derived, totalTokenBound: 165_999 })).toBe(false);
  expect(ok({ ...derived, maxTurns: 3 })).toBe(false);
  expect(ok({ ...derived, maxTurns: 3, totalTokenBound: claudeCliTokenBound({ ...derived, maxTurns: 3 }) })).toBe(true);
  // 안전 정수를 넘는 공식은 증명하지 못한다
  expect(claudeCliTokenBound({ ...derived, maxTurns: 100, inputByteCap: Number.MAX_SAFE_INTEGER })).toBe(Number.POSITIVE_INFINITY);
  expect(ok({ ...derived, maxTurns: 100, inputByteCap: Number.MAX_SAFE_INTEGER, totalTokenBound: Number.MAX_SAFE_INTEGER })).toBe(false);
});

it("Grok·codex 는 declared 로만, Claude 는 derived 로만 들어오고 provenance 가 계약에 남는다", () => {
  expect(cliServingContractSchema.parse(declared).boundProvenance).toBe("declared");
  expect(ok({ ...declared, provider: "codex-cli", model: "gpt-5.3-codex-spark" })).toBe(true);
  expect(ok({ ...declared, provider: "claude-cli" })).toBe(false);
  expect(ok({ ...derived, provider: "grok-cli" })).toBe(false);
  // declared 에 공식 칸을 섞거나, derived 에서 공식 칸을 빼면 거절한다
  expect(ok({ ...declared, maxTurns: 1 })).toBe(false);
  const { overheadTokenBound: _omitted, ...missing } = derived;
  expect(_omitted).toBe(5_000);
  expect(ok(missing)).toBe(false);
  for (const change of [{ protocol: "cli-process-v2" }, { cliVersion: " claude" }, { totalTokenBound: 0 }, { extra: true }, { costBoundUsdMicros: 0 }])
    expect(ok({ ...declared, ...change }), JSON.stringify(change)).toBe(false);
});

it("계약 hash 는 값에 묶이고 production resolver 는 null 이다", () => {
  const hash = cliServingContractHash(derived as CliServingContract);
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  expect(cliServingContractHash({ ...derived } as CliServingContract)).toBe(hash);
  expect(cliServingContractHash({ ...derived, cliVersion: "claude 2.1.264" } as CliServingContract)).not.toBe(hash);
  expect(() => cliServingContractHash({ ...derived, totalTokenBound: 1 } as CliServingContract)).toThrow();
  expect(resolveCliServingContract("crawl-agent-review", "claude-cli", "sonnet")).toBeNull();
  expect(resolveCliServingContract("second-review", "grok-cli", "grok-4.7")).toBeNull();
});

it("terminal 증거: 시작하지 않은 끝에는 exit·출력·usage 가 없고, killed 는 사유가 있고, usage 는 합이 맞고 C 이하다", () => {
  const transport = { protocol: "cli-process-v1", provider: "claude-cli", model: "sonnet", argvHash: "a".repeat(64), inputHash: "b".repeat(64),
    envPolicyHash: "c".repeat(64), cliContractHash: "d".repeat(64), timeoutMs: 20_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384 };
  const exited = { version: 1, kind: "cli_process_terminal", requestId: randomUUID(), transport, totalTokenBound: 166_000, ending: "exited",
    exitCode: 0, signal: null, killReason: null, stdoutHash: "e".repeat(64), stderrHash: EMPTY_SHA256, stdoutBytes: 10, stderrBytes: 0,
    actualUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, provenance: "cli_reported", reportedCostUsdMicros: 2_100 };
  const notStarted = { ...exited, ending: "not_started", exitCode: null, stdoutHash: EMPTY_SHA256, stdoutBytes: 0,
    actualUsage: null, provenance: "unknown", reportedCostUsdMicros: null };
  const valid = (value: unknown) => cliProcessTerminalEvidenceSchema.safeParse(value).success;
  expect(valid(exited)).toBe(true);
  expect(valid(notStarted)).toBe(true);
  expect(valid({ ...notStarted, ending: "spawn_failed" })).toBe(true);
  expect(valid({ ...exited, ending: "killed", exitCode: null, signal: "SIGKILL", killReason: "timeout", actualUsage: null, provenance: "unknown" })).toBe(true);
  for (const [name, value] of Object.entries({
    notStartedWithExit: { ...notStarted, exitCode: 0 }, notStartedWithOutput: { ...notStarted, stdoutBytes: 1 },
    notStartedWithKill: { ...notStarted, killReason: "cancelled" }, spawnFailedWithUsage: { ...exited, ending: "spawn_failed", exitCode: null },
    killedWithoutReason: { ...exited, ending: "killed", exitCode: null, signal: "SIGKILL" }, bothExitAndSignal: { ...exited, signal: "SIGTERM" },
    neitherExitNorSignal: { ...exited, exitCode: null }, usageOverC: { ...exited, actualUsage: { inputTokens: 166_000, outputTokens: 1, totalTokens: 166_001 } },
    usageSumMismatch: { ...exited, actualUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 3 } }, usageWithoutProvenance: { ...exited, provenance: "unknown" },
    unknownTransportField: { ...exited, transport: { ...transport, routeId: "x" } }, badSignal: { ...exited, exitCode: null, signal: "kill" },
  })) expect(valid(value), name).toBe(false);
});
