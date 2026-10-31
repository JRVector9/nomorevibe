"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { connectEngine, readbackEngineBase, type ContractSaveState } from "./actions";

export type EngineConnectModel = { key: string; label: string; requestModel: string; baseUrl: string | null; purposes: string[] };

/** 주소·키·모델만 넣는 연결. The server re-reads the engine and is the authority for every derived value. */
export function EngineConnectForm({ models, routes }: { models: EngineConnectModel[]; routes: readonly string[] }) {
  const [registryKey, setRegistryKey] = useState(models[0]?.key ?? "");
  const selected = models.find(model => model.key === registryKey);
  const [baseUrl, setBaseUrl] = useState(""), [auth, setAuth] = useState("stored"), [key, setKey] = useState("");
  const [engineModels, setEngineModels] = useState<{ id: string; maxModelLen: number | null }[] | null>(null);
  const [engineModel, setEngineModel] = useState(""), [readback, setReadback] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string[]>(() => routes.filter(route => models[0]?.purposes.includes(route)));
  const [maxModelLen, setMaxModelLen] = useState("");
  // mlx_lm.server and the M3 mlx-serve proxy list their model without max_model_len: the operator types the bound then.
  const lenUnknown = !!engineModel && engineModels?.find(model => model.id === engineModel)?.maxModelLen == null;
  const [state, action, pending] = useActionState<ContractSaveState, FormData>(connectEngine, null);
  function pick(next: string) {
    setRegistryKey(next);
    const model = models.find(row => row.key === next);
    setChosen(routes.filter(route => model?.purposes.includes(route)));
  }
  async function check() {
    setReadback("확인 중…"); setEngineModels(null);
    const result = await readbackEngineBase(baseUrl, auth === "stored" ? key : "");
    if (!result.ok) { setReadback(`확인 실패: ${result.reason}`); return; }
    setReadback(result.models.length ? null : "모델 없음");
    setEngineModels(result.models);
    // The current name without its gateway label, also behind a publisher prefix (Qwen3.8-27B-NVFP4 → Inferact/Qwen3.8-27B-NVFP4).
    const bare = selected?.requestModel.replace(/^\[[^\]]+\]\s*/, "").toLowerCase() ?? "";
    const match = result.models.find(model => model.id.toLowerCase() === bare) ?? result.models.find(model => model.id.toLowerCase().endsWith(`/${bare}`));
    setEngineModel(match?.id ?? result.models[0]?.id ?? "");
  }
  return <form action={action} className="grid gap-3 rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <label className="grid gap-1">바꿀 등록부 모델
      <select name="registryKey" value={registryKey} onChange={event => pick(event.target.value)} className="rounded border border-line bg-bg p-2">
        {models.map(model => <option key={model.key} value={model.key}>{model.label} ({model.key}) — 지금 {model.requestModel}</option>)}</select></label>
    <label className="grid gap-1">주소 (OpenAI 호환, …/v1)
      <input name="baseUrl" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://m1-studio.example.ts.net/v1"
        autoComplete="off" className="rounded border border-line bg-bg p-2 font-mono text-[13px]" /></label>
    <label className="grid gap-1">인증
      <select name="auth" value={auth} onChange={event => setAuth(event.target.value)} className="rounded border border-line bg-bg p-2">
        <option value="stored">API 키 저장(암호화)</option><option value="none">키 없음</option></select></label>
    {auth === "stored" && <label className="grid gap-1">API 키 (비워 두면 이 경로·모델에 저장된 키 유지)
      <input name="apiKey" type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} className="rounded border border-line bg-bg p-2" /></label>}
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={check} disabled={!baseUrl} className="rounded border border-line px-3 py-2">엔진 확인 (모델 목록 읽기)</button>
    </div>
    {readback && <p className="text-[13px]">{readback}</p>}
    {engineModels && engineModels.length > 0 && <fieldset className="grid gap-1"><legend className="mb-1">엔진 모델</legend>
      {engineModels.map(model => <label key={model.id} className="flex gap-2 text-[13px]">
        <input type="radio" name="engineModel" value={model.id} checked={engineModel === model.id} onChange={() => setEngineModel(model.id)} />
        <code>{model.id}</code>{model.maxModelLen ? ` · 최대 ${model.maxModelLen} 토큰` : " · 최대 길이 모름"}</label>)}</fieldset>}
    <label className="grid gap-1">컨텍스트 상한(토큰) — /models 가 max_model_len 을 안 줄 때만
      <input name="maxModelLen" type="number" inputMode="numeric" min={1} max={2097152} step={1} value={maxModelLen} onChange={event => setMaxModelLen(event.target.value)}
        placeholder={lenUnknown ? "예: 131072 — 이 모델은 최대 길이를 알려 주지 않습니다" : "엔진이 알려 주면 비워 둡니다(다른 값을 넣으면 거절)"}
        autoComplete="off" className="rounded border border-line bg-bg p-2 font-mono text-[13px]" /></label>
    <fieldset className="grid gap-1"><legend className="mb-1">쓰는 경로</legend>
      {routes.map(route => <label key={route} className="flex gap-2 text-[13px]">
        <input type="checkbox" name="routes" value={route} checked={chosen.includes(route)}
          onChange={event => setChosen(event.target.checked ? [...chosen, route] : chosen.filter(row => row !== route))} />{route}</label>)}</fieldset>
    <label className="flex gap-2 text-[13px]"><input type="checkbox" name="selectStages" defaultChecked />고른 경로의 단계별 모델을 이 모델로 지정</label>
    <label className="grid gap-1">메모<input name="note" maxLength={400} className="rounded border border-line bg-bg p-2" /></label>
    <div><button type="submit" disabled={pending || !engineModel || !chosen.length || (lenUnknown && !maxModelLen.trim())} className="rounded bg-fg px-3 py-2 text-bg">
      {pending ? "연결 중…" : "연결 저장"}</button></div>
    {state?.ok && <p role="status" className="text-[13px]">{state.message}</p>}
    {state?.ok && state.assignHref && <p className="text-[13px]"><Link href={state.assignHref} prefetch={false} className="font-semibold text-accent-ink underline">
      이 모델을 단계에 배정 →</Link> <span className="text-fg-3">모델 배정 화면의 새 배정 폼을 이 모델·엔진 직접 전송으로 채웁니다(연결 저장과 별개).</span></p>}
    {state?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </form>;
}
