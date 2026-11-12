"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { AI_TASK_POOL_MEMBER_SLOTS_MAX, aiTaskPoolCappedLanes, aiTaskPoolFeatures, aiTaskSupportsPool, aiTaskWorkloadPoolApiOnly,
  type AiTaskExecutionInput, type AiTaskPoolRuntime } from "@/lib/llm/ai-task-execution-config";
import type { AiTaskExecutionAdminView } from "@/lib/operations/admin-ai-task-execution";
import { aiRankReasoningEfforts, type AiConnectionView, type AiRankChoice, type AiRankOption } from "@/lib/operations/admin-ai-tasks";
import { modelPickerConnectionLabel, modelPickerModelLabel } from "../model-picker-display";
import { RankSelects } from "../RankSelects";
import type { AiTaskActionState } from "./actions";
import { saveTaskExecutionAction } from "./execution-actions";

/** 실행 쪽의 순위 사정(화면 값) — 잡의 마지막 틱(from job) 또는 이 웹 프로세스의 마지막 요청(from web). at 은 화면 글, observedAt 은 원래 시각, fresh = 30분 안(서버가 정한다). */
export type TaskRuntimeLine = { from: "job" | "web"; at: string; served: { rank: number; count: number }[]; unusable: { rank: number; code: string; text: string; count: number }[];
  degraded: { code: string; detail: string | null } | null; pool?: AiTaskPoolRuntime; startedAt?: string; observedAt?: string; fresh?: boolean } | null;

const MEMBER_FIELDS = Array.from({ length: 4 }, (_, index) => ({ provider: `pool${index + 1}Connection`, model: `pool${index + 1}Model`,
  reasoningEffort: `pool${index + 1}ReasoningEffort` }));
type Props = { view: AiTaskExecutionAdminView; label: string; options: readonly AiRankOption[]; connections: readonly AiConnectionView[];
  readOnly?: boolean; runtime?: TaskRuntimeLine };

/** A previous configuration's last tick must not be presented as this pool's execution. */
export function currentTaskPoolRuntime(view: AiTaskExecutionAdminView, connections: readonly AiConnectionView[], runtime: TaskRuntimeLine | undefined) {
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
export function taskPoolRuntimeGroups(view: AiTaskExecutionAdminView, runtime: NonNullable<TaskRuntimeLine>) {
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

/**
 * 「동시에」의 모델별 칸 수(0179) — 이 단계에 그 모델이 내줄 칸 수. 모두 비우면 예전 작업 분산(단계 동시 수를 함께 나눠 씀).
 * 칸 수를 적으면 칸 수의 합만큼 함께 처리하고, 한 모델이 서도 남은 모델이 계속한다. 장비·모델 한도와 장부는 그대로 거친다.
 */
function PoolSlotFields({ value, slots, disabled, onChange, lanes }: { value: readonly (AiRankChoice | null)[]; slots: readonly string[];
  disabled: boolean; onChange: (index: number, raw: string) => void; lanes: number | null }) {
  const rows = value.flatMap((choice, index) => choice ? [{ choice, index }] : []);
  if (!rows.length) return null;
  return <div className="grid min-w-0 gap-1 text-[13px]">
    <table className="w-full table-fixed border-collapse">
      <colgroup><col style={{ width: "72px" }} /><col /><col style={{ width: "96px" }} /></colgroup>
      <thead><tr className="text-left text-fg-3"><th className="font-normal">모델</th><th className="font-normal">고른 모델</th><th className="text-right font-normal">칸 수</th></tr></thead>
      <tbody>{rows.map(({ choice, index }) => <tr key={index}>
        <td className="tabular-nums">함께 {index + 1}</td>
        <td className="truncate" title={choice.model}>{choice.model}</td>
        <td className="text-right"><input type="number" inputMode="numeric" min={1} max={AI_TASK_POOL_MEMBER_SLOTS_MAX} step={1} placeholder="정하지 않음"
          aria-label={`함께 ${index + 1} 칸 수`} value={slots[index] ?? ""} disabled={disabled} onChange={event => onChange(index, event.target.value)}
          className="min-h-8 w-[88px] rounded-lg border border-line bg-bg-card px-2 text-right tabular-nums" /></td>
      </tr>)}</tbody>
    </table>
    <p className="text-fg-3">{lanes !== null ? `함께 최대 ${lanes}건을 처리합니다. 모델마다 적은 칸 수를 넘겨 보내지 않습니다.`
      : "칸 수를 비우면 예전처럼 단계 동시 수를 모델끼리 나눠 씁니다. 칸 수를 적으면 그 합만큼 함께 처리합니다."}</p>
  </div>;
}

/** Pool members are separate settings; none of these fields are saved as rank 4. */
export function TaskExecutionForm({ view, label, options, connections, readOnly = false, runtime }: Props) {
  const [state, action, saving] = useActionState<AiTaskActionState, FormData>(saveTaskExecutionAction, null);
  const [mode, setMode] = useState(view.mode);
  const initial = view.members.map(member => ({ provider: member.connectionId, model: member.model,
    ...(typeof member.options.reasoningEffort === "string" && member.options.reasoningEffort ? { reasoningEffort: member.options.reasoningEffort } : {}) }));
  const [value, setValue] = useState<(AiRankChoice | null)[]>(initial);
  // 0179: 구성원마다 이 단계에 내줄 칸 수(빈 칸 = 정하지 않음)와 예비 순위
  const initialSlots = Array.from({ length: 4 }, (_, index) => {
    const saved = view.members.find(member => member.position === index + 1)?.maxSlots;
    return typeof saved === "number" ? String(saved) : "";
  });
  const [slots, setSlots] = useState<string[]>(initialSlots);
  const [reserve, setReserve] = useState(view.reserveRanks);
  const supported = aiTaskSupportsPool(view.task, view.slot);
  const features = aiTaskPoolFeatures(view.task, view.slot);
  const apiOnly = aiTaskWorkloadPoolApiOnly(view.task);
  const currentRuntime = currentTaskPoolRuntime(view, connections, runtime);
  if (!supported && view.mode === "fallback") return null;
  const slotOf = (raw: string | undefined): number | undefined => {
    const parsed = Number(raw);
    return features.slotCaps && raw && Number.isInteger(parsed) && parsed >= 1 && parsed <= AI_TASK_POOL_MEMBER_SLOTS_MAX ? parsed : undefined;
  };
  const membersOf = (values: readonly (AiRankChoice | null)[], counts: readonly string[]): AiTaskExecutionInput["members"] => values.flatMap((choice, index) => {
    if (!choice) return [];
    // Repeated engines are independent distribution members; never reuse one member id in two positions.
    const previous = view.members.find(member => member.position === index + 1 && member.connectionId === choice.provider && member.model === choice.model);
    const maxSlots = slotOf(counts[index]);
    return [{ ...(previous ? { memberId: previous.memberId } : {}), connectionId: choice.provider, model: choice.model,
      ...(choice.reasoningEffort ? { reasoningEffort: choice.reasoningEffort } : {}), ...(maxSlots ? { maxSlots } : {}) }];
  });
  const members = membersOf(value, slots);
  const reserveOn = features.reserve && reserve;
  const changed = mode !== view.mode || mode === "workload_pool" && (JSON.stringify(members) !== JSON.stringify(membersOf(initial, initialSlots))
    || reserveOn !== (features.reserve && view.reserveRanks));
  const lanes = aiTaskPoolCappedLanes({ task: view.task, slot: view.slot, mode: "workload_pool", members });
  const issuesOf = (values: readonly (AiRankChoice | null)[]) => {
    const selected = values.filter((choice): choice is AiRankChoice => choice !== null);
    const issues: string[] = [];
    if (!selected.length) issues.push("분산할 모델을 하나 이상 선택하세요.");
    if (selected.some(choice => !connections.some(connection => connection.id === choice.provider && connection.enabled)))
      issues.push("꺼졌거나 없는 연결을 바꿔주세요.");
    if (features.slotCaps) {
      const counts = values.flatMap((choice, index) => choice ? [slots[index] ?? ""] : []);
      if (counts.some(raw => raw !== "" && slotOf(raw) === undefined)) issues.push(`칸 수는 1~${AI_TASK_POOL_MEMBER_SLOTS_MAX} 사이로 적어 주세요.`);
      else if (counts.some(raw => raw === "") && counts.some(raw => raw !== "")) issues.push("칸 수는 모든 모델에 적거나 모두 비워 주세요.");
    }
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
      {mode === "workload_pool" && reserveOn && <input type="hidden" name="reserveRanks" value="1" />}
      <div className="mt-task-form-toolbar">
      <label className="grid min-w-0 gap-1 text-[13px]">실행 방식
        <select name="mode" value={mode} disabled={saving || readOnly} className="min-h-9 min-w-0 rounded-lg border border-line bg-bg-card px-2"
          onChange={event => setMode(event.target.value as typeof mode)}>
          <option value="fallback">{apiOnly ? "기존 CLI 분류" : "순위대로 · 앞 모델을 쓸 수 없을 때 다음 순위"}</option>
          <option value="workload_pool" disabled={!supported}>동시에 · 묶은 모델이 함께 처리</option>
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
        {features.slotCaps && <PoolSlotFields value={value} slots={slots} disabled={saving || readOnly}
          onChange={(index, raw) => setSlots(current => current.map((entry, at) => at === index ? raw : entry))} lanes={lanes} />}
        {features.reserve && <label className="flex min-w-0 items-start gap-2 text-[13px]">
          <input type="checkbox" checked={reserve} disabled={saving || readOnly} onChange={event => setReserve(event.target.checked)} className="mt-1" />
          <span>예비 · 묶은 모델이 모두 설 때(실패·한도 초과·쉼) 이 작업의 순위(1·2·3)로 이어서 처리합니다. 끄면 예비 없이 기다립니다.</span>
        </label>}
        {!features.slotCaps && <p className="text-[13px] text-fg-3">이 작업은 아직 모델별 상한·예비를 따르지 않습니다. 일 하나마다 모델 하나를 고릅니다.</p>}
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
