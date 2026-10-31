"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { CapacityReviewItem, CapacityReviewQueue } from "@/lib/operations/model-capacity-unknowns";
import { kstClock, modelStageLabel } from "@/lib/operations/admin-models-view";
import { buttonSmall } from "../settings/Switch";
import { closeUnknownReview, type UnknownReviewState } from "./unknown-review-actions";

const REASON: Readonly<Record<string, string>> = { client_timeout: "기한 초과(client_timeout)", local_abort: "중단(aborted)", transport_unknown: "전송 뒤 결과 모름(transport_unknown)",
  process_exit: "프로세스 종료(process_exit)", commit_unknown: "정산 commit 모름(commit_unknown)" };
/** 사유별 근거 설명 — 엔진이 아직 생성 중일 수 있는지, 재시도를 막는지. 운영자가 메모를 쓰기 전에 보는 한 줄. */
const GROUND: Readonly<Record<string, string>> = {
  client_timeout: "클라이언트 기한 뒤 응답 없음 · mlx-lm 은 취소 없음 → 엔진이 아직 생성 중일 수 있음",
  transport_unknown: "전송 뒤 소켓이 끊김 · 서버 종료 기록은 별도 확인 · 같은 작업 키 재시도는 막지 않음",
  local_abort: "로컬에서 호출을 중단함 · 엔진이 끝까지 생성했을 수 있음", process_exit: "워커 프로세스가 끝나 결과를 받지 못함",
  commit_unknown: "정산 commit 결과를 모름 · 장부와 업무 기록을 대조" };
const stamp = (value: string | null) => value ? kstClock(value) : "—";

function ReviewRow({ item }: { item: CapacityReviewItem }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<UnknownReviewState, FormData>(closeUnknownReview, null);
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);
  return <li id={`rv-${item.requestId}`} className={`flex flex-col gap-1.5 rounded-md border border-line bg-bg-soft px-2.5 py-2 text-[13px] scroll-mt-28 md:scroll-mt-16 ${state?.ok ? "border-dashed opacity-60" : ""}`}>
    <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
      <code title={item.requestId}>{item.requestId.slice(0, 8)}</code><b className="font-semibold">{modelStageLabel(item.routeId)}</b><span className="font-mono text-fg-2">{item.routeId}</span>
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

/** '확인 못함 — 사람 검토' 목록(2열의 오른쪽). 이 행들은 슬롯을 점유하지 않는다(2026-10-30); 검토 완료는 행을 withdrawn 으로 닫고 감사 기록을 남긴다. 표의 「미확인」 수가 #rv-<requestId> 로 온다. */
export function UnknownReviewList({ queue }: { queue: CapacityReviewQueue }) {
  return <section id="review" className="min-w-0 rounded-xl border border-line bg-bg-card scroll-mt-28 md:scroll-mt-16" aria-labelledby="unknown-review-heading">
    <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1.5 border-b border-line px-3 py-2.5">
      <h2 id="unknown-review-heading" className="text-[15px] font-semibold">확인 못함 · 사람 검토 <span className="font-mono tabular-nums">{queue.items.length}{queue.truncated ? "+" : ""}</span>건</h2>
      <p className="min-w-0 flex-[1_1_240px] text-[13px] text-fg-2">결과를 못 받은 호출(기한 초과·중단·전송 뒤 결과 모름). 슬롯을 점유하지 않음. 「검토 완료」는 withdrawn 으로 닫고 감사 기록을 남김.</p>
    </div>
    {queue.error && <p role="alert" className="px-3 py-2 text-[13px] text-down">검토 목록을 읽지 못했습니다 · {queue.error}</p>}
    {!queue.error && !queue.items.length && <p className="px-3 py-3 text-[13px] text-fg-2">검토할 미확인 호출이 없습니다.</p>}
    {queue.items.length > 0 && <ul className="flex flex-col gap-2 p-3">{queue.items.map(item => <ReviewRow key={item.requestId} item={item} />)}</ul>}
  </section>;
}
