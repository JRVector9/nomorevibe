"use client";
import { useActionState, useState } from "react";
import { turnOffModelAssignmentAction, type AssignmentActionState } from "./actions";

/**
 * 「끄기」 — 숨은 판(CAS)으로 지금 행을 mode off 로 다시 저장한다. 결과·거절 문장은 단추 아래에.
 * 한 번 누르면 바로 꺼지던 것을 두 단계로 바꿨다(2026-11-07 LLM 운영 점검): 끄면 이 배정으로 가던 호출이 다음 배정·순위로 넘어간다.
 */
export function TurnOffButton({ assignmentId, version, disabled }: { assignmentId: string; version: number; disabled?: boolean }) {
  const [state, action, pending] = useActionState<AssignmentActionState, FormData>(turnOffModelAssignmentAction, null);
  const [confirming, setConfirming] = useState(false);
  return <form action={action} className="grid gap-1">
    <input type="hidden" name="assignmentId" value={assignmentId} />
    <input type="hidden" name="expectedVersion" value={version} />
    {confirming && !pending
      ? <div className="grid gap-1">
          <p className="text-[13px] text-fg-2">이 배정을 끕니다. 이 배정으로 가던 호출은 다음 배정·순위로 넘어갑니다.</p>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={disabled} className="w-fit rounded border border-red-600 px-2 py-1 text-[13px] text-red-700 disabled:opacity-50">끄기 확인</button>
            <button type="button" onClick={() => setConfirming(false)} className="w-fit rounded border border-line px-2 py-1 text-[13px]">취소</button>
          </div>
        </div>
      : <button type="button" onClick={() => setConfirming(true)} disabled={pending || disabled}
          className="w-fit rounded border border-line px-2 py-1 text-[13px] disabled:opacity-50">{pending ? "끄는 중…" : "끄기"}</button>}
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </form>;
}
