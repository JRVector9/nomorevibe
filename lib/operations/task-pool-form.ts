import { AI_TASK_POOL_MEMBER_SLOTS_MAX, type AiTaskExecutionInput, type AiTaskPoolFeatures } from "@/lib/llm/ai-task-execution-config";
import type { AiRankChoice } from "./admin-ai-tasks";

/**
 * 「동시에」(작업 분산) 편집의 공통 규칙(운영 콘솔 개편 통합, 2026-11-12) — 작업 배정의 실행 방식 폼(TaskExecutionForm)과
 * 단계 패널의 「모델」 구역(StageModels)이 같은 검사·같은 저장 값을 쓴다. 순수 함수만(화면 양쪽에서 부른다).
 * 서버(saveTaskExecutionAction → aiTaskExecutionInputSchema·saveAiTaskExecutionConfig)가 같은 규칙을 다시 검사한다 — 여기는 저장 전에 미리 알리는 것이다.
 * 칸 수·예비는 실행 쪽이 따르는 작업에서만 받는다(aiTaskPoolFeatures).
 */

/** 화면이 아는 연결 — 켜짐·종류·CLI 도구 */
export type PoolFormConnection = Readonly<{ id: string; enabled: boolean; kind: "api" | "cli"; cliTool: string | null }>;
/** 저장된 구성원(자리·연결·모델·칸 수) — 같은 자리·같은 모델이면 저장된 id 를 이어 쓴다 */
export type PoolSavedMember = Readonly<{ memberId: string; position: number; connectionId: string; model: string; maxSlots?: number | null }>;
export type PoolFormRules = Readonly<{ apiOnly: boolean; features: AiTaskPoolFeatures }>;

/** 칸 수 글자 → 수. 칸 수를 따르지 않는 작업이거나 비었거나 1~8 밖이면 undefined */
export function poolSlotOf(raw: string | undefined, features: AiTaskPoolFeatures): number | undefined {
  const text = (raw ?? "").trim();
  const parsed = Number(text);
  return features.slotCaps && text && Number.isInteger(parsed) && parsed >= 1 && parsed <= AI_TASK_POOL_MEMBER_SLOTS_MAX ? parsed : undefined;
}

/** 저장된 칸 수 → 자리(1~4)마다의 칸 글자(빈 글자 = 정하지 않음) */
export function poolSlotTexts(members: readonly Pick<PoolSavedMember, "position" | "maxSlots">[], size = 4): string[] {
  return Array.from({ length: size }, (_, index) => {
    const saved = members.find(member => member.position === index + 1)?.maxSlots;
    return typeof saved === "number" ? String(saved) : "";
  });
}

/**
 * 구성원 검사 — 문제는 화면 문장. 빈 목록이면 저장할 수 있다.
 * 모델 하나 이상 · 켜진 연결 · 발행 분류는 API·OpenCode 만 · 같은 CLI 연결·모델은 추론 강도가 같아야 함 · 칸 수는 1~8, 모두 적거나 모두 비움.
 */
export function poolMemberIssues(values: readonly (AiRankChoice | null)[], slots: readonly string[], connections: readonly PoolFormConnection[],
  rules: PoolFormRules): string[] {
  const selected = values.filter((choice): choice is AiRankChoice => !!choice);
  const issues: string[] = [];
  if (!selected.length) issues.push("분산할 모델을 하나 이상 선택하세요.");
  if (selected.some(choice => !connections.some(row => row.id === choice.provider && row.enabled))) issues.push("꺼졌거나 없는 연결을 바꿔주세요.");
  if (rules.features.slotCaps) {
    const counts = values.flatMap((choice, index) => choice ? [(slots[index] ?? "").trim()] : []);
    if (counts.some(raw => raw !== "" && poolSlotOf(raw, rules.features) === undefined)) issues.push(`칸 수는 1~${AI_TASK_POOL_MEMBER_SLOTS_MAX} 사이로 적어 주세요.`);
    else if (counts.some(raw => raw === "") && counts.some(raw => raw !== "")) issues.push("칸 수는 모든 모델에 적거나 모두 비워 주세요.");
  }
  if (rules.apiOnly && selected.some(choice => !connections.some(row => row.id === choice.provider && (row.kind === "api" || row.cliTool === "opencode"))))
    issues.push("발행 분류에는 API 또는 OpenCode 연결을 선택하세요.");
  if (selected.some((choice, index) => connections.some(row => row.id === choice.provider && row.kind === "cli")
    && selected.slice(0, index).some(previous => previous.provider === choice.provider && previous.model === choice.model
      && (previous.reasoningEffort ?? "") !== (choice.reasoningEffort ?? ""))))
    issues.push("같은 CLI 연결·모델은 추론 강도를 같게 설정하세요.");
  return issues;
}

/** 저장할 구성원(saveTaskExecutionAction 의 members) — 같은 자리·같은 연결·같은 모델은 저장된 id 를 이어 쓰고, 칸 수는 받는 작업에서만 싣는다 */
export function poolMembersInput(values: readonly (AiRankChoice | null)[], slots: readonly string[], saved: readonly PoolSavedMember[],
  features: AiTaskPoolFeatures): AiTaskExecutionInput["members"] {
  return values.flatMap((choice, index) => {
    if (!choice) return [];
    // 같은 엔진을 두 자리에 두면 서로 다른 구성원이다 — 한 id 를 두 자리에 쓰지 않는다
    const previous = saved.find(member => member.position === index + 1 && member.connectionId === choice.provider && member.model === choice.model);
    const maxSlots = poolSlotOf(slots[index], features);
    return [{ ...(previous ? { memberId: previous.memberId } : {}), connectionId: choice.provider, model: choice.model,
      ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}), ...(maxSlots ? { maxSlots } : {}) }];
  });
}

/** 저장 폼(FormData)의 칸 — 작업 배정 폼의 hidden 칸과 같은 이름. 예비는 「동시에」로 저장할 때만 싣는다 */
export function poolExecutionForm(input: { task: string; slot: number; revision: number | null; mode: "fallback" | "workload_pool";
  members: AiTaskExecutionInput["members"]; reserve: boolean }): FormData {
  const form = new FormData();
  form.set("task", input.task); form.set("slot", String(input.slot));
  form.set("expectedRevision", input.revision == null ? "" : String(input.revision));
  form.set("mode", input.mode);
  form.set("members", JSON.stringify(input.mode === "workload_pool" ? input.members : []));
  if (input.mode === "workload_pool" && input.reserve) form.set("reserveRanks", "1");
  return form;
}
