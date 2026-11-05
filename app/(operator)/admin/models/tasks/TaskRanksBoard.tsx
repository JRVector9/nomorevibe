"use client";
import { aiRankChoiceOfRow } from "@/lib/operations/admin-ai-tasks";
import { useActionState, useState } from "react";
import { AI_TASK_GROUP_LABELS, AI_TASK_KIND_LABELS, aiTask, type AiTaskGroup } from "@/lib/llm/ai-tasks";
// 형과 순수 함수만 — 저장은 actions(서버)를 거친다
import { AI_RANK_SLOT_NAMES, aiRankOptionBlocked, validateAiTaskRanks, type AiConnectionView, type AiRankChoice, type AiRankOption, type AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
import { RankSelects } from "../RankSelects";
import { saveAiTaskRanksAction, type AiTaskActionState } from "./actions";

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
    degraded: { code: string; detail: string | null } | null } | null;
};

/** 넓은 화면의 한 줄: 작업 | 1·2·3순위 | 저장 */
const GRID = "grid gap-x-3 gap-y-2 md:items-start md:[grid-template-columns:minmax(0,15rem)_minmax(0,1fr)_7.5rem]";

/**
 * 「작업 ↔ 모델」 표(2026-11-02 소유자 지시 「작업 한 줄마다 1·2·3순위 드롭다운만」) — 작업(2차는 투표자마다) 한 줄에 1·2·3순위 드롭다운과 저장 버튼, 한 줄 상태만 보인다.
 * 드롭다운은 서버(AI 연결)마다 묶여 그 서버가 서비스하는 모델 이름만 나온다(API 는 GET /models, CLI 는 적은 모델 이름). 지금 실제로 쓰는 모델·준비 상태·실행 기록은 줄마다 「자세히」에 접는다.
 * 줄마다 따로 저장한다(화면 판 compare-and-set). 검증은 서버와 같은 순수 함수(validateAiTaskRanks)를 그 자리에서 돌려 보인다.
 */
export function TaskRanksBoard({ lines, connections, rows, readOnly = false }: { lines: TaskRankLine[]; connections: AiConnectionView[]; rows: AiTaskRankRow[]; readOnly?: boolean }) {
  const groups = [...new Set(lines.map(line => line.group))];
  return <div className="grid gap-4">
    {groups.map(group => <section key={group} className="grid gap-0 rounded-xl border border-line bg-bg-card" aria-labelledby={`task-group-${group}`}>
      <h3 id={`task-group-${group}`} className="border-b border-line px-4 py-2 text-[15px] font-semibold">{AI_TASK_GROUP_LABELS[group]}</h3>
      <div className={`${GRID} border-b border-line px-4 py-1.5 text-[13px] font-semibold text-fg-3 max-md:hidden`} aria-hidden="true">
        <span>작업</span><span className="grid grid-cols-3 gap-2"><span>1순위</span><span>2순위</span><span>3순위</span></span><span /></div>
      {lines.filter(line => line.group === group).map(line =>
        <TaskRankLineForm key={`${line.task}#${line.slot}`} line={line} connections={connections} rows={rows} readOnly={readOnly} />)}
    </section>)}
  </div>;
}

type Status = { text: string; tone: "ok" | "warn" | "bad" | "muted" };
const TONE: Record<Status["tone"], string> = { ok: "text-emerald-700", warn: "text-amber-700", bad: "text-red-600", muted: "text-fg-3" };

/** 한 줄 상태(작업 이름 밑) — 고칠 일이 있으면 그것 하나, 없으면 「준비됨」. 자세한 까닭은 「자세히」에 있다. */
function lineStatus(line: TaskRankLine, changed: boolean, cleared: boolean): Status {
  if (cleared) return line.live ? { text: "모두 비움 — 저장하면 이 작업이 멈춥니다", tone: "bad" } : { text: "모두 비움 — 저장 전", tone: "warn" };
  if (changed) return { text: "바꿈 — 저장 전", tone: "warn" };
  if (!line.rows.length) return line.live ? { text: "순위 없음 — 이 작업은 돌지 않습니다", tone: "bad" } : { text: "순위 없음", tone: "muted" };
  if (line.readiness.some(row => row.blocking.length)) return { text: "쓸 수 없는 순위가 있습니다 — 자세히", tone: "bad" };
  if (line.runtime?.degraded) return { text: "실행 멈춤 — 자세히", tone: "bad" };
  if (line.options.some(option => option.saved)) return { text: "저장한 모델이 지금 서버 목록에 없습니다", tone: "warn" };
  if (line.readiness.some(row => row.pending.length)) return { text: "빠진 것이 있습니다 — 다시 저장하면 만듭니다", tone: "warn" };
  if (line.readiness.some(row => row.warnings.length)) return { text: "알림이 있습니다 — 자세히", tone: "warn" };
  if (!line.live) return { text: "저장됨 · 실행 쪽은 아직 옛 설정", tone: "muted" };
  const served = line.runtime?.served.filter(row => row.count > 0) ?? [];
  return { text: served.length ? `준비됨 · 마지막 실행 ${served.map(row => `${row.rank}순위 ${row.count}건`).join(" · ")}` : "준비됨", tone: "ok" };
}

/** 순위를 모두 비우는 저장 앞의 확인 글(브라우저 confirm). 취소하면 폼 동작이 돌지 않는다(onSubmit preventDefault). */
export const clearConfirmText = (line: Pick<TaskRankLine, "label" | "live">) => line.live
  ? `「${line.label}」의 1·2·3순위를 모두 비웁니다. 저장하면 이 작업은 모델을 부르지 않고 멈춥니다. 정말 비울까요?`
  : `「${line.label}」의 1·2·3순위를 모두 비웁니다. 정말 비울까요?`;

function TaskRankLineForm({ line, connections, rows, readOnly }: { line: TaskRankLine; connections: AiConnectionView[]; rows: AiTaskRankRow[]; readOnly: boolean }) {
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
  const status = lineStatus(line, changed, cleared);
  const confirmClear = (event: { preventDefault(): void }) => {
    if (cleared && !window.confirm(clearConfirmText(line))) event.preventDefault();
  };
  return <form action={action} onSubmit={confirmClear} className={`${GRID} border-b border-line px-4 py-3 last:border-b-0`} data-task={line.task} data-slot={line.slot}>
    <input type="hidden" name="task" value={line.task} /><input type="hidden" name="slot" value={line.slot} /><input type="hidden" name="revision" value={line.revision} />
    <div className="grid content-start gap-0.5 text-[13px]">
      <span className="text-[14px] font-semibold" title={line.description}>{line.label}</span>
      <span className={TONE[status.tone]} data-status={status.tone}>{status.text}</span>
    </div>
    <RankSelects<AiRankChoice> stage={{ id: `${line.task}-${line.slot}`, label: line.label, slots: 3 }} options={line.options} connections={connections} value={value} onChange={setValue}
      slotNames={AI_RANK_SLOT_NAMES} disabled={saving || readOnly} showProvider={false} compact note={null}
      blocked={(option, index, slots) => aiRankOptionBlocked(task, line.slot, index, option, slots, rows)}
      validate={slots => validateAiTaskRanks(line.task, line.slot, slots, { connections, rows })} />
    <div className="grid content-start">
      <button type="submit" disabled={saving || readOnly || issues.length > 0 || !changed && !pending}
        className="min-h-9 rounded-lg bg-fg px-3 text-[13px] text-bg disabled:opacity-40">
        {saving ? "저장 중…" : !changed && pending ? "다시 저장" : "저장"}</button>
    </div>
    {(state?.ok || state?.warnings?.length || state?.issues?.length) ? <div className="grid gap-0.5 text-[13px] md:col-span-3">
      {state?.ok && <p role="status">{state.message}</p>}
      {state?.warnings?.map(text => <p key={text} role="note" className="text-amber-700">알림 — {text}</p>)}
      {state?.issues && <ul role="alert" className="grid gap-0.5 text-red-600">{state.issues.map(text => <li key={text}>{text}</li>)}</ul>}
    </div> : null}
    <details className="text-[13px] md:col-span-3">
      <summary className="cursor-pointer text-fg-3">자세히</summary>
      <div className="mt-1 grid gap-1 rounded-lg border border-line px-3 py-2">
        <span className="text-fg-2">{line.description}</span>
        <span className="text-fg-3">{AI_TASK_KIND_LABELS[line.kind]} · 받는 연결: {line.accepts}</span>
        {task.sameModelAcrossRanks && <span className="text-fg-3">2·3순위는 1순위와 같은 모델을 다른 서버에 둘 때만 씁니다.</span>}
        <span className="text-fg-3">{line.live ? "실행 쪽이 이 순위를 읽습니다 — 1순위를 쓸 수 없으면 같은 일을 2순위, 그다음 3순위로 넘깁니다."
          : "이 작업의 실행 쪽은 아직 이 순위를 읽지 않습니다(다음 단계)."} 저장하면 없는 장비 행·엔진 직접 계약·용량 경로를 함께 만듭니다(만들 수 없으면 저장하지 않고 이유를 보입니다).</span>
        <CurrentDetail line={line} />
        {line.live && <RuntimeLine runtime={line.runtime} />}
      </div>
    </details>
  </form>;
}

/** 지금 실제로 쓰는 모델 · 준비 상태(「자세히」 안). */
function CurrentDetail({ line }: { line: TaskRankLine }) {
  return <div className="grid gap-0.5">
    <span className="font-semibold">지금 실제로 쓰는 모델</span>
    {line.current === null ? <span className="text-fg-3">지금 값을 읽지 못했습니다.</span>
      : line.current.error ? <span className="text-amber-700">지금 값을 읽지 못했습니다({line.current.error}).</span>
        : line.current.labels.length ? <ol className="grid gap-0.5">{line.current.labels.map((text, index) =>
          <li key={`${index}:${text}`}><span className="font-mono tabular-nums text-fg-3">{index + 1}.</span> {text}</li>)}</ol>
          : <span className="text-fg-3">{line.current.skip ?? "지금 쓰는 모델이 없습니다."}</span>}
    {line.current && !line.current.error && <span className="text-fg-3">출처: {line.current.source}</span>}
    {line.current?.notes.map(text => <span key={text} className="text-fg-3">{text}</span>)}
    {line.sameAsCurrent !== null && line.rows.length > 0 && <span className={line.sameAsCurrent ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
      {line.sameAsCurrent ? "저장한 순위 = 지금 동작" : "저장한 순위가 지금 동작과 다릅니다"}</span>}
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
