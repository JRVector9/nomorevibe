import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { cliModelDispatchSchema, type CliModelDispatch } from "@/lib/llm/capacity";
import { prepareCliCall, runReservedCliCall, settleCliNotStarted, type CliCallOutcome, type CliProcessTerminal,
  type PreparedCliCall } from "@/lib/llm/cli-process-runner";
import { cliServingContractHash, cliServingContractSchema, cliTransportSchema, resolveCliServingContract,
  type CliServingContract, type CliTransport } from "@/lib/llm/cli-serving-contract";
import { reviewCliArgs, reviewCliPrompt, reviewModel, reviewWithAgent, REVIEW_CLI_TIMEOUT_MS,
  type AgentReviewResult, type ReviewCliRun } from "./agent-review";
import { grokAuthPath, grokReviewAgentDefinition, grokReviewArgs, grokReviewResult, GROK_REVIEW_AGENT,
  GROK_REVIEW_TIMEOUT_MS } from "./agent-review-grok";
import { MAX_REVIEW_INPUT_BYTES, type ReviewInput } from "./agent-review-contract";
import { assertLiveReviewAdapterAllowed } from "./review-fixture-transport";

/**
 * AI1·AI2 심사의 CLI 호출을 공통 모델 슬롯에 묶는 프로세스 쪽 절반(PR05c-4). 장부는 모른다 — 호출자가 slot·dispatch 를 잡는다.
 *
 * legacy reviewWithAgent·reviewWithGrokCli 와 같은 명령·argv·stdin·env·제한 시간·출력 상한을 미리 정해 runner 의 one-use 호출로
 * 준비하고(transport 가 dispatch 에 묶인다), 실행은 runner 로 한다. 결과 해석은 legacy parser 를 그대로 쓴다:
 * Claude 는 reviewWithAgent 의 run 자리에 runner 를 끼우고(넘어온 argv·stdin·제한 시간이 준비한 값과 다르면 spawn 하지 않는다),
 * Grok 은 legacy 와 같은 grokReviewResult 로 읽는다. 제한 시간은 spawn 부터 센다(runner). 임시 디렉터리는 호출마다 하나다.
 */
export type ReviewCliProvider = "claude-cli" | "grok-cli";
export type ReviewCliRoute = "crawl-agent-review" | "second-review";
export type PreparedReviewCliCall = Readonly<{ kind: "prepared_cli"; routeId: ReviewCliRoute; provider: ReviewCliProvider; model: string;
  inputHash: string; transport: CliTransport; totalTokenBound: number }>;
export type ReviewCliOutcome = Readonly<{ result: AgentReviewResult; terminal: CliProcessTerminal | null;
  indeterminate: "process_exit" | "transport_unknown" | null }>;
/** 장부 claim TX 가 받는 모양 — prepared 객체의 값 사본이고 실행 권한은 아니다 */
export const reviewCliCallRefSchema = z.object({ kind: z.literal("prepared_cli"), routeId: z.enum(["crawl-agent-review", "second-review"]),
  provider: z.enum(["claude-cli", "grok-cli"]), model: z.string().min(1).max(160), inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  transport: cliTransportSchema, totalTokenBound: z.number().int().positive().safe() }).strict();

// legacy runReviewCli·runGrokCli 와 같은 값이다 — 같은 입력에서 legacy 와 byte 단위로 같은지 테스트가 고정한다
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const CLAUDE_MAX_OUTPUT_TOKENS = "2000";

type State = { cli: PreparedCliCall; directory: string; inputIdentity: string; args: readonly string[]; stdin: string | null;
  timeoutMs: number; started: boolean; released: Promise<void> | null };
const calls = new WeakMap<PreparedReviewCliCall, State>();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function isReviewCliProvider(value: unknown): value is ReviewCliProvider {
  return value === "claude-cli" || value === "grok-cli";
}

/** 장부 claim TX 가 묻는 계약. 운영 resolver 는 null 이라 CLI 는 open 이면 계속 미뤄진다(05c-1 과 같은 결과). */
export function reviewCliServingContract(routeId: ReviewCliRoute, provider: string, model: string): CliServingContract | null {
  if (!isReviewCliProvider(provider)) return null;
  const parsed = cliServingContractSchema.safeParse(structuredClone(resolveCliServingContract(routeId, provider, model)));
  return parsed.success && parsed.data.routeId === routeId && parsed.data.provider === provider && parsed.data.model === model ? parsed.data : null;
}
export function reviewCliContractMatches(call: z.infer<typeof reviewCliCallRefSchema>, contract: CliServingContract): boolean {
  return call.routeId === contract.routeId && call.provider === contract.provider && call.model === contract.model
    && call.transport.provider === contract.provider && call.transport.model === contract.model
    && call.transport.cliContractHash === cliServingContractHash(contract) && call.totalTokenBound === contract.totalTokenBound;
}

/** legacy 가 not_configured·input_too_large 로 끝낼 입력과 계약 밖 호출은 준비하지 않는다(gateway 선례처럼 미룬다). */
export async function prepareReviewCliCall(input: ReviewInput, options: { routeId: ReviewCliRoute; provider: ReviewCliProvider;
  model: string; timeoutMs: number }): Promise<PreparedReviewCliCall | { kind: "unsupported"; reason: "provider_contract_unavailable" }> {
  assertLiveReviewAdapterAllowed();
  const unsupported = { kind: "unsupported", reason: "provider_contract_unavailable" } as const;
  const snapshot = structuredClone(input), { routeId, provider, model } = options;
  if (!isReviewCliProvider(provider) || (routeId !== "crawl-agent-review" && routeId !== "second-review")
    || reviewModel({ CRAWL_REVIEW_MODEL: model }) !== model || !Number.isSafeInteger(options.timeoutMs)) return unsupported;
  const serialized = JSON.stringify(snapshot.snapshot);
  if (Buffer.byteLength(serialized, "utf8") > MAX_REVIEW_INPUT_BYTES) return unsupported;
  const prompt = reviewCliPrompt(serialized);
  if (provider === "claude-cli" && Buffer.byteLength(prompt, "utf8") > MAX_REVIEW_INPUT_BYTES + 256) return unsupported;
  // legacy 와 같은 상한 — 호출자가 더 짧게 줄 수는 있어도 늘릴 수는 없다
  const ceiling = provider === "grok-cli" ? GROK_REVIEW_TIMEOUT_MS : REVIEW_CLI_TIMEOUT_MS;
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs, ceiling));
  const directory = await mkdtemp(path.join(os.tmpdir(), provider === "grok-cli" ? "nomorevibe-grok-" : "nomorevibe-review-"));
  let args: string[], stdin: string | null, prepared: ReturnType<typeof prepareCliCall>;
  try {
    if (provider === "claude-cli") {
      const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: CLAUDE_MAX_OUTPUT_TOKENS };
      delete env.CLAUDECODE;
      args = reviewCliArgs(model); stdin = prompt;
      prepared = prepareCliCall({ routeId, provider, model, command: process.env.CLAUDE_CLI ?? "claude", args, stdin, cwd: directory, env,
        boundEnvKeys: ["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], timeoutMs, maxStdoutBytes: MAX_STDOUT_BYTES, maxStderrBytes: MAX_STDERR_BYTES });
    } else {
      const env = { ...process.env, GROK_HOME: path.join(directory, "home"), GROK_AUTH_PATH: grokAuthPath(), RUST_LOG: "off", NO_COLOR: "1" };
      args = grokReviewArgs(model, path.join(directory, "prompt.txt")); stdin = null;
      prepared = prepareCliCall({ routeId, provider, model, command: process.env.GROK_CLI ?? "grok", args, stdin,
        files: [{ path: "prompt.txt", content: prompt }, { path: path.join("home", "agents", `${GROK_REVIEW_AGENT}.md`), content: grokReviewAgentDefinition() }],
        cwd: directory, env, boundEnvKeys: ["NO_COLOR", "RUST_LOG"], timeoutMs, maxStdoutBytes: MAX_STDOUT_BYTES, maxStderrBytes: MAX_STDERR_BYTES });
    }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  if (prepared.kind !== "prepared") { await rm(directory, { recursive: true, force: true }); return unsupported; }
  const call: PreparedReviewCliCall = Object.freeze({ kind: "prepared_cli" as const, routeId, provider, model, inputHash: snapshot.inputHash,
    transport: prepared.transport, totalTokenBound: prepared.totalTokenBound });
  calls.set(call, { cli: prepared, directory, inputIdentity: sha(JSON.stringify(snapshot)), args: Object.freeze([...args]), stdin, timeoutMs,
    started: false, released: null });
  return call;
}

function release(state: State): Promise<void> {
  state.released ??= rm(state.directory, { recursive: true, force: true });
  return state.released;
}
/** 실행하지 않고 버리는 호출의 임시 디렉터리를 지운다(여러 번 불러도 된다). dispatch 는 건드리지 않는다. */
export async function releaseReviewCliCall(call: PreparedReviewCliCall): Promise<void> {
  const state = calls.get(call);
  if (state) await release(state);
}

function reviewInputHash(binding: CliModelDispatch["binding"]): string | null {
  return binding.kind === "ai1_legacy_cli" ? binding.inputHash
    : binding.kind === "ai1_item_cli" || binding.kind === "ai2_item_cli" ? binding.review.inputHash : null;
}
function owned(call: PreparedReviewCliCall, dispatch: CliModelDispatch): { state: State; requestId: string } {
  const state = calls.get(call), checked = cliModelDispatchSchema.safeParse(structuredClone(dispatch));
  if (!state || !checked.success) throw new Error("review_cli_call_mismatch");
  const binding = checked.data.binding;
  if (reviewInputHash(binding) !== call.inputHash || binding.routeId !== call.routeId || binding.provider !== call.provider
    || binding.model !== call.model || binding.totalTokenBound !== call.totalTokenBound
    || !isDeepStrictEqual(binding.transport, call.transport)) throw new Error("review_cli_call_mismatch");
  return { state, requestId: checked.data.requestId };
}

/**
 * spawn 하지 않고 포기한 dispatch 를 닫는 증명(D5). 이미 실행에 들어간 호출이면 null 이다 — 그때는 실행 결과만 근거다.
 * 임시 디렉터리도 지운다.
 */
export async function settleReviewCliNotStarted(call: PreparedReviewCliCall, dispatch: CliModelDispatch): Promise<CliProcessTerminal | null> {
  const { state, requestId } = owned(call, dispatch);
  try {
    if (state.started) return null;
    state.started = true;
    return settleCliNotStarted(state.cli, { requestId, transport: call.transport });
  } finally { await release(state); }
}

/** 장부에 commit 된 dispatch 하나로 한 번만 실행한다. terminal 이 없으면 출력은 버려지고 결과는 legacy 의 중단 kind 다. */
export async function reviewWithReservedCli(input: ReviewInput, dispatch: CliModelDispatch, call: PreparedReviewCliCall,
  options: { signal?: AbortSignal } = {}): Promise<ReviewCliOutcome> {
  assertLiveReviewAdapterAllowed();
  const snapshot = structuredClone(input), signal = options.signal;
  const { state, requestId } = owned(call, dispatch);
  if (state.started || state.released || sha(JSON.stringify(snapshot)) !== state.inputIdentity) throw new Error("review_cli_call_mismatch");
  state.started = true;
  const ref = { requestId, transport: call.transport };
  let outcome: CliCallOutcome | undefined, result: AgentReviewResult;
  try {
    if (call.provider === "claude-cli") {
      // legacy reviewWithAgent 가 만든 argv·stdin·제한 시간이 준비한 호출과 같을 때만 runner 로 spawn 한다
      const run: ReviewCliRun = async (args, stdin, runOptions) => {
        if (!isDeepStrictEqual(args, state.args) || stdin !== state.stdin || runOptions.timeoutMs !== state.timeoutMs
          || runOptions.maxOutputTokens !== undefined) throw new Error("review_cli_call_mismatch");
        outcome = await runReservedCliCall(state.cli, ref, { signal: runOptions.signal });
        return outcome.result;
      };
      result = await reviewWithAgent(snapshot, { model: call.model, timeoutMs: state.timeoutMs, signal, run });
    } else {
      try {
        outcome = await runReservedCliCall(state.cli, ref, { signal });
        result = grokReviewResult(snapshot, outcome.result);
      } catch { result = { ok: false, error: "cli_error" }; }
    }
    if (outcome) return { result, terminal: outcome.terminal, indeterminate: outcome.indeterminate };
    // runner 에 닿기 전에 끝났다(legacy 의 not_configured 등) — 같은 one-use 호출을 spawn 0 으로 닫는다
    const terminal = settleCliNotStarted(state.cli, ref);
    return terminal ? { result, terminal, indeterminate: null } : { result, terminal: null, indeterminate: "transport_unknown" };
  } finally { await release(state); }
}
