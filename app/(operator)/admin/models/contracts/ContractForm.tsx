"use client";
import { useActionState, useState } from "react";
import { readbackEngine, saveServingContract, type ContractSaveState } from "./actions";

const AI1_TEMPLATE = { version: 1, protocol: "abcllm-raw-total-bound-v1", routeId: "crawl-agent-review", provider: "abcllm",
  model: "", responseModel: "", deploymentRevision: "", endpoint: "http://host:port/v1/chat/completions", totalTokenBound: 0 };

/** One contract editor. The route schema on the server is the authority; this form only helps fill the JSON. */
export function ContractForm({ routes, initial }: { routes: readonly string[]; initial?: { routeId: string; contract: Record<string, unknown>; auth: string; transport?: string } }) {
  const [routeId, setRouteId] = useState(initial?.routeId ?? "crawl-agent-review");
  const [json, setJson] = useState(() => JSON.stringify(initial?.contract ?? AI1_TEMPLATE, null, 2));
  const [auth, setAuth] = useState(initial?.auth ?? "gateway"), [key, setKey] = useState("");
  const [readback, setReadback] = useState<string | null>(null);
  const [state, action, pending] = useActionState<ContractSaveState, FormData>(saveServingContract, null);
  const endpoint = (() => { try { return String((JSON.parse(json) as { endpoint?: unknown }).endpoint ?? ""); } catch { return ""; } })();
  async function check() {
    setReadback("확인 중…");
    const result = await readbackEngine(endpoint, auth === "stored" ? key : "");
    setReadback(result.ok ? result.models.map(model => `${model.id}${model.maxModelLen ? ` · 최대 ${model.maxModelLen} 토큰` : ""}`).join("\n") || "모델 없음"
      : `확인 실패: ${result.reason}`);
  }
  return <form action={action} className="grid gap-3 rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <label className="grid gap-1">경로
      <select name="routeId" value={routeId} onChange={event => setRouteId(event.target.value)} className="rounded border border-line bg-bg p-2">
        {routes.map(route => <option key={route} value={route}>{route}</option>)}</select></label>
    <label className="grid gap-1">계약 JSON (이 경로의 형식 그대로)
      <textarea name="contract" value={json} onChange={event => setJson(event.target.value)} rows={12} spellCheck={false}
        className="rounded border border-line bg-bg p-2 font-mono text-[13px]" /></label>
    <label className="grid gap-1">전송
      <select name="transport" defaultValue={initial?.transport ?? "gateway"} className="rounded border border-line bg-bg p-2">
        <option value="gateway">abcLLM 게이트웨이로</option><option value="direct">엔진에 직접(게이트웨이 없음)</option></select></label>
    <label className="grid gap-1">인증
      <select name="auth" value={auth} onChange={event => setAuth(event.target.value)} className="rounded border border-line bg-bg p-2">
        <option value="gateway">abcLLM 게이트웨이 키(기본)</option><option value="none">키 없음(직접 연결 서버)</option>
        <option value="stored">이 연결의 키 저장(암호화)</option></select></label>
    {auth === "stored" && <label className="grid gap-1">API 키 (비워 두면 저장된 키 유지)
      <input name="apiKey" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} className="rounded border border-line bg-bg p-2" /></label>}
    <label className="grid gap-1">메모<input name="note" maxLength={400} className="rounded border border-line bg-bg p-2" /></label>
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={check} disabled={!endpoint} className="rounded border border-line px-3 py-2">엔진 확인 (모델·최대 길이 읽기)</button>
      <button type="submit" disabled={pending} className="rounded bg-fg px-3 py-2 text-bg">{pending ? "저장 중…" : "저장"}</button>
    </div>
    {readback && <pre className="whitespace-pre-wrap rounded bg-bg p-2 text-[13px]">{readback}</pre>}
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </form>;
}
