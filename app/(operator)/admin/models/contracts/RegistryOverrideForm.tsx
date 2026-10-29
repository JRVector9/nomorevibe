"use client";
import { useActionState, useState } from "react";
import { disableRegistryOverride, saveRegistryOverride, type ContractSaveState } from "./actions";

/** Edit one registry definition as JSON. The server checks the merged registry, purposes and saved stage selections. */
export function RegistryOverrideForm({ definitions }: { definitions: Record<string, unknown>[] }) {
  const [key, setKey] = useState(String(definitions[0]?.key ?? ""));
  const [json, setJson] = useState(() => JSON.stringify(definitions[0] ?? {}, null, 2));
  const [state, action, pending] = useActionState<ContractSaveState, FormData>(saveRegistryOverride, null);
  function pick(next: string) {
    setKey(next);
    setJson(JSON.stringify(definitions.find(row => row.key === next) ?? {}, null, 2));
  }
  return <form action={action} className="grid gap-3 rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <label className="grid gap-1">불러올 정의
      <select value={key} onChange={event => pick(event.target.value)} className="rounded border border-line bg-bg p-2">
        {definitions.map(row => <option key={String(row.key)} value={String(row.key)}>{String(row.displayName)} ({String(row.key)})</option>)}</select></label>
    <label className="grid gap-1">정의 JSON (키를 새로 쓰면 추가)
      <textarea name="definition" value={json} onChange={event => setJson(event.target.value)} rows={14} spellCheck={false}
        className="rounded border border-line bg-bg p-2 font-mono text-[13px]" /></label>
    <label className="grid gap-1">메모<input name="note" maxLength={400} className="rounded border border-line bg-bg p-2" /></label>
    <div><button type="submit" disabled={pending} className="rounded bg-fg px-3 py-2 text-bg">{pending ? "저장 중…" : "저장"}</button></div>
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </form>;
}

export function RevertRegistryButton({ registryKey }: { registryKey: string }) {
  const [state, action, pending] = useActionState<ContractSaveState, FormData>(disableRegistryOverride, null);
  return <form action={action} onSubmit={event => { if (!confirm(`${registryKey} 정의를 코드 기본값으로 되돌릴까요?`)) event.preventDefault(); }}>
    <input type="hidden" name="key" value={registryKey} />
    <button type="submit" disabled={pending} className="rounded border border-line px-2 py-1">되돌리기</button>
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </form>;
}
