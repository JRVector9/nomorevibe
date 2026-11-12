"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { aiTaskPoolCappedLanes, aiTaskPoolFeatures, aiTaskSupportsPool, aiTaskWorkloadPoolApiOnly,
  type AiTaskPoolRuntime } from "@/lib/llm/ai-task-execution-config";
import type { AiTaskExecutionAdminView } from "@/lib/operations/admin-ai-task-execution";
import { aiModelChoiceName, aiRankReasoningEfforts, type AiConnectionView, type AiRankChoice, type AiRankOption } from "@/lib/operations/admin-ai-tasks";
import { poolMemberIssues, poolMembersInput, poolSlotTexts } from "@/lib/operations/task-pool-form";
import { buildPoolHelp, poolHelpWarnings, type PoolHelpContext } from "@/lib/operations/pool-help";
import { PoolHelpTip } from "./PoolHelp";
import { RankSelects } from "../RankSelects";
import type { AiTaskActionState } from "./actions";
import { saveTaskExecutionAction } from "./execution-actions";
import { PoolReserveField, PoolSlotFields } from "./PoolSlotFields";

/** 실행 쪽의 순위 사정(화면 값) — 잡의 마지막 틱(from job) 또는 이 웹 프로세스의 마지막 요청(from web). at 은 화면 글, observedAt 은 원래 시각, fresh = 30분 안(서버가 정한다). */
export type TaskRuntimeLine = { from: "job" | "web"; at: string; served: { rank: number; count: number }[]; unusable: { rank: number; code: string; text: string; count: number }[];
  degraded: { code: string; detail: string | null } | null; pool?: AiTaskPoolRuntime; startedAt?: string; observedAt?: string; fresh?: boolean } | null;

const MEMBER_FIELDS = Array.from({ length: 4 }, (_, index) => ({ provider: `pool${index + 1}Connection`, model: `pool${index + 1}Model`,
  reasoningEffort: `pool${index + 1}ReasoningEffort` }));
type Props = { view: AiTaskExecutionAdminView; label: string; options: readonly AiRankOption[]; connections: readonly AiConnectionView[];
  readOnly?: boolean; runtime?: TaskRuntimeLine;
  /** 「동시에」 도움말이 읽은 한도(장비·실시간 한도·수집·판정 설정) — 없으면 도움말이 「읽지 못함」이라고 적는다 */
  help?: PoolHelpContext | null };

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

/** Pool members are separate settings; none of these fields are saved as rank 4. */
export function TaskExecutionForm({ view, label, options, connections, readOnly = false, runtime, help = null }: Props) {
  const [state, action, saving] = useActionState<AiTaskActionState, FormData>(saveTaskExecutionAction, null);
  const [mode, setMode] = useState(view.mode);
  const initial = view.members.map(member => ({ provider: member.connectionId, model: member.model,
    ...(typeof member.options.reasoningEffort === "string" && member.options.reasoningEffort ? { reasoningEffort: member.options.reasoningEffort } : {}) }));
  const [value, setValue] = useState<(AiRankChoice | null)[]>(initial);
  // 0179: 구성원마다 이 단계에 내줄 칸 수(빈 칸 = 정하지 않음)와 예비 순위 — 검사·저장 값은 단계 패널과 같은 함수(task-pool-form)
  const initialSlots = poolSlotTexts(view.members);
  const [slots, setSlots] = useState<string[]>(initialSlots);
  const [reserve, setReserve] = useState(view.reserveRanks);
  const supported = aiTaskSupportsPool(view.task, view.slot);
  const features = aiTaskPoolFeatures(view.task, view.slot);
  const apiOnly = aiTaskWorkloadPoolApiOnly(view.task);
  const currentRuntime = currentTaskPoolRuntime(view, connections, runtime);
  if (!supported && view.mode === "fallback") return null;
  const members = poolMembersInput(value, slots, view.members, features);
  const reserveOn = features.reserve && reserve;
  const changed = mode !== view.mode || mode === "workload_pool" && (JSON.stringify(members) !== JSON.stringify(poolMembersInput(initial, initialSlots, view.members, features))
    || reserveOn !== (features.reserve && view.reserveRanks));
  const lanes = aiTaskPoolCappedLanes({ task: view.task, slot: view.slot, mode: "workload_pool", members });
  const issuesOf = (values: readonly (AiRankChoice | null)[]) => poolMemberIssues(values, slots, connections, { apiOnly, features });
  const nameOf = (choice: AiRankChoice) => { const connection = connections.find(row => row.id === choice.provider); return connection ? aiModelChoiceName(connection, choice.model) : "지워진 연결"; };
  const issues = mode === "workload_pool" ? issuesOf(value) : [];
  // 「동시에」 도움말 — 지금 고른 모델·칸 수로 다시 센다(권장 칸 수 · 같은 모델 두 줄 · 장비 한도 넘김)
  const poolHelp = buildPoolHelp({ task: view.task, slot: view.slot, taskLabel: label, members: mode === "workload_pool" ? value : [], slots, connections, context: help });
  // Keep a missing saved choice visible until the operator explicitly changes it.
  const choices = options.filter(option => !apiOnly || connections.some(connection => connection.id === option.provider && (connection.kind === "api" || connection.cliTool === "opencode")));
  for (const member of view.members) if (!choices.some(option => option.provider === member.connectionId && option.model === member.model)) {
    const connection = connections.find(row => row.id === member.connectionId);
    choices.push({ provider: member.connectionId, model: member.model, saved: true,
      label: `${connection ? aiModelChoiceName(connection, member.model) : "연결 없음"} (저장된 값)`,
      group: connection ? aiModelChoiceName(connection) : "연결 없음", text: connection ? `${aiModelChoiceName(connection, member.model, { short: true })} (저장된 값)` : "저장된 값",
      reasoningEfforts: connection ? aiRankReasoningEfforts(view.task, connection, member.model) : [] });
  }
  return <section className="mt-task-execution" aria-label={`${label} 실행 방식`}>
    <form action={action} className="grid min-w-0 gap-2">
      <input type="hidden" name="task" value={view.task} /><input type="hidden" name="slot" value={view.slot} />
      <input type="hidden" name="expectedRevision" value={view.revision ?? ""} />
      <input type="hidden" name="members" value={JSON.stringify(mode === "workload_pool" ? members : [])} />
      {mode === "workload_pool" && reserveOn && <input type="hidden" name="reserveRanks" value="1" />}
      <div className="mt-task-form-toolbar">
      {/* 도움말 단추는 label 밖에 둔다 — label 안에 두면 고르기의 이름에 단추 글자가 섞인다 */}
      <div className="grid min-w-0 gap-1 text-[13px]">
        <span className="cs-help-head"><label htmlFor={`mode-${view.task}-${view.slot}`}>실행 방식</label>{supported && <PoolHelpTip view={poolHelp} label="「동시에」" />}</span>
        <select id={`mode-${view.task}-${view.slot}`} name="mode" value={mode} disabled={saving || readOnly} className="min-h-9 min-w-0 rounded-lg border border-line bg-bg-card px-2"
          onChange={event => setMode(event.target.value as typeof mode)}>
          <option value="fallback">{apiOnly ? "기존 CLI 분류" : "순위대로 · 앞 모델을 쓸 수 없을 때 다음 순위"}</option>
          <option value="workload_pool" disabled={!supported}>동시에 · 묶은 모델이 함께 처리</option>
        </select>
      </div>
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
        {features.slotCaps && <PoolSlotFields value={value} slots={slots} disabled={saving || readOnly} nameOf={nameOf}
          onChange={(index, raw) => setSlots(current => current.map((entry, at) => at === index ? raw : entry))} lanes={lanes}
          help={<PoolHelpTip view={poolHelp} label="칸 수" />} warnings={poolHelpWarnings(poolHelp)} />}
        {features.reserve && <PoolReserveField checked={reserve} disabled={saving || readOnly} onChange={setReserve} />}
        {!features.slotCaps && <p className="text-[13px] text-fg-3">이 작업은 아직 모델별 상한·예비를 따르지 않습니다. 일 하나마다 모델 하나를 고릅니다.</p>}
      </> : <p className="text-[13px] text-fg-3">{apiOnly ? "API·OpenCode 모델을 쓰려면 작업 분산으로 전환하세요." : "우선 모델 하나를 사용하고, 대체가 필요할 때만 다음 순위로 전환합니다."}</p>}
      {view.mode === "workload_pool" && <div className="grid gap-1 text-[13px] text-fg-3">
        {currentRuntime?.pool ? <>
          <p>마지막 관측 · {currentRuntime.at} · {currentRuntime.from === "job" ? "마지막 작업 틱" : "이 웹 프로세스의 마지막 요청"}</p>
          {taskPoolRuntimeGroups(view, currentRuntime).map(group => {
            const member = group.members[0];
            const connection = connections.find(row => row.id === member.connectionId);
            return <p key={group.key}>{group.members.map(row => `모델 ${row.position}`).join("·")} · {connection ? aiModelChoiceName(connection, member.model) : "연결 없음"}
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
