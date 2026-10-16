import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * CLI 모델 호출(claude/grok/codex 자식 프로세스)의 serving 계약과 물리 종료 증거 모양.
 *
 * 슬롯 한도는 개수 기반이다. 여기의 C(totalTokenBound)는 활성화 판정에 쓰지 않고 binding·terminal 증거로만 남는다.
 * - Claude(derived): --max-turns·CLAUDE_CODE_MAX_OUTPUT_TOKENS·입력 바이트 상한으로 공식을 세운다.
 *   입력 토큰 ≤ UTF-8 바이트(byte-level BPE)라는 가정과 overhead 값은 root 결정(D6)이다.
 * - Grok·codex(declared): 출력 상한 플래그가 없어 공식으로 증명하지 못한다. 실측 최대에 여유를 둔 값을 계약 PR 에서 넣는다.
 * CLI 가 보고한 usage 는 참고값(cli_reported)이다. 점유를 줄이지 않고, C 를 넘으면 계약 모순으로 terminal 을 내지 않는다.
 */
const identity = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
const positive = z.number().int().positive().safe();
const count = z.number().int().nonnegative().safe();
const sha64 = z.string().regex(/^[a-f0-9]{64}$/);
export const CLI_PROTOCOL = "cli-process-v1";
export const cliProviderSchema = z.enum(["claude-cli", "grok-cli", "codex-cli"]);
export type CliProvider = z.infer<typeof cliProviderSchema>;

/** 턴 k 의 입력은 첫 입력과 앞선 출력의 합이다 — turns·(입력+overhead) + Σk·출력. 안전 정수를 넘으면 증명하지 못한다. */
export function claudeCliTokenBound(value: { maxTurns: number; inputByteCap: number; overheadTokenBound: number; outputTokensPerTurn: number }): number {
  const { maxTurns: turns, inputByteCap, overheadTokenBound, outputTokensPerTurn } = value;
  const bound = turns * (inputByteCap + overheadTokenBound) + (turns * (turns + 1) / 2) * outputTokensPerTurn;
  return Number.isSafeInteger(bound) ? bound : Number.POSITIVE_INFINITY;
}
const contractBase = { version: z.literal(1), protocol: z.literal(CLI_PROTOCOL), routeId: identity(120), model: identity(200),
  cliVersion: identity(80), inputByteCap: positive, totalTokenBound: positive, costBoundUsdMicros: positive.nullable() };
export const cliServingContractSchema = z.discriminatedUnion("boundProvenance", [
  z.object({ ...contractBase, boundProvenance: z.literal("derived"), provider: z.literal("claude-cli"),
    maxTurns: positive.max(100), outputTokensPerTurn: positive, overheadTokenBound: positive }).strict()
    .refine(value => value.totalTokenBound >= claudeCliTokenBound(value), "cli_token_bound_below_formula"),
  z.object({ ...contractBase, boundProvenance: z.literal("declared"), provider: z.enum(["grok-cli", "codex-cli"]) }).strict(),
]);
export type CliServingContract = Readonly<z.infer<typeof cliServingContractSchema>>;
export function cliServingContractHash(value: CliServingContract): string {
  return createHash("sha256").update(JSON.stringify(cliServingContractSchema.parse(value))).digest("hex");
}
/** No bounded CLI serving contract is enabled; measured values and cliVersion pinning belong to the contract PR (D6·D7). */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- No deployment is enabled.
export function resolveCliServingContract(_routeId: string, _provider: CliProvider, _model: string): CliServingContract | null { return null; }

/** 장부 binding 에 들어갈 CLI transport(05c-3). 해시는 실제 spawn 에 쓴 값으로 runner 가 만든다. */
export const cliTransportSchema = z.object({
  protocol: z.literal(CLI_PROTOCOL), provider: cliProviderSchema, model: identity(200),
  argvHash: sha64, inputHash: sha64, envPolicyHash: sha64, cliContractHash: sha64,
  timeoutMs: positive, maxStdoutBytes: positive, maxStderrBytes: positive,
}).strict();
export type CliTransport = Readonly<z.infer<typeof cliTransportSchema>>;

export const EMPTY_SHA256 = createHash("sha256").update("").digest("hex");
/**
 * 한 번의 물리 실행에 대한 증거. exited/killed 는 자식의 exit 와 close(모든 stdio 닫힘)를 둘 다 본 경우뿐이다.
 * spawn_failed 는 pid 없이 끝난 spawn, not_started 는 one-use 호출을 spawn 없이 닫은 경우다 — 둘 다 provider 호출 0 의 증명이다.
 * killReason 은 runner 가 요청한 중단 사유다(업무 결과 kind 를 정한다). killed 는 runner 의 SIGKILL 이 exit 전에 전달된 경우다.
 */
export const cliProcessTerminalEvidenceSchema = z.object({
  version: z.literal(1), kind: z.literal("cli_process_terminal"), requestId: z.uuid(), transport: cliTransportSchema,
  totalTokenBound: positive, ending: z.enum(["exited", "killed", "spawn_failed", "not_started"]),
  exitCode: z.number().int().nullable(), signal: z.string().regex(/^SIG[A-Z0-9]+$/).nullable(),
  killReason: z.enum(["timeout", "cancelled", "output_too_large", "stdin_error"]).nullable(),
  stdoutHash: sha64, stderrHash: sha64, stdoutBytes: count, stderrBytes: count,
  actualUsage: z.object({ inputTokens: count, outputTokens: count, totalTokens: count }).strict().nullable(),
  provenance: z.enum(["cli_reported", "unknown"]), reportedCostUsdMicros: count.nullable(),
}).strict().refine(value => {
  const started = value.ending === "exited" || value.ending === "killed";
  if (!started) return value.exitCode === null && value.signal === null && value.killReason === null
    && value.stdoutBytes === 0 && value.stderrBytes === 0 && value.stdoutHash === EMPTY_SHA256 && value.stderrHash === EMPTY_SHA256
    && value.actualUsage === null && value.provenance === "unknown" && value.reportedCostUsdMicros === null;
  return (value.exitCode === null) !== (value.signal === null) && (value.ending !== "killed" || value.killReason !== null);
}, "invalid_cli_process_ending").refine(value => value.actualUsage === null ? value.provenance === "unknown"
  : value.provenance === "cli_reported" && Number.isSafeInteger(value.actualUsage.inputTokens + value.actualUsage.outputTokens)
    && value.actualUsage.inputTokens + value.actualUsage.outputTokens === value.actualUsage.totalTokens
    && value.actualUsage.totalTokens <= value.totalTokenBound, "invalid_cli_process_usage");
export type CliProcessTerminalEvidence = Readonly<z.infer<typeof cliProcessTerminalEvidenceSchema>>;
