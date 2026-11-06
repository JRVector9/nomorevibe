"use client";

import { useActionState, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { CapacityReviewItem, CapacityReviewQueue } from "@/lib/operations/model-capacity-unknowns";
import { kstClock, modelStageLabel } from "@/lib/operations/admin-models-view";
import { closeUnknownReview, type UnknownReviewState } from "../models/unknown-review-actions";
import "./unknown-reviews.css";

const reasons: Record<string, string> = { client_timeout: "응답 시간 초과", local_abort: "호출 중단", transport_unknown: "전송 결과 미확인", process_exit: "프로세스 종료", commit_unknown: "결과 저장 미확인" };
type Scope = { task?: string; model?: string };

function ReviewRow({ item, onClosed }: { item: CapacityReviewItem; onClosed: (id: string) => void }) {
  const id = useId();
  const [state, action, pending] = useActionState<UnknownReviewState, FormData>(async (previous, form) => {
    try {
      const result = await closeUnknownReview(previous, form);
      if (result?.ok) onClosed(result.requestId);
      return result;
    } catch { return { ok: false, error: "종료 결과를 확인하지 못했습니다. 목록을 새로고침해 상태를 확인하세요." }; }
  }, null);
  return <li className="fu-row">
    <div className="fu-row-head"><b>{modelStageLabel(item.routeId)}</b><span>{item.reason ? reasons[item.reason] ?? "사유 미확인" : "사유 기록 없음"}</span></div>
    <p className="fu-model">{item.model} · {item.groupId}</p>
    <p className="fu-meta">전송 {item.dispatchedAt ? `${kstClock(item.dispatchedAt)} KST` : "시각 미확인"} · {item.localEndRecorded ? "호출자 측 종료 기록 있음" : "호출자 측 종료 기록 없음"}</p>
    <details><summary>호출 근거</summary><p className="fu-meta">요청 {item.requestId}<br />경로 {item.routeId}<br />작업 {item.workKey}<br />담당 {item.ownerInstanceId}{item.oldPolicy ? " · 이전 정책의 호출" : ""}</p></details>
    <form action={action} className="fu-form">
      <input type="hidden" name="requestId" value={item.requestId} />
      <label className="admin-vh" htmlFor={id}>검토 메모</label>
      <input id={id} name="note" required maxLength={400} placeholder="확인한 근거와 조치 메모" disabled={pending} />
      <button className="button small" type="submit" disabled={pending}>{pending ? "기록 중…" : "검토 종료"}</button>
    </form>
    {state && !state.ok && <p role="alert" className="fu-error">{state.error}</p>}
  </li>;
}

function ReviewDialog({ task, model, onClose }: Scope & { onClose: () => void }) {
  const router = useRouter(), title = useId();
  const dialog = useRef<HTMLDialogElement>(null), request = useRef<AbortController | null>(null);
  const closed = useRef(new Set<string>());
  const [queue, setQueue] = useState<CapacityReviewQueue | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const load = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    const params = new URLSearchParams();
    if (task) params.set("task", task);
    if (model) params.set("model", model);
    try {
      const response = await fetch(`/api/admin/flow/unknowns?${params}`, { cache: "no-store", credentials: "same-origin", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) throw new Error("unavailable");
      const value = await response.json() as { queue?: CapacityReviewQueue };
      if (!value.queue || value.queue.error || !Array.isArray(value.queue.items)) throw new Error("invalid");
      if (!controller.signal.aborted) { setQueue({ ...value.queue, items: value.queue.items.filter(item => !closed.current.has(item.requestId)) }); setError(null); }
    } catch { if (!controller.signal.aborted) setError("미확정 기록을 읽지 못했습니다. 다시 시도하세요."); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [task, model]);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    void load();
    return () => { request.current?.abort(); };
  }, [load]);
  const removed = (id: string) => {
    closed.current.add(id);
    setQueue(current => current ? { ...current, items: current.items.filter(item => item.requestId !== id) } : current);
    setMessage("검토 기록을 종료하고 감사 기록을 남겼습니다.");
    router.refresh();
  };
  return <dialog ref={dialog} className="fu-dialog" aria-labelledby={title} onClose={onClose}>
    <div className="fu-header"><h2 id={title}>미확정 호출 검토</h2><button className="button small" type="button" onClick={() => dialog.current?.close()}>닫기</button></div>
    <div className="fu-body">
      <p>검토 기록을 닫습니다. 모델 서버의 실행을 중지하는 기능은 아닙니다. 이 기록은 슬롯을 점유하지 않습니다.</p>
      {model && <p className="fu-model">선택한 모델 · {model}</p>}
      <div className="fu-toolbar"><span>{queue ? `${queue.items.length.toLocaleString("ko-KR")}건` : "조회 중"}</span><button type="button" className="button small" disabled={loading} onClick={() => { setLoading(true); setError(null); void load(); }}>목록 새로고침</button></div>
      <p role="status" aria-live="polite" className="fu-meta">{message}</p>
      {loading && <p role="status">미확정 기록을 읽는 중…</p>}
      {error && <p role="alert" className="fu-error">{error}</p>}
      {!loading && !error && queue && <>
        {queue.truncated && <p className="fu-meta">오래된 기록 최대 100건에서 조회했습니다. 조건에 맞는 다른 기록이 뒤에 남아 있을 수 있습니다.</p>}
        {!queue.items.length && <p>{queue.truncated ? "조회 범위에 이 조건의 미확정 기록이 없습니다." : "이 조건의 미확정 기록이 없습니다."}</p>}
        <ul className="fu-list">{queue.items.map(item => <ReviewRow key={item.requestId} item={item} onClosed={removed} />)}</ul>
      </>}
    </div>
  </dialog>;
}

/** Mount and read only on demand; portal outside station buttons retains the admin theme. */
export function FlowUnknownReviews({ label = "미확정 검토", task, model, className = "button small" }: Scope & { label?: string; className?: string }) {
  const trigger = useRef<HTMLButtonElement>(null), [target, setTarget] = useState<HTMLElement | null>(null);
  const close = () => { setTarget(null); trigger.current?.focus(); };
  return <><button ref={trigger} type="button" className={className} aria-haspopup="dialog" aria-expanded={target !== null}
    onClick={event => { event.stopPropagation(); setTarget(event.currentTarget.closest<HTMLElement>(".admin-prototype") ?? document.body); }}>{label}</button>
    {target && createPortal(<ReviewDialog task={task} model={model} onClose={close} />, target)}</>;
}
