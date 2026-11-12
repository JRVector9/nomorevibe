import { aiTaskPoolFeatures, aiTaskSupportsPool, aiTaskWorkloadPoolApiOnly, AI_TASK_POOL_MEMBER_MAX, type AiTaskPoolFeatures } from "@/lib/llm/ai-task-execution-config";
import { aiTask, aiTaskAccepts } from "@/lib/llm/ai-tasks";
import type { AiRankChoice } from "./admin-ai-tasks";
import { aiTaskEditTarget } from "./ai-task-edit-target";
import { FLOW_RANK_LOCKS, rankForm, type FlowRankEditor, type FlowRankLine } from "./flow-rank-editor";
import type { AssignmentState, PreviewContext } from "./stage-panel-model";
import { poolExecutionForm, poolMembersInput, poolSlotTexts } from "./task-pool-form";

/**
 * 모델에서 바로 붙이기(2026-11-12 소유자 「모델 목록에 모델이 떠 있으면 … 작업 배정을 따로 하지 않아도」) — 모델 상세의 「쓰는 단계」에서
 * 작업(단계)을 고르고 「순위대로 1·2·3순위」나 「함께(동시에)」로 붙인다. 순수 함수만: 붙일 수 있는 작업 · 바꾼 뒤 배정(draft) · 저장 전 확인의 둘레.
 * 저장은 작업 배정·단계 패널과 같은 서버 동작(saveAiTaskRanksAction · saveTaskExecutionAction)을 화면이 부른다 — 새 쓰기 경로가 없다.
 */

export const ATTACH_RANKS = 3;
export type AttachMode = "rank" | "pool";

/** 붙일 수 있는 작업 한 줄 — 이 연결을 받는 작업만(aiTaskAccepts · 쓸 수 있는 작업 allowedTasks) */
export type AttachTarget = Readonly<{
  key: string; task: string; slot: number; label: string;
  /** 순위대로로 붙일 수 있나(발행 분류는 순위 대신 기존 CLI 분류라 아니다) */
  rank: boolean;
  /** 함께(동시에)로 붙일 수 있나 — 실행 쪽이 받는 작업만 */
  pool: boolean; features: AiTaskPoolFeatures; apiOnly: boolean;
  /** 이 모델이 지금 이 작업에 있나(순위 또는 함께) */
  using: boolean;
}>;

/** 순위대로·함께 둘 다 막힌 까닭(화면에서 바꿀 수 없는 작업 · 실행이 이 순위를 읽지 않는 작업) — 목록에서 뺀다 */
function blocked(line: FlowRankLine): boolean {
  if (FLOW_RANK_LOCKS[line.task]) return true;
  return !line.live && line.task !== "publish-classify" && !!aiTaskEditTarget(line.task);
}

/** 이 연결을 붙일 수 있는 작업들 — 순서는 작업 배정 화면과 같다(흐름 칸 차례) */
export function attachTargets(editor: FlowRankEditor, connectionId: string): AttachTarget[] {
  const connection = editor.connections.find(row => row.id === connectionId);
  if (!connection || !connection.enabled) return [];
  return editor.lines.flatMap(line => {
    const task = aiTask(line.task);
    if (!task || !aiTaskAccepts(task, connection) || blocked(line)) return [];
    if (!line.options.some(option => option.provider === connectionId && !option.off && !option.saved)) return [];
    const apiOnly = aiTaskWorkloadPoolApiOnly(line.task);
    const pool = aiTaskSupportsPool(line.task, line.slot) && (!apiOnly || connection.kind === "api" || connection.cliTool === "opencode");
    const rank = !apiOnly;
    if (!rank && !pool) return [];
    const using = line.saved.some(row => row.provider === connectionId)
      || (line.execution?.mode === "workload_pool" && line.execution.members.some(member => member.connectionId === connectionId));
    return [{ key: line.key, task: line.task, slot: line.slot, label: line.label, rank, pool, features: aiTaskPoolFeatures(line.task, line.slot), apiOnly, using }];
  });
}

/** 저장된 배정(작업 배정·단계 패널과 같은 모양) */
export function savedAssignment(line: FlowRankLine): AssignmentState {
  const members = (line.execution?.members ?? []).map(member => ({ provider: member.connectionId, model: member.model,
    ...(typeof member.options.reasoningEffort === "string" && member.options.reasoningEffort ? { reasoningEffort: member.options.reasoningEffort } : {}) }));
  return { mode: line.execution?.mode ?? "fallback", ranks: line.saved, members, slots: poolSlotTexts(line.execution?.members ?? []),
    reserve: line.execution?.reserveRanks ?? false };
}

const filled = (rows: readonly (AiRankChoice | null)[]) => rows.filter((row): row is AiRankChoice => !!row);

/** 순위대로 붙일 때 실제로 들어갈 자리 — 비운 자리 없이(빈 순위 뒤에 고를 수 없다) */
export function attachRankPosition(before: AssignmentState, choice: AiRankChoice, wanted: number): number {
  const others = filled(before.ranks).filter(row => row.provider !== choice.provider);
  return Math.max(1, Math.min(wanted, others.length + 1, ATTACH_RANKS));
}

/**
 * 바꾼 뒤 배정.
 * - 순위대로: 이 모델(같은 연결의 다른 순위는 뺀다)을 고른 순위에 넣고 뒤는 한 칸씩 밀린다(3순위 밖은 빠진다). 「동시에」였으면 순위대로로 돌아간다.
 * - 함께: 이미 「동시에」면 그 구성원에 더하고(있으면 그대로), 순위대로였으면 지금 1순위와 이 모델로 시작한다(지금 쓰는 모델이 빠지지 않게).
 *   칸 수는 화면이 넘긴 자리별 글자 그대로, 예비는 순위대로에서 넘어올 때 켠다(받는 작업만 — 나머지 순위가 예비로 남는다).
 */
export function attachDraft(input: { before: AssignmentState; choice: AiRankChoice; mode: AttachMode; rank: number; slots?: readonly string[] | null;
  reserve?: boolean | null; features: AiTaskPoolFeatures }): AssignmentState {
  const { before, choice } = input;
  if (input.mode === "rank") {
    const others = filled(before.ranks).filter(row => row.provider !== choice.provider);
    const at = attachRankPosition(before, choice, input.rank) - 1;
    const ranks = [...others.slice(0, at), choice, ...others.slice(at)].slice(0, ATTACH_RANKS);
    return { ...before, mode: "fallback", ranks };
  }
  const members = before.mode === "workload_pool" ? filled(before.members) : filled(before.ranks).slice(0, 1);
  const already = members.some(row => row.provider === choice.provider && row.model === choice.model);
  const nextMembers = already ? members : [...members, choice].slice(0, AI_TASK_POOL_MEMBER_MAX);
  const savedSlots = before.mode === "workload_pool" ? before.slots ?? [] : [];
  const slots = Array.from({ length: AI_TASK_POOL_MEMBER_MAX }, (_, index) => input.slots?.[index] ?? savedSlots[index] ?? "");
  const reserve = input.features.reserve && (input.reserve ?? (before.mode === "workload_pool" ? !!before.reserve : true));
  return { mode: "workload_pool", ranks: before.ranks, members: nextMembers, slots, reserve };
}

/** 구성원이 이미 가득(4)이라 더할 수 없나 */
export const attachPoolFull = (before: AssignmentState, choice: AiRankChoice) => before.mode === "workload_pool"
  && filled(before.members).length >= AI_TASK_POOL_MEMBER_MAX && !filled(before.members).some(row => row.provider === choice.provider && row.model === choice.model);

/**
 * 저장 전 확인의 둘레(assignmentPreview 의 context) — 순위·구성원은 편집기에서, 장비 점유·한도는 모델 화면의 읽기에서.
 * modelGroups 는 화면이 모델 이름 하나로 부를지 가르는 수(고르는 상자와 같은 셈 — 화면이 넘긴다).
 */
export function attachPreviewContext(editor: FlowRankEditor, devices: readonly { deviceId: string; active: number; limitSlots: number | null }[] | null,
  names: (connectionId: string) => { label: string; models: readonly string[]; modelGroups: number }): PreviewContext {
  return {
    connections: editor.connections.map(connection => ({ id: connection.id, deviceId: connection.deviceId, capacitySlots: connection.capacitySlots, ...names(connection.id) })),
    devices: devices?.map(device => ({ deviceId: device.deviceId, active: device.active, ...(device.limitSlots !== null ? { limit: device.limitSlots } : {}) })) ?? null,
    uses: editor.lines.flatMap(line => [
      ...line.saved.map(row => ({ task: line.task, slot: line.slot, connectionId: row.provider })),
      ...(line.execution?.mode === "workload_pool" ? line.execution.members.map(member => ({ task: line.task, slot: line.slot, connectionId: member.connectionId })) : []),
    ]),
  };
}

/**
 * 저장할 폼 — 저장 전 확인(assignmentPreview)이 고른 차례대로. 실행 방식은 작업 배정 「실행 방식」 폼과 같은 칸(poolExecutionForm — task·slot·expectedRevision·mode·members·reserveRanks,
 * 같은 자리·같은 모델의 구성원은 저장된 id 를 이어 쓴다), 순위는 작업 배정 서랍과 같은 칸(rankForm — 같은 판 비교). 부르는 서버 동작도 그 화면들과 같다.
 */
export function attachSaveForms(input: { line: FlowRankLine; after: AssignmentState; features: AiTaskPoolFeatures; saves: readonly ("execution" | "ranks")[] })
  : { kind: "execution" | "ranks"; form: FormData }[] {
  const { line, after, features } = input;
  return input.saves.map(kind => kind === "execution"
    ? { kind, form: poolExecutionForm({ task: line.task, slot: line.slot, revision: line.execution?.revision ?? null, mode: after.mode,
      members: poolMembersInput(after.members, after.slots ?? [], line.execution?.members ?? [], features), reserve: features.reserve && !!after.reserve }) }
    : { kind, form: rankForm(line, after.ranks) });
}
