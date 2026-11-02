"use client";
import { useActionState } from "react";
import { buttonSmall } from "../../settings/Switch";
import { deleteAiConnectionAction, readAiConnectionModelsAction, type AiTaskActionState } from "./actions";

/** 「다시 읽기」 — 저장된 주소·키로 GET /models(1분에 한 번). 결과를 그 자리에 보인다. */
export function RereadModelsButton({ id }: { id: string }) {
  const [state, action, pending] = useActionState<AiTaskActionState, FormData>(readAiConnectionModelsAction, null);
  return <form action={action} className="grid gap-1">
    <input type="hidden" name="id" value={id} />
    <button type="submit" disabled={pending} className={buttonSmall}>{pending ? "읽는 중…" : "다시 읽기"}</button>
    {state?.ok && <span role="status" className="text-[13px]">{state.message}</span>}
    {state?.issues?.map(text => <span key={text} role="alert" className="text-[13px] text-red-600">{text}</span>)}
  </form>;
}

/** 지우기 — 이 연결을 쓰는 순위가 없을 때만. 확인 칸에 연결 이름을 그대로 적어야 한다. */
export function DeleteConnectionButton({ id, label, version }: { id: string; label: string; version: number }) {
  const [state, action, pending] = useActionState<AiTaskActionState, FormData>(deleteAiConnectionAction, null);
  return <details className="text-[13px]"><summary className="cursor-pointer text-fg-3">지우기</summary>
    <form action={action} className="mt-1 grid gap-1">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="label" value={label} /><input type="hidden" name="expectedVersion" value={version} />
      <input name="confirm" autoComplete="off" placeholder={label} aria-label={`${label} 지우기 확인`} className="w-40 rounded border border-line bg-bg px-2 py-1" />
      <button type="submit" disabled={pending} className={buttonSmall}>{pending ? "지우는 중…" : "이 연결 지우기"}</button>
      {state?.issues?.map(text => <span key={text} role="alert" className="text-red-600">{text}</span>)}
    </form></details>;
}
