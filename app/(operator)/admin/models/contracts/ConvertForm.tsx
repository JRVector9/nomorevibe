"use client";
import { useActionState, useState } from "react";
import { ConfirmSubmit } from "../ConfirmSubmit";
import { applyContractConversion, previewContractConversion, type ConversionState } from "./actions";

/**
 * abcllm 계약 → 직접 연결(local-direct) 전환과 되돌리기(2026-11-21 2단계). 먼저 「미리 보기」로 계획(바뀔 계약·덧붙일 정책 route·거절과 까닭·관문)을 보고,
 * 그 계획 hash 로만 실행한다. 서버가 같은 계획인지 다시 확인한다 — 그 사이 바뀌었으면 거절한다.
 */
export function ConvertForm({ routes }: { routes: readonly string[] }) {
  const [routeId, setRouteId] = useState(routes[0] ?? ""), [model, setModel] = useState(""), [action, setAction] = useState<"convert" | "revert">("convert");
  const [preview, previewAction, previewing] = useActionState<ConversionState, FormData>(previewContractConversion, null);
  const [applied, applyAction, applying] = useActionState<ConversionState, FormData>(applyContractConversion, null);
  const plan = preview?.plan;
  const current = plan && plan.routeId === routeId && (plan.model ?? "") === model.trim() && plan.action === action ? plan : null;
  return <div className="grid gap-3 rounded-xl border border-line bg-bg-card p-5 text-[14px]">
    <form action={previewAction} className="grid gap-3">
      <div className="flex flex-wrap gap-3">
        <label className="grid gap-1">동작
          <select name="action" value={action} onChange={event => setAction(event.target.value === "revert" ? "revert" : "convert")} className="rounded border border-line bg-bg p-2">
            <option value="convert">abcllm → 직접 연결 전환</option><option value="revert">직접 연결 → abcllm 되돌리기</option></select></label>
        <label className="grid gap-1">경로
          <select name="routeId" value={routeId} onChange={event => setRouteId(event.target.value)} className="rounded border border-line bg-bg p-2">
            {routes.map(route => <option key={route} value={route}>{route}</option>)}</select></label>
        <label className="grid gap-1">모델(장부 이름, 비우면 경로 전체)
          <input name="model" value={model} onChange={event => setModel(event.target.value)} maxLength={200} className="rounded border border-line bg-bg p-2" /></label>
      </div>
      <div><button type="submit" disabled={previewing} className="rounded border border-line px-3 py-2">{previewing ? "읽는 중…" : "미리 보기"}</button></div>
    </form>
    {preview?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
    {plan && <pre className="whitespace-pre-wrap rounded bg-bg p-2 text-[13px]">{plan.lines.join("\n")}</pre>}
    {current && !current.blocked && current.targets > 0 && <form action={applyAction} className="grid gap-1">
      <input type="hidden" name="action" value={current.action} /><input type="hidden" name="routeId" value={current.routeId} />
      <input type="hidden" name="model" value={current.model ?? ""} /><input type="hidden" name="planHash" value={current.planHash} />
      <ConfirmSubmit label={current.action === "convert" ? "이 계획대로 전환" : "이 계획대로 되돌리기"} confirmLabel="실행 확인" pending={applying} pendingLabel="실행 중…"
        changes={[]} savedKey={current.planHash}
        summary={`${current.routeId}${current.model ? ` · ${current.model}` : ""}의 계약 ${current.targets}개를 ${current.action === "convert"
          ? "직접 연결(local-direct)로 다시 저장하고 정책 route 를 덧붙입니다" : "앞 abcllm 계약으로 다시 저장합니다"}. 앞 행은 꺼진 채 남습니다.`} />
    </form>}
    {plan && !current && <p className="text-[13px] text-fg-3">입력이 바뀌었습니다 — 미리 보기를 다시 해주세요.</p>}
    {applied?.ok && <p role="status" className="text-[13px]">{applied.message}</p>}
    {applied?.issues?.map(text => <p key={text} role="alert" className="text-[13px] text-red-600">{text}</p>)}
  </div>;
}
