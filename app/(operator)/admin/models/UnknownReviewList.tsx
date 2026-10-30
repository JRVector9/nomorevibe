"use client";
import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { CapacityReviewItem, CapacityReviewQueue } from "@/lib/operations/model-capacity-unknowns";
import { modelStageLabel } from "@/lib/operations/admin-models-view";
import { buttonSmall } from "../settings/Switch";
import { closeUnknownReview, type UnknownReviewState } from "./unknown-review-actions";

const REASON: Readonly<Record<string, string>> = { client_timeout: "기한 초과(client_timeout)", local_abort: "중단(aborted)", transport_unknown: "전송 뒤 결과 모름",
  process_exit: "프로세스 종료", commit_unknown: "정산 commit 모름" };
const stamp = (value: string | null) => value ? value.replace("T", " ").replace(/\.\d{3}Z$/, "Z") : "—";

function ReviewRow({ item }: { item: CapacityReviewItem }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<UnknownReviewState, FormData>(closeUnknownReview, null);
  useEffect(() => { if (state?.ok) router.refresh(); }, [state, router]);
  return <li className="flex flex-col gap-2 rounded-lg border border-line bg-bg-soft p-3 text-[13px]">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <strong>{modelStageLabel(item.routeId)}</strong><span className="text-fg-2">{item.routeId}</span>
      <span>{item.provider} · {item.model}</span><span className="text-fg-2">[{item.groupId} / {item.providerBudgetId}]</span>
      <span className="rounded bg-bg-hover px-2 py-0.5 font-semibold">{item.reason ? REASON[item.reason] ?? item.reason : "사유 기록 없음"}</span>
      {item.oldPolicy && <span className="text-fg-2">옛 정책 세대</span>}
      {item.localEndRecorded && <span className="text-fg-2">로컬 종료 기록 있음</span>}
    </div>
    <p className="break-all text-fg-2">작업 키 {item.workKey}{item.logicalWorkKey && item.logicalWorkKey !== item.workKey ? ` · 논리 키 ${item.logicalWorkKey}` : ""} · owner {item.ownerInstanceId}</p>
    <p className="text-fg-2">전송 {stamp(item.dispatchedAt)} · 미확인 처리 {stamp(item.markedAt)} · 요청 {item.requestId}</p>
    <form action={action} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="requestId" value={item.requestId} />
      <input name="note" required maxLength={400} placeholder="검토 메모(엔진 상태·조치)" className="min-w-[16rem] flex-1 rounded border border-line bg-bg-card px-2 py-1" disabled={pending || state?.ok === true} />
      <button type="submit" className={buttonSmall} disabled={pending || state?.ok === true}>{state?.ok ? "검토 완료됨" : pending ? "기록 중…" : "검토 완료"}</button>
      {state && !state.ok && <span role="alert" className="text-down">{state.error}</span>}
    </form>
  </li>;
}

/** '확인 못함 — 사람 검토' 목록. 이 행들은 슬롯을 점유하지 않는다(2026-10-30); 검토 완료는 행을 withdrawn 으로 닫고 감사 기록을 남긴다. */
export function UnknownReviewList({ queue }: { queue: CapacityReviewQueue }) {
  return <section className="flex flex-col gap-3 rounded-xl border border-line bg-bg-card p-5" aria-labelledby="unknown-review-heading">
    <h2 id="unknown-review-heading" className="text-[18px] font-semibold">확인 못함 — 사람 검토 {queue.items.length}{queue.truncated ? "+" : ""}건</h2>
    <p className="text-[13px] text-fg-2">결과를 확인하지 못한 모델 호출입니다(기한 초과·중단·전송 뒤 결과 모름). 슬롯을 점유하지 않고 다른 작업·같은 작업의 재시도·정책 변경을 막지 않습니다.
      엔진은 클라이언트 기한 뒤에도 응답을 만들고 있을 수 있습니다(mlx-lm 취소 없음·vLLM 은 연결 끊김에 취소). 검토 뒤 「검토 완료」로 닫으면 withdrawn 으로 남고 감사 기록이 남습니다.</p>
    {queue.error && <p role="alert" className="text-[13px] text-down">검토 목록을 읽지 못했습니다 · {queue.error}</p>}
    {!queue.error && !queue.items.length && <p className="text-[13px] text-fg-2">검토할 미확인 호출이 없습니다.</p>}
    {queue.items.length > 0 && <ul className="flex flex-col gap-2">{queue.items.map(item => <ReviewRow key={item.requestId} item={item} />)}</ul>}
  </section>;
}
