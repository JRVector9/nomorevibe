"use client";

import { useActionState, useState } from "react";
import type { AssistControlView } from "@/lib/operations/llm-assist-controls";
import { buttonSmall } from "../../settings/Switch";
import type { AiTaskActionState } from "./actions";
import { saveAssistControlAction } from "./assist-actions";

const fmt = (value: number) => value.toLocaleString("ko-KR");
const MODES = [["off", "끔"], ["shadow", "그림자(묻고 기록만)"], ["confirm", "확인 후 반영"]] as const;
const STATE_LABELS: Readonly<Record<string, string>> = { queued: "대기", claimed: "처리 중", waiting_evidence: "근거 대기", waiting_capacity: "칸 대기",
  retryable_transport: "다시 시도", human: "사람 확인", indeterminate: "결과 모름" };

function queueText(queue: AssistControlView["queue"]): string {
  if (!queue) return "확인 불가";
  const entries = Object.entries(queue).filter(([, count]) => count > 0);
  if (!entries.length) return "없음";
  return entries.map(([state, count]) => `${STATE_LABELS[state] ?? state} ${fmt(count)}`).join(" · ");
}

/** 보강 일 하나의 제어 폼 — 단계·보내기·반영. 판(revision)으로 compare-and-set 한다. */
function ControlRow({ control, readOnly }: { control: AssistControlView; readOnly: boolean }) {
  const [state, action, pending] = useActionState<AiTaskActionState, FormData>(saveAssistControlAction, null);
  const [mode, setMode] = useState(control.mode);
  const [dispatch, setDispatch] = useState(control.dispatchEnabled);
  const [apply, setApply] = useState(control.applyEnabled);
  const confirmLocks = mode === "confirm" && !control.confirmationRequired;
  return <tr className="border-b border-line align-top" data-assist-task={control.task}>
    <th scope="row" className="py-2 pr-3 text-left font-semibold">{control.label}<div className="text-[12px] font-normal text-fg-3">{control.task} · {control.aiTaskLabel}</div></th>
    <td className="py-2 pr-3">{queueText(control.queue)}</td>
    <td className="py-2 pr-3">
      {MODES.find(([value]) => value === control.mode)?.[1] ?? control.mode} · 보내기 {control.dispatchEnabled ? "켜짐" : "꺼짐"} · 반영 {control.applyEnabled ? "켜짐" : "꺼짐"}
      {control.confirmationRequired && <div className="text-[12px] text-fg-3">확인 필수(끌 수 없음){control.task === "uptime" ? " — 옛 자동 내림이 보강 확인을 기다립니다" : ""}</div>}
      <div className="text-[12px] text-fg-3">판 {control.revision}</div>
    </td>
    <td className="py-2 pr-3">
      {readOnly ? <span className="text-fg-3">읽기 전용</span> : <form action={action} className="grid gap-1">
        <input type="hidden" name="task" value={control.task} /><input type="hidden" name="revision" value={control.revision} />
        <label className="flex items-center gap-2">단계
          <select name="mode" value={mode} disabled={pending} aria-label={`${control.label} 단계`} className="rounded border border-line bg-bg px-2 py-1"
            onChange={event => { const next = event.target.value as typeof mode; setMode(next);
              if (next === "off") { setDispatch(false); setApply(false); } else if (next !== "confirm") setApply(false); }}>
            {MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>
        <label className="flex items-center gap-2"><input type="checkbox" name="dispatch" checked={dispatch} disabled={pending || mode === "off"}
          onChange={event => { setDispatch(event.target.checked); if (!event.target.checked) setApply(false); }} />보내기(모델 호출)</label>
        <label className="flex items-center gap-2"><input type="checkbox" name="apply" checked={apply} disabled={pending || mode !== "confirm" || !dispatch}
          onChange={event => setApply(event.target.checked)} />반영(결과를 제품에 적용)</label>
        {confirmLocks && <span role="note" className="text-[12px] text-amber-700">「확인 후 반영」으로 저장하면 확인 필수가 켜지고 다시 끌 수 없습니다(DB 규칙).</span>}
        <button type="submit" disabled={pending} className={buttonSmall}>{pending ? "저장하는 중…" : "저장"}</button>
        {state?.ok && <span role="status" className="text-[13px]">{state.message}</span>}
        {state?.issues?.map(text => <span key={text} role="alert" className="text-[13px] text-red-600">{text}</span>)}
      </form>}
    </td>
  </tr>;
}

/**
 * 「LLM 보강 제어」(2026-11-11) — llm_assist_controls 의 보강 일마다 단계·보내기·반영을 관리자가 바꾼다. 모델은 위 표의 LLM 보강·LLM 보강 독립 감사 순위가 고른다.
 * 저장은 한 줄씩(판 compare-and-set, 감사 한 줄). 이 화면은 아무 것도 저절로 켜지 않는다.
 */
export function AssistControlsCard({ controls, error, readOnly }: { controls: readonly AssistControlView[]; error: string | null; readOnly: boolean }) {
  if (error) return <p role="alert" className="text-[13px] text-red-600">LLM 보강 제어를 읽지 못했습니다({error}).</p>;
  if (!controls.length) return <p className="text-[13px] text-fg-3">LLM 보강 제어 행이 없습니다.</p>;
  return <div className="grid gap-2">
    <p className="text-[13px] text-fg-3">보내기가 켜진 일만 잡이 가져가 모델을 부릅니다(그림자는 기록만, 「확인 후 반영」 + 반영이 켜져야 제품에 적용). 모든 호출은 용량 장부의 장비 칸을 거칩니다.
      저장하면 그 일의 판이 올라 진행 중이던 호출은 모델을 부르기 전에 멈춥니다.</p>
    <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]">
      <thead><tr className="border-b border-line"><th className="py-2 pr-3">보강 일</th><th className="py-2 pr-3">끝나지 않은 일</th><th className="py-2 pr-3">지금</th><th className="py-2 pr-3">바꾸기</th></tr></thead>
      <tbody>{controls.map(control => <ControlRow key={control.task} control={control} readOnly={readOnly} />)}</tbody>
    </table></div>
  </div>;
}
