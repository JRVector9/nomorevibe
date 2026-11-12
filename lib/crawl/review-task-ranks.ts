// 심사 두 경로의 계약 모듈을 먼저 올린다 — 각 모듈이 처음 읽힐 때 자기 경로의 계약 모양을 등록한다(registeredGatewayServingContractSchema).
import "./agent-review-serving-contract";
import "./second-review-serving-contract";
import { AsyncLocalStorage } from "node:async_hooks";
import { AI_CLI_TOOL_PROVIDERS, AI_TASK_KEY_MISSING_CAUSE, AI_TASK_RANK_DEGRADED_CODES, aiConnectionTaskAllowed, aiTask, aiTaskSlotLabel, onlyKeyMissing,
  type AiCliTool, type AiReviewTaskId } from "@/lib/llm/ai-tasks";
import { aiTaskModelsReadState, ensureAiTaskModels } from "@/lib/llm/ai-task-models-snapshot";
import { taskModels, textRankUnusableText, type AiTaskRank } from "@/lib/llm/ai-task-resolver";
import { cliServingContractDiagnosis, cliToolVersionEpoch, type CliProvider } from "@/lib/llm/cli-serving-contract";
import { aiTaskModelRows } from "@/lib/llm/ai-task-models-snapshot";
import { parseGatewayServingContract, registeredGatewayServingContractSchema, type GatewayServingRoute } from "@/lib/llm/gateway-serving-contract-config";
import { ensureServingContracts, servingContractRowAccess, servingContractSnapshot, type StoredServingContract } from "@/lib/llm/serving-contract-store";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { ModelCapacityDeferredError } from "@/lib/llm/capacity-deferred";
import { canonicalReviewModel } from "./review-model-identity";
import { aiTaskExecutionReadState, ensureAiTaskExecutionConfigs, readAiTaskExecutionConfig } from "@/lib/llm/ai-task-execution-snapshot";
import { chooseTaskWorkloadMember } from "@/lib/llm/ai-task-workload-selector";
import { aiTaskPoolFeatures, type AiTaskExecutionConfig, type AiTaskPoolMember, type AiTaskPoolSelection } from "@/lib/llm/ai-task-execution-config";

/**
 * 심사 묶음(1차 AI 검수·2차 AI 검수 투표자)의 「작업 ↔ 모델」 순위 → 실행 쪽 심사자(2026-11-02 소유자 결정, PR C1).
 *
 * - 1차(`first-review`, 칸 1)와 2차(`second-review`, 투표자 칸 1·2·3)의 1·2·3순위만 읽는다(30초 스냅숏, lib/llm/ai-task-models-snapshot.ts).
 *   예전의 crawl_settings.firstReview·firstReviewAdditional·secondReview.voters·fallbacks, 배정 표(ai1·ai2), 등록부 기본 후보는 읽지 않는다.
 * - 순위 하나를 그 연결이 가리키는 것에 묶는다:
 *   API 연결 → 그 경로(crawl-agent-review·second-review)의 켜진 계약 중 끝점 = `<연결 주소>/chat/completions`, 엔진 모델(engineModel 또는 model) = 순위 모델인 것.
 *     abcllm 형(total-bound, transport direct — 엔진에 바로 보낸다)을 먼저, local-direct(direct-openai-chat-v1) 를 다음으로 쓴다. 장부 이름(identity) = 계약 행의 model
 *     (같은 모델을 다른 연결에도 두면 `<모델>@<연결 8자>`). 보내는 키는 연결의 키다(serving-contract-store textRouteAccess).
 *   CLI 연결 → claude-cli·grok-cli, identity = 순위 모델. 계약은 순위 저장이 만든 DB CLI 계약(cli:<provider>:<route>)뿐이고 버전은 워커가 부를 때 견준다.
 * - 쓸 수 없는 순위(계약 없음·꺼짐·키를 못 엶·CLI 계약 없음·버전 다름)는 까닭을 남긴다. identity 를 아는 순위(계약은 있는데 닫힘, CLI)는 「지금 심사자」
 *   목록에 남는다 — 그 순위가 낸 기록은 여전히 지금 심사자의 기록이고, 고르기는 그 순위를 비켜 간다(avoid). 계약이 없어 identity 를 모르는 API 순위는 빠진다.
 * - 순위가 없으면 `no_task_models`, 표를 못 읽었으면 `task_models_unreadable`, 모두 쓸 수 없으면 `all_ranks_unusable` — 코드 기본값·환경변수로 대신 부르지 않는다.
 */

export type ReviewTaskRoute = "crawl-agent-review" | "second-review";
export const REVIEW_TASK_ROUTES: Readonly<Record<AiReviewTaskId, ReviewTaskRoute>> = Object.freeze({ "first-review": "crawl-agent-review", "second-review": "second-review" });
export type ReviewRankProvider = "abcllm" | "local-direct" | "claude-cli" | "grok-cli" | "opencode-cli";
export type ReviewRankBinding = Readonly<{
  task: AiReviewTaskId; slot: number; rank: number; routeId: ReviewTaskRoute;
  connectionId: string; connectionLabel: string; deviceId: string;
  provider: ReviewRankProvider;
  /** 장부·계약 행·시도 행의 model 열쇠 */
  identity: string;
  /** 엔진·CLI 에 보내는 모델 이름(순위 행의 model) */
  engineModel: string;
}>;
export type ReviewRankCandidate = Readonly<{ rank: AiTaskRank; binding: ReviewRankBinding | null; unusable: string | null; detail: string | null; poolMember?: AiTaskPoolMember }>;
export type ReviewRankStatus = "ok" | "no_task_models" | "task_models_unreadable";
export type ReviewRankResolution = Readonly<{ task: AiReviewTaskId; slot: number; routeId: ReviewTaskRoute; status: ReviewRankStatus;
  candidates: readonly ReviewRankCandidate[]; execution?: AiTaskExecutionConfig }>;
/** 심사자 하나(시도·장부·2차 행의 provider·model). */
export type ReviewRankReviewer = { provider: ReviewRankProvider; model: string };

type RouteContract = Readonly<{ row: StoredServingContract; provider: "abcllm" | "local-direct"; endpointBase: string | null; wireModel: string }>;
const text = (value: unknown, name: string): string | null => {
  const field = value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
  return typeof field === "string" && field ? field : null;
};
function endpointBase(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    const url = new URL(endpoint);
    return url.pathname === "/v1/chat/completions" ? `${url.origin}/v1` : null;
  } catch { return null; }
}
/** 이 경로의 켜진 계약 중 모양이 맞는 것. 게이트웨이 전송 행(abcllm 형, transport gateway)은 열리지 않는다 — 엔진 직접만 순위가 된다. */
export function reviewRouteContracts(routeId: ReviewTaskRoute): RouteContract[] {
  const schema = registeredGatewayServingContractSchema(routeId as GatewayServingRoute);
  if (!schema) return [];
  return servingContractSnapshot().rows.filter(row => row.routeId === routeId).flatMap(row => {
    const parsed = parseGatewayServingContract(row.contract, routeId as GatewayServingRoute, schema);
    if (!parsed || parsed.model !== row.model) return [];
    const provider = parsed.provider === "local-direct" ? "local-direct" as const : "abcllm" as const;
    if (provider === "abcllm" && row.transport !== "direct") return [];
    const wireModel = provider === "local-direct" ? parsed.model : text(parsed, "engineModel") ?? parsed.model;
    return [{ row, provider, endpointBase: endpointBase(text(parsed, "endpoint")), wireModel }];
  });
}

const CLI_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const REVIEW_CLI_PROVIDERS: ReadonlySet<string> = new Set(["claude-cli", "grok-cli", "opencode-cli"]);

/** 순위 하나 → 묶음(스냅숏 둘을 읽는다). */
export function bindReviewTaskRank(task: AiReviewTaskId, rank: AiTaskRank, contracts: readonly RouteContract[] = reviewRouteContracts(REVIEW_TASK_ROUTES[task])): ReviewRankCandidate {
  const routeId = REVIEW_TASK_ROUTES[task];
  const result = (binding: ReviewRankBinding | null, unusable: string | null, detail: string | null = null): ReviewRankCandidate =>
    Object.freeze({ rank, binding, unusable, detail });
  const connection = rank.connection;
  if (!rank.enabled) return result(null, "rank_disabled");
  if (!connection.enabled) return result(null, "connection_disabled");
  if (!aiConnectionTaskAllowed(task, connection)) return result(null, "connection_task_not_allowed");
  const base = { task, slot: rank.slot, rank: rank.rank, routeId, connectionId: connection.id, connectionLabel: connection.label, deviceId: connection.deviceId };
  if (connection.kind === "cli") {
    const provider = connection.cliTool ? AI_CLI_TOOL_PROVIDERS[connection.cliTool as AiCliTool] : null;
    if (!provider || !REVIEW_CLI_PROVIDERS.has(provider)) return result(null, "cli_tool_unsupported");
    if (!CLI_MODEL.test(rank.model)) return result(null, "cli_model_invalid");
    const binding = Object.freeze({ ...base, provider: provider as "claude-cli" | "grok-cli" | "opencode-cli", identity: rank.model, engineModel: rank.model });
    // 웹 프로세스는 CLI 를 띄우지 않아 버전을 모른다(probe_pending) — 그때는 쓸 수 있는 것으로 둔다. 워커는 부를 때 계약·버전을 다시 본다
    const { status, observedVersion } = cliServingContractDiagnosis(routeId, provider as CliProvider, rank.model);
    if (status === "ready" || status === "probe_pending") return result(binding, null);
    if (status === "not_configured") return result(binding, "cli_contract_missing");
    if (status === "cli_version_mismatch") return result(binding, "cli_version_mismatch", observedVersion ? `이 워커의 CLI 버전 ${observedVersion}` : null);
    return result(binding, "cli_contract_unavailable", status);
  }
  if (!connection.baseUrl) return result(null, "connection_not_api");
  const mine = contracts.filter(entry => entry.endpointBase === connection.baseUrl && entry.wireModel === rank.model)
    .sort((a, b) => Number(a.provider !== "abcllm") - Number(b.provider !== "abcllm") || Number(a.row.model !== rank.model) - Number(b.row.model !== rank.model)
      || a.row.model.localeCompare(b.row.model));
  const picked = mine[0];
  if (!picked) return result(null, "no_direct_contract");
  const binding = Object.freeze({ ...base, provider: picked.provider, identity: picked.row.model, engineModel: rank.model });
  if (connection.keyUnreadable) return result(binding, "stored_key_unreadable");
  const access = servingContractRowAccess(picked.row, picked.provider);
  // 계약 행의 키가 열리지 않는 것은 상관없다 — 보내는 키는 연결의 키다
  if (access.block && access.block !== "stored_key_unreadable") return result(binding, access.block);
  // 키가 필요한 서버(계약 auth stored)인데 연결에 키가 없다 — 키 없이 보내지 않는다(text 작업 bindTextTaskRank 와 같은 규칙)
  if (picked.row.auth === "stored" && connection.apiKey === null) return result(binding, "connection_key_missing");
  return result(binding, null);
}

/**
 * 저장된 설정이 심사자를 선언하는 판정의 범위 — 고정 입력 replay 의 스냅숏 판정(pipeline-replay-ai2-target·pipeline-replay-readiness)처럼, 지금 프로세스의 순위가
 * 아니라 그 스냅숏의 crawl_settings 행(firstReview·voters·fallbacks)으로 1차·2차 심사자를 읽어야 하는 순수 판정만 연다. 격리 replay DB 범위(currentReplayDb)와 같은 뜻이다.
 */
const settingsHolder = globalThis as unknown as { __nmvSettingsReviewers?: AsyncLocalStorage<true> };
const settingsScope = (): AsyncLocalStorage<true> => (settingsHolder.__nmvSettingsReviewers ??= new AsyncLocalStorage<true>());
export function withSettingsReviewers<T>(run: () => T): T { return settingsScope().run(true, run); }
/** 심사자를 설정 행에서 읽는 범위인가 — 격리 replay DB 범위이거나 withSettingsReviewers 안. */
export const settingsReviewersActive = (): boolean => settingsScope().getStore() === true || !!currentReplayDb();

/** 시험 고정: 심사자 목록을 묶기가 끝난 순위로 둔다(연결·계약 스냅숏을 거치지 않는다). second[k] = 투표자 칸 k+1 의 1·2·3순위. null = 풀기. */
type PinnedReviewRanks = { first: readonly ReviewRankReviewer[]; second: readonly (readonly ReviewRankReviewer[])[] };
type ReviewRanksPin = PinnedReviewRanks | (() => PinnedReviewRanks);
const pinHolder = globalThis as unknown as { __nmvReviewRanksPin?: ReviewRanksPin | null };
const normalizePin = (value: Partial<PinnedReviewRanks>): PinnedReviewRanks => ({ first: [...value.first ?? []], second: (value.second ?? []).map(slot => [...slot]) });
/**
 * 고정 입력 replay 실행(lib/operations/pipeline-replay-model-runner.ts)이 manifest 가 선언한 모델을 그 실행 동안 순위로 고정한다 — 격리 DB 에는 순위 표가 없다.
 * 시험도 같은 길을 쓴다(setReviewRanksForTest). null = 풀기.
 */
export function pinReviewTaskRanks(value: Partial<PinnedReviewRanks> | null): void { setReviewRanksForTest(value); }
/** 값 또는 부를 때마다 읽는 함수(시험이 설정을 바꿀 때마다 따라가게). */
export function setReviewRanksForTest(value: Partial<PinnedReviewRanks> | (() => Partial<PinnedReviewRanks>) | null): void {
  pinHolder.__nmvReviewRanksPin = value === null ? null : typeof value === "function" ? () => normalizePin(value()) : normalizePin(value);
}
export const reviewTaskRanksPinned = (): boolean => !!currentPin();
const currentPin = (): PinnedReviewRanks | null => {
  const pin = pinHolder.__nmvReviewRanksPin;
  return !pin ? null : typeof pin === "function" ? pin() : pin;
};
function pinnedResolution(pin: PinnedReviewRanks, task: AiReviewTaskId, slot: number): ReviewRankResolution {
  const routeId = REVIEW_TASK_ROUTES[task];
  const reviewers = task === "first-review" ? slot === 1 ? pin.first : [] : pin.second[slot - 1] ?? [];
  const candidates = reviewers.slice(0, 3).map((reviewer, index): ReviewRankCandidate => {
    const cli = reviewer.provider === "claude-cli" || reviewer.provider === "grok-cli" || reviewer.provider === "opencode-cli";
    const connection = Object.freeze({ id: `00000000-0000-4000-8000-${String(index + slot * 10).padStart(12, "0")}`, label: `test-${reviewer.provider}`,
      kind: cli ? "cli" as const : "api" as const, baseUrl: cli ? null : "http://review.test:8000/v1", cliTool: cli ? reviewer.provider.replace(/-cli$/, "") : null,
      deviceId: "test-device", enabled: true, models: null, contextTokens: null, apiKey: null, keyUnreadable: false });
    const rank: AiTaskRank = Object.freeze({ task, slot, rank: index + 1, model: reviewer.model, enabled: true, options: Object.freeze({}), connection });
    return Object.freeze({ rank, unusable: null, detail: null, binding: Object.freeze({ task, slot, rank: index + 1, routeId, connectionId: connection.id,
      connectionLabel: connection.label, deviceId: connection.deviceId, provider: reviewer.provider, identity: reviewer.model, engineModel: reviewer.model }) });
  });
  return Object.freeze({ task, slot, routeId, status: candidates.length ? "ok" as const : "no_task_models" as const, candidates: Object.freeze(candidates) });
}

/** 심사 작업 한 칸의 순위 → 묶음(1·2·3 차례). 스냅숏을 한 번도 읽지 못했으면 task_models_unreadable, 순위가 없으면 no_task_models. */
export function resolveReviewTaskRanks(task: AiReviewTaskId, slot = 1): ReviewRankResolution {
  const pin = currentPin();
  if (pin) return pinnedResolution(pin, task, slot);
  // 같은 스냅숏(계약·순위)·같은 CLI 버전 확인 결과면 묶기를 다시 하지 않는다 — 2차 입력 검사·SQL 조각이 한 틱에 여러 번 부른다
  const execution = readAiTaskExecutionConfig(task, slot), executionLoadedAt = aiTaskExecutionReadState().loadedAt;
  const contractsToken = servingContractSnapshot().token, rows = aiTaskModelRows(), loaded = aiTaskModelsReadState().loaded, epoch = cliToolVersionEpoch();
  if (!memo || memo.contractsToken !== contractsToken || memo.rows !== rows || memo.loaded !== loaded || memo.epoch !== epoch || memo.executionLoadedAt !== executionLoadedAt)
    memo = { contractsToken, rows, loaded, epoch, executionLoadedAt, results: new Map() };
  const key = `${task}#${slot}`, known = memo.results.get(key);
  if (known) return known;
  const routeId = REVIEW_TASK_ROUTES[task];
  const members = execution.mode === "workload_pool" ? execution.members : [];
  // Positions here enumerate runtime candidates only; no fourth fallback-rank row is stored.
  const ranks: AiTaskRank[] = execution.mode === "workload_pool" ? members.map(member => ({ task, slot,
    rank: member.position, model: member.model, enabled: true, options: member.options, connection: member.connection })) : taskModels(task, slot);
  const contracts = ranks.length ? reviewRouteContracts(routeId) : [];
  const resolved: ReviewRankResolution = !ranks.length ? Object.freeze({ task, slot, routeId, candidates: Object.freeze([]),
    status: loaded ? "no_task_models" as const : "task_models_unreadable" as const })
    : Object.freeze({ task, slot, routeId, execution, status: "ok" as const, candidates: Object.freeze(ranks.map((rank, index) => ({
      ...bindReviewTaskRank(task, rank, contracts), ...(members[index] ? { poolMember: members[index] } : {}),
    }))) });
  memo.results.set(key, resolved);
  return resolved;
}
let memo: { contractsToken: string; rows: readonly unknown[]; loaded: boolean; epoch: number; executionLoadedAt: number; results: Map<string, ReviewRankResolution>;
  reserves?: Map<string, readonly ReviewRankCandidate[]> } | null = null;

/**
 * 「동시에」의 예비 순위(0179 reserve_ranks, 2026-11-12 1·2차도 따름): 묶음이 모두 설 때(칸 수가 참·줄에 설 구성원도 없음·쉼) 이 칸의 저장된 1·2·3순위를
 * 순위 차례로 이어 쓴다. 순위대로·예비 꺼짐·고정 시험 순위·설정 행을 읽는 범위면 빈 목록. 묶기는 resolveReviewTaskRanks 와 같은 스냅숏으로 한 번만 한다.
 */
export function resolveReviewReserveRanks(task: AiReviewTaskId, slot = 1): readonly ReviewRankCandidate[] {
  if (currentPin() || settingsReviewersActive()) return [];
  const resolution = resolveReviewTaskRanks(task, slot), execution = resolution.execution;
  if (execution?.mode !== "workload_pool" || execution.reserveRanks !== true || !aiTaskPoolFeatures(task, slot).reserve || !memo) return [];
  const key = `${task}#${slot}`, known = (memo.reserves ??= new Map()).get(key);
  if (known) return known;
  const ranks = taskModels(task, slot);
  const contracts = ranks.length ? reviewRouteContracts(REVIEW_TASK_ROUTES[task]) : [];
  const bound = Object.freeze(ranks.map(rank => bindReviewTaskRank(task, rank, contracts)));
  memo.reserves.set(key, bound);
  return bound;
}

/**
 * 1차의 지금 묶음 — 순위대로면 1·2·3순위, 「동시에」면 구성원과(예비를 켰을 때만) 예비 순위, 이 차례로. 고르기(firstReviewRanks)와 전송 준비
 * (reviewRankFor 의 연결·추론 강도, OpenCode 호스트 관측)가 이 한 집합을 읽는다 — 2026-11-12 검수 F3: 예비를 고를 수 있는데 전송 준비가 구성원만 찾아
 * 예비의 연결·옵션을 잃었다. 예비를 끄면 예비 순위는 들지 않는다(임의로 켜지 않는다).
 */
export function firstReviewRankCandidates(): readonly ReviewRankCandidate[] {
  return [...resolveReviewTaskRanks("first-review", 1).candidates, ...resolveReviewReserveRanks("first-review", 1)];
}

/**
 * 칸 수(max_slots)를 적은 「동시에」 — 구성원 열쇠(JSON [provider, identity], firstReviewerKey 와 같은 꼴)마다 칸 수 합. 같은 엔진(같은 장부 이름)을 두 자리에 넣으면
 * 한 열쇠로 더한다(장부·표가 자리를 가르지 못한다 — 함께 차고 함께 빈다). 칸 수를 적지 않았거나 따르지 않는 작업이면 null(예전처럼 상한 없음).
 */
export function reviewPoolSlotCaps(task: AiReviewTaskId, slot: number, execution: AiTaskExecutionConfig | undefined,
  candidates: readonly ReviewRankCandidate[]): ReadonlyMap<string, number> | null {
  if (execution?.mode !== "workload_pool" || !aiTaskPoolFeatures(task, slot).slotCaps || !execution.members.some(member => member.maxSlots != null)) return null;
  const caps = new Map<string, number>();
  for (const candidate of candidates) {
    if (!candidate.binding || !candidate.poolMember) continue;
    const key = JSON.stringify([candidate.binding.provider, candidate.binding.identity]);
    caps.set(key, (caps.get(key) ?? 0) + (candidate.poolMember.maxSlots ?? 1));
  }
  return caps;
}
/** 칸 수 합에 닿은 구성원 열쇠 — loads 는 열쇠마다 지금 그 구성원이 쥔 일(1차: 살아 있는 장부 행, 2차: 끝나지 않은 표). */
export function reviewPoolCappedKeys(caps: ReadonlyMap<string, number> | null, loads: ReadonlyMap<string, number>): Set<string> {
  return new Set(caps ? [...caps].filter(([key, cap]) => (loads.get(key) ?? 0) >= cap).map(([key]) => key) : []);
}
/** 계약·순위 스냅숏을 기다린 뒤(잡 틱·소비자 쪽의 길목). 던지지 않는다. */
export async function ensureReviewTaskRanks(maxAgeMs?: number): Promise<void> {
  await Promise.all([ensureServingContracts(maxAgeMs), ensureAiTaskModels(maxAgeMs), ensureAiTaskExecutionConfigs(maxAgeMs)]);
}
/**
 * 순위 표를 한 번도 읽지 못했으면 미룬다(ModelCapacityDeferredError assignments_unavailable) — 어느 투표자·심사자가 맞는지 모르는 채로 빈 목록으로
 * 2차 표를 올리거나 정리(model_removed)하지 않는다(예전 배정 표의 requireStageAssignments 자리). 격리 replay 는 설정 행을 읽으므로 곧 돌아온다.
 */
export async function requireReviewTaskRanks(): Promise<void> {
  if (currentReplayDb() || pinHolder.__nmvReviewRanksPin) return;
  await ensureReviewTaskRanks();
  if (!aiTaskModelsReadState().loaded) throw new ModelCapacityDeferredError("assignments_unavailable");
}


/** One workload choice for one new input. Existing intents are pinned by the caller before this hint. */
export async function chooseReviewWorkloadMember(resolution: ReviewRankResolution,
  blocked: ReadonlySet<string> = new Set()): Promise<(ReviewRankReviewer & { poolSelection: AiTaskPoolSelection }) | null> {
  const config = resolution.execution;
  if (!config || config.mode !== "workload_pool") return null;
  const candidates = resolution.candidates.flatMap(candidate => {
    const binding = candidate.binding, member = candidate.poolMember;
    if (!binding || !member || candidate.unusable || blocked.has(JSON.stringify([binding.provider, binding.identity]))) return [];
    return [{ memberId: member.memberId, routeId: binding.routeId, connectionId: binding.connectionId,
      provider: binding.provider, identity: binding.identity, engineModel: binding.engineModel, deviceId: binding.deviceId }];
  });
  // 빈 칸이 없어도 줄에 설 수 있는 구성원을 고른다 — claim(requestSlot)이 대기 행을 쓰고 차례를 기다린다(순위대로와 같은 줄, 2026-11-12 검토).
  // 예전에는 장비가 그 순간 가득이면 null 이라 후보가 「순위 밖 모델에 묶임」(reviewer_unassigned)으로 건너뛰어지고 그 횟수가 후보 탓으로 쌓였다.
  const chosen = await chooseTaskWorkloadMember(config, candidates, { queueWhenFull: true });
  return chosen ? { provider: chosen.provider as ReviewRankProvider, model: chosen.identity, poolSelection: chosen.poolSelection } : null;
}

const reviewerKey = (value: ReviewRankReviewer) => JSON.stringify([value.provider, value.model]);
const reviewerOf = (binding: ReviewRankBinding): ReviewRankReviewer => ({ provider: binding.provider, model: binding.identity });

/** 쓸 수 없는 까닭(코드) → 운영자 문장(text 작업과 같은 표 + 심사 쪽 코드). */
export const reviewRankUnusableText = (code: string, detail?: string | null): string => `${textRankUnusableText(code)}${detail ? `(${detail})` : ""}`;

/**
 * 1차 순위 — 「지금 1차 심사자」(순위 차례, identity 를 아는 것만)와 쓸 수 없는 것(고르기가 비켜 갈 열쇠 → 까닭).
 * 「동시에」에 예비를 켰으면 예비 순위도 「지금 1차 심사자」다(그 결과가 유효하고 claim 재확인·2차 관문이 센다) — 구성원 다음에 붙고, 구성원과 같은 열쇠(같은 엔진)는
 * 한 번만 든다(reserve 에는 구성원과 다른 열쇠만 — 칸이 찬·쉬는 구성원의 엔진을 예비로 다시 부르지 않는다).
 */
export type FirstReviewRanks = Readonly<{ resolution: ReviewRankResolution; pool: readonly ReviewRankReviewer[];
  unusable: ReadonlyMap<string, string>; usable: number; reserve: readonly ReviewRankReviewer[]; reserveCandidates: readonly ReviewRankCandidate[] }>;
export function firstReviewRanks(): FirstReviewRanks {
  const resolution = resolveReviewTaskRanks("first-review", 1);
  const reserveCandidates = resolveReviewReserveRanks("first-review", 1);
  const pool: ReviewRankReviewer[] = [], unusable = new Map<string, string>(), reserve: ReviewRankReviewer[] = [];
  for (const candidate of [...resolution.candidates, ...reserveCandidates]) {
    if (!candidate.binding) continue;
    const reviewer = reviewerOf(candidate.binding), key = reviewerKey(reviewer);
    if (pool.some(entry => reviewerKey(entry) === key)) continue;
    pool.push(reviewer);
    if (reserveCandidates.includes(candidate)) reserve.push(reviewer);
    if (candidate.unusable) unusable.set(key, candidate.unusable);
  }
  return Object.freeze({ resolution, pool: Object.freeze(pool), unusable, usable: pool.length - unusable.size,
    reserve: Object.freeze(reserve), reserveCandidates });
}

/** 2차 투표자 칸 하나: 그 칸의 순위와 지금 표를 내는 순위(쓸 수 있는 가장 높은 순위 — 1순위를 쓸 수 없으면 2·3순위). */
export type SecondReviewSlotRanks = Readonly<{ slot: number; resolution: ReviewRankResolution; voter: ReviewRankBinding | null;
  /** identity 를 아는 순위(순위 차례) — 이 칸의 「지금 2차 심사자」 */
  members: readonly ReviewRankBinding[] }>;
export type SecondReviewRanks = Readonly<{ status: ReviewRankStatus; slots: readonly SecondReviewSlotRanks[] }>;
export function secondReviewRanks(): SecondReviewRanks {
  const task = aiTask("second-review");
  const slots = Array.from({ length: task?.slots ?? 3 }, (_, index) => {
    const resolution = resolveReviewTaskRanks("second-review", index + 1);
    const members = resolution.candidates.flatMap(candidate => candidate.binding ? [candidate.binding] : []);
    const voter = resolution.candidates.find(candidate => candidate.binding && !candidate.unusable)?.binding ?? null;
    return Object.freeze({ slot: index + 1, resolution, voter, members: Object.freeze(members) });
  });
  const statuses = slots.map(slot => slot.resolution.status);
  const status: ReviewRankStatus = statuses.includes("ok") ? "ok" : statuses.includes("task_models_unreadable") ? "task_models_unreadable" : "no_task_models";
  return Object.freeze({ status, slots: Object.freeze(slots) });
}
/**
 * 2차의 투표자(칸마다 지금 표를 내는 순위)와 대체(그 밖의 identity 를 아는 순위). 한 모델은 한 칸에만 든다 — 같은 모델(같은 가중치·연결로 가른 이름 포함)이
 * 두 칸에 있으면(저장이 막지만 옛 행·가져오기) 앞 칸만 쓴다. 대체 고르기는 secondReviewSlotFallbacks 로 같은 칸 안에서만 한다.
 */
export function secondReviewRankSets(ranks: SecondReviewRanks = secondReviewRanks()): { voters: ReviewRankReviewer[]; fallbacks: ReviewRankReviewer[] } {
  const taken = new Set<string>(), voters: ReviewRankReviewer[] = [], fallbacks: ReviewRankReviewer[] = [];
  for (const slot of ranks.slots) {
    if (!slot.voter) continue;
    const key = canonicalReviewModel(slot.voter.identity);
    if (taken.has(key)) continue;
    taken.add(key);
    voters.push(reviewerOf(slot.voter));
  }
  for (const slot of ranks.slots) for (const member of slot.members) {
    const key = canonicalReviewModel(member.identity);
    if (taken.has(key)) continue;
    taken.add(key);
    fallbacks.push(reviewerOf(member));
  }
  return { voters, fallbacks };
}
/**
 * 그 모델(2차 행의 첫 표 모델)이 든 투표자 칸 — 없으면 null(순위에서 빠졌다). 한 모델은 한 칸에만 든다(저장이 막는다). 옛 행·가져오기로 두 칸에 있으면
 * 그 모델이 표를 내는 칸, 없으면 앞 칸의 것으로 본다(secondReviewRankSets 와 같은 규칙).
 */
export function secondReviewSlotOf(model: string, ranks: SecondReviewRanks = secondReviewRanks()): SecondReviewSlotRanks | null {
  const key = canonicalReviewModel(model);
  return ranks.slots.find(slot => slot.voter && canonicalReviewModel(slot.voter.identity) === key)
    ?? ranks.slots.find(slot => slot.members.some(member => canonicalReviewModel(member.identity) === key)) ?? null;
}
/** Options of the exact rank represented by the selected reviewer; mirror identity deduplication above. */
export function reviewRankFor(routeId: ReviewTaskRoute, provider: string, model: string): AiTaskRank | null {
  // Compatibility/replay callers have no DB rank options; admission has already ensured the live rank snapshot.
  if (settingsReviewersActive() || !aiTaskModelsReadState().loaded && !currentPin()) return null;
  if (routeId === "crawl-agent-review") {
    // 구성원 먼저, 다음 예비(켰을 때만) — firstReviewRanks 의 중복 제거와 같은 차례라 같은 열쇠면 고르기가 본 것과 같은 순위다
    return firstReviewRankCandidates().find(candidate => candidate.binding?.provider === provider && candidate.binding.identity === model)?.rank ?? null;
  }
  const ranks = secondReviewRanks(), slot = secondReviewSlotOf(model, ranks);
  if (!slot) {
    // Existing slot1 votes still execute their saved legacy primary/fallback binding.
    // New pool work is selected only from resolution.candidates above.
    if (readAiTaskExecutionConfig('second-review', 1).mode !== 'workload_pool') return null;
    return taskModels('second-review', 1).find(rank => {
      const candidate = bindReviewTaskRank('second-review', rank);
      return candidate.binding?.provider === provider && candidate.binding.identity === model;
    }) ?? null;
  }
  const voter = slot.voter?.provider === provider && slot.voter.identity === model ? slot.voter : null;
  return slot.resolution.candidates.find(candidate => candidate.binding?.provider === provider && candidate.binding.identity === model
    && (!voter || candidate.binding.connectionId === voter.connectionId && candidate.binding.rank === voter.rank))?.rank ?? null;
}
export function reviewRankOptionsFor(routeId: ReviewTaskRoute, provider: string, model: string): Readonly<Record<string, unknown>> | null {
  return reviewRankFor(routeId, provider, model)?.options ?? null;
}

/**
 * 같은 칸의 대체 차례(PR C1 — 투표자 칸마다 따로 1·2·3순위). 첫 표 모델(root)이 든 칸에서 그 모델 다음 순위부터, 쓸 수 있는 것만. 다른 칸의 모델은 들지 않는다 —
 * 대체 목록을 투표자 모두가 나눠 쓰던 때(PR A 의 남은 일 2)처럼 한 모델이 한 항목에 두 표를 내지 않는다. 두 칸에 있는 모델은 secondReviewSlotOf 가 정한 칸의 것이다.
 * 부르는 쪽은 이미 표를 낸 모델도 뺀다.
 */
export function secondReviewSlotFallbacks(rootModel: string, ranks: SecondReviewRanks = secondReviewRanks()): ReviewRankReviewer[] {
  const slot = secondReviewSlotOf(rootModel, ranks);
  if (!slot) return [];
  const key = canonicalReviewModel(rootModel);
  const at = slot.resolution.candidates.findIndex(candidate => candidate.binding && canonicalReviewModel(candidate.binding.identity) === key);
  return slot.resolution.candidates.slice(at + 1).flatMap(candidate => candidate.binding && !candidate.unusable
    && secondReviewSlotOf(candidate.binding.identity, ranks)?.slot === slot.slot ? [reviewerOf(candidate.binding)] : []);
}

// ── 제 일 못 함(degraded)·틱 요약 ───────────────────────────────────────────────────────────────────────

export type ReviewRankDegraded = { code: (typeof AI_TASK_RANK_DEGRADED_CODES)[number]; detail: string; cause?: typeof AI_TASK_KEY_MISSING_CAUSE };
/** 모든 순위가 키 없는 연결뿐이면 cause(설정의 일 — 진행 감시가 배포를 막지 않는다, AI_TASK_KEY_MISSING_CAUSE). */
const keyMissingCause = (candidates: readonly ReviewRankCandidate[]) => onlyKeyMissing(candidates.map(candidate => candidate.unusable))
  ? { cause: AI_TASK_KEY_MISSING_CAUSE } : {};
const candidateText = (candidate: ReviewRankCandidate) =>
  `${candidate.rank.rank}순위 ${candidate.rank.connection.label} · ${candidate.rank.model}: ${candidate.unusable ? reviewRankUnusableText(candidate.unusable, candidate.detail) : "쓸 수 있음"}`;
/** 1차: 순위 없음·표 못 읽음·모든 순위를 쓸 수 없음이면 그 degraded, 부를 순위가 있으면 null. */
export function firstReviewRanksDegraded(ranks: FirstReviewRanks): ReviewRankDegraded | null {
  const name = aiTask("first-review")?.label ?? "1차 AI 검수";
  const { resolution } = ranks;
  if (resolution.status === "no_task_models")
    return { code: "no_task_models", detail: `${name}: 작업 ↔ 모델(/admin/models/tasks)에 순위가 없습니다 — 코드 기본값·옛 설정으로 대신 부르지 않습니다` };
  if (resolution.status === "task_models_unreadable")
    return { code: "task_models_unreadable", detail: `${name}: 작업 ↔ 모델 표를 아직 읽지 못했습니다(권한·migration 0162 확인) — 기본값으로 대신 부르지 않습니다` };
  if (ranks.usable > 0) return null;
  const all = [...resolution.candidates, ...ranks.reserveCandidates];
  const parts = [...resolution.candidates.map(candidateText), ...ranks.reserveCandidates.map(candidate => `예비 ${candidateText(candidate)}`)];
  return { code: "all_ranks_unusable", detail: `${name}: ${parts.join(" / ")}`.slice(0, 300), ...keyMissingCause(all) };
}
/** 2차: 순위 없음·표 못 읽음, 또는 표를 낼 칸이 하나도 없음(모든 칸의 모든 순위를 쓸 수 없음). */
export function secondReviewRanksDegraded(ranks: SecondReviewRanks): ReviewRankDegraded | null {
  const task = aiTask("second-review");
  const name = task?.label ?? "2차 AI 검수";
  if (ranks.status === "no_task_models")
    return { code: "no_task_models", detail: `${name}: 작업 ↔ 모델(/admin/models/tasks)에 투표자 순위가 없습니다 — 옛 설정·기본 투표자로 대신 부르지 않습니다` };
  if (ranks.status === "task_models_unreadable")
    return { code: "task_models_unreadable", detail: `${name}: 작업 ↔ 모델 표를 아직 읽지 못했습니다(권한·migration 0162 확인) — 기본값으로 대신 부르지 않습니다` };
  if (ranks.slots.some(slot => slot.voter)) return null;
  const parts = ranks.slots.filter(slot => slot.resolution.candidates.length).map(slot =>
    `${task ? aiTaskSlotLabel(task, slot.slot) : `투표자 ${slot.slot}`} — ${slot.resolution.candidates.map(candidateText).join(", ")}`);
  return { code: "all_ranks_unusable", detail: `${name}: ${parts.join(" / ")}`.slice(0, 300),
    ...keyMissingCause(ranks.slots.flatMap(slot => slot.resolution.candidates)) };
}
/**
 * 틱 끝 요약(ai_task.ranks 의 숫자 칸) — 칸·순위마다 쓸 수 없는 까닭과 지금 표를 내는 순위. text 작업의 summary 와 같은 이름을 쓴다(관리 화면이 읽는다).
 * reserve: 「동시에」의 예비 순위 — text 작업처럼 served.<순위>·unusable.<순위>.<까닭> 으로 센다(구성원 칸과 섞지 않는다).
 */
export function reviewRanksSummary(resolutions: readonly ReviewRankResolution[], served: ReadonlyMap<number, number> = new Map(),
  reserve?: Readonly<{ candidates: readonly ReviewRankCandidate[]; served: ReadonlyMap<number, number> }>): Record<string, number> {
  const out: Record<string, number> = { ranks: resolutions.reduce((sum, row) => sum + row.candidates.length, 0) };
  if (reserve?.candidates.length) {
    for (const [rank, count] of reserve.served) if (count > 0) out[`served.${rank}`] = count;
    for (const candidate of reserve.candidates) if (candidate.unusable && /^[a-z_]{1,60}$/.test(candidate.unusable)) {
      const key = `unusable.${candidate.rank.rank}.${candidate.unusable}`;
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  const pool = resolutions.find(resolution => resolution.execution?.mode === 'workload_pool');
  if (pool?.execution?.revision) {
    out.pool_revision = pool.execution.revision;
    out.pool_members = pool.candidates.length;
  } else for (const [rank, count] of served) out[`served.${rank}`] = count;
  for (const resolution of resolutions) for (const candidate of resolution.candidates) {
    const member = resolution.execution?.mode === 'workload_pool' ? candidate.poolMember : null;
    if (member) {
      const count = served.get(candidate.rank.rank) ?? 0;
      if (count > 0) out[`member_served.${member.memberId}`] = count;
    }
    if (!candidate.unusable || !/^[a-z_]{1,60}$/.test(candidate.unusable)) continue;
    const key = member ? `member_unusable.${member.memberId}.${candidate.unusable}` : `unusable.${candidate.rank.rank}.${candidate.unusable}`;
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
