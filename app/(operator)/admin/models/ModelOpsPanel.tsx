"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { type OpsState, type OpsCommand, opsStepsFor, OPS_STEP_LABELS, opsHoldsBoundary } from "@/lib/operations/ops-runner/contract";
import { submitAdminModelOperation, readAdminModelOperation } from "./ops-runner-actions";
import { buttonClass, buttonSmall, inputClass, hintClass } from "../settings/Switch";

export type ModelOpsControls = { open: (action: OpsCommand["action"], targetId: string, label?: string) => void; disabled: boolean };
const titles = { "request-release": "요청 종료·해제", "model-restart": "모델 재시작", "admission-pause": "접수 일시중지", "admission-open": "접수 재개" };
export function ModelOpsPanel({ mode, requests, models, initialStates = [], submitAction = submitAdminModelOperation, readAction = readAdminModelOperation, renderControls }: {
  mode: string | null; requests: { requestId: string; model: string }[]; models: { key: string; label: string }[];
  renderControls?: (controls: ModelOpsControls) => React.ReactNode;
  initialStates?: OpsState[]; submitAction?: typeof submitAdminModelOperation; readAction?: typeof readAdminModelOperation;
}) {
  const router = useRouter();
  const [dialog, setDialog] = useState<{ action: OpsCommand["action"]; targetId: string; id: string; label?: string } | null>(null);
  const [localStates, setStates] = useState<OpsState[]>([]), [reason, setReason] = useState(""), [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(models[0]?.key ?? ""), [busy, start] = useTransition();
  const states = [...new Set([...localStates, ...initialStates].map(row => row.id))].map(id => {
    const local = localStates.find(row => row.id === id), initial = initialStates.find(row => row.id === id);
    return initial && (!local || (initial.auditId ?? 0) > (local.auditId ?? 0)) ? initial : local!;
  });
  const unfinished = states.find(opsHoldsBoundary);
  useEffect(() => {
    if (!unfinished) return;
    let live = true;
    const timer = setInterval(() => {
      void readAction(unfinished.id).then(result => {
        if (!live) return;
        if (result.error) setError(result.error);
        if (result.state) {
          setStates(rows => [result.state!, ...rows.filter(row => row.id !== result.state!.id)]);
          if (result.state.status === "completed") router.refresh();
        }
      }).catch(() => { if (live) setError("진행 상황 조회 실패 · 감사 기록을 확인해주세요."); });
    }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [unfinished, readAction, router]);
  const open = (action: OpsCommand["action"], targetId: string, label?: string) => { setReason(""); setError(null); setDialog({ action, targetId, id: crypto.randomUUID(), label }); };
  const submit = () => {
    if (!dialog) return;
    start(async () => {
      try {
        const result = await submitAction({ action: dialog.action, targetId: dialog.targetId, id: dialog.id, reason, confirmed: true });
        if (result.error) setError(result.error);
        if (result.state) { setStates(rows => [result.state!, ...rows.filter(row => row.id !== result.state!.id)]); setDialog(null); }
      } catch { setError("접수 응답 미확인 · 같은 작업 ID로 다시 확인하세요. 작업을 새로 만들지 마세요."); }
    });
  };
  return <div className="flex min-w-0 flex-col gap-3">
    {renderControls ? renderControls({ open, disabled: !!unfinished || busy }) : <><div className="flex flex-wrap gap-2">
      {mode === "open" && <button type="button" className={buttonClass} disabled={!!unfinished || busy} onClick={() => open("admission-pause", "model-capacity")}>접수 일시중지</button>}
      {mode === "draining" && <button type="button" className={buttonClass} disabled={!!unfinished || busy} onClick={() => open("admission-open", "model-capacity")}>접수 재개</button>}
    </div>
    {!!models.length && <div className="flex flex-wrap items-end gap-2"><label className="flex min-w-0 flex-col gap-1">재시작할 모델
      <select className={inputClass} value={model} disabled={!!unfinished || busy} onChange={event => setModel(event.target.value)}>{models.map(row => <option key={row.key} value={row.key}>{row.label}</option>)}</select></label>
      <button type="button" className={buttonSmall} disabled={!model || !!unfinished || busy} onClick={() => open("model-restart", model)}>모델 재시작</button></div>}
    {requests.map(row => <div key={row.requestId} className="flex flex-wrap items-center gap-2 text-[13px]"><span className="break-all">{row.model} · {row.requestId}</span>
      <button type="button" className={buttonSmall} disabled={!!unfinished || busy} onClick={() => open("request-release", row.requestId)}>요청 종료·해제</button></div>)}
    </>}
    <p className={hintClass}>확인 후 작업 큐에 접수합니다. 별도 운영 실행기가 prepare → run으로 처리하며 진행 상황은 자동 갱신됩니다. 종료 근거가 없으면 해제하지 않습니다. 미완료 작업은 같은 ID로 이어갑니다.</p>
    {error && <p role="alert">{error}</p>}
    {states.slice(0, 5).map(state => <ModelOpsProgress key={state.id} state={state} />)}
    {dialog && <OpsConfirm title={titles[dialog.action]} busy={busy} close={() => setDialog(null)}>
      <p>대상: {dialog.label ?? (dialog.action.startsWith("admission-") ? "모든 공통 모델" : dialog.targetId)}</p>
      <details><summary>자세히</summary><p className="break-all">대상 ID {dialog.targetId} · 작업 ID {dialog.id}</p></details>
      <p>{dialog.action === "request-release" ? "접수 중지 → 요청 보낸 서비스·모델 종료 확인 → 근거 검증 후 정산(확인 못함 행은 점유가 아니므로 검토 목록에서만 닫힘) → 원래 설정 복원 → 접수 재개. 업무 기록과 사용량 미확인을 보존합니다."
        : dialog.action === "model-restart" ? "접수 중지 → 모델과 관련 서비스 종료 확인 → 원래 설정으로 복원 → 접수 재개. 요청 해제는 수행하지 않습니다."
          : "모든 공통 모델의 접수 상태를 바꿉니다. 진행 중 요청과 업무 기록은 보존합니다."}</p>
      <p className={hintClass}>종료 근거를 얻지 못하면 해당 단계에서 멈춥니다. M3 native verify-stop은 native verify로 재확인합니다. M1 sudo 종료·복원은 사람이 장비에서 할 일이며 자동 실행하지 않습니다.</p>
      <label className="flex flex-col gap-2">변경 사유<input autoFocus className={inputClass} value={reason} maxLength={300} onChange={event => setReason(event.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">작업 접수·감사 기록 확인 중…</p>}
      <div className="flex flex-wrap justify-end gap-2"><button type="button" className={buttonClass} disabled={busy} onClick={() => setDialog(null)}>취소</button>
        <button type="button" className={buttonClass} disabled={busy || !reason.trim()} onClick={submit}>확인 · {titles[dialog.action]}</button></div>
    </OpsConfirm>}
  </div>;
}
export function ModelOpsProgress({ state }: { state: OpsState }) {
  const steps = opsStepsFor(state);
  return <article className="flex min-w-0 scroll-mt-28 flex-col gap-2 rounded-lg border border-line p-3 text-[14px] md:scroll-mt-6" aria-label={`${titles[state.action]} 진행 상황`}>
    <p><strong>{titles[state.action]}</strong></p>
    <p>감사 번호: {state.auditId ? `#${state.auditId}` : "접수 기록 확인 중"}</p>
    <details><summary>자세히</summary><p className="break-all">대상 {state.targetId} · 작업 ID {state.id}</p></details>
    <p role="status" className="text-[14px]" data-admin-type="status">{state.status === "queued" ? "운영 실행기 대기" : state.status === "completed" ? "완료" : state.status === "running" ? "진행 중" : "중단"}</p>
    {state.finalAdmission === "draining" && <p>이 작업은 끝나도 접수를 DRAIN으로 둡니다. 다음 절차가 정식 명령으로 OPEN합니다.</p>}
    <ol className="list-inside list-decimal">{steps.map(step => <li key={step}>{OPS_STEP_LABELS[step]} · {state.steps[step] === "done" ? "완료" : state.steps[step] === "running" ? "진행 중" : state.steps[step] ? "중단" : "대기"}</li>)}</ol>
    {(state.status === "blocked" || state.status === "manual") && <div role="alert"><p>멈춘 단계: {OPS_STEP_LABELS[state.step]}</p>
      <p className="break-all">사유: {state.code}</p>{state.status === "manual" && <p>사람이 장비에서 할 일: sudo가 필요한 종료·복원. 자동 실행하지 않습니다.</p>}
      <p>같은 작업 ID로 원인과 종료·복원 근거를 확인한 뒤 이어가세요.</p></div>}
  </article>;
}
function OpsConfirm({ title, busy, close, children }: { title: string; busy: boolean; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const previous = document.activeElement; const dialog = ref.current; dialog?.showModal();
    return () => { dialog?.close(); if (previous instanceof HTMLElement) previous.focus(); }; }, []);
  return <dialog ref={ref} className="admin-confirm" aria-labelledby="model-ops-title" data-dirty="true"
    onCancel={event => { event.preventDefault(); if (!busy) close(); }} onKeyDown={event => event.stopPropagation()}>
    <div className="flex flex-col gap-4 p-5"><h3 id="model-ops-title" className="text-[20px] font-semibold">{title}</h3>{children}</div>
  </dialog>;
}
