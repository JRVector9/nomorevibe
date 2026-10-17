import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { usageFrom } from "@/lib/crawl/agent-review";
import { assertLiveReviewAdapterAllowed } from "@/lib/crawl/review-fixture-transport";
import { CLI_PROTOCOL, cliProcessTerminalEvidenceSchema, cliProviderSchema, cliServingContractHash, cliServingContractSchema,
  cliTransportSchema, EMPTY_SHA256, resolveCliServingContract, type CliProcessTerminalEvidence, type CliProvider,
  type CliServingContract, type CliTransport } from "@/lib/llm/cli-serving-contract";

/**
 * CLI 모델 호출의 물리 종료 근거를 내는 공통 프로세스 runner(설계 2.2). legacy runReviewCli·runGrokCli·codex defaultRun 은
 * 그대로 두고, native 경로만 이것을 쓴다. 같은 명령·argv·stdin·env·제한 시간·출력 상한이면 legacy 와 같은 결과를 돌려준다.
 *
 * terminal 은 자식의 exit 와 close(모든 stdio 닫힘)를 둘 다 본 경우에만 낸다. exit 뒤 CLI_CLOSE_GRACE_MS 안에 close 가 없으면
 * 자손이 pipe 를 쥐고 있다는 뜻이다 — terminal 없이 process_exit 로 돌려주고 점유는 유지된다. kill 뒤 CLI_KILL_GRACE_MS 안에
 * exit 가 없으면 transport_unknown 이다. pid 없이 끝난 spawn(ENOENT·EACCES 등)과 spawn 하지 않고 닫은 one-use 호출은 호출 0 의
 * 증명이므로 spawn_failed·not_started terminal 이다. 전체 시간은 timeoutMs + KILL_GRACE + CLOSE_GRACE 를 넘지 않는다.
 * terminal 이 없으면 exit 출력을 parser 에 넘기지 않는다(기존 중단 kind 는 지키고, 없으면 cli_error).
 */
export const CLI_KILL_GRACE_MS = 2_000;
export const CLI_CLOSE_GRACE_MS = 2_000;
/** legacy ReviewCliResult·GrokCliResult 와 같은 모양 — parser 는 그대로 받는다 */
export type CliProcessResult = { kind: "exit"; code: number | null; stdout: string; stderr: string }
  | { kind: "timeout" | "cancelled" | "output_too_large" | "missing_cli" | "cli_error" };
type StopResult = Exclude<CliProcessResult, { kind: "exit" }>;
type KillReason = "timeout" | "cancelled" | "output_too_large" | "stdin_error";
type Indeterminate = "process_exit" | "transport_unknown";
export type CliCallInput = Readonly<{
  routeId: string; provider: CliProvider; model: string; command: string; args: readonly string[];
  /** null 이면 stdin 을 열지 않는다(Grok 의 stdio ignore) */
  stdin: string | null;
  /** cwd 기준 상대 경로. runner 가 spawn 직전에 쓰고 원문을 inputHash 에 묶는다(Grok prompt·agent 파일) */
  files?: readonly Readonly<{ path: string; content: string }>[];
  cwd: string; env: Readonly<Record<string, string | undefined>>;
  /** 값이 envPolicyHash 에 묶이는 키 — 비밀이 아닌 동작 설정만 넣는다(예: CLAUDE_CODE_MAX_OUTPUT_TOKENS) */
  boundEnvKeys: readonly string[];
  timeoutMs: number; maxStdoutBytes: number; maxStderrBytes: number;
}>;
export type PreparedCliCall = Readonly<{ kind: "prepared"; routeId: string; transport: CliTransport; totalTokenBound: number }>;
/** 장부 dispatch 에서 이 호출에 해당하는 부분(05c-3 binding 의 requestId·transport) */
export type CliDispatchRef = Readonly<{ requestId: string; transport: CliTransport }>;
export type CliProcessTerminal = Readonly<{ kind: "cli_process_terminal" }>;
export type CliCallOutcome = Readonly<{ result: CliProcessResult; terminal: CliProcessTerminal; indeterminate: null }>
  | Readonly<{ result: StopResult; terminal: null; indeterminate: Indeterminate }>;

const positive = z.number().int().positive().safe();
const relativeFile = z.string().min(1).max(200).refine(value => !path.isAbsolute(value) && path.normalize(value) === value
  && !value.split(path.sep).includes(".."));
const inputSchema = z.object({
  routeId: z.string().min(1).max(120), provider: cliProviderSchema, model: z.string().min(1).max(200), command: z.string().min(1),
  args: z.array(z.string()).max(256), stdin: z.string().nullable(),
  files: z.array(z.object({ path: relativeFile, content: z.string() }).strict()).max(16).optional(),
  cwd: z.string().refine(value => path.isAbsolute(value)), env: z.record(z.string(), z.string().optional()),
  boundEnvKeys: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).max(64),
  timeoutMs: positive, maxStdoutBytes: positive, maxStderrBytes: positive,
}).strict();
const dispatchSchema = z.object({ requestId: z.uuid(), transport: cliTransportSchema }).strict();
type State = Omit<z.infer<typeof inputSchema>, "files" | "routeId" | "model" | "boundEnvKeys"> & { files: { path: string; content: string }[];
  transport: CliTransport; totalTokenBound: number; used: boolean };
const calls = new WeakMap<PreparedCliCall, State>();
const terminals = new WeakMap<CliProcessTerminal, CliProcessTerminalEvidence>();
const dispatchedRequests = new Set<string>();
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
/** `--flag value` 값들. `--flag=value` 모양이 있으면 셀 수 없으므로 null 이다 */
function flagValues(args: readonly string[], flag: string): (string | null)[] {
  if (args.some(arg => arg.startsWith(`${flag}=`))) return [null];
  return args.flatMap((arg, index) => arg === flag ? [args[index + 1] ?? null] : []);
}
function single(args: readonly string[], ...flags: string[]): string | null {
  const values = flags.flatMap(flag => flagValues(args, flag));
  return values.length === 1 ? values[0] : null;
}
/** 공식 C 는 실제 argv·env 가 계약의 턴·출력·비용 상한과 같을 때만 그 호출의 증거다 */
function invocationMatches(spec: z.infer<typeof inputSchema>, contract: CliServingContract): boolean {
  if (single(spec.args, "--model", "-m") !== contract.model) return false;
  if (contract.boundProvenance === "declared") return true;
  const tokens = spec.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, budget = single(spec.args, "--max-budget-usd");
  return single(spec.args, "--max-turns") === String(contract.maxTurns) && spec.boundEnvKeys.includes("CLAUDE_CODE_MAX_OUTPUT_TOKENS")
    && typeof tokens === "string" && /^[1-9][0-9]{0,8}$/.test(tokens) && Number(tokens) <= contract.outputTokensPerTurn
    && (contract.costBoundUsdMicros === null || (budget !== null && /^[0-9]{1,6}(\.[0-9]{1,6})?$/.test(budget)
      && Math.round(Number(budget) * 1e6) <= contract.costBoundUsdMicros));
}

/** No caller descriptor can enable a CLI contract; production resolves none, so every call stays unsupported. */
export function prepareCliCall(input: CliCallInput): PreparedCliCall | { kind: "unsupported"; reason: "provider_contract_unavailable" } {
  assertLiveReviewAdapterAllowed();
  const unsupported = { kind: "unsupported", reason: "provider_contract_unavailable" } as const;
  const parsed = inputSchema.safeParse({ ...input, env: { ...input.env } });
  if (!parsed.success) return unsupported;
  const spec = parsed.data, files = [...spec.files ?? []].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (new Set(files.map(file => file.path)).size !== files.length || new Set(spec.boundEnvKeys).size !== spec.boundEnvKeys.length) return unsupported;
  const resolved = resolveCliServingContract(spec.routeId, spec.provider, spec.model);
  const checked = resolved ? cliServingContractSchema.safeParse(structuredClone(resolved)) : null;
  if (!checked?.success) return unsupported;
  const contract = checked.data;
  const inputBytes = [...spec.args, spec.stdin ?? "", ...files.map(file => file.content)].reduce((sum, value) => sum + Buffer.byteLength(value, "utf8"), 0);
  if (contract.routeId !== spec.routeId || contract.provider !== spec.provider || contract.model !== spec.model
    || inputBytes > contract.inputByteCap || !invocationMatches(spec, contract)) return unsupported;
  const transport = freeze(cliTransportSchema.parse({ protocol: CLI_PROTOCOL, provider: spec.provider, model: spec.model,
    argvHash: sha(JSON.stringify([spec.command, ...spec.args])),
    inputHash: sha(JSON.stringify({ stdin: spec.stdin, files: files.map(file => [file.path, file.content]) })),
    envPolicyHash: sha(JSON.stringify([...spec.boundEnvKeys].sort().map(key => [key, spec.env[key] ?? null]))),
    cliContractHash: cliServingContractHash(contract), timeoutMs: spec.timeoutMs, maxStdoutBytes: spec.maxStdoutBytes, maxStderrBytes: spec.maxStderrBytes }));
  const call = freeze({ kind: "prepared" as const, routeId: spec.routeId, transport, totalTokenBound: contract.totalTokenBound });
  calls.set(call, { provider: spec.provider, command: spec.command, args: spec.args, stdin: spec.stdin, files, cwd: spec.cwd, env: spec.env,
    timeoutMs: spec.timeoutMs, maxStdoutBytes: spec.maxStdoutBytes, maxStderrBytes: spec.maxStderrBytes,
    transport, totalTokenBound: contract.totalTokenBound, used: false });
  return call;
}

/** Only the original native capability has evidence; JSON, spread copies and legacy results do not. */
export function readCliProcessTerminal(value: unknown): CliProcessTerminalEvidence | null {
  return value && typeof value === "object" ? terminals.get(value as CliProcessTerminal) ?? null : null;
}

function own(call: PreparedCliCall, dispatch: CliDispatchRef): { state: State; requestId: string } | null {
  const state = calls.get(call), checked = dispatchSchema.safeParse(dispatch);
  if (!state || !checked.success || JSON.stringify(checked.data.transport) !== JSON.stringify(state.transport)
    || dispatchedRequests.has(checked.data.requestId)) return null;
  return { state, requestId: checked.data.requestId };
}
type Evidence = Pick<CliProcessTerminalEvidence, "ending" | "exitCode" | "signal" | "killReason" | "stdoutHash" | "stderrHash"
  | "stdoutBytes" | "stderrBytes" | "actualUsage" | "provenance" | "reportedCostUsdMicros">;
const unstarted = (ending: "spawn_failed" | "not_started"): Evidence => ({ ending, exitCode: null, signal: null, killReason: null,
  stdoutHash: EMPTY_SHA256, stderrHash: EMPTY_SHA256, stdoutBytes: 0, stderrBytes: 0, actualUsage: null, provenance: "unknown", reportedCostUsdMicros: null });
function issue(state: State, requestId: string, evidence: Evidence): CliProcessTerminal {
  const terminal: CliProcessTerminal = Object.freeze({ kind: "cli_process_terminal" });
  terminals.set(terminal, freeze(cliProcessTerminalEvidenceSchema.parse({ version: 1, kind: "cli_process_terminal", requestId,
    transport: state.transport, totalTokenBound: state.totalTokenBound, ...evidence })));
  return terminal;
}

/**
 * spawn 하기 전에 포기한 호출(틱 여유 부족 등)을 닫는다(D5). 이 one-use 객체가 아직 실행되지 않았다는 것이 호출 0 의 증명이다.
 * 이미 실행에 들어간 호출이면 null — 그때는 runReservedCliCall 의 결과만 근거다.
 */
export function settleCliNotStarted(call: PreparedCliCall, dispatch: CliDispatchRef): CliProcessTerminal | null {
  if (calls.get(call)?.used) return null;
  const owned = own(call, dispatch);
  if (!owned) throw new Error("cli_call_mismatch");
  owned.state.used = true; dispatchedRequests.add(owned.requestId);
  return issue(owned.state, owned.requestId, unstarted("not_started"));
}

export async function runReservedCliCall(call: PreparedCliCall, dispatch: CliDispatchRef, options: { signal?: AbortSignal } = {}): Promise<CliCallOutcome> {
  assertLiveReviewAdapterAllowed();
  const owned = own(call, dispatch), signal = options.signal;
  if (!owned || owned.state.used) throw new Error("cli_call_mismatch");
  const { state, requestId } = owned;
  state.used = true; dispatchedRequests.add(requestId);
  const notStarted = (result: StopResult) => ({ result, terminal: issue(state, requestId, unstarted("not_started")), indeterminate: null });
  if (signal?.aborted) return notStarted({ kind: "cancelled" });
  try {
    for (const file of state.files) {
      const target = path.join(state.cwd, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
  } catch { return notStarted({ kind: "cli_error" }); }
  if (signal?.aborted) return notStarted({ kind: "cancelled" });
  const observed = await observe(state, signal);
  if (observed.ending === null) return { result: observed.result, terminal: null, indeterminate: observed.indeterminate };
  if (observed.ending === "spawn_failed") return { result: observed.result, terminal: issue(state, requestId, unstarted("spawn_failed")), indeterminate: null };
  const usage = observed.result.kind === "exit" ? reportedUsage(state.provider, observed.result.stdout) : null;
  // 보고된 usage 가 C 를 넘으면 계약 모순이다 — 싼 완료의 증명이 아니므로 terminal 을 내지 않고 출력도 넘기지 않는다.
  if (usage?.actualUsage && usage.actualUsage.totalTokens > state.totalTokenBound)
    return { result: { kind: "cli_error" }, terminal: null, indeterminate: "transport_unknown" };
  const terminal = issue(state, requestId, { ending: observed.ending, exitCode: observed.exit.code, signal: observed.exit.signal,
    killReason: observed.killReason, stdoutHash: sha(observed.stdout), stderrHash: sha(observed.stderr),
    stdoutBytes: observed.stdout.byteLength, stderrBytes: observed.stderr.byteLength, actualUsage: usage?.actualUsage ?? null,
    provenance: usage?.actualUsage ? "cli_reported" : "unknown", reportedCostUsdMicros: usage?.reportedCostUsdMicros ?? null });
  return { result: observed.result, terminal, indeterminate: null };
}

/** CLI 가 보고한 usage — 참고값이다(Claude 는 cache 토큰이 빠질 수 있다). codex 는 출력에 usage 가 없다. */
function reportedUsage(provider: CliProvider, stdout: string) {
  if (provider === "codex-cli") return null;
  let parsed: unknown;
  try {
    // Grok 은 legacy parser 처럼 첫 { 부터 읽는다
    const start = provider === "grok-cli" ? stdout.indexOf("{") : 0;
    parsed = JSON.parse(start > 0 ? stdout.slice(start) : stdout);
  } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const usage = usageFrom(parsed as Record<string, unknown>);
  const total = usage.inputTokens !== undefined && usage.outputTokens !== undefined ? usage.inputTokens + usage.outputTokens : null;
  const cost = usage.costUsd !== undefined ? Math.round(usage.costUsd * 1e6) : null;
  return { actualUsage: total !== null && Number.isSafeInteger(total)
    ? { inputTokens: usage.inputTokens!, outputTokens: usage.outputTokens!, totalTokens: total } : null,
  reportedCostUsdMicros: cost !== null && Number.isSafeInteger(cost) ? cost : null };
}

type Observed = { ending: null; indeterminate: Indeterminate; result: StopResult }
  | { ending: "spawn_failed"; result: StopResult }
  | { ending: "exited" | "killed"; result: CliProcessResult; exit: { code: number | null; signal: NodeJS.Signals | null };
    killReason: KillReason | null; stdout: Buffer; stderr: Buffer };
/** legacy runReviewCli 와 같은 순서·규율로 띄우고 죽인다. 다른 점은 exit 와 close 를 따로 보고 두 유예로 끝을 묶는 것뿐이다. */
function observe(state: State, signal: AbortSignal | undefined): Promise<Observed> {
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      // D4: detached:false — 워커 프로세스 그룹을 물려받아 슈퍼바이저의 그룹 kill 이 CLI 에도 닿는다.
      // 한계: setsid 등으로 새 세션·그룹을 만들고 stdio 까지 닫은 자손은 exit+close 로 보이지 않는다(테스트 setsid 모드).
      // 그룹 검사(kill(-pgid,0))로 강화하려면 detached:true 가 필요하고, 그러면 슈퍼바이저의 그룹 kill 에서 빠진다.
      // env 는 호출자가 준 그대로다. Next 전역 타입이 NODE_ENV 를 필수로 두어 타입만 맞춘다.
      child = spawn(state.command, state.args, { cwd: state.cwd, env: state.env as NodeJS.ProcessEnv,
        stdio: [state.stdin === null ? "ignore" : "pipe", "pipe", "pipe"], detached: false });
    } catch {
      // 동기 예외는 프로세스를 만들기 전이다. legacy 호출자는 이 throw 를 cli_error 로 적었다.
      resolve({ ending: "spawn_failed", result: { kind: "cli_error" } }); return;
    }
    const spawned = child.pid !== undefined, stdout: Buffer[] = [], stderr: Buffer[] = [];
    let stdoutBytes = 0, stderrBytes = 0, killSent = false, done = false;
    // 결과 kind 는 legacy 처럼 먼저 온 것(error 또는 중단)이 이긴다. killReason 은 runner 가 처음 요청한 중단 사유다.
    let stopped: StopResult | null = null, killReason: KillReason | null = null;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let killTimer: NodeJS.Timeout | undefined, closeTimer: NodeJS.Timeout | undefined;
    const finish = (closed: { code: number | null } | null, reason: Indeterminate) => {
      if (done) return;
      done = true;
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(closeTimer);
      signal?.removeEventListener("abort", abort);
      // close 없이 끝내면 우리 쪽 pipe 끝을 닫아 이벤트 루프를 놓아준다. 쥐고 있던 자손은 그대로다(점유 유지).
      if (!closed) for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      const failed = stopped ?? { kind: "cli_error" as const };
      if (!spawned) resolve({ ending: "spawn_failed", result: failed });
      else if (!closed || !exit) resolve({ ending: null, indeterminate: closed ? "transport_unknown" : reason, result: failed });
      else {
        const out = Buffer.concat(stdout), err = Buffer.concat(stderr);
        resolve({ ending: killSent ? "killed" : "exited", exit, killReason, stdout: out, stderr: err,
          result: stopped ?? { kind: "exit", code: closed.code, stdout: out.toString("utf8"), stderr: err.toString("utf8") } });
      }
    };
    const stop = (result: StopResult, reason: KillReason) => {
      stopped ??= result; killReason ??= reason;
      if (!child.pid || exit || done) return;
      try {
        if (child.kill("SIGKILL")) killSent = true;
      } catch { /* exit 가 오지 않으면 kill 유예가 끝을 정한다 */ }
      killTimer ??= setTimeout(() => finish(null, "transport_unknown"), CLI_KILL_GRACE_MS);
    };
    const abort = () => stop({ kind: "cancelled" }, "cancelled");
    const timer = setTimeout(() => stop({ kind: "timeout" }, "timeout"), state.timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > state.maxStdoutBytes) stop({ kind: "output_too_large" }, "output_too_large");
      else stdout.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > state.maxStderrBytes) stop({ kind: "output_too_large" }, "output_too_large");
      else stderr.push(chunk);
    });
    child.stdin?.on("error", () => stop({ kind: "cli_error" }, "stdin_error"));
    child.on("error", (error: NodeJS.ErrnoException) => {
      stopped ??= { kind: error.code === "ENOENT" ? "missing_cli" : "cli_error" };
    });
    child.on("exit", (code: number | null, exitSignal: NodeJS.Signals | null) => {
      exit = { code, signal: exitSignal };
      clearTimeout(killTimer);
      closeTimer = setTimeout(() => finish(null, "process_exit"), CLI_CLOSE_GRACE_MS);
    });
    child.on("close", (code: number | null) => finish({ code }, "transport_unknown"));
    // pid 없는 spawn 은 exit 이벤트가 없다 — close 가 오지 않아도 유예 뒤에 끝낸다(프로세스가 없으므로 spawn_failed 다).
    if (!spawned) closeTimer = setTimeout(() => finish(null, "transport_unknown"), CLI_CLOSE_GRACE_MS);
    if (child.stdin && state.stdin !== null) child.stdin.end(state.stdin);
  });
}
