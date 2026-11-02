"use client";
import { useActionState, useState } from "react";
import { AI_TASK_GROUP_LABELS, AI_TASK_KIND_LABELS, aiTask, type AiTaskGroup } from "@/lib/llm/ai-tasks";
// 형과 순수 함수만 — 저장은 actions(서버)를 거친다
import { AI_RANK_SLOT_NAMES, validateAiTaskRanks, type AiConnectionView, type AiRankChoice, type AiRankOption, type AiTaskRankRow } from "@/lib/operations/admin-ai-tasks";
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
};

const GRID = "grid gap-3 md:[grid-template-columns:minmax(0,2fr)_minmax(0,5fr)_minmax(0,3fr)]";

/**
 * 「작업 ↔ 모델」 표 — 작업(2차는 투표자마다) 한 줄에 1·2·3순위 드롭다운(RankSelects, 「연결 이름 · 모델」 + 「없음」)과 「지금 실제로 쓰는 모델」·준비 상태.
 * 줄마다 따로 저장한다(화면 판 compare-and-set). 검증은 서버와 같은 순수 함수(validateAiTaskRanks)를 그 자리에서 돌려 보인다.
 */
export function TaskRanksBoard({ lines, connections, rows, readOnly = false }: { lines: TaskRankLine[]; connections: AiConnectionView[]; rows: AiTaskRankRow[]; readOnly?: boolean }) {
  const groups = [...new Set(lines.map(line => line.group))];
  return <div className="grid gap-4">
    {groups.map(group => <section key={group} className="grid gap-0 rounded-xl border border-line bg-bg-card" aria-labelledby={`task-group-${group}`}>
      <h3 id={`task-group-${group}`} className="border-b border-line px-4 py-2 text-[15px] font-semibold">{AI_TASK_GROUP_LABELS[group]}</h3>
      <div className={`${GRID} border-b border-line px-4 py-2 text-[13px] font-semibold text-fg-3 max-md:hidden`}><span>작업</span><span>1·2·3순위</span><span>지금 실제로 쓰는 모델 · 준비 상태</span></div>
      {lines.filter(line => line.group === group).map(line =>
        <TaskRankLineForm key={`${line.task}#${line.slot}`} line={line} connections={connections} rows={rows} readOnly={readOnly} />)}
    </section>)}
  </div>;
}

function TaskRankLineForm({ line, connections, rows, readOnly }: { line: TaskRankLine; connections: AiConnectionView[]; rows: AiTaskRankRow[]; readOnly: boolean }) {
  const [state, action, saving] = useActionState<AiTaskActionState, FormData>(saveAiTaskRanksAction, null);
  const initial = line.rows.map(row => ({ provider: row.connectionId, model: row.model }));
  const [value, setValue] = useState<(AiRankChoice | null)[]>(initial);
  const task = aiTask(line.task)!;
  const issues = validateAiTaskRanks(line.task, line.slot, value, { connections, rows });
  const changed = JSON.stringify(value.filter(Boolean)) !== JSON.stringify(initial);
  // 가져온 순위처럼 계약·경로·장비가 아직 없는 줄은 바뀐 것이 없어도 다시 저장해 만든다
  const pending = line.readiness.some(row => row.pending.length > 0);
  return <form action={action} className={`${GRID} border-b border-line px-4 py-3 last:border-b-0`} data-task={line.task} data-slot={line.slot}>
    <input type="hidden" name="task" value={line.task} /><input type="hidden" name="slot" value={line.slot} /><input type="hidden" name="revision" value={line.revision} />
    <div className="grid content-start gap-1 text-[13px]">
      <span className="text-[14px] font-semibold">{line.label}</span>
      <span className="text-fg-2">{line.description}</span>
      <span className="text-fg-3">{AI_TASK_KIND_LABELS[line.kind]} · 받는 연결: {line.accepts}</span>
    </div>
    <div className="grid content-start gap-2">
      <RankSelects<AiRankChoice> stage={{ id: `${line.task}-${line.slot}`, label: line.label, slots: 3 }} options={line.options} value={value} onChange={setValue}
        slotNames={AI_RANK_SLOT_NAMES} disabled={saving || readOnly} showProvider={false}
        validate={slots => validateAiTaskRanks(line.task, line.slot, slots, { connections, rows })}
        note={<p className="text-[13px] text-fg-2">{task.sameModelAcrossRanks ? "2·3순위는 1순위와 같은 모델을 다른 서버에 둘 때만 씁니다. " : ""}
          저장하면 없는 장비 행·엔진 직접 계약·용량 경로를 함께 만듭니다(만들 수 없으면 저장하지 않고 이유를 보입니다). 잡은 아직 이 순위를 읽지 않습니다.</p>} />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={saving || readOnly || issues.length > 0 || !changed && !pending} className="rounded bg-fg px-3 py-1.5 text-[13px] text-bg disabled:opacity-50">
          {saving ? "확인·저장 중…" : !changed && pending ? "다시 저장해 빠진 것 만들기" : "이 줄 저장"}</button>
        {!changed && !pending && !state && <span className="text-[13px] text-fg-3">바뀐 것이 없습니다.</span>}
      </div>
      {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
      {state?.warnings?.map(text => <p key={text} role="note" className="text-[13px] text-amber-700">알림 — {text}</p>)}
      {state?.issues && <ul role="alert" className="grid gap-0.5 text-[13px] text-red-600">{state.issues.map(text => <li key={text}>{text}</li>)}</ul>}
    </div>
    <div className="grid content-start gap-1 text-[13px]">
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
    </div>
  </form>;
}
