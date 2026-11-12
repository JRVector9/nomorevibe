import { z } from "zod";
import { aiTask } from "./ai-tasks";
import type { AiTaskConnectionSnapshot } from "./ai-task-models-snapshot";

export const AI_TASK_EXECUTION_MODES = ["fallback", "workload_pool"] as const;
export type AiTaskExecutionMode = (typeof AI_TASK_EXECUTION_MODES)[number];
export const AI_TASK_POOL_MEMBER_MAX = 4;
/** 구성원 하나가 한 단계에 내줄 수 있는 칸 수의 상한(0179 CHECK 와 같다) */
export const AI_TASK_POOL_MEMBER_SLOTS_MAX = 8;
/** 칸 수를 적은 묶음이 한 틱에 함께 돌리는 줄의 상한(칸 수 합이 이보다 크면 여기서 자른다) */
export const AI_TASK_POOL_LANES_MAX = 16;

/**
 * 「동시에」(workload_pool) 지원 표 — 관리 화면·단계 패널·저장 검증·실행이 모두 이 표만 묻는다(2026-11-12, 운영 콘솔 개편 2b).
 * 표에 없는 작업은 「동시에」를 고를 수 없다(순위대로만). 표의 값은 실행 쪽이 실제로 따르는 것만 적는다 — 넓히려면 실행 경로를 먼저 잇고 시험으로 고정한다.
 * - slots: 「동시에」를 받는 칸(2차 검수는 투표자 1만 — 투표자 1·2·3 은 같은 후보를 각자 판정하는 뜻이라 건드리지 않는다)
 * - slotCaps: 구성원마다 이 단계에 내줄 칸 수(max_slots)를 따른다 — 칸 수를 적으면 칸 수의 합만큼 함께 돌고, 구성원마다 그 칸 수를 넘겨 보내지 않는다
 * - reserve: 묶음이 모두 설 때(실패·한도 초과·쉼) 이 작업의 순위(1·2·3)를 예비로 이어 쓴다(reserve_ranks)
 * 1차·2차(투표자 1) 검수도 칸 수·예비를 따른다(2026-11-12 소유자 「1,2차도 동시에 선택하면 새 동작을 따르게」):
 * - 1차: 구성원의 칸 수 = 그 모델의 살아 있는 1차 장부 행(대기·예약·보냄) 상한. 찬 구성원은 고르지 않고, 남은 구성원 중에서만 줄에 선다. 모두 차거나 설 자리가 없으면
 *   예비 순위가 받는다(예비도 장부 줄에 선다 — lib/crawl/agent-review-repository.ts chooseFirstReviewForCandidate).
 * - 2차: 구성원의 칸 수 = 그 모델에 배정돼 아직 끝나지 않은 표(pending) 상한 — 표 하나는 호출 하나라 동시 호출도 그만큼이다. 모두 차면 예비(저장된 순위의 첫 쓸 수 있는 순위,
 *   배정 행 없는 첫 표)가 받는다. 표 수·고정 표 규칙은 그대로(lib/crawl/second-review-workload.ts insertSecondReviewWorkloadRows).
 * 카테고리 분류·검색어 번역(웹)은 예전의 작업 분산(일 하나마다 구성원 하나)만 따르고 칸 수·예비는 아직 읽지 않는다.
 */
export type AiTaskPoolFeatures = Readonly<{ slotCaps: boolean; reserve: boolean }>;
const POOL_TEXT_JOB: AiTaskPoolFeatures = Object.freeze({ slotCaps: true, reserve: true });
const POOL_DISTRIBUTE_ONLY: AiTaskPoolFeatures = Object.freeze({ slotCaps: false, reserve: false });
const AI_TASK_POOL_SUPPORT: Readonly<Record<string, Readonly<{ slots: readonly number[]; features: AiTaskPoolFeatures }>>> = Object.freeze({
  "product-translate": { slots: [1], features: POOL_TEXT_JOB },
  "reason-translate": { slots: [1], features: POOL_TEXT_JOB },
  "product-search-verify": { slots: [1], features: POOL_TEXT_JOB },
  "product-search-profile": { slots: [1], features: POOL_TEXT_JOB },
  "product-tagline-ko": { slots: [1], features: POOL_TEXT_JOB },
  "crawl-tagline": { slots: [1], features: POOL_TEXT_JOB },
  "search-query-translate": { slots: [1], features: POOL_DISTRIBUTE_ONLY },
  "first-review": { slots: [1], features: POOL_TEXT_JOB },
  "second-review": { slots: [1], features: POOL_TEXT_JOB },
  "publish-classify": { slots: [1], features: POOL_DISTRIBUTE_ONLY },
});
/** 「동시에」를 지원하는 작업(id 차례). */
export const AI_TASK_WORKLOAD_POOL_TASKS: readonly string[] = Object.freeze(Object.keys(AI_TASK_POOL_SUPPORT));
/**
 * 이 작업(칸)에서 「동시에」를 고를 수 있고 실행 경로가 그 설정을 따르는가 — 「지원하는 작업인가」의 유일한 답이다.
 * 화면(작업 배정·단계 패널)은 이것만 묻고, 칸 수·예비 칸은 aiTaskPoolFeatures 로 보인다.
 */
export const aiTaskSupportsPool = (taskId: string, slot = 1): boolean =>
  Object.hasOwn(AI_TASK_POOL_SUPPORT, taskId) && AI_TASK_POOL_SUPPORT[taskId].slots.includes(slot);
/** 「동시에」 안에서 실행 쪽이 따르는 설정(칸 수·예비). 지원하지 않는 작업이면 둘 다 false. */
export const aiTaskPoolFeatures = (taskId: string, slot = 1): AiTaskPoolFeatures =>
  aiTaskSupportsPool(taskId, slot) ? AI_TASK_POOL_SUPPORT[taskId].features : POOL_DISTRIBUTE_ONLY;
/** Actual publication fallback is ConnectAgent CLI; its new pool adapter is API-only. */
export const aiTaskWorkloadPoolApiOnly = (taskId: string): boolean => taskId === 'publish-classify';
/** UI explanation only. This never enables an adapter or treats a model name as space-equivalence proof. */
export function aiTaskWorkloadPoolUnsupportedReason(taskId: string, slot = 1): string | null {
  if (aiTaskSupportsPool(taskId, slot)) return null;
  if (taskId === "second-review" && slot !== 1) return "2차 검수의 작업 분산은 투표자 1칸만 지원합니다.";
  if (taskId === "human-review")
    return "위임 검수의 모델별 승인 유효성과 재시도 이력을 유지하는 전용 연결이 필요해 아직 작업 분산을 지원하지 않습니다.";
  if (taskId === "split-confirm")
    return "갈림 재확인의 기존 입력·모델 고정과 확인 결과 기록을 연결해야 해 아직 작업 분산을 지원하지 않습니다.";
  if (taskId === "split-tiebreak")
    return "이전 심사와 다른 모델을 쓰는 조건과 갈림 확인 단계를 유지해야 해 아직 작업 분산을 지원하지 않습니다.";
  if (taskId === "held-review-retry")
    return "보류 재심사의 모델별 대상 선정·시도 이력을 연결해야 해 아직 작업 분산을 지원하지 않습니다.";
  if (taskId === "audit-review" || taskId === "product-audit")
    return "감사에 고정된 심사자와 명시적 모델 전환 기록을 유지해야 해 아직 작업 분산을 지원하지 않습니다.";
  if (taskId === "audit-second-opinion" || taskId === "published-filter")
    return "모델별 추가 의견의 중복 제외와 감사 종료 조건을 연결해야 해 아직 작업 분산을 지원하지 않습니다.";
  if (taskId === "screen-review")
    return "이미지 지원 계약과 캡처 증거를 선택한 연결에 묶어 검증해야 해 아직 작업 분산을 지원하지 않습니다.";
  if (taskId === "assist-review" || taskId === "assist-audit")
    return "보강 작업의 백엔드·입력·독립 감사 조건을 보존하는 전용 연결이 필요해 아직 작업 분산을 지원하지 않습니다.";
  if (taskId === "product-intro-check")
    return "소개 검수는 기존 CLI 실행·묶음 입력 계약을 사용하며 아직 작업 분산 설정을 읽지 않습니다.";
  if (taskId === "product-embedding" || taskId === "search-embedding")
    return "제품과 검색어가 같은 벡터 공간을 쓰는지 연결별 검증이 필요해 아직 작업 분산을 지원하지 않습니다.";
  if (taskId === "search-rerank")
    return "같은 점수 기준을 쓰는 복제본인지 연결별 검증이 필요해 아직 작업 분산을 지원하지 않습니다.";
  if (taskId === "grok-session-check")
    return "로그인 세션 유지 작업이므로 여러 모델에 나누어 호출하지 않습니다.";
  return "이 작업의 실행 경로는 아직 작업 분산 설정을 읽지 않습니다.";
}
export const AI_TASK_EXECUTION_SAVE_AUDIT_ACTION = "ai-task-execution-save";
const identity = z.string().min(1).max(200).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value));
export const aiTaskPoolMemberInputSchema = z.object({
  memberId: z.uuid().optional(), connectionId: z.uuid(), model: identity,
  reasoningEffort: z.string().min(1).max(40).optional(),
  /** 이 단계에 내줄 칸 수(0179). 없으면 정하지 않음 — 예전처럼 단계 동시 수를 구성원끼리 나눠 쓴다 */
  maxSlots: z.number().int().min(1).max(AI_TASK_POOL_MEMBER_SLOTS_MAX).optional(),
}).strict();
export const aiTaskExecutionInputSchema = z.object({
  task: z.string().min(1).max(64), slot: z.number().int().min(1).max(8),
  expectedRevision: z.number().int().positive().safe().nullable(),
  mode: z.enum(AI_TASK_EXECUTION_MODES), members: z.array(aiTaskPoolMemberInputSchema).max(AI_TASK_POOL_MEMBER_MAX),
  /** 묶음이 모두 설 때 순위(1·2·3)를 예비로 쓴다(0179). 없으면 false — 예비 없음 */
  reserveRanks: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  const task = aiTask(value.task);
  if (!task || value.slot > task.slots) ctx.addIssue({ code: "custom", message: "ai_task_execution_invalid_task_slot" });
  if (value.mode === "workload_pool" && !aiTaskSupportsPool(value.task, value.slot))
    ctx.addIssue({ code: "custom", message: value.task === "second-review" && value.slot !== 1
      ? "ai_task_pool_ai2_single_slot_only" : "ai_task_pool_task_unsupported" });
  if (value.mode === "workload_pool" && value.members.length === 0)
    ctx.addIssue({ code: "custom", message: "ai_task_pool_empty" });
  if (value.mode === "fallback" && (value.members.length !== 0 || value.reserveRanks))
    ctx.addIssue({ code: "custom", message: "ai_task_fallback_uses_existing_ranks" });
  // 실행 쪽이 따르지 않는 설정은 받지 않는다(저장만 되고 안 도는 칸을 만들지 않는다)
  const features = aiTaskPoolFeatures(value.task, value.slot);
  if (value.mode === "workload_pool" && !features.slotCaps && value.members.some(member => member.maxSlots !== undefined))
    ctx.addIssue({ code: "custom", message: "ai_task_pool_slot_caps_unsupported" });
  if (value.mode === "workload_pool" && !features.reserve && value.reserveRanks)
    ctx.addIssue({ code: "custom", message: "ai_task_pool_reserve_unsupported" });
  // 칸 수는 모두 적거나 모두 비운다 — 섞이면 어느 쪽 동작인지 모호하다
  const capped = value.members.filter(member => member.maxSlots !== undefined).length;
  if (value.mode === "workload_pool" && capped && capped !== value.members.length)
    ctx.addIssue({ code: "custom", message: "ai_task_pool_slot_caps_partial" });
});
export type AiTaskExecutionInput = z.infer<typeof aiTaskExecutionInputSchema>;
export type AiTaskPoolMember = Readonly<{
  memberId: string; position: number; connectionId: string; model: string;
  options: Readonly<Record<string, unknown>>; canonicalModel: string; deviceId: string; engineKey: string;
  /** 이 단계에 내줄 칸 수(0179). null·없음 = 정하지 않음(예전 작업 분산 — 단계 동시 수를 구성원끼리 나눠 씀) */
  maxSlots?: number | null;
  /** Current connection, including decrypted credentials in server memory only. Never serialize to UI. */
  connection: AiTaskConnectionSnapshot;
}>;
export type AiTaskExecutionConfig = Readonly<{
  task: string; slot: number; mode: AiTaskExecutionMode; revision: number | null; updatedAt: string | null;
  members: readonly AiTaskPoolMember[];
  /** 묶음이 모두 설 때 순위(ai_task_models)를 예비로 쓴다(0179). 없거나 옛 행이면 false */
  reserveRanks?: boolean;
}>;
/**
 * 칸 수를 적은 묶음의 함께 도는 줄 수 — 칸 수의 합(AI_TASK_POOL_LANES_MAX 에서 자름). 칸 수를 적지 않은 묶음·순위대로는 null
 * (부르는 잡이 예전처럼 단계 동시 수를 쓴다). 칸 수를 따르지 않는 작업도 null.
 */
export function aiTaskPoolCappedLanes(config: Readonly<{ task: string; slot: number; mode: AiTaskExecutionMode;
  members: readonly Readonly<{ maxSlots?: number | null }>[] }>): number | null {
  if (config.mode !== "workload_pool" || !aiTaskPoolFeatures(config.task, config.slot).slotCaps) return null;
  if (!config.members.some(member => member.maxSlots != null)) return null;
  const total = config.members.reduce((sum, member) => sum + (member.maxSlots ?? 1), 0);
  return Math.max(1, Math.min(AI_TASK_POOL_LANES_MAX, total));
}
/** Observation metadata, not capacity/dispatch authority. Existing dispatch bindings remain unchanged. */
export type AiTaskPoolSelection = Readonly<{
  task: string; slot: number; configRevision: number; memberId: string; position: number;
  policyEpoch: number; policyRevision: number; policyHash: string;
}>;
export type AiTaskWorkloadCandidate = Readonly<{
  memberId: string; routeId: string; connectionId: string; engineModel: string;
  provider: string; identity: string; deviceId: string;
}>;
export type AiTaskWorkloadChoice<T extends AiTaskWorkloadCandidate> = T & Readonly<{ poolSelection: AiTaskPoolSelection }>;

/** Safe numeric/member-ID observation; credentials and endpoint configuration are excluded. */
export type AiTaskPoolRuntime = Readonly<{
  configRevision: number; members: number; served: Readonly<Record<string, number>>;
  unusable: readonly Readonly<{ memberId: string; code: string; count: number }>[];
}>;
