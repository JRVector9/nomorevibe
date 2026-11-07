"use client";
import { useActionState, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { closeUnknownReview, requeueUnknownReviews, type RequeueUnknownState, type UnknownReviewState } from "../unknown-review-actions";

/**
 * 「다시 대기열」 — 단계(route)의 결과 미확정 행 전부(최대 500건)를 그 단계의 작업 큐로 되돌리고, 성공한 행만 운영자 검토로 닫는다(서버 동작 그대로).
 * 확인은 화면 안 두 단계다(window.confirm 을 쓰지 않는다): 단추 → 바뀌는 내용 한 줄 + 「확인」·「취소」.
 * routeId 가 빈 문자열이면 지원하는 단계 모두다. 기록 › 재실행 패널과 대시보드 「먼저 할 일」이 같은 단추를 쓴다(할 일에서는 named 로 단계 이름을 붙인다).
 */
export function RequeueButton({ routeId, label, count, named = false, readOnly = false }: { routeId: string; label: string; count: number; named?: boolean; readOnly?: boolean }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<RequeueUnknownState, FormData>(requeueUnknownReviews, null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);
  if (readOnly) return <span className="llm-muted">읽기 전용</span>;
  if (state?.ok) return <span className="llm-retry-done" role="status">다시 넣음 · 행 {state.closed.toLocaleString("ko-KR")}건 닫음</span>;
  return <form action={action} className="llm-retry-form" data-confirming={confirming || undefined}>
    {routeId && <input type="hidden" name="routeId" value={routeId} />}
    {!confirming ? <button type="button" className="button small" onClick={() => setConfirming(true)} disabled={pending}>
      {!routeId ? "지원 단계 모두 다시 대기열" : named ? `${label} 다시 대기열` : "다시 대기열"}</button>
      : <>
        <span className="llm-retry-preview">{label} 결과 미확정 {count.toLocaleString("ko-KR")}건을 다시 실행하고, 다시 넣은 행은 닫습니다.</span>
        <button type="submit" className="button small primary" disabled={pending}>{pending ? "넣는 중…" : "확인"}</button>
        <button type="button" className="button small" onClick={() => setConfirming(false)} disabled={pending}>취소</button>
      </>}
    {state && !state.ok && <span role="alert" className="llm-retry-error">{state.error}</span>}
  </form>;
}

/** 「닫기」 — 작업을 다시 넣지 않고 행만 운영자 검토(withdrawn)로 닫는다. 사유 한 줄을 받는다(감사 기록에 남는다). */
export function CloseReviewForm({ requestId, readOnly = false }: { requestId: string; readOnly?: boolean }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<UnknownReviewState, FormData>(closeUnknownReview, null);
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);
  if (readOnly) return null;
  if (state?.ok) return <p className="llm-retry-done" role="status">닫음 · 작업 로그에 사유를 남겼습니다</p>;
  return <form action={action} className="llm-retry-close">
    <input type="hidden" name="requestId" value={requestId} />
    <label className="admin-vh" htmlFor={`note-${requestId}`}>닫는 사유</label>
    <input id={`note-${requestId}`} name="note" required minLength={1} maxLength={400} placeholder="닫는 사유(엔진 상태·조치)" disabled={pending} />
    <button type="submit" className="button small" disabled={pending}>{pending ? "기록 중…" : "닫기"}</button>
    {state && !state.ok && <span role="alert" className="llm-retry-error">{state.error}</span>}
  </form>;
}
