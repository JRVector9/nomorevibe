"use client";

import { useActionState, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import type { CapacityReviewDetailsItem, CapacityReviewDetailsQueue } from "@/lib/operations/model-capacity-unknowns";
import { kstClock, modelStageLabel } from "@/lib/operations/admin-models-view";
import { closeUnknownReview, type UnknownReviewState } from "../models/unknown-review-actions";
import "./unknown-reviews.css";

const reasons: Record<string, string> = {
  client_timeout: "기한 초과",
  local_abort: "호출자 측 중단",
  transport_unknown: "전송 결과 미확인",
  process_exit: "호출 프로세스 종료로 결과 미확인",
  commit_unknown: "정산 저장 여부 미확인",
};
type Scope = { task?: string; model?: string };

const kstDate = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const time = (value: string | null | undefined) => {
  if (!value || !Number.isFinite(Date.parse(value))) return "기록 없음";
  return `${kstDate.format(new Date(value))} ${kstClock(value)} KST`;
};

function ReviewRow({ item, readOnly, onClosed }: { item: CapacityReviewDetailsItem; readOnly: boolean; onClosed: (id: string) => void }) {
  const id = useId();
  const [state, action, pending] = useActionState<UnknownReviewState, FormData>(async (previous, form) => {
    try {
      const result = await closeUnknownReview(previous, form);
      if (result?.ok) onClosed(result.requestId);
      return result;
    } catch { return { ok: false, error: "종료 결과를 확인하지 못했습니다. 목록을 새로고침해 상태를 확인하세요." }; }
  }, null);
  const projects = Array.isArray(item.projects) ? item.projects : [];
  return <li className="fu-row">
    <div className="fu-row-head"><b>{modelStageLabel(item.routeId)}</b><code className="fu-route">{item.routeId}</code><span>{item.reason ? reasons[item.reason] ?? "사유 기록 없음" : "사유 기록 없음"}</span></div>
    <div className="fu-projects">
      <p className="fu-meta">프로젝트</p>
      {projects.length > 0 ? <ul className="fu-project-list">{projects.map(project => <li key={`${project.kind}:${project.id}`}>
        <span>{project.label} <span className="fu-meta">({project.kind === "candidate" ? "후보" : "등록 프로젝트"} #{project.id})</span></span>
        {project.href ? <a className="fu-link" href={project.href}>기록 열기</a> : <span className="fu-meta">링크 기록 없음</span>}
      </li>)}</ul> : <p className="fu-meta">프로젝트 연결 정보 없음</p>}
      {item.projectsTruncated && <p className="fu-meta">프로젝트 표본 32개까지 표시</p>}
    </div>
    <p className="fu-model">{item.model} · {item.groupId}</p>
    {(item.provider || item.providerBudgetId) && <p className="fu-meta">{[item.provider ? `제공자 ${item.provider}` : "", item.providerBudgetId ? `예산 ${item.providerBudgetId}` : ""].filter(Boolean).join(" · ")}</p>}
    <dl className="fu-times">
      <div><dt>접수</dt><dd>{time(item.queuedAt)}</dd></div>
      <div><dt>전송</dt><dd>{time(item.dispatchedAt)}</dd></div>
      <div><dt>미확정 등록</dt><dd>{time(item.markedAt)}</dd></div>
      <div><dt>호출자 종료 기록</dt><dd>{time(item.localEndedAt)}{!item.localEndedAt && item.localEndRecorded ? " · 호출자 측 종료 기록 있음" : ""}</dd></div>
    </dl>
    <details><summary>호출 근거</summary><p className="fu-meta">요청 {item.requestId}<br />경로 {item.routeId}<br />{item.logicalWorkKey ? <>논리 키 {item.logicalWorkKey}<br /></> : null}작업 {item.workKey}<br />담당 {item.ownerInstanceId}{item.oldPolicy ? " · 이전 정책의 호출" : ""}</p></details>
    <form action={action} className="fu-form">
      <input type="hidden" name="requestId" value={item.requestId} />
      <label className="admin-vh" htmlFor={id}>검토 메모</label>
      <input id={id} name="note" required minLength={1} maxLength={400} placeholder="확인한 근거와 조치 메모" disabled={pending || readOnly} />
      <button className="button small" type="submit" disabled={pending || readOnly}>{pending ? "기록 중…" : "검토 기록 종료"}</button>
    </form>
    {state && !state.ok && <p role="alert" className="fu-error">{state.error}</p>}
  </li>;
}

function ReviewDialog({ task, model, onClose }: Scope & { onClose: () => void }) {
  const router = useRouter(), title = useId();
  const dialog = useRef<HTMLDialogElement>(null), request = useRef<AbortController | null>(null);
  const closed = useRef(new Set<string>());
  const [queue, setQueue] = useState<CapacityReviewDetailsQueue | null>(null);
  const [canReview, setCanReview] = useState(false);
  const [observedAt, setObservedAt] = useState<string | null>(null);
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
      const value = await response.json() as { queue?: CapacityReviewDetailsQueue; observedAt?: string | null; canReview?: boolean };
      if (!value.queue || value.queue.error || !Array.isArray(value.queue.items)) throw new Error("invalid");
      if (!controller.signal.aborted) {
        setQueue({ ...value.queue, items: value.queue.items.filter(item => !closed.current.has(item.requestId)) });
        setCanReview(value.canReview === true);
        setObservedAt(value.observedAt ?? value.queue.observedAt ?? null);
        setError(null);
      }
    } catch { if (!controller.signal.aborted) { setCanReview(false); setError("미확정 기록을 읽지 못했습니다. 다시 시도하세요."); } }
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
    setMessage("검토 기록을 닫고 감사 기록을 남겼습니다.");
    router.refresh();
  };
  return <dialog ref={dialog} className="fu-dialog" aria-labelledby={title} onClose={onClose}>
    <div className="fu-header"><h2 id={title}>미확정 호출 검토</h2><button className="button small" type="button" onClick={() => dialog.current?.close()}>닫기</button></div>
    <div className="fu-body">
      <p>확인한 근거를 메모하고 검토 기록을 종료합니다. 모델 실행 중지나 작업 승인으로 처리하지 않습니다.</p>
      <p className="fu-meta">장부 슬롯: 점유 없음 · 원격 실행 종료: 별도 확인</p>
      {model && <p className="fu-model">선택한 모델 · {model}</p>}
      <div className="fu-toolbar"><span>{queue ? `${queue.items.length.toLocaleString("ko-KR")}건` : "조회 중"}{observedAt ? ` · ${time(observedAt)} 기준` : ""}</span><button type="button" className="button small" disabled={loading} onClick={() => { setCanReview(false); setLoading(true); setError(null); void load(); }}>목록 새로고침</button></div>
      <p role="status" aria-live="polite" className="fu-meta">{message}</p>
      {loading && <p role="status">미확정 기록을 읽는 중…</p>}
      {error && <p role="alert" className="fu-error">{error}</p>}
      {!loading && !error && !canReview && <p className="fu-meta">읽기 전용에서는 검토를 종료할 수 없습니다.</p>}
      {!loading && !error && queue && <>
        {queue.truncated && <p className="fu-meta">이 조건의 오래된 기록 최대 100건을 표시합니다.</p>}
        {!queue.items.length && <p>이 조건의 미확정 기록이 없습니다.</p>}
        <ul className="fu-list">{queue.items.map(item => <ReviewRow key={item.requestId} item={item} readOnly={!canReview} onClosed={removed} />)}</ul>
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
