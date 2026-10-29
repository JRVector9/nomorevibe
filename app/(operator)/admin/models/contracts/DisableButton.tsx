"use client";
import { useActionState } from "react";
import { disableServingContract, type ContractSaveState } from "./actions";

export function DisableButton({ routeId, model }: { routeId: string; model: string }) {
  const [state, action, pending] = useActionState<ContractSaveState, FormData>(disableServingContract, null);
  return <form action={action} onSubmit={event => { if (!confirm(`${routeId} · ${model} 계약을 끌까요?`)) event.preventDefault(); }}>
    <input type="hidden" name="routeId" value={routeId} /><input type="hidden" name="model" value={model} />
    <button type="submit" disabled={pending} className="rounded border border-line px-2 py-1">끄기</button>
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </form>;
}
