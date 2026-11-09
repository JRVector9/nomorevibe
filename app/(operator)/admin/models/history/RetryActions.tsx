"use client";
import Link from "next/link";
import { useActionState, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { LLM_RETRY_HREF } from "@/lib/operations/llm-ops-links";
import { requeueSummaryText } from "@/lib/operations/model-capacity-requeue-text";
import { closeUnknownReview, requeueUnknownReviews, type RequeueUnknownState, type UnknownReviewState } from "../unknown-review-actions";

/**
 * 「다시 대기열」 결과 한 줄 — N건 다시 넣음 · M건 닫음 · K건 남음(까닭). 남은 행이 있거나 오류일 때만 기록 › 재실행 대기로 가는 작은 링크를 붙인다
 * (historyLink=false 는 이미 그 화면 안이라 링크를 두지 않는다).
 */
function RequeueResult({ state, historyLink }: { state: NonNullable<RequeueUnknownState>; historyLink: boolean }) {
  const link = historyLink ? <Link prefetch={false} className="llm-link llm-retry-more" href={LLM_RETRY_HREF}>재실행 보기 →</Link> : null;
  if (!state.ok) return <span role="alert" className="llm-retry-error">{state.error}{link && <> {link}</>}</span>;
  return <span role="status" className={state.left ? "llm-retry-left" : "llm-retry-done"}>{requeueSummaryText(state)}{state.left > 0 && link && <> {link}</>}</span>;
}

/**
 * 「다시 대기열」 — 단계(route)의 결과 미확정 행 전부(최대 500건)를 그 단계의 작업 큐로 되돌리고, 다시 넣었거나 할 일이 이미 끝난 행만 운영자 검토로 닫는다.
 * 확인은 화면 안 두 단계다(window.confirm 을 쓰지 않는다): 단추 → 바뀌는 내용 한 줄 + 「확인」·「취소」.
 * routeId 가 빈 문자열이면 모든 단계다(지원하지 않는 단계의 행은 까닭과 함께 남는다). 기록 › 재실행 패널과 대시보드 「먼저 할 일」이 같은 단추를 쓴다
 * (할 일에서는 named 로 단계 이름을 붙이고 historyLink 로 남은 행이 있을 때 재실행 패널 링크를 붙인다).
 */
export function RequeueButton({ routeId, label, count, named = false, readOnly = false, historyLink = false }: { routeId: string; label: string; count: number;
  named?: boolean; readOnly?: boolean; historyLink?: boolean }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<RequeueUnknownState, FormData>(requeueUnknownReviews, null);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);
  if (readOnly) return <span className="llm-muted">읽기 전용</span>;
  // 「확인」을 누르면 확인 줄을 닫고 보낸다 — 결과 한 줄이 남고, 다시 누르면 처음부터 두 단계다
  const submit = (data: FormData) => { setConfirming(false); action(data); };
  return <form action={submit} className="llm-retry-form" data-confirming={confirming || undefined}>
    {routeId && <input type="hidden" name="routeId" value={routeId} />}
    {!confirming ? <button type="button" className="button small" onClick={() => setConfirming(true)} disabled={pending || count <= 0}>
      {pending ? "넣는 중…" : !routeId ? "지원 단계 모두 다시 대기열" : named ? `${label} 다시 대기열` : "다시 대기열"}</button>
      : <>
        <span className="llm-retry-preview">{label} 결과 미확정 {count.toLocaleString("ko-KR")}건을 다시 실행하고, 다시 넣었거나 할 일이 이미 끝난 행은 닫습니다.</span>
        <button type="submit" className="button small primary" disabled={pending}>{pending ? "넣는 중…" : "확인"}</button>
        <button type="button" className="button small" onClick={() => setConfirming(false)} disabled={pending}>취소</button>
      </>}
    {state && <RequeueResult state={state} historyLink={historyLink} />}
  </form>;
}

/**
 * LLM 운영(/admin/models/llm) 행의 상태 칸 — 「미확정 있음」 배지를 누르면 그 연결(장비 groupId) 또는 CLI 도구(provider)의 결과 미확정 행을
 * 그 자리에서 바로 다시 대기열에 넣는다(기록 화면으로 가지 않는다 · 같은 서버 동작 requeueUnknownReviews, 같은 작업 로그).
 * 상태가 더 나쁜 신호(실패 등)라 배지가 「미확정 있음」이 아니면 배지는 그대로 두고 까닭 아래 작은 단추를 둔다.
 * 결과는 이 칸에 한 줄로 남고, 처리하지 못한 행이 있을 때만 기록 › 재실행 대기로 가는 링크를 붙인다.
 * badge 는 서버가 그린 상태 배지(LevelBadge)다. 새로 그려도 같은 자리라 결과 한 줄이 사라지지 않는다(미확정이 0건이 되어도).
 */
export function UnknownRequeueStatus({ badge, unknownBadge, count, groupId = null, provider = null, readOnly, children }: {
  badge: ReactNode; unknownBadge: boolean; count: number | null; groupId?: string | null; provider?: string | null; readOnly: boolean; children?: ReactNode }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<RequeueUnknownState, FormData>(requeueUnknownReviews, null);
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);
  const can = !readOnly && !!count && count > 0 && (!!groupId || !!provider);
  const hint = `누르면 결과 미확정 ${(count ?? 0).toLocaleString("ko-KR")}건을 바로 다시 대기열에 넣습니다(할 일이 이미 끝난 행은 닫음)`;
  if (!can && !state) return <>{badge}{children}</>;
  return <form action={action} className="llm-retry-inline">
    {groupId ? <input type="hidden" name="groupId" value={groupId} /> : provider ? <input type="hidden" name="provider" value={provider} /> : null}
    {can && unknownBadge ? <button type="submit" className="llm-level-button" disabled={pending} title={hint} aria-label={`미확정 있음 — ${hint}`}>{badge}</button> : badge}
    {pending && <span className="llm-muted" aria-live="polite">넣는 중…</span>}
    {children}
    {can && !unknownBadge && <button type="submit" className="button small" disabled={pending} title={hint}>미확정 {(count ?? 0).toLocaleString("ko-KR")}건 다시 넣기</button>}
    {state && <RequeueResult state={state} historyLink />}
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
