"use client";
import { useActionState } from "react";
import { buttonSmall } from "../../settings/Switch";
import { clearUnreadAiTaskRanksAction, deleteAiConnectionAction, hideAiConnectionModelAction, readAiConnectionModelsAction, type AiTaskActionState } from "./actions";

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

/**
 * 모델 「삭제」(목록에서 빼기)·「되돌리기」 — 배정이 없는 모델 줄에만 보인다. 서버·CLI 쪽 모델은 그대로이고 이 연결의 목록·순위 선택지에서만 빠진다.
 * 같은 모델의 별칭(여러 이름)은 한 번에 뺀다. 결과는 그 자리에 보인다.
 */
export function HideModelButton({ id, version, models, label, hidden }: { id: string; version: number; models: readonly string[]; label: string; hidden: boolean }) {
  const [state, action, pending] = useActionState<AiTaskActionState, FormData>(hideAiConnectionModelAction, null);
  return <form action={action} className="llm-model-act">
    <input type="hidden" name="id" value={id} /><input type="hidden" name="expectedVersion" value={version} />
    <input type="hidden" name="hidden" value={hidden ? "1" : "0"} />
    {models.map(model => <input key={model} type="hidden" name="model" value={model} />)}
    <button type="submit" disabled={pending} className="llm-model-hide" aria-label={`${label} ${hidden ? "목록에서 삭제" : "목록에 되돌리기"}`}
      title={hidden ? "이 연결의 모델 목록과 순위 선택지에서 뺍니다. 서버 쪽 모델은 그대로이며 「숨긴 모델」에서 되돌릴 수 있습니다." : undefined}>
      {pending ? "…" : hidden ? "삭제" : "되돌리기"}</button>
    {state?.ok && <span role="status" className="llm-muted">{state.message}</span>}
    {state?.issues?.map(text => <span key={text} role="alert" className="text-red-600">{text}</span>)}
  </form>;
}

/** 「기록 지우기」 — 실행 쪽이 읽지 않는 작업의 옛 순위 행(실행 안 함)을 지운다. 실행 동작은 바뀌지 않는다. */
export function ClearRecordsButton({ task, slot, revision, count, label }: { task: string; slot: number; revision: string; count: number; label: string }) {
  const [state, action, pending] = useActionState<AiTaskActionState, FormData>(clearUnreadAiTaskRanksAction, null);
  if (state?.ok) return <span role="status" className="tk-records-done">{state.message}</span>;
  return <form action={action} className="tk-records-form">
    <input type="hidden" name="task" value={task} /><input type="hidden" name="slot" value={slot} /><input type="hidden" name="revision" value={revision} />
    <button type="submit" disabled={pending} className="llm-model-hide" aria-label={`${label} 옛 순위 기록 ${count}개 지우기`}
      title="실행 쪽이 이 작업의 순위를 읽지 않습니다. 남은 순위 행은 실행에 쓰이지 않는 기록이라 지워도 동작은 바뀌지 않습니다.">{pending ? "지우는 중…" : "기록 지우기"}</button>
    {state?.issues?.map(text => <span key={text} role="alert" className="text-red-600">{text}</span>)}
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
