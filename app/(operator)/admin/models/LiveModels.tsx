"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AdminModelsObservation, AdminModelMetrics, AdminModelRequest } from "@/lib/operations/admin-models-observation";
import { elapsedModelTime, modelIdentityKey } from "@/lib/operations/admin-models-view";
import { changeAdminModelAdmission, probeAdminModel, type ModelProbeResult, type ModelOperationResult } from "./operation-actions";
import { buttonClass, buttonSmall, hintClass, inputClass } from "../settings/Switch";

const states = { waiting: "보류 · 접수 대기", reserved: "예약", dispatched: "진행 중", indeterminate: "미확인 · indeterminate" };
const stamp = (at: string | null) => at ? at.replace("T", " ").replace("Z", " UTC") : "기록 없음";
type Dialog = { kind: "admission"; to: "open" | "draining" } | { kind: "recovery"; request: AdminModelRequest };

export function LiveModels({ observation, probeAction = probeAdminModel, admissionAction = changeAdminModelAdmission }: {
  observation: AdminModelsObservation; probeAction?: typeof probeAdminModel; admissionAction?: typeof changeAdminModelAdmission;
}) {
  const router = useRouter(), [busy, start] = useTransition();
  const [dialog, setDialog] = useState<Dialog | null>(null), [reason, setReason] = useState("");
  const [probes, setProbes] = useState<Record<string, ModelProbeResult>>({});
  const [result, setResult] = useState<ModelOperationResult | null>(null);
  const open = (next: Dialog) => { setDialog(next); setReason(""); setResult(null); };
  const runProbe = (row: AdminModelMetrics) => start(async () => {
    const key = modelIdentityKey(row);
    try {
      const next = await probeAction({ routeId: row.routeId, provider: row.provider, model: row.model });
      setProbes(current => ({ ...current, [key]: next }));
    } catch { setProbes(current => ({ ...current, [key]: { error: "연결 확인 결과를 읽지 못했습니다. 감사 기록과 연결 상태를 확인해주세요." } })); }
  });
  const submitAdmission = () => {
    if (dialog?.kind !== "admission") return;
    const to = dialog.to;
    start(async () => {
      try {
        const next = await admissionAction({ to, fromMode: observation.mode, expectEpoch: observation.epoch,
          expectRevision: observation.revision, reason, confirmed: true });
        setResult(next);
        if (next.ok) router.refresh();
      } catch { setResult({ error: "실행 결과를 확인하지 못했습니다. 새로고침해 접수 상태와 감사 기록을 확인해주세요." }); }
    });
  };
  return <section className="flex min-w-0 flex-col gap-4 rounded-xl border border-line bg-bg-card p-5" aria-labelledby="live-models-heading">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="live-models-heading" className="text-[18px] font-semibold">실제 동작·미확인 요청</h2>
      <button type="button" className={buttonSmall} disabled={busy} onClick={() => router.refresh()}>실측 새로고침</button></div>
    {observation.error ? <p role="alert">{observation.error}</p> : <>
      <p>접수 <strong>{observation.mode?.toUpperCase()}</strong> · 관측 {stamp(observation.observedAt)}</p>
      <p className={hintClass}>최근 1시간 성공·실패는 장부에 남은 모델 응답 종료 판정입니다. 업무 승인·발행 성공과 다릅니다. 판정할 수 없는 종료는 미분류로 표시하며, 응답이 안 끝난 요청은 미확인에 남깁니다.</p>
      <div className="flex flex-wrap gap-2">{observation.groups.map(group => <span key={group.groupId} className="rounded-lg border border-line px-3 py-2 text-[13px] break-all">
        {group.groupId} · 점유 {group.held}/{group.limit ?? "상한 미확인"}</span>)}</div>
      <p className={hintClass}>예약·진행 중·미확인은 모두 슬롯을 점유합니다. 예약 기한이 지나도 이 화면은 해제하지 않습니다. {observation.policyVerified ? `전체 상한 ${observation.globalLimit}` : "정책 검증 실패 · 상한 미확인"}</p>
      <div className="flex flex-wrap gap-2">
        {observation.policyVerified && observation.mode === "open" && <button type="button" className={buttonClass} disabled={busy} onClick={() => open({ kind: "admission", to: "draining" })}>접수 일시중지</button>}
        {observation.policyVerified && observation.mode === "draining" && <button type="button" className={buttonClass} disabled={busy} onClick={() => open({ kind: "admission", to: "open" })}>접수 재개</button>}
      </div>
      <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-left text-[13px]">
        <thead><tr><th className="p-2">단계·모델·그룹</th><th className="p-2">1시간 성공 / 실패 / 철회 / 미분류</th><th className="p-2">진행 / 미확인 / 예약 / 보류</th><th className="p-2">마지막 성공</th><th className="p-2">연결 확인</th></tr></thead>
        <tbody>{observation.rows.map(row => <tr key={`${modelIdentityKey(row)}|${row.groupId}|${row.providerBudgetId}`} className="border-t border-line align-top">
          <th className="max-w-[260px] break-words p-2 font-normal"><strong>{row.routeId}</strong><br />{row.provider} · {row.model}<br /><span className={hintClass}>{row.groupId} / {row.providerBudgetId}</span></th>
          <td className="p-2 tabular-nums">{row.succeeded1h} / {row.failed1h} / {row.withdrawn1h} / {row.unclassified1h}</td>
          <td className="p-2 tabular-nums">{row.dispatched} / {row.indeterminate} / {row.reserved} / {row.waiting}</td>
          <td className="p-2">{stamp(row.lastSuccessAt)}</td>
          <td className="max-w-[240px] p-2"><button type="button" className={buttonSmall} disabled={busy || row.provider !== "abcllm"} onClick={() => runProbe(row)}>연결 확인</button>
            {row.provider !== "abcllm" && <p className={hintClass}>모델 목록 조회 실행기 연결 필요</p>}
            {probes[modelIdentityKey(row)] && <ProbeNotice result={probes[modelIdentityKey(row)]} />}</td>
        </tr>)}</tbody></table></div>
      <h3 className="text-[16px] font-semibold">미확인·보류·예약·진행 중 요청</h3>
      {observation.truncated && <p role="alert">요청이 100건을 넘습니다. 미확인 우선으로 100건만 표시하며 위 점유 합계에는 모든 요청을 포함합니다.</p>}
      {!observation.requests.length && <p>현재 남아 있는 요청이 없습니다.</p>}
      {observation.requests.map(request => <article key={request.requestId} className="flex min-w-0 flex-col gap-2 rounded-lg border border-line p-3 text-[13px]">
        <p><strong>{states[request.state]}</strong> · {request.routeId} · {request.model}</p>
        <p className="break-all font-mono">{request.requestId} · {request.groupId} · {request.ownerInstanceId}</p>
        <p>발생 {stamp(request.stateSince)} · 상태 경과 {elapsedModelTime(request.stateSince, observation.observedAt)} · 접수 후 {elapsedModelTime(request.queuedAt, observation.observedAt)}</p>
        {request.reservedUntil && <p>예약 기한 {stamp(request.reservedUntil)}</p>}
        {request.localEndRecorded && <p>로컬 호출 종료 기록 있음 · 모델 제공자의 종료 증거는 별도 확인이 필요합니다.</p>}
        {request.state === "indeterminate" && <div><button type="button" className={buttonSmall} disabled={busy} onClick={() => open({ kind: "recovery", request })}>복구 조건 확인</button></div>}
      </article>)}
    </>}
    {dialog && <ModelOperationDialog busy={busy} onClose={() => setDialog(null)}>
        <h3 id="model-operation-title" className="text-[20px] font-semibold">{dialog.kind === "admission" ? dialog.to === "open" ? "접수 재개" : "접수 일시중지" : "복구 조건 확인"}</h3>
        {dialog.kind === "admission" ? <>
          <p>모든 공통 모델의 접수를 {dialog.to === "open" ? "재개" : "일시중지"}합니다. 진행 중 요청과 업무 기록은 보존합니다.</p>
          <p className={hintClass}>현재 {observation.mode?.toUpperCase()} · epoch {observation.epoch} · revision {observation.revision}. 서버에서 상태·실행 계약을 다시 확인하며 거절 사유를 표시합니다.</p>
          <label className="flex flex-col gap-2">변경 사유<input autoFocus className={inputClass} value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label>
          {busy && <p role="status">현재 상태 검증 → 정식 접수 제어 실행 → 감사 기록 확인 중…</p>}
          {result?.error && <div role="alert"><p>{result.error}</p>{result.blocked?.map(code => <p key={code} className="break-all font-mono text-[13px]">{code}</p>)}</div>}
          {result?.ok && <p role="status">접수 상태를 변경하고 감사 기록을 남겼습니다.</p>}
          <div className="flex flex-wrap justify-end gap-2"><button type="button" disabled={busy} className={buttonClass} onClick={() => setDialog(null)}>닫기</button>
            {!result?.ok && <button type="button" className={buttonClass} disabled={busy || !reason.trim()} onClick={submitAdmission}>확인 · {dialog.to === "open" ? "접수 재개" : "접수 일시중지"}</button>}</div>
        </> : <>
          <p className="break-all">{dialog.request.model} · {dialog.request.requestId}</p>
          <ol className="list-inside list-decimal text-[14px]"><li>접수 중지(DRAIN)</li><li>요청 보낸 서비스·모델 종료 확인</li><li>종료 근거 검증 후 정식 provider-boundary/V1 해제</li><li>원래 설정 복원</li><li>접수 재개</li></ol>
          <p role="alert">시작 전 중단: 웹에서 기존 prepare→run 복구 실행기와 종료 근거 수집기를 호출할 연결이 없습니다. 요청과 점유를 보존합니다.</p>
          {/m1|29877f65/i.test(`${dialog.request.groupId} ${dialog.request.model} ${dialog.request.requestId}`) && <p>사람이 장비에서 할 일: M1의 sudo가 필요한 종료·복원은 장비에서 수행해야 합니다. 자동 실행하지 않습니다.</p>}
          <p className={hintClass}>M3 native stop이 exit_fact_missing_launchdUnloaded로 실패하면 native verify로 종료를 재확인해야 합니다. 시간 경과와 로컬 종료 기록만으로 해제하지 않습니다.</p>
          <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled title="종료 근거 수집·정식 복구 실행기 연결 필요">요청 종료·해제</button>
            <button type="button" className={buttonClass} disabled title="정식 복구 실행기 연결 필요">모델 재시작</button></div>
          <button type="button" className={buttonClass} autoFocus onClick={() => setDialog(null)}>닫기</button>
        </>}
    </ModelOperationDialog>}
  </section>;
}

function ModelOperationDialog({ busy, onClose, children }: { busy: boolean; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="model-operation-title" data-dirty="true"
    className="admin-confirm" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={event => event.stopPropagation()}>
    <div className="flex flex-col gap-4 p-5">{children}</div>
  </dialog>;
}

function ProbeNotice({ result }: { result: ModelProbeResult }) {
  return <div role="status" className="mt-2 flex flex-col gap-1 text-[12px]">
    <p>{result.listed === undefined ? "목록 미확인" : result.listed ? "모델 목록에 있음" : "모델 목록에 없음"} · {result.listMs ?? "—"}ms</p>
    {result.error && <p>{result.error}</p>}<p>시험 호출: {result.callMs === undefined ? result.callBlocked : `${result.callMs}ms`}</p>
  </div>;
}
