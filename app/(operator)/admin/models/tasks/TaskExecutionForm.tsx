"use client";

import { useActionState, useState } from "react";
import { aiTaskSupportsWorkloadPool, aiTaskWorkloadPoolApiOnly, type AiTaskExecutionInput } from "@/lib/llm/ai-task-execution-config";
import type { AiTaskExecutionAdminView } from "@/lib/operations/admin-ai-task-execution";
import { aiRankReasoningEfforts, type AiConnectionView, type AiRankChoice, type AiRankOption } from "@/lib/operations/admin-ai-tasks";
import { modelPickerChoiceKey, modelPickerConnectionLabel, modelPickerModelLabel } from "../model-picker-display";
import { RankSelects } from "../RankSelects";
import type { AiTaskActionState } from "./actions";
import { saveTaskExecutionAction } from "./execution-actions";
import type { TaskRankLine } from "./TaskRanksBoard";

const MEMBER_FIELDS = Array.from({ length: 4 }, (_, index) => ({ provider: `pool${index + 1}Connection`, model: `pool${index + 1}Model`,
  reasoningEffort: `pool${index + 1}ReasoningEffort` }));
type Props = { view: AiTaskExecutionAdminView; label: string; options: readonly AiRankOption[]; connections: readonly AiConnectionView[];
  readOnly?: boolean; runtime?: TaskRankLine["runtime"] };

/** Pool members are separate settings; none of these fields are saved as rank 4. */
export function TaskExecutionForm({ view, label, options, connections, readOnly = false, runtime }: Props) {
  const [state, action, saving] = useActionState<AiTaskActionState, FormData>(saveTaskExecutionAction, null);
  const [mode, setMode] = useState(view.mode);
  const initial = view.members.map(member => ({ provider: member.connectionId, model: member.model,
    ...(typeof member.options.reasoningEffort === "string" && member.options.reasoningEffort ? { reasoningEffort: member.options.reasoningEffort } : {}) }));
  const [value, setValue] = useState<(AiRankChoice | null)[]>(initial);
  const supported = aiTaskSupportsWorkloadPool(view.task, view.slot);
  const apiOnly = aiTaskWorkloadPoolApiOnly(view.task);
  const memberIds = new Set(view.members.map(member => member.memberId));
  const lastSaved = Math.max(Date.parse(view.updatedAt ?? "") || 0, ...connections.filter(connection => view.members.some(member => member.connectionId === connection.id))
    .map(connection => Date.parse(connection.updatedAt) || 0));
  const startedAt = Date.parse(runtime?.startedAt ?? runtime?.observedAt ?? "");
  const observedAt = Date.parse(runtime?.observedAt ?? "");
  const currentRuntime = runtime?.pool?.configRevision === view.revision && runtime.pool.members === view.members.length
    && [...Object.keys(runtime.pool.served), ...runtime.pool.unusable.map(row => row.memberId)].every(id => memberIds.has(id))
    && Number.isFinite(startedAt) && startedAt >= lastSaved && Number.isFinite(observedAt) && runtime.fresh === true
    ? runtime : null;
  if (!supported && view.mode === "fallback") return null;
  const membersOf = (values: readonly (AiRankChoice | null)[]): AiTaskExecutionInput["members"] => values.flatMap(choice => {
    if (!choice) return [];
    const previous = view.members.find(member => member.connectionId === choice.provider && member.model === choice.model);
    return [{ ...(previous ? { memberId: previous.memberId } : {}), connectionId: choice.provider, model: choice.model,
      ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}) }];
  });
  const members = membersOf(value);
  const changed = mode !== view.mode || mode === "workload_pool" && JSON.stringify(members) !== JSON.stringify(membersOf(initial));
  const issuesOf = (values: readonly (AiRankChoice | null)[]) => {
    const selected = values.filter((choice): choice is AiRankChoice => choice !== null);
    const issues: string[] = [];
    if (!selected.length) issues.push("분산할 모델을 하나 이상 선택하세요.");
    if (new Set(selected.map(choice => modelPickerChoiceKey(choice, connections))).size !== selected.length)
      issues.push("같은 연결·모델은 한 번만 선택할 수 있습니다.");
    if (selected.some(choice => !connections.some(connection => connection.id === choice.provider && connection.enabled)))
      issues.push("꺼졌거나 없는 연결을 바꿔주세요.");
    if (apiOnly && selected.some(choice => !connections.some(connection => connection.id === choice.provider && connection.kind === "api")))
      issues.push("발행 분류에는 API 연결을 선택하세요.");
    return issues;
  };
  const issues = mode === "workload_pool" ? issuesOf(value) : [];
  // Keep a missing saved choice visible until the operator explicitly changes it.
  const choices = options.filter(option => !apiOnly || connections.some(connection => connection.id === option.provider && connection.kind === "api"));
  for (const member of view.members) if (!choices.some(option => option.provider === member.connectionId && option.model === member.model)) {
    const connection = connections.find(row => row.id === member.connectionId);
    choices.push({ provider: member.connectionId, model: member.model, saved: true,
      label: `${connection ? modelPickerConnectionLabel(connection) : "연결 없음"} · ${member.model} (저장된 값)`,
      group: connection ? modelPickerConnectionLabel(connection) : "연결 없음", text: connection ? modelPickerModelLabel(connection, member.model) : member.model,
      reasoningEfforts: connection ? aiRankReasoningEfforts(view.task, connection, member.model) : [] });
  }
  return <details id={`execution-${view.task}-${view.slot}`} className="min-w-0 scroll-mt-6 border-b border-line px-4 py-3" open={view.mode === "workload_pool"}>
    <summary className="cursor-pointer text-[13px] font-semibold">{view.mode === "workload_pool" ? `${label} · 작업 분산 · 모델 ${view.members.length}개` : apiOnly ? "실행 방식 · 기존 CLI 분류" : "실행 방식 · 기존 대체 실행"}</summary>
    <form action={action} className="mt-3 grid min-w-0 gap-3">
      <input type="hidden" name="task" value={view.task} /><input type="hidden" name="slot" value={view.slot} />
      <input type="hidden" name="expectedRevision" value={view.revision ?? ""} />
      <input type="hidden" name="members" value={JSON.stringify(mode === "workload_pool" ? members : [])} />
      <label className="grid max-w-sm gap-1 text-[13px]">실행 방식
        <select name="mode" value={mode} disabled={saving || readOnly} className="min-h-9 rounded-lg border border-line bg-bg-card px-2"
          onChange={event => setMode(event.target.value as typeof mode)}>
          <option value="fallback">{apiOnly ? "기존 CLI 분류" : "대체 실행 · 우선순위로 모델 하나 선택"}</option>
          <option value="workload_pool" disabled={!supported}>작업 분산 · 최대 4개 모델</option>
        </select>
      </label>
      {mode === "workload_pool" ? <>
        <p className="text-[13px] text-fg-3">서로 다른 업무를 모델에 나눕니다. 업무마다 모델 하나를 선택하며, 동시 실행 수는 단계·장비 한도를 따릅니다.</p>
        <a href="/admin/models/limits" className="text-[13px] text-accent-ink underline">동시 실행 수 설정 →</a>
        <RankSelects<AiRankChoice> stage={{ id: `pool-${view.task}-${view.slot}`, label, slots: 4 }} selectionKind="pool"
          options={choices} connections={connections} value={value} onChange={setValue} slotNames={MEMBER_FIELDS}
          disabled={saving || readOnly || !supported} showProvider={false} note={null} validate={issuesOf} />
        {view.task === "second-review" && <p className="text-[13px] text-fg-3">투표자 한 칸에서 후보별 모델을 고릅니다. 분산 모델 수가 표 수를 늘리지 않습니다.</p>}
      </> : <p className="text-[13px] text-fg-3">{apiOnly ? "기존 CLI 분류를 사용합니다. API 모델을 쓰려면 작업 분산으로 전환하세요." : "우선 모델 하나를 쓰고, 대체가 필요한 경우에만 다음 순위로 전환합니다. 같은 입력을 세 모델이 차례로 검수하지 않습니다."}</p>}
      {view.mode === "workload_pool" && <div className="grid gap-1 text-[13px] text-fg-3">
        {currentRuntime?.pool ? <>
          <p>마지막 관측 · {currentRuntime.at} · {currentRuntime.from === "job" ? "마지막 작업 틱" : "이 웹 프로세스의 마지막 요청"}</p>
          {view.members.map(member => <p key={member.memberId}>모델 {member.position} · 맡은 업무 {currentRuntime.pool!.served[member.memberId] ?? 0}건
            {currentRuntime.pool!.unusable.some(row => row.memberId === member.memberId) && <span> · 사용 불가 {currentRuntime.pool!.unusable.filter(row => row.memberId === member.memberId).reduce((sum, row) => sum + row.count, 0)}건</span>}</p>)}
          {currentRuntime.degraded?.code === "all_ranks_unusable" && <p role="alert" className="text-red-600">현재 분산 모델을 모두 사용할 수 없습니다. {currentRuntime.degraded.detail}</p>}
        </> : <p>현재 분산 설정으로 관측된 실행 기록이 아직 없습니다.</p>}
      </div>}
      <div><button type="submit" disabled={saving || readOnly || !changed || issues.length > 0 || mode === "workload_pool" && !supported}
        className="min-h-9 rounded-lg bg-fg px-4 text-[13px] text-bg disabled:opacity-40">{saving ? "저장 중…" : "실행 설정 저장"}</button></div>
      {state?.message && <p role="status" className="text-[13px]">{state.message}</p>}
      {!!state?.issues?.length && <ul role="alert" className="text-[13px] text-down">{state.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
      {!!state?.warnings?.length && <ul className="text-[13px] text-amber-700">{state.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    </form>
  </details>;
}
