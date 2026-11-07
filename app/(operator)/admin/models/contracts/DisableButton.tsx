"use client";
import { useActionState } from "react";
import { ConfirmSubmit } from "../ConfirmSubmit";
import { disableServingContract, type ContractSaveState } from "./actions";

/** 계약 끄기 — window.confirm 대신 두 단계 확인(PR 5). 같은 계약을 다시 저장하면 돌아오므로 사유는 받지 않는다 */
export function DisableButton({ routeId, model }: { routeId: string; model: string }) {
  const [state, action, pending] = useActionState<ContractSaveState, FormData>(disableServingContract, null);
  return <form action={action} className="grid gap-1">
    <input type="hidden" name="routeId" value={routeId} /><input type="hidden" name="model" value={model} />
    <ConfirmSubmit label="끄기" confirmLabel="끄기 확인" pending={pending} pendingLabel="끄는 중…" className="rounded border border-line px-2 py-1" changes={[]}
      summary={`${routeId} · ${model} 계약을 끕니다. 다시 저장할 때까지 이 경로·모델은 호출하지 않습니다.`} />
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </form>;
}
