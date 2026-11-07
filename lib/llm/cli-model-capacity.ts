import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db, onPrimary } from "@/lib/db";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { ReviewCliRun } from "@/lib/crawl/agent-review";
import { roleLeaseFromEnv } from "@/lib/jobs/role-leader";
import { ModelCapacityDeferredError } from "./capacity-deferred";
import { modelCapacityIndeterminateReason } from "./capacity";
import { modelCapacityOwnerSchema, type CliDispatchBinding, type CliModelDispatch, type ModelCapacityRequestIdentity } from "./capacity";
import { cancelReservedModelSlot, findOwnPendingModelRequest, finishCliModelCapacityDispatch, lockCliModelCapacityDispatch,
  markModelDispatchIndeterminate, readModelCapacityCallerControl, reconcileCliProcessTerminal, requestCliModelSlot, type CliTarget } from "./capacity-repository";
import { markUnsettledDispatch } from "./capacity-unsettled";
import { cliCommandFor, resolveCliServingContract } from "./cli-serving-contract";
import { prepareCliCall, readCliProcessTerminal, runReservedCliCall, settleCliNotStarted, type CliCallInput, type CliCallOutcome,
  type CliProcessResult, type PreparedCliCall } from "./cli-process-runner";
import { releaseRemoteCliTaskCall, runRemoteCliTaskCall, settleRemoteCliTaskNotStarted } from "@/lib/crawl/cli-task-remote";
import { refreshCliHostObservation } from "@/lib/operations/cli-host-observation";
import { readCliHostTarget } from "@/lib/operations/cli-host-target";

/**
 * 공통 슬롯 밖에서 CLI 를 부르던 reviewer 배경 호출자 — 소개 검수·Claude 감사·Grok 세션 점검(PR05c-5).
 *
 * control 을 한 번 읽어 disabled 면 원 경로(legacy)를 그대로 둔다. draining·매핑 없음·CLI 계약 없음(운영 resolver 는 null)이면 호출 전에
 * 미룬다. 계약이 있으면 slot → 도메인 증명과 같은 TX 의 dispatch → runner → terminal 정산(close 를 못 보면 indeterminate)을 마친 뒤에야
 * 업무 기록으로 간다. argv·stdin·parser 는 원래 함수(checkIntros·reviewWithAgent·checkGrokSession)가 그대로 만들고 run 만 runner 로 바뀐다.
 */
const BACKGROUND_CLI = { "product-intro-check": "claude-cli", "product-audit": "claude-cli", "grok-session-check": "grok-cli" } as const;
export type BackgroundCliRoute = keyof typeof BACKGROUND_CLI;
/** runReviewCli·runGrokCli 와 같은 출력 상한 */
const MAX_STDOUT_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
/** runReviewCli 가 출력 토큰을 따로 받지 않을 때의 값(agent-review.ts reviewCliMaxOutputTokens) */
const CLAUDE_OUTPUT_TOKENS = 2_000;

export async function backgroundCliPath(routeId: BackgroundCliRoute, model: string,
  providerOverride?: "opencode-cli", connectionId?: string): Promise<"legacy" | "native"> {
  if (!Object.hasOwn(BACKGROUND_CLI, routeId)) throw new Error("invalid_cli_model_route");
  if (providerOverride !== undefined && routeId !== "product-intro-check" && routeId !== "product-audit")
    throw new Error("invalid_cli_model_route");
  const provider = providerOverride ?? BACKGROUND_CLI[routeId], control = await readModelCapacityCallerControl();
  if (control.mode === "disabled") {
    if (providerOverride !== undefined) throw new ModelCapacityDeferredError("disabled");
    return "legacy";
  }
  if (control.mode === "draining") throw new ModelCapacityDeferredError("draining");
  if (control.mode !== "open") throw new Error("model_capacity_control_invalid");
  if (!control.policy?.routes.some(route => route.routeId === routeId && route.provider === provider && route.model === model))
    throw new ModelCapacityDeferredError("unmapped");
  // OpenCode 계약은 이 워커가 60초 안에 본 호스트 버전이 있어야 열린다 — 원격 prepare(카탈로그 읽기)는 이 확인 뒤라 먼저 낡았을 때만 채운다.
  // 실패하면 아무것도 바꾸지 않아 아래가 오늘처럼 provider_contract_unavailable 로 미룬다(cli-host-observation)
  if (provider === "opencode-cli" && connectionId) await refreshCliHostObservation(connectionId, () => readCliHostTarget(connectionId));
  if (!resolveCliServingContract(routeId, provider, model)) throw new ModelCapacityDeferredError("provider_contract_unavailable");
  return "native";
}

/** reviewer 역할 리스의 인스턴스·부트가 슬롯 주인이다. 리스 없이 도는 워커는 슬롯을 잡지 않고 미룬다 */
export function reviewerModelOwner() {
  const lease = roleLeaseFromEnv("reviewer", process.env);
  if (!lease) throw new ModelCapacityDeferredError("owner_unavailable");
  return modelCapacityOwnerSchema.parse({ instanceId: lease.instanceId, bootId: lease.bootId });
}

/** runReviewCli 와 같은 명령·env(CLAUDECODE 제거, 출력 토큰)·출력 상한. argv·stdin 은 parser 가 넘긴 그대로다 */
export function claudeCliCallInput(routeId: string, model: string, args: string[], stdin: string,
  options: { timeoutMs: number; maxOutputTokens?: number }, cwd: string): CliCallInput {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(options.maxOutputTokens ?? CLAUDE_OUTPUT_TOKENS) };
  delete env.CLAUDECODE;
  return { routeId, provider: "claude-cli", model, command: cliCommandFor(routeId, "claude-cli"), args, stdin, cwd, env,
    boundEnvKeys: ["CLAUDE_CODE_MAX_OUTPUT_TOKENS"], timeoutMs: options.timeoutMs, maxStdoutBytes: MAX_STDOUT_BYTES, maxStderrBytes: MAX_STDERR_BYTES };
}

/** runGrokCli 와 같은 명령·stdin 없음·env·출력 상한. 값이 binding 에 묶이는 env 는 동작 설정(NO_COLOR·RUST_LOG)뿐이다 */
export function grokCliCallInput(routeId: string, model: string, args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): CliCallInput {
  return { routeId, provider: "grok-cli", model, command: cliCommandFor(routeId, "grok-cli"), args, stdin: null, cwd: options.cwd, env: options.env,
    boundEnvKeys: ["NO_COLOR", "RUST_LOG"], timeoutMs: options.timeoutMs, maxStdoutBytes: MAX_STDOUT_BYTES, maxStderrBytes: MAX_STDERR_BYTES };
}

type CliPlan = Readonly<{ identity: ModelCapacityRequestIdentity; target: CliTarget }>;
export type CliCapacityRun = Readonly<{ kind: "ran"; result: CliProcessResult } | { kind: "not_started" | "skipped" }>;
/** The current native child has no physical terminal. Admission refusals never use this error. */
export class CliPhysicalEndUnknownError extends ModelCapacityDeferredError {
  constructor(readonly cause?: unknown) { super("dispatched"); this.name = "CliPhysicalEndUnknownError"; }
}
export type CliCapacityWork = Readonly<{
  /** A multi-model caller must never start fallback while this process has no physical terminal. */
  requireTerminal?: true;
  /** dispatch 커밋 뒤 spawn 직전의 기존 시간 검사(remaining·canStart). false 면 not_started 로 정산하고 업무는 적지 않는다 */
  beforeSpawn: () => boolean;
  /** 슬롯 요청 전 주인·도메인 스냅숏. null 이면 그사이 바뀌었다 */
  plan: () => Promise<CliPlan | null>;
  /** lock 접두 뒤 같은 TX 에서 도메인 행·job 리스를 증명하고 binding 을 낸다. null 이면 건너뛴다(예약은 거둔다) */
  prove: (tx: ProductTransaction, call: Pick<PreparedCliCall, "routeId" | "transport" | "totalTokenBound">, plan: CliPlan) => Promise<CliDispatchBinding | null>;
}>;

/**
 * 한 번의 CLI 호출. 슬롯 대기는 기다리지 않고 미룸(ModelCapacityDeferredError)으로 끝난다 — 시도·실패 기록보다 앞이다.
 * D5: spawn 전에 포기하면 one-use 호출이 아직 쓰이지 않았다는 것이 호출 0 의 증명이다 — not_started 로 정산해 슬롯을 남기지 않는다.
 */
export async function runCliWithModelCapacity(input: CliCallInput, signal: AbortSignal | undefined, work: CliCapacityWork): Promise<CliCapacityRun> {
  if (signal?.aborted) return { kind: "not_started" };
  const call = prepareCliCall(input);
  if (call.kind !== "prepared") throw new ModelCapacityDeferredError(call.reason);
  const plan = await work.plan();
  if (!plan) return { kind: "skipped" };
  const pending = await findOwnPendingModelRequest(plan.identity);
  if (pending?.state === "dispatched") throw new ModelCapacityDeferredError("dispatched");
  const slot = await requestCliModelSlot({ ...plan.identity, requestId: pending?.requestId ?? randomUUID() }, plan.target);
  if (slot.kind !== "granted") throw new ModelCapacityDeferredError(slot.reason);
  let dispatch: CliModelDispatch | null;
  try {
    // 장부 lock 접두가 도메인·job 잠금보다 앞선다. 이 TX 는 transport 를 품지 않는다
    dispatch = await onPrimary(() => db.transaction(async tx => {
      const lock = await lockCliModelCapacityDispatch(tx, { reservation: slot.reservation, identity: plan.identity, target: plan.target });
      if (!lock) throw new ModelCapacityDeferredError("reservation_lost");
      const binding = await work.prove(tx, call, plan);
      return binding && finishCliModelCapacityDispatch(tx, lock, binding);
    }));
  } catch (error) {
    // 커밋 응답을 모르면 이미 dispatched 일 수 있다 — 이 CAS 는 아직 reserved 인 원 행만 거둔다
    try { await cancelReservedModelSlot(slot.reservation); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "cli_model_reservation_cleanup_failed"); }
    throw error;
  }
  if (!dispatch) {
    await cancelReservedModelSlot(slot.reservation);
    return { kind: "skipped" };
  }
  const ref = { requestId: dispatch.requestId, transport: dispatch.binding.transport };
  if (signal?.aborted || !work.beforeSpawn()) {
    const terminal = settleCliNotStarted(call, ref);
    if (!terminal) throw new Error("cli_model_call_already_used");
    try { await reconcileCliProcessTerminal(terminal); }
    catch (error) { await markUnsettledDispatch(dispatch); throw error; }
    return { kind: "not_started" };
  }
  let outcome: CliCallOutcome;
  try { outcome = await runReservedCliCall(call, ref, { signal, beforeSpawn: work.beforeSpawn }); }
  catch (error) {
    let failure: unknown = error;
    try {
      if (!await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal, error }))) throw new Error("cli_model_dispatch_not_marked");
    } catch (cleanup) { failure = new AggregateError([error, cleanup], "cli_model_transport_cleanup_failed"); }
    if (work.requireTerminal) throw new CliPhysicalEndUnknownError(failure);
    throw failure;
  }
  // 물리 종료가 업무 기록보다 먼저 정산된다. close 를 못 본 호출(자손이 pipe 를 쥠)은 terminal 없이 점유를 유지한다
  if (outcome.terminal) {
    try { await reconcileCliProcessTerminal(outcome.terminal); }
    catch (error) { await markUnsettledDispatch(dispatch); throw error; }
  } else {
    try {
      if (!await markModelDispatchIndeterminate(dispatch, outcome.indeterminate)) throw new Error("cli_model_dispatch_not_marked");
    } catch (error) { if (work.requireTerminal) throw new CliPhysicalEndUnknownError(error); throw error; }
    if (work.requireTerminal) throw new CliPhysicalEndUnknownError();
  }
  return readCliProcessTerminal(outcome.terminal)?.ending === "not_started" ? { kind: "not_started" } : { kind: "ran", result: outcome.result };
}

type RemoteCliTaskCall = Parameters<typeof runRemoteCliTaskCall>[0];
type RemoteCliTaskResult = Awaited<ReturnType<typeof runRemoteCliTaskCall>>["result"];
export type RemoteCliTaskCapacityRun = { kind: "ran"; result: RemoteCliTaskResult } | { kind: "not_started" | "skipped" };

/** 원격 task 호출도 같은 슬롯·dispatch·정산 순서를 쓴다. 검증된 remoteSettlement 없이는 결과를 내보내지 않는다. */
export async function runRemoteCliTaskWithModelCapacity(call: RemoteCliTaskCall, signal: AbortSignal | undefined,
  work: CliCapacityWork): Promise<RemoteCliTaskCapacityRun> {
  try {
    if (signal?.aborted) return { kind: "not_started" };
    if ((call.routeId !== "product-intro-check" && call.routeId !== "product-audit") || call.provider !== "opencode-cli")
      throw new Error("invalid_cli_task_route");
    const plan = await work.plan();
    if (!plan) return { kind: "skipped" };
    if (plan.identity.routeId !== call.routeId || plan.identity.provider !== call.provider
      || plan.identity.model !== call.model)
      throw new Error("cli_task_identity_mismatch");
    const pending = await findOwnPendingModelRequest(plan.identity);
    if (pending?.state === "dispatched") throw new ModelCapacityDeferredError("dispatched");
    const slot = await requestCliModelSlot({ ...plan.identity, requestId: pending?.requestId ?? randomUUID() }, plan.target);
    if (slot.kind !== "granted") throw new ModelCapacityDeferredError(slot.reason);
    let dispatch: CliModelDispatch | null;
    try {
      // 장부 lock 접두가 도메인·job 잠금보다 앞선다. 이 TX 는 transport 를 품지 않는다
      dispatch = await onPrimary(() => db.transaction(async tx => {
        const lock = await lockCliModelCapacityDispatch(tx, { reservation: slot.reservation, identity: plan.identity, target: plan.target });
        if (!lock) throw new ModelCapacityDeferredError("reservation_lost");
        const binding = await work.prove(tx, call, plan);
        return binding && finishCliModelCapacityDispatch(tx, lock, binding);
      }));
    } catch (error) {
      try { await cancelReservedModelSlot(slot.reservation); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "cli_model_reservation_cleanup_failed"); }
      throw error;
    }
    if (!dispatch) {
      await cancelReservedModelSlot(slot.reservation);
      return { kind: "skipped" };
    }
    if (signal?.aborted || !work.beforeSpawn()) {
      let settlement: Awaited<ReturnType<typeof settleRemoteCliTaskNotStarted>> | null = null;
      try { settlement = await settleRemoteCliTaskNotStarted(call, dispatch); }
      catch (error) {
        try {
          if (!await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal, error })))
            throw new Error("cli_model_dispatch_not_marked");
        } catch (cleanup) { throw new CliPhysicalEndUnknownError(new AggregateError([error, cleanup], "cli_model_transport_cleanup_failed")); }
        throw new CliPhysicalEndUnknownError(error);
      }
      if (!settlement) {
        try {
          if (!await markModelDispatchIndeterminate(dispatch, "transport_unknown")) throw new Error("cli_model_dispatch_not_marked");
        } catch (error) { throw new CliPhysicalEndUnknownError(error); }
        throw new CliPhysicalEndUnknownError();
      }
      return { kind: "not_started" };
    }
    let outcome: Awaited<ReturnType<typeof runRemoteCliTaskCall>>;
    try { outcome = await runRemoteCliTaskCall(call, dispatch, { signal }); }
    catch (error) {
      let failure: unknown = error;
      try {
        if (!await markModelDispatchIndeterminate(dispatch, modelCapacityIndeterminateReason({ signal, error })))
          throw new Error("cli_model_dispatch_not_marked");
      } catch (cleanup) { failure = new AggregateError([error, cleanup], "cli_model_transport_cleanup_failed"); }
      throw new CliPhysicalEndUnknownError(failure);
    }
    if (!outcome.remoteSettlement) {
      try {
        if (!await markModelDispatchIndeterminate(dispatch, outcome.indeterminate ?? "transport_unknown"))
          throw new Error("cli_model_dispatch_not_marked");
      } catch (error) { throw new CliPhysicalEndUnknownError(error); }
      throw new CliPhysicalEndUnknownError();
    }
    return outcome.notStarted ? { kind: "not_started" } : { kind: "ran", result: outcome.result };
  } finally {
    await releaseRemoteCliTaskCall(call);
  }
}

/**
 * checkIntros·reviewWithAgent 는 run 의 예외를 cli_error 로 적는다. 미룸·건너뜀·띄우지 않음·장부 오류는 여기서 붙잡아 parser 에는
 * cancelled 를 주고, parser 뒤에 settled() 가 다시 던지거나 알려 준다 — 그 경우 parser 결과는 기록하지 않는다.
 * run 이 불리지 않았으면(parser 가 입력 검사에서 끝냄) settled() 는 null 이고 parser 결과가 원래대로 기록된다.
 */
export function capturedClaudeCliRun(routeId: string, model: string, work: CliCapacityWork): { run: ReviewCliRun; settled: () => CliCapacityRun | null } {
  let captured: CliCapacityRun | null = null, failure: { error: unknown } | null = null, used = false;
  const run: ReviewCliRun = async (args, stdin, options) => {
    if (used) { failure ??= { error: new Error("cli_model_run_reused") }; return { kind: "cancelled" }; }
    used = true;
    // runReviewCli 처럼 호출마다 빈 임시 디렉터리에서 띄운다
    const cwd = await mkdtemp(path.join(os.tmpdir(), "nomorevibe-review-"));
    try {
      captured = await runCliWithModelCapacity(claudeCliCallInput(routeId, model, args, stdin, options, cwd), options.signal, work);
      return captured.kind === "ran" ? captured.result : { kind: "cancelled" };
    } catch (error) {
      failure = { error };
      return { kind: "cancelled" };
    } finally { await rm(cwd, { recursive: true, force: true }); }
  };
  return { run, settled: () => { if (failure) throw failure.error; return captured; } };
}
