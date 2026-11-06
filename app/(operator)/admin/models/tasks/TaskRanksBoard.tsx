"use client";
import Link from "next/link";
import { aiRankChoiceOfRow } from "@/lib/operations/admin-ai-tasks";
import { useActionState, useEffect, useState } from "react";
import { AI_TASK_GROUP_LABELS, AI_TASK_KIND_LABELS, aiTask, type AiTaskGroup } from "@/lib/llm/ai-tasks";
// 형과 순수 함수만 — 저장은 actions(서버)를 거친다
import { AI_RANK_SLOT_NAMES, aiRankOptionBlocked, validateAiTaskRanks, type AiConnectionView, type AiRankChoice, type AiRankOption, type AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import { RankSelects } from "../RankSelects";
import { saveAiTaskRanksAction, type AiTaskActionState } from "./actions";
import type { AiTaskExecutionAdminView } from "@/lib/operations/admin-ai-task-execution";
import { currentTaskPoolRuntime, taskPoolRuntimeGroups, TaskExecutionForm } from "./TaskExecutionForm";
import { aiTaskWorkloadPoolUnsupportedReason, aiTaskWorkloadPoolApiOnly, type AiTaskPoolRuntime } from "@/lib/llm/ai-task-execution-config";
import { modelPickerConnectionLabel, modelPickerModelLabel } from "../model-picker-display";
import { aiTaskEditTarget } from "@/lib/operations/ai-task-edit-target";

/** 한 줄(작업 × 칸)의 화면 값 — 서버(readAiTasksAdminView)가 만든다. */
export type TaskRankLine = {
  task: string; slot: number; label: string; group: AiTaskGroup; kind: keyof typeof AI_TASK_KIND_LABELS; description: string; accepts: string;
  revision: string; rows: AiTaskRankRow[]; options: AiRankOption[];
  current: { labels: string[]; source: string; notes: string[]; error: string | null; skip: string | null } | null;
  sameAsCurrent: boolean | null;
  /** 저장된 순위의 준비 상태: 막힘·경고·아직 없는 것(그 줄을 다시 저장하면 만든다) */
  readiness: { rank: number; blocking: string[]; warnings: string[]; pending: string[] }[];
  /** 실행 쪽이 이 순위를 읽는가(PR B text 일곱 · PR C1 심사 둘·Grok 로그인 유지) */
  live: boolean;
  /** 실행 쪽의 순위 사정 — 잡의 마지막 틱(from job) 또는 이 웹 프로세스의 마지막 검색어 번역(from web). at 은 화면 글(서버가 만든다) */
  runtime: { from: "job" | "web"; at: string; served: { rank: number; count: number }[]; unusable: { rank: number; code: string; text: string; count: number }[];
    degraded: { code: string; detail: string | null } | null; pool?: AiTaskPoolRuntime; startedAt?: string; observedAt?: string; fresh?: boolean } | null;
};

/**
 * 한 목록에서 작업·실행 방식·모든 저장 모델·최근 실행을 비교한다.
 * 수정 폼은 같은 행에서 펼치며 기존 순위/실행 방식의 별도 CAS 저장 경로를 유지한다.
 */
export function TaskRanksBoard({ lines, connections, rows, executions = [], readOnly = false }: { lines: TaskRankLine[]; connections: AiConnectionView[]; rows: AiTaskRankRow[];
  executions?: readonly AiTaskExecutionAdminView[]; readOnly?: boolean }) {
  useEffect(() => {
    const openTarget = () => {
      const id = window.location.hash.slice(1);
      if (!id.startsWith("execution-")) return;
      const target = document.getElementById(id);
      if (target instanceof HTMLDetailsElement) {
        target.open = true;
        target.scrollIntoView({ block: "start" });
      }
    };
    openTarget();
    window.addEventListener("hashchange", openTarget);
    return () => window.removeEventListener("hashchange", openTarget);
  }, []);
  const groups = [...new Set(lines.map(line => line.group))];
  return <div className="mt-task-list text-[13px]">
    <div className="mt-task-list-head" aria-hidden="true"><span>작업</span><span>실행 방식 · 상태</span><span>모델 설정 · 순위별 표시</span><span>최근 실행 관측</span><span /></div>
    {groups.map(group => <section key={group} aria-labelledby={`task-group-${group}`}>
      <h3 id={`task-group-${group}`} className="mt-task-group-title">{AI_TASK_GROUP_LABELS[group]}</h3>
      {lines.filter(line => line.group === group).map(line => {
        const execution = executions.find(view => view.task === line.task && view.slot === line.slot);
        const pool = execution?.mode === "workload_pool";
        const apiOnly = aiTaskWorkloadPoolApiOnly(line.task);
        const externalTarget = !line.live && line.task !== "publish-classify" ? aiTaskEditTarget(line.task) : null;
        const status: Status = readOnly ? { text: "설정 읽기 실패 · 저장 잠김", tone: "warn" }
          : pool ? poolStatus(line, execution, connections) : externalTarget ? effectiveStatus(line)
            : apiOnly ? legacyClassificationStatus(line) : lineStatus(line, false, false);
        const ranks = <TaskRankLineForm line={line} connections={connections} rows={rows} readOnly={readOnly || pool} inactive={pool} />;
        return <details key={`${line.task}#${line.slot}`} id={`execution-${line.task}-${line.slot}`} className="mt-task-row">
          <summary className="mt-task-row-summary">
            <span className="mt-task-identity"><b title={line.description}>{line.label}</b><small>{AI_TASK_KIND_LABELS[line.kind]} · {line.accepts}</small></span>
            <span className="mt-task-mode"><b>{readOnly ? "실행 방식 미확인" : pool ? `작업 분산 · ${execution.members.length}칸` : apiOnly ? "기존 CLI 분류" : externalTarget ? "실제 적용 설정" : "대체 실행"}</b>
              <span className={TONE[status.tone]} data-status={status.tone}>{status.text}</span></span>
            <TaskModelsSummary line={line} execution={execution} connections={connections} />
            {readOnly ? <span className="mt-task-runtime text-fg-3">실행 방식 확인 후 표시</span> : <TaskRuntimeSummary line={line} execution={execution} connections={connections} />}
            <span className="mt-task-toggle">설정</span>
          </summary>
          <div className="mt-task-editor">
            {execution && <TaskExecutionForm key={`${line.task}#${line.slot}#${execution.revision ?? "default"}`} view={execution}
              label={line.label} options={line.options} connections={connections} readOnly={readOnly} runtime={line.runtime} />}
            {externalTarget ? <EffectiveModelConfig line={line} target={externalTarget} readOnly={readOnly} />
              : <>
                {!pool && !apiOnly && ranks}
                {pool && !apiOnly && <details className="text-[13px]">
                  <summary className="cursor-pointer text-fg-3">보관된 대체 순위</summary>{ranks}
                </details>}
              </>}
          </div>
        </details>;
      })}
    </section>)}
  </div>;
}

type Status = { text: string; tone: "ok" | "warn" | "bad" | "muted" };
const TONE: Record<Status["tone"], string> = { ok: "text-emerald-700", warn: "text-amber-700", bad: "text-red-600", muted: "text-fg-3" };

function poolStatus(line: TaskRankLine, execution: AiTaskExecutionAdminView, connections: readonly AiConnectionView[]): Status {
  if (!execution.members.length) return { text: "분산 모델 없음", tone: "bad" };
  if (execution.members.some(member => !connections.some(connection => connection.id === member.connectionId && connection.enabled)))
    return { text: "꺼졌거나 없는 연결", tone: "bad" };
  const runtime = currentTaskPoolRuntime(execution, connections, line.runtime);
  if (runtime?.degraded?.code === "all_ranks_unusable") return { text: "최근 실행 사용 불가", tone: "bad" };
  if (runtime?.degraded) return { text: "일부 모델 확인 필요", tone: "warn" };
  if (runtime?.pool && Object.values(runtime.pool.served).some(count => count > 0)) return { text: "최근 실행 기록 있음", tone: "ok" };
  return { text: "설정 저장됨 · 실행 관측 대기", tone: "muted" };
}

function legacyClassificationStatus(line: TaskRankLine): Status {
  if (!line.current || line.current.error || !line.current.labels.length) return { text: "CLI 설정 확인 필요", tone: "warn" };
  return { text: "기존 CLI 설정 사용", tone: "muted" };
}

function effectiveStatus(line: TaskRankLine): Status {
  if (!line.current) return { text: "실제 적용 설정 확인 필요", tone: "warn" };
  if (line.current.error) return { text: "실제 적용 설정 읽지 못함", tone: "bad" };
  if (line.current.skip) return { text: "실행 조건 확인", tone: "muted" };
  return { text: "실제 적용 설정 확인", tone: "muted" };
}

function TaskModelsSummary({ line, execution, connections }: { line: TaskRankLine; execution?: AiTaskExecutionAdminView; connections: readonly AiConnectionView[] }) {
  const pool = execution?.mode === "workload_pool";
  const effectiveOnly = !pool && !line.live && line.task !== "publish-classify";
  if (effectiveOnly) {
    if (!line.current) return <span className="mt-task-models text-fg-3">실제 적용 설정 확인 필요</span>;
    if (line.current.error) return <span className="mt-task-models text-red-600">실제 적용 설정 읽지 못함</span>;
    if (line.current.labels.length) return <span className="mt-task-models">
      {line.current.labels.map((text, index) => <span key={`${index}:${text}`} className="mt-task-model-line"><b>모델 {index + 1}</b><span>{text}</span></span>)}
      <small className="text-fg-3">출처: {line.current.source}</small>
      {line.current.skip && <small className="text-amber-700">{line.current.skip}</small>}
    </span>;
    return <span className="mt-task-models text-fg-3">{line.current.skip ?? "실제 적용 모델 설정 없음"}</span>;
  }
  const models = pool ? execution.members.map(member => ({ position: member.position, connectionId: member.connectionId, model: member.model,
    effort: typeof member.options.reasoningEffort === "string" ? member.options.reasoningEffort : "" }))
    : aiTaskWorkloadPoolApiOnly(line.task) ? [] : line.rows.map(row => ({ position: row.rank, connectionId: row.connectionId, model: row.model,
      effort: typeof row.options.reasoningEffort === "string" ? row.options.reasoningEffort : "" }));
  if (!models.length) {
    if (!pool && aiTaskWorkloadPoolApiOnly(line.task) && line.current?.labels.length) return <span className="mt-task-models">
      {line.current.labels.map((text, index) => <span key={`${index}:${text}`} className="mt-task-model-line"><b>{index + 1}순위</b><span>{text}</span></span>)}
    </span>;
    return <span className="mt-task-models text-fg-3">{!pool && aiTaskWorkloadPoolApiOnly(line.task) ? "CLI 모델 확인 필요" : "모델 미설정"}</span>;
  }
  return <span className="mt-task-models">{models.map((model, index) => {
    const connection = connections.find(row => row.id === model.connectionId);
    return <span className="mt-task-model-line" key={`${model.position}:${index}`}>
      <b>{pool ? `모델 ${model.position}` : `${model.position}순위`}</b>
      <span>{connection ? modelPickerConnectionLabel(connection) : "연결 없음"} · {connection ? modelPickerModelLabel(connection, model.model) : model.model}
        {model.effort && <small> · 추론 {model.effort}</small>}</span>
    </span>;
  })}{!pool && line.sameAsCurrent === false && <small className="text-amber-700">실행 설정과 다름 · 자세히 확인</small>}</span>;
}

function TaskRuntimeSummary({ line, execution, connections }: { line: TaskRankLine; execution?: AiTaskExecutionAdminView; connections: readonly AiConnectionView[] }) {
  if (!line.live && execution?.mode !== "workload_pool" && line.task !== "publish-classify") {
    return <span className="mt-task-runtime text-fg-3">실제 호출은 모델 운영 현황에서 확인 <Link href="/admin/models" prefetch={false}>모델 운영 현황</Link></span>;
  }
  const runtime = execution?.mode === "workload_pool" ? currentTaskPoolRuntime(execution, connections, line.runtime)
    : line.runtime?.fresh ? line.runtime : null;
  if (!runtime) return <span className="mt-task-runtime text-fg-3">최근 실행 관측 없음</span>;
  const groups = execution?.mode === "workload_pool" && runtime.pool ? taskPoolRuntimeGroups(execution, runtime) : null;
  const counts = execution?.mode === "workload_pool" && runtime.pool
    ? groups!.map(group => `${group.members.map(member => `모델 ${member.position}`).join("·")} · ${group.served === null ? "사용 집계 없음" : `${group.shared ? "동일 모델 공유 업무 " : ""}${group.served}건`}`)
    : runtime.served.filter(row => row.count > 0).map(row => `${row.rank}순위 ${row.count}건`);
  const unusable = groups ? groups.reduce((sum, group) => sum + group.unusable, 0) : runtime.unusable.reduce((sum, row) => sum + row.count, 0);
  return <span className="mt-task-runtime">{counts.length ? counts.map(text => <b key={text}>{text}</b>) : <b>맡은 업무 없음</b>}<small>{runtime.at} · {runtime.from === "job" ? "마지막 틱" : "웹 요청"}</small>
    {unusable > 0 && <span className="text-amber-700">사용 불가 {unusable}건</span>}</span>;
}

/** 한 줄 상태(작업 이름 밑) — 고칠 일이 있으면 그것 하나, 없으면 「준비됨」. 자세한 까닭은 「자세히」에 있다. */
function lineStatus(line: TaskRankLine, changed: boolean, cleared: boolean): Status {
  if (cleared) return line.live ? { text: "모두 비움 — 저장하면 이 작업이 멈춥니다", tone: "bad" } : { text: "모두 비움 — 저장 전", tone: "warn" };
  if (changed) return { text: "바꿈 — 저장 전", tone: "warn" };
  if (!line.rows.length) return line.live ? { text: "순위 없음 — 이 작업은 돌지 않습니다", tone: "bad" } : { text: "순위 없음", tone: "muted" };
  if (line.readiness.some(row => row.blocking.length)) return { text: "쓸 수 없는 순위가 있습니다 — 자세히", tone: "bad" };
  if (line.runtime?.fresh && line.runtime.degraded) return { text: "최근 실행 사용 불가", tone: "bad" };
  if (line.options.some(option => option.saved)) return { text: "저장한 모델이 지금 서버 목록에 없습니다", tone: "warn" };
  if (line.readiness.some(row => row.pending.length)) return { text: "빠진 것이 있습니다 — 다시 저장하면 만듭니다", tone: "warn" };
  if (line.readiness.some(row => row.warnings.length)) return { text: "알림이 있습니다 — 자세히", tone: "warn" };
  if (!line.live) return { text: "저장됨 · 실행 쪽은 아직 옛 설정", tone: "muted" };
  return { text: "설정 준비됨", tone: "ok" };
}

/** 순위를 모두 비우는 저장 앞의 확인 글(브라우저 confirm). 취소하면 폼 동작이 돌지 않는다(onSubmit preventDefault). */
export const clearConfirmText = (line: Pick<TaskRankLine, "label" | "live">) => line.live
  ? `「${line.label}」의 1·2·3순위를 모두 비웁니다. 저장하면 이 작업은 모델을 부르지 않고 멈춥니다. 정말 비울까요?`
  : `「${line.label}」의 1·2·3순위를 모두 비웁니다. 정말 비울까요?`;

function TaskRankLineForm({ line, connections, rows, readOnly, inactive = false }: { line: TaskRankLine; connections: AiConnectionView[]; rows: AiTaskRankRow[]; readOnly: boolean; inactive?: boolean }) {
  const [state, action, saving] = useActionState<AiTaskActionState, FormData>(saveAiTaskRanksAction, null);
  const initial = line.rows.map(aiRankChoiceOfRow);
  const [value, setValue] = useState<(AiRankChoice | null)[]>(initial);
  const task = aiTask(line.task)!;
  const issues = validateAiTaskRanks(line.task, line.slot, value, { connections, rows });
  const changed = JSON.stringify(value.filter(Boolean)) !== JSON.stringify(initial);
  // 가져온 순위처럼 계약·경로·장비가 아직 없는 줄은 바뀐 것이 없어도 다시 저장해 만든다
  const pending = line.readiness.some(row => row.pending.length > 0);
  // 저장된 순위를 모두 비우는 저장 — 실행 쪽이 읽는 작업은 그 순간 멈추므로 한 번 더 묻는다(2026-11-02 드롭다운 결함으로 1차 AI 검수가 비워져 멈춘 일)
  const cleared = line.rows.length > 0 && value.every(row => !row);
  const status: Status = inactive ? { text: "보관된 대체 순위 · 현재 사용 안 함", tone: "muted" } : lineStatus(line, changed, cleared);
  const confirmClear = (event: { preventDefault(): void }) => {
    if (cleared && !window.confirm(clearConfirmText(line))) event.preventDefault();
  };
  return <form action={action} onSubmit={confirmClear} className="mt-task-ranks grid min-w-0 gap-2" data-task={line.task} data-slot={line.slot}>
    <input type="hidden" name="task" value={line.task} /><input type="hidden" name="slot" value={line.slot} /><input type="hidden" name="revision" value={line.revision} />
    <div className="mt-task-form-toolbar text-[13px]">
      <span className="grid content-start gap-0.5"><b>대체 모델 순위</b>
      <span className={TONE[status.tone]} data-status={status.tone}>{status.text}</span>
      </span>
      <button type="submit" disabled={saving || readOnly || issues.length > 0 || !changed && !pending}
        className="min-h-9 rounded-lg bg-fg px-3 text-[13px] text-bg disabled:opacity-40">
        {saving ? "저장 중…" : !changed && pending ? "다시 저장" : "저장"}</button>
    </div>
    <RankSelects<AiRankChoice> stage={{ id: `${line.task}-${line.slot}`, label: line.label, slots: 3 }} options={line.options} connections={connections} value={value} onChange={setValue}
      slotNames={AI_RANK_SLOT_NAMES} disabled={saving || readOnly} showProvider={false} note={null}
      blocked={(option, index, slots) => aiRankOptionBlocked(task, line.slot, index, option, slots, rows)}
      validate={slots => validateAiTaskRanks(line.task, line.slot, slots, { connections, rows })} />
    {(state?.ok || state?.warnings?.length || state?.issues?.length) ? <div className="grid gap-0.5 text-[13px]">
      {state?.ok && <p role="status">{state.message}</p>}
      {state?.warnings?.map(text => <p key={text} role="note" className="text-amber-700">알림 — {text}</p>)}
      {state?.issues && <ul role="alert" className="grid gap-0.5 text-red-600">{state.issues.map(text => <li key={text}>{text}</li>)}</ul>}
    </div> : null}
    <details className="text-[13px]">
      <summary className="cursor-pointer text-fg-3">자세히</summary>
      <div className="mt-1 grid gap-1 rounded-lg border border-line px-3 py-2">
        <span className="text-fg-2">{line.description}</span>
        <span className="text-fg-3">{AI_TASK_KIND_LABELS[line.kind]} · 받는 연결: {line.accepts}</span>
        {aiTaskWorkloadPoolUnsupportedReason(line.task, line.slot) && <span className="text-fg-3">작업 분산: {aiTaskWorkloadPoolUnsupportedReason(line.task, line.slot)}</span>}
        {task.sameModelAcrossRanks && <span className="text-fg-3">2·3순위도 1순위와 같은 모델을 선택합니다.</span>}
        <span className="text-fg-3">{inactive ? "현재 작업 분산에는 이 순위를 쓰지 않습니다. 대체 실행으로 전환하면 사용합니다."
          : line.live ? "대체 실행은 우선 모델 하나를 쓰고, 필요한 경우에만 다음 순위로 전환합니다. 순위마다 추가 검수하는 방식이 아닙니다."
          : "이 작업은 아직 기존 설정을 사용합니다."} 저장할 수 없으면 이유를 표시합니다.</span>
        {!inactive && <CurrentDetail line={line} />}
        {line.live && !inactive && <RuntimeLine runtime={line.runtime} />}
      </div>
    </details>
  </form>;
}

function EffectiveModelConfig({ line, target, readOnly }: { line: TaskRankLine; target: { href: string; label: string }; readOnly: boolean }) {
  const current = line.current;
  return <div className="grid gap-1 rounded-lg border border-line px-3 py-2 text-[13px]">
    <span className="font-semibold">실제 적용 모델 설정</span>
    {current === null ? <span className="text-fg-3">지금 실제 적용 설정을 읽지 못했습니다.</span>
      : current.error ? <span className="text-red-600">지금 실제 적용 설정을 읽지 못했습니다({current.error}).</span>
        : current.labels.length ? <ol className="grid gap-0.5">{current.labels.map((text, index) => <li key={`${index}:${text}`}>{text}</li>)}</ol>
          : <span className="text-fg-3">{current.skip ?? "실제 적용 모델 설정이 없습니다."}</span>}
    {current && !current.error && <span className="text-fg-3">출처: {current.source}</span>}
    {current && current.skip && current.labels.length > 0 && <span className="text-fg-3">{current.skip}</span>}
    {current?.notes.map(text => <span key={text} className="text-fg-3">{text}</span>)}
    <Link href={target.href} prefetch={false} className="font-semibold text-accent-ink underline">{target.label} →</Link>
    {readOnly && <span className="text-amber-700">지금은 읽기 전용입니다.</span>}
  </div>;
}

/** 실행 쪽 설정 · 준비 상태. 실제 실행 여부는 별도 관측 기록으로 표시한다. */
function CurrentDetail({ line }: { line: TaskRankLine }) {
  return <div className="grid gap-0.5">
    <span className="font-semibold">실행 쪽 현재 설정</span>
    {line.current === null ? <span className="text-fg-3">지금 값을 읽지 못했습니다.</span>
      : line.current.error ? <span className="text-amber-700">지금 값을 읽지 못했습니다({line.current.error}).</span>
        : line.current.labels.length ? <ol className="grid gap-0.5">{line.current.labels.map((text, index) =>
          <li key={`${index}:${text}`}><span className="font-mono tabular-nums text-fg-3">{index + 1}.</span> {text}</li>)}</ol>
          : <span className="text-fg-3">{line.current.skip ?? "실행 쪽 모델 설정이 없습니다."}</span>}
    {line.current && !line.current.error && <span className="text-fg-3">출처: {line.current.source}</span>}
    {line.current?.notes.map(text => <span key={text} className="text-fg-3">{text}</span>)}
    {line.sameAsCurrent !== null && line.rows.length > 0 && <span className={line.sameAsCurrent ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
      {line.sameAsCurrent ? "저장 순위와 실행 설정 일치" : "저장 순위와 실행 설정이 다릅니다"}</span>}
    {line.readiness.map(row => <span key={row.rank} className={row.blocking.length ? "text-red-600" : "text-amber-700"}>
      {[...row.blocking, ...row.pending, ...row.warnings].map(text => <span key={text} className="block">{text}</span>)}</span>)}
    {line.rows.length > 0 && line.readiness.every(row => !row.blocking.length && !row.warnings.length && !row.pending.length)
      && <span className="text-emerald-700">저장한 순위의 계약·경로·장비가 있습니다.</span>}
  </div>;
}

/** 실행 쪽의 순위 사정 — 어느 순위가 몇 건을 맡았고, 아래 순위를 쓴 까닭(위 순위가 쉰 까닭)은 무엇인가. */
function RuntimeLine({ runtime }: { runtime: TaskRankLine["runtime"] }) {
  if (!runtime) return <span className="text-fg-3" data-runtime="none">실행: 아직 이 순위로 돈 기록이 없습니다.</span>;
  const served = runtime.served.filter(row => row.count > 0);
  const lower = served.some(row => row.rank > 1);
  return <span className="grid gap-0.5" data-runtime={runtime.from}>
    <span className="font-semibold">실행({runtime.from === "job" ? "마지막 틱" : "이 웹 프로세스의 마지막 요청"} · {runtime.at}):{" "}
      {served.length ? served.map(row => `${row.rank}순위 ${row.count}건`).join(" · ") : "맡은 순위 없음"}</span>
    {runtime.unusable.length > 0 && <span className={lower || !served.length ? "text-amber-700" : "text-fg-3"}>
      {lower ? "아래 순위를 쓴 까닭 — " : "쉰 순위 — "}{runtime.unusable.map(row => `${row.rank}순위: ${row.text}${row.count > 1 ? ` ×${row.count}` : ""}`).join(" / ")}</span>}
    {runtime.degraded && <span className="text-red-600">제 일 못 함 <code>{runtime.degraded.code}</code>{runtime.degraded.detail ? ` — ${runtime.degraded.detail}` : ""}</span>}
  </span>;
}
