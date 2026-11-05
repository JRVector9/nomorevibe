// 일곱 text 경로의 계약 모듈을 먼저 올린다 — 각 모듈이 처음 읽힐 때 자기 경로의 계약 모양을 등록한다(registeredGatewayServingContractSchema).
import "./crawl-tagline-serving-contract";
import "./reason-translation-serving-contract";
import "./product-translation-serving-contract";
import "./product-tagline-ko-serving-contract";
import "./websearch-query-serving-contract";
import "./text-profile-serving-contract";
import "./search-verify-serving-contract";
import { EngineDownTally } from "@/lib/jobs/engine-down";
import { AI_TASK_KEY_MISSING_CAUSE, aiTask, isAiTextTask, onlyKeyMissing, type AiTextTaskId } from "./ai-tasks";
import { aiTaskModelRows, aiTaskModelsReadState, ensureAiTaskModels, type AiTaskConnectionSnapshot } from "./ai-task-models-snapshot";
import { runInTextTaskRank, type TextTaskRankBinding } from "./ai-task-rank-scope";
import { ModelCapacityDeferredError, modelCapacityDeferralIsPerModel } from "./capacity-deferred";
import { parseGatewayServingContract, registeredGatewayServingContractSchema, type GatewayServingRoute } from "./gateway-serving-contract-config";
import { ensureServingContracts, servingContractRowAccess, servingContractSnapshot, type StoredServingContract } from "./serving-contract-store";
import type { AiTaskExecutionConfig, AiTaskPoolRuntime } from "./ai-task-execution-config";
import { ensureAiTaskExecutionConfigs, readAiTaskExecutionConfig } from "./ai-task-execution-snapshot";
import { chooseTaskWorkloadMember } from "./ai-task-workload-selector";

/**
 * 공통 실행 resolver(2026-11-02 소유자 결정 「작업 ↔ AI 모델 1~3순위」, PR B).
 *
 * - `taskModels(task, slot)`: 관리 화면이 저장한 순위(ai_task_models)와 그 연결(ai_connections: 주소·키·장비·목록)을 순위 차례로 — 30초 스냅숏
 *   (lib/llm/ai-task-models-snapshot.ts). 워커와 웹(검색어 번역) 둘 다 읽는다.
 * - text 일곱 작업(AI_TEXT_TASK_IDS)은 순위마다 그 연결을 가리키는 엔진 직접 계약(model_serving_contracts, 끝점 = 연결 주소, 엔진 모델 = 순위 모델)을
 *   찾아 장부 이름(identity)·provider·키를 묶는다(TextTaskRankBinding). 계약이 없거나 닫혔으면 그 순위는 쓸 수 없다(까닭을 남긴다).
 * - `TextTaskRanks`: 한 틱(웹은 한 요청)의 순위 대체. 1순위부터 부르고, 그 모델만의 까닭(용량 정책에 경로 없음·장비 행 없음·계약 닫힘·포화·대기열 가득,
 *   엔진이 내려감)이면 같은 일을 다음 순위로 넘기고 그 순위는 이 틱 동안 쉰다(PR #792 1차 순위 대체와 같은 뜻).
 * - 순위가 없으면 `no_task_models`, 모든 순위를 쓸 수 없으면 `all_ranks_unusable` — 코드 기본값·환경변수로 조용히 대신 부르지 않는다.
 *   잡은 degraded(제 일 못 한 틱)로 적어 관리자 상태 화면(조치할 일)에 보이고, 진행 감시는 재시작하지 않는다(worker-progress-query applyAllSkippedBlock).
 */

export type AiTaskRank = Readonly<{ task: string; slot: number; rank: number; model: string; enabled: boolean; options: Readonly<Record<string, unknown>>;
  connection: AiTaskConnectionSnapshot }>;

/** 한 작업 × 칸의 순위(1·2·3 차례). 스냅숏을 읽기만 한다(오래됐으면 뒤에서 다시 읽는다). */
export function taskModels(taskId: string, slot = 1): AiTaskRank[] {
  return aiTaskModelRows().filter(row => row.task === taskId && row.slot === slot).sort((a, b) => a.rank - b.rank);
}
/** 스냅숏을 기다린 뒤 taskModels. */
export async function loadTaskModels(taskId: string, slot = 1): Promise<AiTaskRank[]> {
  await ensureAiTaskModels();
  return taskModels(taskId, slot);
}

// ── text 일곱 작업: 순위 → 계약 ────────────────────────────────────────────────────────────────────────────

/** 순위를 쓸 수 없는 까닭(코드) → 운영자 문장. */
export const TEXT_RANK_UNUSABLE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  rank_disabled: "순위가 꺼져 있음",
  connection_disabled: "연결이 꺼져 있음",
  connection_not_api: "API 주소 연결이 아님(이 작업은 CLI 를 받지 않음)",
  stored_key_unreadable: "연결에 저장한 키를 열 수 없음(암호 상자 키 확인)",
  connection_key_missing: "연결에 키가 없음 — 이 서버의 계약은 키를 씀(같은 주소의 계약 키로도 채우지 못함, 연결에 키를 넣으세요)",
  no_direct_contract: "이 연결·모델의 엔진 직접 계약이 없음(그 줄을 다시 저장하면 만듦)",
  gateway_auth: "계약 인증이 게이트웨이 키로 되어 있음",
  unmapped: "용량 정책에 이 경로·모델이 없음",
  device_unconfigured: "장비 행이 없음",
  provider_contract_unavailable: "전송 계약이 닫힘",
  capacity: "포화(빈 칸 없음)",
  queue_full: "대기열이 가득 참",
  helper_ineligible: "도우미 경로가 닫힘",
  engine_network: "엔진에 닿지 않음(연결 거절이 잇따름)",
  engine_no_key: "엔진이 키를 거절함",
  engine_model_unavailable: "엔진에 이 모델이 없음",
  engine_tokenizer_unavailable: "엔진 tokenizer 를 확인하지 못함",
  engine_failed: "이 틱의 호출이 실패해 쉼",
  engine_unknown: "이 틱의 호출 결과를 몰라 쉼",
  engine_slow: "이 틱의 호출이 느려 쉼",
  // 심사 묶음(PR C1)
  cli_tool_unsupported: "이 작업이 받지 않는 CLI 도구",
  cli_model_invalid: "CLI 에 넘길 수 없는 모델 이름",
  cli_contract_missing: "CLI 계약이 없음(연결에 CLI 버전을 적고 그 줄을 다시 저장하면 만듦)",
  cli_version_mismatch: "워커의 CLI 버전이 계약과 다름(연결의 CLI 버전을 고치고 다시 저장)",
  cli_contract_unavailable: "CLI 계약을 쓸 수 없음(버전 확인 실패 등)",
  model_paused: "이 틱에 쉬는 중",
  blocked_unconfirmed: "미확인 점유로 장비 칸이 가득 참",
});
export const textRankUnusableText = (code: string) => TEXT_RANK_UNUSABLE_TEXT[code] ?? code;

export type TextRankCandidate = Readonly<{ rank: AiTaskRank; binding: TextTaskRankBinding | null; unusable: string | null; memberId?: string }>;
export type TextRankResolution = Readonly<{ routeId: AiTextTaskId; status: "ok" | "no_task_models" | "task_models_unreadable";
  candidates: readonly TextRankCandidate[] }>;

type RouteContract = Readonly<{ row: StoredServingContract; provider: "abcllm" | "local-direct"; endpointBase: string | null; wireModel: string }>;
const text = (value: unknown, name: string): string | null => {
  const field = value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
  return typeof field === "string" && field ? field : null;
};
/** 계약 끝점(…/v1/chat/completions) → 연결 주소 꼴(origin/v1). */
function endpointBase(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return url.pathname === "/v1/chat/completions" ? `${url.origin}/v1` : null;
  } catch { return null; }
}
/** 이 경로의 켜진 계약 중 모양이 맞는 것(경로 모듈이 등록한 스키마로). 계약 JSON 의 model 이 행 열쇠와 같아야 한다. */
function routeContracts(routeId: AiTextTaskId): RouteContract[] {
  const schema = registeredGatewayServingContractSchema(routeId as GatewayServingRoute);
  if (!schema) return [];
  return servingContractSnapshot().rows.filter(row => row.routeId === routeId).flatMap(row => {
    const parsed = parseGatewayServingContract(row.contract, routeId as GatewayServingRoute, schema);
    if (!parsed || parsed.model !== row.model) return [];
    const provider = parsed.provider === "local-direct" ? "local-direct" as const : "abcllm" as const;
    // 게이트웨이 전송 행(abcllm 형, transport gateway)은 열리지 않는다 — 엔진 직접만 순위가 된다
    if (provider === "abcllm" && row.transport !== "direct") return [];
    const wireModel = provider === "local-direct" ? parsed.model : text(parsed, "engineModel") ?? parsed.model;
    return [{ row, provider, endpointBase: endpointBase(text(parsed, "endpoint")), wireModel }];
  });
}

/**
 * 순위 하나 → 묶음(순수에 가깝다 — 스냅숏 둘을 읽는다). 이 연결을 가리키는 계약(끝점 = 연결 주소, 엔진 모델 = 순위 모델)을 찾는다.
 * 같은 연결·모델의 계약이 둘이면 abcllm 형(엔진 연결이 만든 모양)을, 그 안에서는 이름 그대로(identity = 모델)를 먼저 쓴다.
 */
export function bindTextTaskRank(routeId: AiTextTaskId, rank: AiTaskRank, contracts: readonly RouteContract[] = routeContracts(routeId)): TextRankCandidate {
  const unusable = (code: string): TextRankCandidate => Object.freeze({ rank, binding: null, unusable: code });
  const connection = rank.connection;
  if (!rank.enabled) return unusable("rank_disabled");
  if (!connection.enabled) return unusable("connection_disabled");
  if (connection.kind !== "api" || !connection.baseUrl) return unusable("connection_not_api");
  if (connection.keyUnreadable) return unusable("stored_key_unreadable");
  const mine = contracts.filter(entry => entry.endpointBase === connection.baseUrl && entry.wireModel === rank.model)
    .sort((a, b) => Number(a.provider !== "abcllm") - Number(b.provider !== "abcllm") || Number(a.row.model !== rank.model) - Number(b.row.model !== rank.model)
      || a.row.model.localeCompare(b.row.model));
  const picked = mine[0];
  if (!picked) return unusable("no_direct_contract");
  const access = servingContractRowAccess(picked.row, picked.provider);
  // 계약 행의 키가 열리지 않는 것은 상관없다 — 보내는 키는 연결의 키다
  if (access.block && access.block !== "stored_key_unreadable") return unusable(access.block);
  // 키가 필요한 서버(계약 auth stored)인데 연결에 키가 없으면 키 없이 부르지 않는다(2026-11-02 키 없는 연결로 401 → 결과 미확정). 키 없이 도는 서버(auth none)는 그대로다
  if (picked.row.auth === "stored" && connection.apiKey === null) return unusable("connection_key_missing");
  return Object.freeze({ rank, unusable: null, binding: Object.freeze({ routeId, rank: rank.rank, connectionId: connection.id, connectionLabel: connection.label,
    identity: picked.row.model, engineModel: rank.model, provider: picked.provider, bearer: connection.apiKey, deviceId: connection.deviceId }) });
}

/** text 작업 하나의 순위 → 묶음(1·2·3 차례). 스냅숏을 한 번도 읽지 못했으면 task_models_unreadable, 순위가 없으면 no_task_models. */
export function resolveTextTaskRanks(routeId: AiTextTaskId, execution?: AiTaskExecutionConfig): TextRankResolution {
  if (!isAiTextTask(routeId)) throw new Error(`not_text_task:${routeId}`);
  if (execution?.mode === "workload_pool") {
    if (execution.task !== routeId || execution.slot !== 1 || execution.revision === null)
      throw new ModelCapacityDeferredError("assignments_unavailable");
    const contracts = routeContracts(routeId);
    const candidates = execution.members.map(member => {
      const rank: AiTaskRank = Object.freeze({ task: routeId, slot: 1, rank: 0, model: member.model, enabled: true,
        options: member.options, connection: member.connection });
      const candidate = bindTextTaskRank(routeId, rank, contracts);
      return Object.freeze({ ...candidate, memberId: member.memberId, binding: candidate.binding ? Object.freeze({ ...candidate.binding,
        memberId: member.memberId, configRevision: execution.revision! }) : null });
    });
    return Object.freeze({ routeId, status: candidates.length ? "ok" : "no_task_models", candidates: Object.freeze(candidates) });
  }
  const read = aiTaskModelsReadState();
  const ranks = taskModels(routeId);
  if (!ranks.length) return Object.freeze({ routeId, status: read.loaded ? "no_task_models" as const : "task_models_unreadable" as const, candidates: Object.freeze([]) });
  const contracts = routeContracts(routeId);
  return Object.freeze({ routeId, status: "ok" as const, candidates: Object.freeze(ranks.map(rank => bindTextTaskRank(routeId, rank, contracts))) });
}

// ── 한 틱의 순위 대체 ─────────────────────────────────────────────────────────────────────────────────────

/** 잡 degraded 와 같은 모양(lib/jobs/runner JobDegraded) — 웹 경로가 runner 를 끌어오지 않게 여기 따로 적는다. */
export type TextRankDegraded = { code: "no_task_models" | "task_models_unreadable" | "all_ranks_unusable"; detail: string; cause?: typeof AI_TASK_KEY_MISSING_CAUSE };
export type TextRankRun<T> = { kind: "served"; binding: TextTaskRankBinding; value: T } | { kind: "unusable" };
/** 이 틱(또는 이 프로세스의 마지막 요청)의 순위 사정 — 관리 화면이 「지금 몇 순위가 일하나 · 아래 순위를 쓴 까닭」으로 보인다. */
export type TextRankStatus = Readonly<{ routeId: string; at: string; status: TextRankResolution["status"]; ranks: number;
  served: Readonly<Record<string, number>>; unusable: readonly Readonly<{ rank: number; code: string; count: number }>[];
  pool?: AiTaskPoolRuntime }>;

const bindingKey = (binding: Pick<TextTaskRankBinding, "rank" | "memberId">): string => binding.memberId ? `member.${binding.memberId}` : String(binding.rank);
const candidateKey = (candidate: TextRankCandidate): string => candidate.memberId ? `member.${candidate.memberId}` : String(candidate.rank.rank);

const SATURATION = new Set(["capacity", "queue_full"]);
const statusHolder = globalThis as unknown as { __nmvTextRankStatus?: Map<string, TextRankStatus> };
const statuses = () => (statusHolder.__nmvTextRankStatus ??= new Map());
/** 이 프로세스가 마지막으로 남긴 순위 사정(웹 경로: 검색어 번역). 없으면 null. */
export function textTaskRankStatus(routeId: string): TextRankStatus | null { return statuses().get(routeId) ?? null; }

export class TextTaskRanks {
  private readonly paused = new Map<string, string>();
  private readonly served = new Map<string, number>();
  private readonly unusableCounts = new Map<string, number>();
  private readonly engines = new Map<string, EngineDownTally>();
  /** run 이 쓸 순위를 하나도 찾지 못해 돌려보낸 일이 있다 */
  exhausted = false;

  constructor(readonly resolution: TextRankResolution, private readonly execution?: AiTaskExecutionConfig) {
    for (const candidate of resolution.candidates) if (candidate.unusable) this.mark(candidateKey(candidate), candidate.unusable);
  }

  /**
   * 스냅숏 둘(계약·순위)을 기다린 뒤 이 작업의 순위를 묶는다. 잡 틱은 30초보다 오래된 스냅숏을 새로 읽고 기다린다(기본). 웹 요청(검색어 번역)은
   * maxAgeMs 를 길게 주어 처음 한 번만 기다린다 — 그 뒤로는 동기 읽기가 30초마다 뒤에서 새로 읽는다(요청이 DB 를 기다리지 않는다).
   */
  static async open(routeId: AiTextTaskId, maxAgeMs?: number): Promise<TextTaskRanks> {
    await Promise.all([ensureServingContracts(maxAgeMs), ensureAiTaskModels(maxAgeMs), ensureAiTaskExecutionConfigs(maxAgeMs)]);
    const execution = readAiTaskExecutionConfig(routeId);
    return new TextTaskRanks(resolveTextTaskRanks(routeId, execution), execution);
  }

  get routeId(): AiTextTaskId { return this.resolution.routeId; }
  get mode(): "fallback" | "workload_pool" { return this.execution?.mode ?? "fallback"; }
  /** 계약까지 묶인 순위(쉬는 것 포함), 순위 차례. */
  bindings(): TextTaskRankBinding[] { return this.resolution.candidates.flatMap(candidate => candidate.binding ? [candidate.binding] : []); }
  /** 지금 부를 수 있는 순위(쉬지 않는 것), 순위 차례. */
  usable(): TextTaskRankBinding[] { return this.bindings().filter(binding => !this.paused.has(bindingKey(binding))); }

  /** 일을 시작하기 전에 알릴 것: 순위 없음 · 표를 못 읽음 · 모든 순위를 쓸 수 없음(계약 없음 등). 부를 순위가 있으면 null. */
  earlyDegraded(): TextRankDegraded | null {
    if (this.resolution.status !== "ok") return this.degraded();
    return this.usable().length ? null : this.degraded();
  }

  /** 순위를 쉬게 한다(이 틱 동안). 같은 순위의 둘째 까닭은 세기만 한다. */
  pause(binding: Pick<TextTaskRankBinding, "rank" | "memberId">, reason: string): void { this.mark(bindingKey(binding), reason); }
  private mark(member: string, reason: string) {
    if (!this.paused.has(member)) this.paused.set(member, reason);
    const key = `${member}.${reason}`;
    this.unusableCounts.set(key, (this.unusableCounts.get(key) ?? 0) + 1);
  }

  /**
   * 일 하나를 순위 차례로 부른다. work 는 그 순위의 범위(runInTextTaskRank) 안에서 돈다 — 깊은 코드는 textTaskModel(route)로 그 순위를 읽는다.
   * work 가 그 모델만의 미룸(ModelCapacityDeferredError, 범위 model)을 던지면 그 순위를 쉬게 하고 같은 일을 다음 순위로 넘긴다.
   * 그 밖의 오류(전역 미룸·이 일만의 미룸·진짜 오류)는 그대로 던진다 — 부르는 잡이 예전처럼 다룬다. 모두 쉬면 { kind: "unusable" }.
   * prefer(장부 이름)가 주어지면 그 순위를 먼저 본다(이 프로세스가 그 순위로 줄에 세워 둔 요청을 이어받을 때).
   */
  async run<T>(work: (binding: TextTaskRankBinding) => Promise<T>, options: Readonly<{ prefer?: string | null }> = {}): Promise<TextRankRun<T>> {
    if (this.execution?.mode === "workload_pool") return this.runPool(work, options);
    const order = this.bindings();
    const preferred = options.prefer ? order.findIndex(binding => binding.identity === options.prefer) : -1;
    if (preferred > 0) order.unshift(...order.splice(preferred, 1));
    for (const binding of order) {
      if (this.paused.has(bindingKey(binding))) continue;
      try {
        const value = await runInTextTaskRank(binding, () => work(binding));
        const key = bindingKey(binding);
        this.served.set(key, (this.served.get(key) ?? 0) + 1);
        return { kind: "served", binding, value };
      } catch (error) {
        if (error instanceof ModelCapacityDeferredError && modelCapacityDeferralIsPerModel(error.reason)) { this.pause(binding, error.reason); continue; }
        throw error;
      }
    }
    this.exhausted = true;
    return { kind: "unusable" };
  }

  /** Choose once per independent work/batch; never fan out one callback to several models. */
  private async runPool<T>(work: (binding: TextTaskRankBinding) => Promise<T>, options: Readonly<{ prefer?: string | null }>): Promise<TextRankRun<T>> {
    const execution = this.execution!;
    const candidates = this.usable().flatMap(binding => binding.memberId ? [{ ...binding, memberId: binding.memberId }] : []);
    if (!candidates.length) {
      this.exhausted = true;
      return { kind: "unusable" };
    }
    const selected = await chooseTaskWorkloadMember(execution, candidates, { preferIdentity: options.prefer });
    // No eligible idle route is a capacity deferral, not proof that all configured models failed.
    if (!selected) throw new ModelCapacityDeferredError("capacity");
    const binding: TextTaskRankBinding = Object.freeze({ ...selected });
    try {
      const value = await runInTextTaskRank(binding, () => work(binding));
      const key = bindingKey(binding);
      this.served.set(key, (this.served.get(key) ?? 0) + 1);
      return { kind: "served", binding, value };
    } catch (error) {
      if (error instanceof ModelCapacityDeferredError && modelCapacityDeferralIsPerModel(error.reason)) this.pause(binding, error.reason);
      // requestSlot may have committed a waiting row and its logical fence
      // before deferring. Never invoke this work on another member, even when
      // it had no pending identity before this callback. A later independent
      // work unit can choose another member; existing retries resume this one.
      throw error;
    }
  }

  /** 엔진이 이 일에 실패했다(그 일의 시도는 이미 적혔다). 엔진이 내려갔음이 증명되면(engine-down.ts) 그 순위를 쉬게 하고 true. */
  failed(binding: TextTaskRankBinding, error: string): boolean {
    const key = bindingKey(binding);
    const tally = this.engines.get(key) ?? this.engines.set(key, new EngineDownTally()).get(key)!;
    const down = tally.failed(error);
    if (down) this.pause(binding, `engine_${down}`);
    return !!down;
  }
  /** 엔진이 답했다(성공이든 그 일의 실패든) — 연결 거절 연속을 처음부터 센다. */
  answered(binding: TextTaskRankBinding): void { this.engines.get(bindingKey(binding))?.answered(); }

  /** 쉬는 까닭에 포화(capacity·queue_full)가 있다 — 줄이 풀리면 곧 다시 부를 수 있다(잡은 예전처럼 model_capacity 로 미룬다). */
  saturated(): boolean { return [...this.paused.values()].some(reason => SATURATION.has(reason)); }
  /** 쓸 수 있던 순위가 모두 엔진 쪽 까닭(engine_*)으로 쉰다 — 예전의 「엔진이 내려가 틱을 접는다」와 같다. 그 까닭(첫 순위의 것)을 돌려준다. */
  engineDown(): string | null {
    const reasons = this.bindings().map(binding => this.paused.get(bindingKey(binding)));
    if (!reasons.length || reasons.some(reason => !reason?.startsWith("engine_"))) return null;
    return reasons[0]!.slice("engine_".length);
  }

  /** 순위 없음·표를 못 읽음·모든 순위를 쓸 수 없음의 degraded(한국어 까닭, 300자). */
  degraded(): TextRankDegraded {
    const task = aiTask(this.routeId)?.label ?? this.routeId;
    if (this.resolution.status === "no_task_models")
      return { code: "no_task_models", detail: `${task}: 작업 ↔ 모델(/admin/models/tasks)에 순위가 없습니다 — 코드 기본값·환경변수로 대신 부르지 않습니다` };
    if (this.resolution.status === "task_models_unreadable")
      return { code: "task_models_unreadable", detail: `${task}: 작업 ↔ 모델 표를 아직 읽지 못했습니다(권한·migration 0162 확인) — 기본값으로 대신 부르지 않습니다` };
    const reasons = this.resolution.candidates.map(candidate => this.paused.get(candidateKey(candidate)) ?? candidate.unusable);
    const parts = this.resolution.candidates.map((candidate, index) =>
      `${candidate.memberId ? `구성원 ${candidate.memberId}` : `${candidate.rank.rank}순위`} ${candidate.rank.connection.label} · ${candidate.rank.model}: ${reasons[index] ? textRankUnusableText(reasons[index]!) : "쓸 수 있음"}`);
    // 모든 순위가 키 없는 연결뿐이면 설정의 일(cause) — 진행 감시·OPEN 이 배포를 막지 않는다(AI_TASK_KEY_MISSING_CAUSE)
    return { code: "all_ranks_unusable", detail: `${task}: ${parts.join(" / ")}`.slice(0, 300), ...(onlyKeyMissing(reasons) ? { cause: AI_TASK_KEY_MISSING_CAUSE } : {}) };
  }

  /** 틱 끝 요약 — ctx.log("ai_task.ranks", …) 의 숫자 칸. 관측(job:<잡>)의 마지막 이벤트로 남아 관리 화면이 읽는다. */
  summary(): Record<string, number> {
    const out: Record<string, number> = { ranks: this.mode === "fallback" ? this.resolution.candidates.length : 0 };
    if (this.mode === "workload_pool") { out.pool_members = this.resolution.candidates.length; out.pool_revision = this.execution!.revision!; }
    for (const [key, count] of this.served) out[key.startsWith("member.") ? `member_served.${key.slice(7)}` : `served.${key}`] = count;
    for (const [key, count] of this.unusableCounts) out[key.startsWith("member.") ? `member_unusable.${key.slice(7)}` : `unusable.${key}`] = count;
    return out;
  }

  /** 이 프로세스의 순위 사정을 남긴다(웹 경로 화면용). */
  publish(now = new Date()): TextRankStatus {
    const status: TextRankStatus = Object.freeze({ ...textRankStatusFromCounts(this.routeId, now.toISOString(), this.summary()), status: this.resolution.status });
    statuses().set(this.routeId, status);
    return status;
  }
}

/** 관측 이벤트(ai_task.ranks)의 숫자 칸 → 순위 사정(관리 화면). 모양이 틀린 칸은 버린다. */
export function textRankStatusFromCounts(routeId: string, at: string, counts: Readonly<Record<string, unknown>>): TextRankStatus {
  const served: Record<string, number> = {}, unusable: { rank: number; code: string; count: number }[] = [];
  const memberServed: Record<string, number> = {}, memberUnusable: { memberId: string; code: string; count: number }[] = [];
  for (const [key, value] of Object.entries(counts)) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue;
    const servedKey = /^served\.([1-3])$/.exec(key);
    if (servedKey) { served[servedKey[1]] = value; continue; }
    const unusableKey = /^unusable\.([1-3])\.([a-z_]{1,60})$/.exec(key);
    if (unusableKey) unusable.push({ rank: Number(unusableKey[1]), code: unusableKey[2], count: value });
    const memberServedKey = /^member_served\.([0-9a-f-]{36})$/.exec(key);
    if (memberServedKey) memberServed[memberServedKey[1]] = value;
    const memberUnusableKey = /^member_unusable\.([0-9a-f-]{36})\.([a-z_]{1,60})$/.exec(key);
    if (memberUnusableKey) memberUnusable.push({ memberId: memberUnusableKey[1], code: memberUnusableKey[2], count: value });
  }
  const ranks = typeof counts.ranks === "number" && Number.isSafeInteger(counts.ranks) ? counts.ranks : 0;
  const members = typeof counts.pool_members === "number" && Number.isInteger(counts.pool_members) && counts.pool_members >= 1 && counts.pool_members <= 4 ? counts.pool_members : 0;
  const revision = typeof counts.pool_revision === "number" && Number.isSafeInteger(counts.pool_revision) && counts.pool_revision > 0 ? counts.pool_revision : null;
  return Object.freeze({ routeId, at, status: ranks || members && revision !== null ? "ok" as const : "no_task_models" as const,
    ranks, served: Object.freeze(served), unusable: Object.freeze(unusable.sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code))),
    ...(members && revision !== null ? { pool: Object.freeze({ configRevision: revision, members, served: Object.freeze(memberServed),
      unusable: Object.freeze(memberUnusable.sort((a, b) => a.memberId.localeCompare(b.memberId) || a.code.localeCompare(b.code))) }) } : {}) });
}
