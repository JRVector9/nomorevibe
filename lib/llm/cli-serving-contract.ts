import { OPENCODE_NATIVE_TASK_ROUTES } from "./cli-engine-config";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import { z } from "zod";
import { servingContractSnapshot } from "./serving-contract-store";

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
export const cliProviderSchema = z.enum(["claude-cli", "grok-cli", "codex-cli", "opencode-cli"]);
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
  z.object({ ...contractBase, boundProvenance: z.literal("declared"), provider: z.enum(["grok-cli", "codex-cli", "opencode-cli"]) }).strict(),
]);
export type CliServingContract = Readonly<z.infer<typeof cliServingContractSchema>>;
export function cliServingContractHash(value: CliServingContract): string {
  return createHash("sha256").update(JSON.stringify(cliServingContractSchema.parse(value))).digest("hex");
}

/**
 * 계약은 운영자가 reviewer 에 넣는 CLI_SERVING_CONTRACTS(계약 JSON 배열)에서만 온다 — DB 계약 route(아래 CLI_DB_CONTRACT_ROUTES, PR C1)는 빼고.
 * 비어 있으면 그 밖의 모든 CLI 경로가 open 에서 미뤄진다.
 * 항목마다 따로 검증하고, 같은 route·provider·model 이 둘 이상이면 어느 것도 열지 않는다(오류 항목이 끼어도 같다).
 * D7: 프로세스 시작 때 한 번 호출자가 띄울 명령의 --version 을 띄워, 출력(앞뒤 공백 제외)이 cliVersion 과 같은 계약만 연다.
 * probe 를 마치기 전과 probe 하지 않은 프로세스에서는 계약이 없다. CLI 업그레이드는 계약 갱신이다.
 */
export type CliServingContractStatus = "ready" | "probe_pending" | "not_configured" | "invalid_config" | "invalid_entry"
  | "duplicate_entry" | "cli_version_probe_failed" | "cli_version_probe_timeout" | "cli_version_mismatch" | "cli_command_changed"
  /** env CLI_SERVING_CONTRACTS 의 항목이 DB 계약 route(CLI_DB_CONTRACT_ROUTES)의 것이다 — 읽지 않는다(PR C1) */
  | "route_reads_db";
export type CliServingContractProbeReport = Readonly<{ index: number | null; routeId: string | null; provider: string | null;
  model: string | null; status: CliServingContractStatus; observedVersion: string | null }>;
export const CLI_VERSION_PROBE_TIMEOUT_MS = 5_000;
const MAX_CONTRACT_ENTRIES = 32;
const MAX_VERSION_OUTPUT_BYTES = 4 * 1024;
/** 장부 CLI kind(capacity.ts)가 있는 route 와 그 kind 가 받는 CLI. */
const CLI_CONTRACT_ROUTES: Readonly<Record<string, readonly CliProvider[]>> = {
  "crawl-agent-review": ["claude-cli", "grok-cli", "opencode-cli"], "second-review": ["claude-cli", "grok-cli", "opencode-cli"],
  "product-audit": ["claude-cli", "opencode-cli"], "product-intro-check": ["claude-cli", "opencode-cli"], "grok-session-check": ["grok-cli"],
  "crawl-publish-classify": ["claude-cli", "codex-cli"],
};
/** 호출자(review-cli-call·cli-model-capacity·classify)가 띄우는 명령과 같은 식 — env 계약 route(감사·소개 검수·분류)만. DB 계약 route 는 cliCommandFor */
const cliCommand = (provider: CliProvider) => ({ "claude-cli": process.env.CLAUDE_CLI ?? "claude",
  "grok-cli": process.env.GROK_CLI ?? "grok", "codex-cli": process.env.CODEX_CLI ?? "codex", "opencode-cli": "opencode" })[provider];

/**
 * CLI 계약을 DB(model_serving_contracts 의 `cli:<provider>:<route>` 행 — 「작업 ↔ 모델」 순위 저장이 CLI 연결의 버전으로 만든다)에서만 읽는 route
 * (2026-11-02 소유자 결정, PR C1: 1차·2차 심사와 Grok 로그인 유지. 2026-11-09: 발행분 감사 · 변경 재판정(product-audit)의 Claude 순위도 — 그 작업 순위가
 * 재판정의 모델 설정이 되면서 Claude 를 받는다). 이 route 들에는 env CLI_SERVING_CONTRACTS 를 읽지 않고, 실행 파일도 env 경로
 * (CLAUDE_CLI·GROK_CLI)가 아니라 PATH 의 도구 이름이다. 로그인은 그 CLI 가 호스트에서 스스로 쓰는 것이다(PR E 가 env 를 정리한다).
 * cliVersion 은 웹이 확인할 수 없다(CLI 를 띄우지 않는다) — 운영자가 연결에 적은 버전으로 행을 만들고, 워커가 부를 때 예전처럼 `--version` 으로 견준다.
 */
export const CLI_DB_CONTRACT_ROUTES: ReadonlySet<string> = Object.freeze(new Set(["crawl-agent-review", "second-review", "grok-session-check", "product-audit"]));
/** DB 계약 행의 route_id — (도구, route) 마다 따로라 같은 이름의 API 계약·다른 CLI 의 계약과 겹치지 않는다. 계약 JSON 의 routeId 도 이 값이다(표의 CHECK) */
export const cliContractReadsDb = (routeId: string, provider: string): boolean => CLI_DB_CONTRACT_ROUTES.has(routeId)
  || provider === "opencode-cli" && OPENCODE_NATIVE_TASK_ROUTES.includes(routeId);
export const cliContractRouteId = (provider: CliProvider, routeId: string) => `cli:${provider}:${routeId}`;
/** DB 계약 route 의 실행 파일 — PATH 의 도구 이름(env 경로를 읽지 않는다). */
export const CLI_TOOL_COMMANDS: Readonly<Record<CliProvider, string>> = Object.freeze({ "claude-cli": "claude", "grok-cli": "grok", "codex-cli": "codex", "opencode-cli": "opencode" });
/** 그 route 의 CLI 를 띄울 명령 — DB 계약 route 는 PATH 의 도구 이름, 그 밖은 예전 그대로(env 경로 또는 이름). */
export const cliCommandFor = (routeId: string, provider: CliProvider): string =>
  provider === "opencode-cli" ? "/opt/homebrew/bin/opencode"
    : CLI_DB_CONTRACT_ROUTES.has(routeId) ? CLI_TOOL_COMMANDS[provider] : cliCommand(provider);
/** route 가 받는 CLI(장부 CLI kind). */
export const cliContractRouteAccepts = (routeId: string, provider: string): boolean =>
  Object.hasOwn(CLI_CONTRACT_ROUTES, routeId) && (CLI_CONTRACT_ROUTES[routeId] as readonly string[]).includes(provider);

/** DB 계약 route 의 도구 버전(프로세스마다 한 번 `<도구> --version`). probeCliServingContracts 를 부른 프로세스(워커·connect)만 띄운다 — 웹은 띄우지 않는다. */
const toolVersions = new Map<string, VersionProbe | "pending">();
let toolProbesEnabled = false, toolVersionEpoch = 0;
let cliHostVersion: { version: string; observedAt: number } | null = null;
/** A worker learns this version from the authenticated native host catalog; it never probes OpenCode locally. */
export function setCliHostObservedVersion(version: string): void {
  if (!contractBase.cliVersion.safeParse(version).success) throw new Error("invalid_cli_host_version");
  if (cliHostVersion?.version !== version) toolVersionEpoch++;
  cliHostVersion = { version, observedAt: Date.now() };
}
/** 워커가 호스트 카탈로그로 OpenCode 버전을 본 지 얼마나 됐나(ms) — 본 적이 없으면 null. 예약 전 관측 갱신(cli-host-observation)이 낡음을 잰다. */
export function cliHostObservationAgeMs(): number | null {
  return cliHostVersion ? Date.now() - cliHostVersion.observedAt : null;
}
const nativeOpencodeHost = (): boolean => process.env.OPENCODE_HOST_LOCAL === "1";
/** 도구 버전 확인 결과가 바뀔 때마다 오르는 수 — 순위 묶기의 기억(review-task-ranks)이 이것으로 낡음을 안다. */
export const cliToolVersionEpoch = (): number => toolVersionEpoch;
function toolVersion(command: string): VersionProbe | "pending" | null {
  const known = toolVersions.get(command);
  if (known) return known;
  if (!toolProbesEnabled) return null;
  toolVersions.set(command, "pending");
  toolVersionEpoch++;
  void probeCliVersion(command).then(result => { toolVersions.set(command, result); toolVersionEpoch++; });
  return "pending";
}
/** 이 프로세스가 마지막으로 본 도구 버전(진단·화면) — 보지 않았으면 null. */
export function observedCliToolVersion(provider: CliProvider): string | null {
  if (provider === "opencode-cli")
    return cliHostVersion && Date.now() - cliHostVersion.observedAt <= 60_000 ? cliHostVersion.version : null;
  const known = toolVersions.get(CLI_TOOL_COMMANDS[provider]);
  return known && known !== "pending" && known.kind === "ok" ? known.version : null;
}
/** DB 계약 행 하나 → 계약(검사에 통과한 것) 또는 null. */
export function cliContractFromRow(row: { routeId: string; model: string; contract: unknown }): CliServingContract | null {
  const match = /^cli:(claude-cli|grok-cli|codex-cli|opencode-cli):(.+)$/.exec(row.routeId);
  if (!match || !cliContractReadsDb(match[2], match[1]) || !row.contract || typeof row.contract !== "object") return null;
  const parsed = cliServingContractSchema.safeParse({ ...(row.contract as Record<string, unknown>), routeId: match[2] });
  return parsed.success && parsed.data.provider === match[1] && parsed.data.model === row.model && cliContractRouteAccepts(match[2], match[1])
    ? Object.freeze(parsed.data) : null;
}
function dbLookup(routeId: string, provider: CliProvider, model: string): { status: CliServingContractStatus; contract: CliServingContract | null; observed?: string | null } {
  const row = servingContractSnapshot().rows.find(entry => entry.routeId === cliContractRouteId(provider, routeId) && entry.model === model);
  if (!row) return { status: "not_configured", contract: null };
  const contract = cliContractFromRow(row);
  if (!contract) return { status: "invalid_entry", contract: null };
  if (provider === "opencode-cli") {
    const observed = observedCliToolVersion(provider);
    if (!observed) return { status: "probe_pending", contract: null };
    return { status: "ready", contract: Object.freeze({ ...contract, cliVersion: observed }) };
  }
  const version = toolVersion(CLI_TOOL_COMMANDS[provider]);
  if (version === null || version === "pending") return { status: "probe_pending", contract: null };
  if (version.kind !== "ok") return { status: version.kind === "timeout" ? "cli_version_probe_timeout" : "cli_version_probe_failed", contract: null };
  if (version.version !== contract.cliVersion) return { status: "cli_version_mismatch", contract: null, observed: version.version };
  return { status: "ready", contract };
}
const contractKey = (routeId: unknown, provider: unknown, model: unknown) => JSON.stringify([routeId, provider, model]);
type Configured = { kind: "not_configured" | "invalid_config" }
  | { kind: "loaded"; entries: ReadonlyMap<string, { status: CliServingContractStatus; contract: CliServingContract | null; command: string | null }> };
type VersionProbe = { kind: "ok"; version: string } | { kind: "failed" | "timeout" };
let configured: Configured | null = null;
let probed: Promise<readonly CliServingContractProbeReport[]> | null = null;

function lookup(routeId: string, provider: CliProvider, model: string): { status: CliServingContractStatus; contract: CliServingContract | null; observed?: string | null } {
  if (cliContractReadsDb(routeId, provider)) return dbLookup(routeId, provider, model);
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
/** 까닭과, 버전이 다르면 이 프로세스가 본 버전(진단 문장용). */
export function cliServingContractDiagnosis(routeId: string, provider: CliProvider, model: string): { status: CliServingContractStatus; observedVersion: string | null } {
  const found = lookup(routeId, provider, model);
  return { status: found.status, observedVersion: found.observed ?? null };
}

/**
 * 프로세스당 한 번만 읽고 띄운다. 다시 불러도 같은 결과(같은 promise)다. DB 계약 route 의 도구(claude·grok)도 이때 한 번 `--version` 을 띄운다 —
 * 보고에는 routeId null·model null 로 그 도구의 결과와 본 버전이 실린다(워커 로그 cli_contract.probe — 운영자가 연결에 적을 버전).
 */
export function probeCliServingContracts(): Promise<readonly CliServingContractProbeReport[]> {
  // The dedicated native host runs only the existing OpenCode binary; worker env contracts are not its execution authority.
  probed ??= nativeOpencodeHost() ? probeDbCliTools().then(tools => Object.freeze(tools))
    : Promise.all([loadCliServingContracts(), probeDbCliTools()]).then(([env, tools]) => Object.freeze([...env, ...tools]));
  return probed;
}
async function probeDbCliTools(): Promise<CliServingContractProbeReport[]> {
  toolProbesEnabled = true;
  const providers: CliProvider[] = nativeOpencodeHost() ? ["opencode-cli"] : ["claude-cli", "grok-cli"];
  return Promise.all(providers.map(async provider => {
    const command = provider === "opencode-cli" ? cliCommandFor("crawl-agent-review", provider) : CLI_TOOL_COMMANDS[provider];
    const known = toolVersions.get(command);
    const result = known && known !== "pending" ? known : await probeCliVersion(command);
    toolVersions.set(command, result);
    toolVersionEpoch++;
    const status: CliServingContractStatus = result.kind === "ok" ? "ready" : result.kind === "timeout" ? "cli_version_probe_timeout" : "cli_version_probe_failed";
    const observedVersion = result.kind === "ok" && contractBase.cliVersion.safeParse(result.version).success ? result.version : null;
    return { index: null, routeId: null, provider, model: null, status, observedVersion };
  }));
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
    // DB 계약 route(1차·2차·Grok 로그인 유지)의 env 항목은 읽지 않는다 — 계약은 순위 저장이 만든 행뿐이다(PR C1)
    if (fields[index].routeId !== null && cliContractReadsDb(fields[index].routeId!, fields[index].provider ?? "")) return { status: "route_reads_db" as const };
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
  const native = nativeOpencodeHost();
  if (native && command !== cliCommandFor("crawl-agent-review", "opencode-cli")) return Promise.resolve({ kind: "failed" });
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      // detached:false — 워커 그룹에 남아 슈퍼바이저의 그룹 kill 이 닿는다
      child = spawn(command, ["--version"], { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"], detached: false,
        ...(native ? { env: nativeOpenCodeProbeEnv() } : {}) });
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

/** Version checks need host identity and networking settings, never the bridge's database/RPC credentials or startup overrides. */
function nativeOpenCodeProbeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "production", HOME: "/Users/jr", USER: "jr", LOGNAME: "jr", NO_COLOR: "1", OPENCODE_DISABLE_AUTOUPDATE: "true" };
  for (const key of ["PATH", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
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
