import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { z } from "zod";

/**
 * CLI 모델 호출(claude/grok/codex 자식 프로세스)의 serving 계약과 물리 종료 증거 모양.
 *
 * 슬롯 한도는 개수 기반이다. 여기의 C(totalTokenBound)는 활성화 판정에 쓰지 않고 binding·terminal 증거로만 남는다.
 * - Claude(derived): --max-turns·CLAUDE_CODE_MAX_OUTPUT_TOKENS·입력 바이트 상한으로 공식을 세운다.
 *   입력 토큰 ≤ UTF-8 바이트(byte-level BPE)라는 가정과 overhead 값은 root 결정(D6)이다.
 * - Grok·codex(declared): 출력 상한 플래그가 없어 공식으로 증명하지 못한다. 실측 최대에 여유를 둔 값을 운영 설정에 넣는다.
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

/**
 * 계약은 운영자가 reviewer 에 넣는 CLI_SERVING_CONTRACTS(계약 JSON 배열)에서만 온다. 비어 있으면 모든 CLI 경로가 open 에서 미뤄진다.
 * 항목마다 따로 검증하고, 같은 route·provider·model 이 둘 이상이면 어느 것도 열지 않는다(오류 항목이 끼어도 같다).
 * D7: 프로세스 시작 때 한 번 호출자가 띄울 명령의 --version 을 띄워, 출력(앞뒤 공백 제외)이 cliVersion 과 같은 계약만 연다.
 * probe 를 마치기 전과 probe 하지 않은 프로세스에서는 계약이 없다. CLI 업그레이드는 계약 갱신이다.
 */
export type CliServingContractStatus = "ready" | "probe_pending" | "not_configured" | "invalid_config" | "invalid_entry"
  | "duplicate_entry" | "cli_version_probe_failed" | "cli_version_probe_timeout" | "cli_version_mismatch" | "cli_command_changed";
export type CliServingContractProbeReport = Readonly<{ index: number | null; routeId: string | null; provider: string | null;
  model: string | null; status: CliServingContractStatus; observedVersion: string | null }>;
export const CLI_VERSION_PROBE_TIMEOUT_MS = 5_000;
const MAX_CONTRACT_ENTRIES = 32;
const MAX_VERSION_OUTPUT_BYTES = 4 * 1024;
/** 장부 CLI kind(capacity.ts)가 있는 route 와 그 kind 가 받는 CLI. codex 는 kind 가 없어 계약을 열 수 없다(D2) */
const CLI_CONTRACT_ROUTES: Readonly<Record<string, readonly CliProvider[]>> = {
  "crawl-agent-review": ["claude-cli", "grok-cli"], "second-review": ["claude-cli", "grok-cli"],
  "product-audit": ["claude-cli"], "product-intro-check": ["claude-cli"], "grok-session-check": ["grok-cli"],
};
/** 호출자(review-cli-call·cli-model-capacity·classify)가 띄우는 명령과 같은 식 */
const cliCommand = (provider: CliProvider) => ({ "claude-cli": process.env.CLAUDE_CLI ?? "claude",
  "grok-cli": process.env.GROK_CLI ?? "grok", "codex-cli": process.env.CODEX_CLI ?? "codex" })[provider];
const contractKey = (routeId: unknown, provider: unknown, model: unknown) => JSON.stringify([routeId, provider, model]);
type Configured = { kind: "not_configured" | "invalid_config" }
  | { kind: "loaded"; entries: ReadonlyMap<string, { status: CliServingContractStatus; contract: CliServingContract | null; command: string | null }> };
type VersionProbe = { kind: "ok"; version: string } | { kind: "failed" | "timeout" };
let configured: Configured | null = null;
let probed: Promise<readonly CliServingContractProbeReport[]> | null = null;

function lookup(routeId: string, provider: CliProvider, model: string): { status: CliServingContractStatus; contract: CliServingContract | null } {
  if (!configured) return { status: "probe_pending", contract: null };
  if (configured.kind !== "loaded") return { status: configured.kind, contract: null };
  const entry = configured.entries.get(contractKey(routeId, provider, model));
  if (!entry) return { status: "not_configured", contract: null };
  return entry.contract && entry.command !== cliCommand(provider) ? { status: "cli_command_changed", contract: null } : entry;
}
export function resolveCliServingContract(routeId: string, provider: CliProvider, model: string): CliServingContract | null {
  return lookup(routeId, provider, model).contract;
}
/** 계약이 없는 까닭 — 미룸(provider_contract_unavailable)의 운영 진단용이다 */
export function cliServingContractStatus(routeId: string, provider: CliProvider, model: string): CliServingContractStatus {
  return lookup(routeId, provider, model).status;
}

/** 프로세스당 한 번만 읽고 띄운다. 다시 불러도 같은 결과(같은 promise)다 */
export function probeCliServingContracts(): Promise<readonly CliServingContractProbeReport[]> {
  probed ??= loadCliServingContracts();
  return probed;
}
async function loadCliServingContracts(): Promise<readonly CliServingContractProbeReport[]> {
  const raw = process.env.CLI_SERVING_CONTRACTS;
  if (raw === undefined || raw.trim() === "") { configured = { kind: "not_configured" }; return []; }
  let values: unknown = null;
  try { values = JSON.parse(raw); } catch { /* 아래에서 invalid_config */ }
  if (!Array.isArray(values) || values.length > MAX_CONTRACT_ENTRIES) {
    configured = { kind: "invalid_config" };
    return [{ index: null, routeId: null, provider: null, model: null, status: "invalid_config", observedVersion: null }];
  }
  const text = (value: unknown) => typeof value === "string" && value.length <= 200 ? value : null;
  const fields = values.map((value: unknown) => {
    const entry = value && typeof value === "object" ? value as Record<string, unknown> : {};
    return { routeId: text(entry.routeId), provider: text(entry.provider), model: text(entry.model) };
  });
  const keys = fields.map(field => field.routeId !== null && field.provider !== null && field.model !== null
    ? contractKey(field.routeId, field.provider, field.model) : null);
  const counts = new Map<string, number>();
  for (const key of keys) if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  const checked = values.map((value, index) => {
    const key = keys[index];
    if (key && counts.get(key)! > 1) return { status: "duplicate_entry" as const };
    const parsed = cliServingContractSchema.safeParse(value);
    return parsed.success && Object.hasOwn(CLI_CONTRACT_ROUTES, parsed.data.routeId)
      && CLI_CONTRACT_ROUTES[parsed.data.routeId].includes(parsed.data.provider)
      ? { status: "ready" as const, contract: Object.freeze(parsed.data) } : { status: "invalid_entry" as const };
  });
  const commands = new Map(checked.flatMap(entry => entry.status === "ready" ? [[entry.contract.provider, cliCommand(entry.contract.provider)] as const] : []));
  const versions = new Map(await Promise.all([...commands].map(async ([provider, command]) => [provider, await probeCliVersion(command)] as const)));
  const entries = new Map<string, { status: CliServingContractStatus; contract: CliServingContract | null; command: string | null }>();
  const reports = checked.map((entry, index): CliServingContractProbeReport => {
    let status: CliServingContractStatus = entry.status, observedVersion: string | null = null;
    if (entry.status === "ready") {
      const probe = versions.get(entry.contract.provider)!;
      if (probe.kind !== "ok") status = probe.kind === "timeout" ? "cli_version_probe_timeout" : "cli_version_probe_failed";
      else if (probe.version !== entry.contract.cliVersion) {
        status = "cli_version_mismatch";
        observedVersion = contractBase.cliVersion.safeParse(probe.version).success ? probe.version : null;
      }
      entries.set(keys[index]!, { status, contract: status === "ready" ? entry.contract : null, command: commands.get(entry.contract.provider)! });
    } else if (keys[index]) entries.set(keys[index], { status, contract: null, command: null });
    return { index, ...fields[index], status, observedVersion };
  });
  configured = { kind: "loaded", entries };
  return reports;
}

/** --version 만 띄운다(모델 호출이 아니다). 제한 시간 안에 close 까지 오지 않으면 죽이고 기다리지 않는다 */
function probeCliVersion(command: string): Promise<VersionProbe> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      // detached:false — 워커 그룹에 남아 슈퍼바이저의 그룹 kill 이 닿는다
      child = spawn(command, ["--version"], { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"], detached: false });
    } catch { resolve({ kind: "failed" }); return; }
    const stdout: Buffer[] = [];
    let bytes = 0, done = false;
    const finish = (outcome: VersionProbe) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (outcome.kind !== "ok") try { child.kill("SIGKILL"); } catch { /* 이미 끝났다 */ }
      for (const stream of [child.stdout, child.stderr]) stream?.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: "timeout" }), CLI_VERSION_PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > MAX_VERSION_OUTPUT_BYTES) finish({ kind: "failed" });
      else stdout.push(chunk);
    });
    child.stderr?.resume();
    child.on("error", () => finish({ kind: "failed" }));
    child.on("close", (code: number | null) => finish(code === 0 ? { kind: "ok", version: Buffer.concat(stdout).toString("utf8").trim() } : { kind: "failed" }));
  });
}

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
