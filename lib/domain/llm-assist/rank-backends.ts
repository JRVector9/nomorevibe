import { readActionAuditPolicy } from "@/lib/domain/products/automated-action-audit";
import { aiAssistRouteId, aiConnectionTaskAllowed, aiTask, type AiAssistTaskId } from "@/lib/llm/ai-tasks";
import { aiTaskModelsReadState, ensureAiTaskModels } from "@/lib/llm/ai-task-models-snapshot";
import { taskModels, textRankUnusableText, type AiTaskRank } from "@/lib/llm/ai-task-resolver";
import { readModelCapacityControlObservation } from "@/lib/llm/capacity-repository";
import { localModelRouteIdReady, verifiedLocalModelContract } from "@/lib/llm/local-model-capacity";
import type { LocalModelServingContract } from "@/lib/llm/local-model-serving-contract";
import { modelFamily } from "@/lib/llm/model-registry";
import { assistBackendDrains, type AssistBackendDrain } from "./config";
import { assistWorkTaskSchema, type AssistWorkTask } from "./work";

/**
 * LLM 보강의 모델 고르기(2026-11-11 운영자 결정 「LLM 보강 화면 연결은 끊겨 있으니 다시 연결하고 관리자에서 관리할 수 있도록 하자」).
 *
 * - 보강 줄(regular: 연결 확인·저장소 이동·소개 재검수·소식)은 「작업 ↔ 모델」의 LLM 보강(assist-review), 감사 줄(audit: 판정 감사·의미 예외)은
 *   LLM 보강 독립 감사(assist-audit)의 1·2·3순위를 읽는다. 순위가 하나라도 있으면 순위만 쓴다 — env LLM_ASSIST_BACKENDS 는 읽지 않는다.
 * - 순위가 하나도 없으면(옮기는 동안) 예전처럼 env LLM_ASSIST_BACKENDS(assistBackendDrains)로 돈다. 배포 뒤 두 작업에 순위를 저장하면 env 를 지울 수 있다.
 * - 순위 표를 한 번도 읽지 못했으면 아무 것도 부르지 않는다(task_models_unreadable) — env 로 대신 부르지 않는다.
 * - 대체 실행: 쓸 수 있는 가장 앞 순위 하나로 이 틱의 줄을 돈다(쓸 수 없는 앞 순위의 까닭을 남긴다). 포화(capacity)는 장부가 그 줄의 일을 기다리게 한다 —
 *   다음 순위로 넘기지 않는다.
 * - 순위 하나를 쓰려면: 켜진 API 연결(주소, 저장한 키를 열 수 있음, 「쓸 수 있는 작업」에 이 작업), 그 주소·모델의 검증된 로컬 계약(local-openai-chat-v1 —
 *   관리 표 또는 워커 env), JSON 스키마를 받는 계약, 보강 계열(판정 = 등록부 assist-primary 의 family, 감사 = assist-primary·assist-audit 중 하나 —
 *   예전 env 길과 같은 규칙), 용량 정책에 보강 일의 route(local-assist-<일>-<backend>)가 계약의 예산·장비로 있고 장비에 물리 상한이 있음.
 *   route 가 있는 일만 이 줄이 맡는다. 순위 저장(작업 배정 화면)이 계약·route·장비 행을 만든다.
 * 호출은 늘 용량 장부(withLocalModelCapacity, 장비 칸)를 거친다. 켜기·끄기(llm_assist_controls 의 보내기·반영)는 따로다 — 여기서는 모델만 고른다.
 */

/** 보강 줄 → 그 줄의 「작업 ↔ 모델」 작업 */
export const ASSIST_LANE_TASK: Readonly<Record<"regular" | "audit", AiAssistTaskId>> = Object.freeze({ regular: "assist-review", audit: "assist-audit" });
/** 순위로 고른 줄이 틱마다 맡는 일 수(예전 운영 env 의 maxClaims 와 같은 1). 한 틱 안의 일은 차례로 묻는다 — 동시성은 장부의 장비 칸이 정한다 */
export const ASSIST_RANK_MAX_CLAIMS = 1;

export type AssistRankDrain = AssistBackendDrain & {
  /** 순위로 고른 줄 — 키는 연결의 키(메모리 안에서만), 계약은 단계 풀의 CLI 리비전이 아니라 이 주소·모델로 고른다(servingRevision: null) */
  rank: Readonly<{ rank: number; connectionId: string; connectionLabel: string; model: string }>;
  apiKey: string | null;
};
export type AssistRankUnusable = Readonly<{ rank: number; label: string; model: string; code: string }>;
export type AssistLanePlan =
  | Readonly<{ source: "env"; drains: AssistBackendDrain[] }>
  | Readonly<{ source: "ranks"; drains: AssistRankDrain[]; ranks: number; unusable: readonly AssistRankUnusable[];
    /** 순위는 있는데 부를 순위가 없음(all_ranks_unusable)·순위 표를 못 읽음(task_models_unreadable). 이 줄에 맡을 일이 없으면(감사 꺼짐) null */
    degraded: Readonly<{ code: string; detail: string }> | null;
    /** 관리 화면 「실행」 줄 — 잡 관측의 ai_task.ranks 와 같은 꼴(lib/llm/ai-task-resolver.ts textRankStatusFromCounts) */
    summary: Readonly<Record<string, number>> }>;

type Env = Readonly<Record<string, string | undefined>>;
export type AssistLaneDeps = Readonly<{
  ranks?: (taskId: string) => readonly AiTaskRank[];
  loaded?: () => boolean;
  policy?: () => Promise<Readonly<{ mode: string; policy: Readonly<{ routes: readonly { routeId: string; provider: string; model: string; providerBudgetId: string; groupId: string }[] }> | null }>>;
  contract?: (endpoint: string, model: string) => LocalModelServingContract | null;
  families?: () => Readonly<{ primary: string; audit: string }>;
}>;

/** 이 줄이 맡는 보강 일 — 작업 목록의 assistWork(감사 줄은 감사 정책이 켜져 있을 때만, 예전 env 길과 같다) */
export function assistLaneWork(lane: "regular" | "audit", env: Env = process.env): AssistWorkTask[] {
  const work = (aiTask(ASSIST_LANE_TASK[lane])?.assistWork ?? []).map(value => assistWorkTaskSchema.parse(value));
  return lane === "audit" && !readActionAuditPolicy(env).enabled ? [] : work;
}

/** 순위 하나가 그 줄에서 쓰일 수 있는가 — 쓸 수 있으면 줄, 아니면 까닭 코드 */
function rankDrain(rank: AiTaskRank, lane: "regular" | "audit", work: readonly AssistWorkTask[], families: { primary: string; audit: string },
  policy: Awaited<ReturnType<NonNullable<AssistLaneDeps["policy"]>>>, contractOf: NonNullable<AssistLaneDeps["contract"]>, env: Env): AssistRankDrain | string {
  const connection = rank.connection;
  if (!rank.enabled) return "rank_disabled";
  if (!connection.enabled) return "connection_disabled";
  if (!aiConnectionTaskAllowed(ASSIST_LANE_TASK[lane], connection)) return "connection_task_not_allowed";
  if (connection.kind !== "api") return "connection_not_api";
  if (!connection.baseUrl) return "connection_url_missing";
  if (connection.keyUnreadable) return "stored_key_unreadable";
  const contract = contractOf(`${connection.baseUrl}/chat/completions`, rank.model);
  if (!contract) return "no_local_contract";
  if (!contract.capabilities.jsonSchema) return "assist_json_schema_missing";
  const allowed = lane === "audit" ? [families.primary, families.audit] : [families.primary];
  if (!allowed.includes(contract.modelFamily)) return "assist_family_mismatch";
  // 장부가 열려 있을 때만 경로를 미리 본다 — 꺼졌거나 비우는 중이면 부르는 길(withLocalModelCapacity)이 미룬다
  const tasks = policy.mode === "open" ? work.filter(task => localModelRouteIdReady(policy.policy, aiAssistRouteId(task, contract.backendId), contract, env)) : [...work];
  if (!tasks.length) return "assist_routes_missing";
  return { backendId: contract.backendId, tasks, maxClaims: ASSIST_RANK_MAX_CLAIMS, contract, apiKey: connection.apiKey,
    rank: Object.freeze({ rank: rank.rank, connectionId: connection.id, connectionLabel: connection.label, model: rank.model }) };
}

/**
 * 이 틱의 보강 줄. 순위가 없으면 env 길(assistBackendDrains — 예전 그대로, 그 길이 던지는 오류도 그대로), 있으면 순위로 고른 줄 하나(또는 없음 + 까닭).
 */
export async function assistLanePlan(lane: "regular" | "audit", env: Env = process.env, deps: AssistLaneDeps = {}): Promise<AssistLanePlan> {
  const taskId = ASSIST_LANE_TASK[lane];
  if (!deps.ranks) await ensureAiTaskModels();
  const ranks = [...(deps.ranks ?? (id => taskModels(id, 1)))(taskId)].sort((a, b) => a.rank - b.rank);
  const loaded = deps.loaded ? deps.loaded() : aiTaskModelsReadState().loaded;
  if (!ranks.length) {
    if (!loaded) return Object.freeze({ source: "ranks", drains: [], ranks: 0, unusable: [],
      degraded: Object.freeze({ code: "task_models_unreadable", detail: "작업 ↔ 모델 표를 아직 읽지 못했습니다 — LLM 보강을 부르지 않습니다(env 로 대신 부르지 않음)" }),
      summary: Object.freeze({ ranks: 0 }) });
    return Object.freeze({ source: "env", drains: assistBackendDrains(env, lane) });
  }
  const work = assistLaneWork(lane, env);
  if (!work.length) return Object.freeze({ source: "ranks", drains: [], ranks: ranks.length, unusable: [], degraded: null, summary: Object.freeze({ ranks: ranks.length }) });
  const families = (deps.families ?? (() => ({ primary: modelFamily("assist-primary", env), audit: modelFamily("assist-audit", env) })))();
  const policy = await (deps.policy ?? readModelCapacityControlObservation)();
  const contractOf = deps.contract ?? ((endpoint: string, model: string) => verifiedLocalModelContract(endpoint, model, env));
  const unusable: AssistRankUnusable[] = [];
  const summary: Record<string, number> = { ranks: ranks.length };
  for (const rank of ranks) {
    const drain = rankDrain(rank, lane, work, families, policy, contractOf, env);
    if (typeof drain !== "string") {
      // 맡은 순위 — 맡은 일 수는 잡이 틱 끝에 채운다(llm-assist-review.ts)
      summary[`served.${rank.rank}`] = 0;
      return Object.freeze({ source: "ranks", drains: [drain], ranks: ranks.length, unusable: Object.freeze(unusable), degraded: null, summary: Object.freeze(summary) });
    }
    unusable.push(Object.freeze({ rank: rank.rank, label: rank.connection.label, model: rank.model, code: drain }));
    summary[`unusable.${rank.rank}.${drain}`] = 1;
  }
  return Object.freeze({ source: "ranks", drains: [], ranks: ranks.length, unusable: Object.freeze(unusable), summary: Object.freeze(summary),
    degraded: Object.freeze({ code: "all_ranks_unusable",
      detail: unusable.map(entry => `${entry.rank}순위 ${entry.label} · ${entry.model}: ${assistRankUnusableText(entry.code)}`).join(" / ") }) });
}

/** 순위를 쓸 수 없는 까닭(코드) → 운영자 문장 — text 작업과 같은 표(ai-task-resolver TEXT_RANK_UNUSABLE_TEXT, 보강 까닭도 그 표에 있다) */
export const assistRankUnusableText = (code: string): string => textRankUnusableText(code);
