"use client";
import { useActionState } from "react";
import { turnOffModelAssignmentAction, type AssignmentActionState } from "./actions";

/** 「끄기」 — 숨은 판(CAS)으로 지금 행을 mode off 로 다시 저장한다. 결과·거절 문장은 단추 아래에 */
export function TurnOffButton({ assignmentId, version, disabled }: { assignmentId: string; version: number; disabled?: boolean }) {
  const [state, action, pending] = useActionState<AssignmentActionState, FormData>(turnOffModelAssignmentAction, null);
  return <form action={action} className="grid gap-1">
    <input type="hidden" name="assignmentId" value={assignmentId} />
    <input type="hidden" name="expectedVersion" value={version} />
    <button type="submit" disabled={pending || disabled} className="w-fit rounded border border-line px-2 py-1 text-[13px] disabled:opacity-50">
      {pending ? "끄는 중…" : "끄기"}</button>
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </form>;
}
