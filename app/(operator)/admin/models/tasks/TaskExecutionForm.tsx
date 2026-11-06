"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { aiTaskSupportsWorkloadPool, aiTaskWorkloadPoolApiOnly, type AiTaskExecutionInput } from "@/lib/llm/ai-task-execution-config";
import type { AiTaskExecutionAdminView } from "@/lib/operations/admin-ai-task-execution";
import { aiRankReasoningEfforts, type AiConnectionView, type AiRankChoice, type AiRankOption } from "@/lib/operations/admin-ai-tasks";
import { modelPickerConnectionLabel, modelPickerModelLabel } from "../model-picker-display";
import { RankSelects } from "../RankSelects";
import type { AiTaskActionState } from "./actions";
import { saveTaskExecutionAction } from "./execution-actions";
import type { TaskRankLine } from "./TaskRanksBoard";

const MEMBER_FIELDS = Array.from({ length: 4 }, (_, index) => ({ provider: `pool${index + 1}Connection`, model: `pool${index + 1}Model`,
  reasoningEffort: `pool${index + 1}ReasoningEffort` }));
type Props = { view: AiTaskExecutionAdminView; label: string; options: readonly AiRankOption[]; connections: readonly AiConnectionView[];
  readOnly?: boolean; runtime?: TaskRankLine["runtime"] };

/** A previous configuration's last tick must not be presented as this pool's execution. */
export function currentTaskPoolRuntime(view: AiTaskExecutionAdminView, connections: readonly AiConnectionView[], runtime: TaskRankLine["runtime"] | undefined) {
  const memberIds = new Set(view.members.map(member => member.memberId));
  const lastSaved = Math.max(Date.parse(view.updatedAt ?? "") || 0, ...connections.filter(connection => view.members.some(member => member.connectionId === connection.id))
    .map(connection => Date.parse(connection.updatedAt) || 0));
  const startedAt = Date.parse(runtime?.startedAt ?? runtime?.observedAt ?? "");
  const observedAt = Date.parse(runtime?.observedAt ?? "");
  return runtime?.pool?.configRevision === view.revision && runtime.pool.members === view.members.length
    && [...Object.keys(runtime.pool.served), ...runtime.pool.unusable.map(row => row.memberId)].every(id => memberIds.has(id))
    && Number.isFinite(startedAt) && startedAt >= lastSaved && Number.isFinite(observedAt) && runtime.fresh === true
    ? runtime : null;
}

/** AI1 reports the identity total in every matching member; text/publication report individual member totals. */
export function taskPoolRuntimeGroups(view: AiTaskExecutionAdminView, runtime: NonNullable<TaskRankLine["runtime"]>) {
  const groups = new Map<string, AiTaskExecutionAdminView["members"][number][]>();
  for (const member of view.members) {
    const key = JSON.stringify([member.connectionId, member.model]);
    groups.set(key, [...groups.get(key) ?? [], member]);
  }
  return [...groups].map(([key, members]) => {
    const served = members.map(member => runtime.pool?.served[member.memberId] ?? 0);
    const unusable = members.map(member => runtime.pool?.unusable.filter(row => row.memberId === member.memberId).reduce((sum, row) => sum + row.count, 0) ?? 0);
    // AI2's legacy job tick may report configuration without consumer call totals. Absence is not zero calls.
    const known = view.task !== "second-review" || members.some(member => Object.hasOwn(runtime.pool?.served ?? {}, member.memberId));
    return { key, members, shared: members.length > 1,
      served: known ? view.task === "first-review" ? Math.max(0, ...served) : served.reduce((sum, count) => sum + count, 0) : null,
      unusable: view.task === "first-review" ? Math.max(0, ...unusable) : unusable.reduce((sum, count) => sum + count, 0) };
  });
}

/** Pool members are separate settings; none of these fields are saved as rank 4. */
export function TaskExecutionForm({ view, label, options, connections, readOnly = false, runtime }: Props) {
  const [state, action, saving] = useActionState<AiTaskActionState, FormData>(saveTaskExecutionAction, null);
  const [mode, setMode] = useState(view.mode);
  const initial = view.members.map(member => ({ provider: member.connectionId, model: member.model,
    ...(typeof member.options.reasoningEffort === "string" && member.options.reasoningEffort ? { reasoningEffort: member.options.reasoningEffort } : {}) }));
  const [value, setValue] = useState<(AiRankChoice | null)[]>(initial);
  const supported = aiTaskSupportsWorkloadPool(view.task, view.slot);
  const apiOnly = aiTaskWorkloadPoolApiOnly(view.task);
  const currentRuntime = currentTaskPoolRuntime(view, connections, runtime);
  if (!supported && view.mode === "fallback") return null;
  const membersOf = (values: readonly (AiRankChoice | null)[]): AiTaskExecutionInput["members"] => values.flatMap((choice, index) => {
    if (!choice) return [];
    // Repeated engines are independent distribution members; never reuse one member id in two positions.
    const previous = view.members.find(member => member.position === index + 1 && member.connectionId === choice.provider && member.model === choice.model);
    return [{ ...(previous ? { memberId: previous.memberId } : {}), connectionId: choice.provider, model: choice.model,
      ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}) }];
  });
  const members = membersOf(value);
  const changed = mode !== view.mode || mode === "workload_pool" && JSON.stringify(members) !== JSON.stringify(membersOf(initial));
  const issuesOf = (values: readonly (AiRankChoice | null)[]) => {
    const selected = values.filter((choice): choice is AiRankChoice => choice !== null);
    const issues: string[] = [];
    if (!selected.length) issues.push("분산할 모델을 하나 이상 선택하세요.");
    if (selected.some(choice => !connections.some(connection => connection.id === choice.provider && connection.enabled)))
      issues.push("꺼졌거나 없는 연결을 바꿔주세요.");
    if (apiOnly && selected.some(choice => !connections.some(connection => connection.id === choice.provider && (connection.kind === "api" || connection.cliTool === "opencode"))))
      issues.push("발행 분류에는 API 또는 OpenCode 연결을 선택하세요.");
    if (selected.some((choice, index) => connections.some(connection => connection.id === choice.provider && connection.kind === "cli")
      && selected.slice(0, index).some(previous => previous.provider === choice.provider && previous.model === choice.model
        && (previous.reasoningEffort ?? "") !== (choice.reasoningEffort ?? ""))))
      issues.push("같은 CLI 연결·모델은 추론 강도를 같게 설정하세요.");
    return issues;
  };
  const issues = mode === "workload_pool" ? issuesOf(value) : [];
  // Keep a missing saved choice visible until the operator explicitly changes it.
  const choices = options.filter(option => !apiOnly || connections.some(connection => connection.id === option.provider && (connection.kind === "api" || connection.cliTool === "opencode")));
  for (const member of view.members) if (!choices.some(option => option.provider === member.connectionId && option.model === member.model)) {
    const connection = connections.find(row => row.id === member.connectionId);
    choices.push({ provider: member.connectionId, model: member.model, saved: true,
      label: `${connection ? modelPickerConnectionLabel(connection) : "연결 없음"} · ${member.model} (저장된 값)`,
      group: connection ? modelPickerConnectionLabel(connection) : "연결 없음", text: connection ? modelPickerModelLabel(connection, member.model) : member.model,
      reasoningEfforts: connection ? aiRankReasoningEfforts(view.task, connection, member.model) : [] });
  }
  return <section className="mt-task-execution" aria-label={`${label} 실행 방식`}>
    <form action={action} className="grid min-w-0 gap-2">
      <input type="hidden" name="task" value={view.task} /><input type="hidden" name="slot" value={view.slot} />
      <input type="hidden" name="expectedRevision" value={view.revision ?? ""} />
      <input type="hidden" name="members" value={JSON.stringify(mode === "workload_pool" ? members : [])} />
      <div className="mt-task-form-toolbar">
      <label className="grid min-w-0 gap-1 text-[13px]">실행 방식
        <select name="mode" value={mode} disabled={saving || readOnly} className="min-h-9 min-w-0 rounded-lg border border-line bg-bg-card px-2"
          onChange={event => setMode(event.target.value as typeof mode)}>
          <option value="fallback">{apiOnly ? "기존 CLI 분류" : "대체 실행 · 우선순위로 모델 하나 선택"}</option>
          <option value="workload_pool" disabled={!supported}>작업 분산 · 최대 4칸</option>
        </select>
      </label>
      <button type="submit" disabled={saving || readOnly || !changed || issues.length > 0 || mode === "workload_pool" && !supported}
        className="min-h-9 self-end rounded-lg bg-fg px-3 text-[13px] text-bg disabled:opacity-40">{saving ? "저장 중…" : "실행 방식 저장"}</button>
      </div>
      {mode === "workload_pool" ? <>
        <p className="text-[13px] text-fg-3">같은 모델도 반복 선택할 수 있습니다. <Link href="/admin/models/limits" prefetch={false} className="text-accent-ink underline">동시 실행 수</Link>는 단계·장비 공유 한도를 따릅니다.</p>
        {["first-review", "second-review"].includes(view.task) && <p className="text-[13px] text-fg-3">같은 연결·모델을 반복하면 추론 강도도 같게 설정하세요.</p>}
        <RankSelects<AiRankChoice> stage={{ id: `pool-${view.task}-${view.slot}`, label, slots: 4 }} selectionKind="pool"
          options={choices} connections={connections} value={value} onChange={setValue} slotNames={MEMBER_FIELDS}
          disabled={saving || readOnly || !supported} showProvider={false} note={null} validate={issuesOf} />
        {view.task === "second-review" && <p className="text-[13px] text-fg-3">후보별 모델 하나를 고르며, 투표 수는 늘리지 않습니다.</p>}
      </> : <p className="text-[13px] text-fg-3">{apiOnly ? "API·OpenCode 모델을 쓰려면 작업 분산으로 전환하세요." : "우선 모델 하나를 사용하고, 대체가 필요할 때만 다음 순위로 전환합니다."}</p>}
      {view.mode === "workload_pool" && <div className="grid gap-1 text-[13px] text-fg-3">
        {currentRuntime?.pool ? <>
          <p>마지막 관측 · {currentRuntime.at} · {currentRuntime.from === "job" ? "마지막 작업 틱" : "이 웹 프로세스의 마지막 요청"}</p>
          {taskPoolRuntimeGroups(view, currentRuntime).map(group => {
            const member = group.members[0];
            const connection = connections.find(row => row.id === member.connectionId);
            return <p key={group.key}>{group.members.map(row => `모델 ${row.position}`).join("·")} · {connection ? modelPickerConnectionLabel(connection) : "연결 없음"} · {connection ? modelPickerModelLabel(connection, member.model) : member.model}
              {group.served === null ? " · 사용 집계 없음" : ` · ${group.shared ? "동일 모델 공유 업무" : "맡은 업무"} ${group.served}건`}
              {group.unusable > 0 && <span> · 사용 불가 {group.unusable}건</span>}</p>;
          })}
          {currentRuntime.degraded?.code === "all_ranks_unusable" && <p role="alert" className="text-red-600">현재 분산 모델을 모두 사용할 수 없습니다. {currentRuntime.degraded.detail}</p>}
        </> : <p>현재 분산 설정으로 관측된 실행 기록이 아직 없습니다.</p>}
      </div>}
      {state?.message && <p role="status" className="text-[13px]">{state.message}</p>}
      {!!state?.issues?.length && <ul role="alert" className="text-[13px] text-down">{state.issues.map(issue => <li key={issue}>{issue}</li>)}</ul>}
      {!!state?.warnings?.length && <ul className="text-[13px] text-amber-700">{state.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    </form>
  </section>;
}
