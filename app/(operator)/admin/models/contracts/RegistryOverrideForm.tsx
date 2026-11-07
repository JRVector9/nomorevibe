"use client";
import { useActionState, useState } from "react";
import { ConfirmSubmit } from "../ConfirmSubmit";
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
    <div className="flex flex-wrap items-center gap-3"><ConfirmSubmit label="저장" pending={pending} changes={[{ label: "덮어쓸 등록부 키", after: jsonKey(json) ?? "JSON 을 읽지 못함(서버가 거절합니다)" }]}
      summary="이 JSON 이 코드 기본 정의 대신 쓰입니다. 되돌리면 코드 기본값이 다시 쓰입니다." /></div>
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </form>;
}

/** 정의 JSON 의 key — 확인 칸에 무엇을 덮어쓰는지 보인다. 못 읽으면 null(저장은 서버가 판정한다) */
function jsonKey(json: string): string | null {
  try { const parsed: unknown = JSON.parse(json); return parsed && typeof parsed === "object" && "key" in parsed ? String((parsed as { key: unknown }).key) : null; }
  catch { return null; }
}

/** 덮어쓰기 되돌리기 — window.confirm 대신 두 단계 확인(PR 5). 다시 저장하면 돌아오므로 사유는 받지 않는다 */
export function RevertRegistryButton({ registryKey }: { registryKey: string }) {
  const [state, action, pending] = useActionState<ContractSaveState, FormData>(disableRegistryOverride, null);
  return <form action={action} className="grid gap-1">
    <input type="hidden" name="key" value={registryKey} />
    <ConfirmSubmit label="되돌리기" confirmLabel="되돌리기 확인" pending={pending} pendingLabel="되돌리는 중…" className="rounded border border-line px-2 py-1" changes={[]}
      summary={`${registryKey} 정의를 코드 기본값으로 되돌립니다. 지금 덮어쓴 값은 이 표에서 빠집니다(같은 JSON 을 다시 저장하면 돌아옵니다).`} />
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </form>;
}
