"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { CapacityReviewItem, CapacityReviewQueue } from "@/lib/operations/model-capacity-unknowns";
import { kstClock, modelStageLabel } from "@/lib/operations/admin-models-view";
import { buttonSmall } from "../settings/Switch";
import { closeUnknownReview, requeueUnknownReviews, type RequeueUnknownState, type UnknownReviewState } from "./unknown-review-actions";

const REASON: Readonly<Record<string, string>> = { client_timeout: "기한 초과(client_timeout)", local_abort: "중단(aborted)", transport_unknown: "전송 뒤 결과 모름(transport_unknown)",
  process_exit: "프로세스 종료(process_exit)", commit_unknown: "정산 commit 모름(commit_unknown)" };
/** 사유별 근거 설명 — 엔진이 아직 생성 중일 수 있는지, 재시도를 막는지. 운영자가 메모를 쓰기 전에 보는 한 줄. */
const GROUND: Readonly<Record<string, string>> = {
  client_timeout: "클라이언트 기한 뒤 응답 없음 · mlx-lm 은 취소 없음 → 엔진이 아직 생성 중일 수 있음",
  transport_unknown: "전송 뒤 소켓이 끊김 · 서버 종료 기록은 별도 확인 · 같은 작업 키 재시도는 막지 않음",
  local_abort: "로컬에서 호출을 중단함 · 엔진이 끝까지 생성했을 수 있음", process_exit: "워커 프로세스가 끝나 결과를 받지 못함",
  commit_unknown: "정산 commit 결과를 모름 · 장부와 업무 기록을 대조" };
const stamp = (value: string | null) => value ? kstClock(value) : "—";

/** 서버의 지원 목록(lib/operations/model-capacity-requeue.ts HANDLERS)과 같게 유지한다 — 버튼을 숨길지 정하는 표시용 사본. */
const REQUEUE_SUPPORTED = new Set(["crawl-publish-classify", "crawl-agent-review", "local-held-qwen", "second-review",
  "product-search-profile", "product-translate", "reason-translate"]);
const ROUTE_LABEL: Readonly<Record<string, string>> = {
  "crawl-publish-classify": "발행 분류", "crawl-agent-review": "1차 검수", "local-held-qwen": "보류 Qwen 재검사",
  "second-review": "2차 검수", "product-search-profile": "검색 프로필", "product-translate": "제품 번역",
  "reason-translate": "사유 번역", "product-tagline-ko": "한국어 태그라인", "search-query-translate": "검색어 번역",
  "crawl-tagline": "태그라인", "product-intro-check": "소개 검수",
};
const routeLabel = (routeId: string) => ROUTE_LABEL[routeId] ?? modelStageLabel(routeId);

function RequeueGroup({ routeId, count }: { routeId: string; count: number }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<RequeueUnknownState, FormData>(requeueUnknownReviews, null);
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);
  const supported = REQUEUE_SUPPORTED.has(routeId);
  const label = routeId ? routeLabel(routeId) : "지원하는 단계 모두";
  return <form action={action} className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-bg-soft px-2.5 py-2 text-[13px]">
    {routeId && <input type="hidden" name="routeId" value={routeId} />}
    <span className="font-semibold">{label}</span>
    <span className="font-mono tabular-nums text-fg-2">{count}건</span>
    {supported ? <button type="submit" className={buttonSmall} disabled={pending || state?.ok === true}
      onClick={event => { if (!window.confirm(`${label} ${count}건을 다시 대기열에 넣을까요?\n\n작업은 다시 실행되고, 이 확인 못함 행은 운영자 검토로 닫힙니다.`)) event.preventDefault(); }}>
      {state?.ok ? "다시 넣음" : pending ? "넣는 중…" : "다시 대기열에 넣기"}
    </button> : <span className="text-fg-3">아직 지원하지 않는 단계</span>}
    {state?.ok && <span className="font-semibold text-up">작업 재요청 · 행 {state.closed}건 닫음</span>}
    {state && !state.ok && <span role="alert" className="text-down">{state.error}</span>}
  </form>;
}

function ReviewRow({ item }: { item: CapacityReviewItem }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<UnknownReviewState, FormData>(closeUnknownReview, null);
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);
  return <li id={`rv-${item.requestId}`} className={`flex flex-col gap-1.5 rounded-md border border-line bg-bg-soft px-2.5 py-2 text-[13px] scroll-mt-28 md:scroll-mt-16 ${state?.ok ? "border-dashed opacity-60" : ""}`}>
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <code title={item.requestId}>{item.requestId.slice(0, 8)}</code><b className="font-semibold">{routeLabel(item.routeId)}</b><span className="font-mono text-fg-2">{item.routeId}</span>
      <span className="rounded bg-warn/10 px-1.5 font-semibold text-warn">{item.reason ? REASON[item.reason] ?? item.reason : "사유 기록 없음"}</span>
      {item.oldPolicy && <span className="text-fg-2">옛 정책 세대</span>}
    </div>
    <p className="break-all text-fg-2">{item.provider} · {item.model} · [{item.groupId} / {item.providerBudgetId}] · 전송 <span className="font-mono tabular-nums">{stamp(item.dispatchedAt)}</span> · 미확인 처리 <span className="font-mono tabular-nums">{stamp(item.markedAt)}</span> KST{item.localEndRecorded ? " · 로컬 종료 기록 있음" : ""}</p>
    <p className="text-fg-2">근거: {item.reason ? GROUND[item.reason] ?? "사유 코드만 기록됨" : "사유 기록 없음 — 장부 이벤트를 확인"} · owner {item.ownerInstanceId}</p>
    <p className="break-all text-fg-2">작업 키 {item.workKey}{item.logicalWorkKey && item.logicalWorkKey !== item.workKey ? ` · 논리 키 ${item.logicalWorkKey}` : ""}</p>
    <form action={action} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="requestId" value={item.requestId} />
      <label className="sr-only" htmlFor={`note-${item.requestId}`}>검토 메모</label>
      <input id={`note-${item.requestId}`} name="note" required maxLength={400} placeholder="검토 메모(엔진 상태·조치)" className="min-w-0 flex-[1_1_180px] rounded-md border border-line bg-bg-card px-2 py-1 text-[13px] text-fg" disabled={pending || state?.ok === true} />
      <button type="submit" className={buttonSmall} disabled={pending || state?.ok === true}>{state?.ok ? "검토 완료됨" : pending ? "기록 중…" : "검토 완료"}</button>
      {state?.ok && <span className="font-semibold text-up">withdrawn 으로 닫음 · 감사 기록</span>}
      {state && !state.ok && <span role="alert" className="text-down">{state.error}</span>}
    </form>
  </li>;
}

/**
 * '확인 못함 — 사람 검토' 목록. 슬롯을 점유하지 않는 indeterminate 행이다(2026-10-30).
 * 「다시 대기열에 넣기」는 단계별 실제 작업 큐를 되돌리고, 성공한 행만 운영자 검토로 닫는다(2026-11-07).
 * 개별 「검토 완료」는 작업을 다시 넣지 않고 장부 행만 닫는다 — 엔진 상태를 사람이 확인했을 때 쓴다.
 */
export function UnknownReviewList({ queue }: { queue: CapacityReviewQueue }) {
  const groups = queue.groups.length ? queue.groups : [...queue.items.reduce((map, item) => {
    map.set(item.routeId, (map.get(item.routeId) ?? 0) + 1); return map;
  }, new Map<string, number>())].map(([routeId, count]) => ({ routeId, count }));
  const total = groups.reduce((sum, group) => sum + group.count, 0);
  const supported = groups.filter(group => REQUEUE_SUPPORTED.has(group.routeId));
  return <section id="review" className="min-w-0 rounded-xl border border-line bg-bg-card scroll-mt-28 md:scroll-mt-16" aria-labelledby="unknown-review-heading">
    <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5 border-b border-line px-3 py-2.5">
      <h2 id="unknown-review-heading" className="text-[15px] font-semibold">확인 못함 · 사람 검토 <span className="font-mono tabular-nums">{total}</span>건</h2>
      <p className="min-w-0 flex-[1_1_240px] text-[13px] text-fg-2">결과를 못 받은 호출. 슬롯을 점유하지 않음. 「다시 대기열에 넣기」는 그 단계의 작업을 다시 실행하고 성공한 행만 닫습니다. 「검토 완료」는 작업을 다시 넣지 않고 행만 닫습니다.</p>
    </div>
    {queue.error && <p role="alert" className="px-3 py-2 text-[13px] text-down">검토 목록을 읽지 못했습니다 · {queue.error}</p>}
    {!queue.error && total === 0 && <p className="px-3 py-3 text-[13px] text-fg-2">검토할 미확인 호출이 없습니다.</p>}
    {total > 0 && <div className="flex flex-col gap-2 border-b border-line px-3 py-3">
      <p className="text-[13px] font-semibold text-fg-2">다시 대기열에 넣기</p>
      <div className="flex flex-wrap gap-2">{groups.map(group => <RequeueGroup key={group.routeId} routeId={group.routeId} count={group.count} />)}</div>
      {supported.length > 1 && <RequeueGroup routeId="" count={supported.reduce((sum, group) => sum + group.count, 0)} />}
      {queue.truncated && <p className="text-[13px] text-fg-2">목록은 오래된 100건만 표시합니다. 버튼은 이 단계의 전체 미확인 행(최대 500건)에 적용됩니다.</p>}
    </div>}
    {queue.items.length > 0 && <ul className="flex flex-col gap-2 p-3">{queue.items.map(item => <ReviewRow key={item.requestId} item={item} />)}</ul>}
  </section>;
}
