import Link from "next/link";
import type { StarGrowthPage, StarGrowthSnapshot } from "@/lib/domain/products/star-growth";
import { formatDetailTime } from "@/lib/format/time";
import { jobHref } from "./action-links";

const STATUS = { ready: "자료 준비됨", warming: "비교 자료 준비 중", late: "관측 확인 필요", "no-results": "급상승 0건" };
const RUN = { preparing: "대상 준비 중", collecting: "수집 중 · 아직 닫히지 않음", closed: "마감 완료", failed: "마감 실패" };
const REASON: Record<NonNullable<StarGrowthSnapshot["reason"]>, string> = {
  "missing-run": "마감 회차가 없습니다.", "run-not-closed": "마감 회차가 아직 닫히지 않았습니다.",
  "run-failed": "마감 회차가 실패했습니다.", "missing-baseline": "직전 8시간 회차가 없습니다.",
  "baseline-not-closed": "직전 8시간 회차가 닫히지 않았습니다.", "invalid-policy": "관측 정책을 읽을 수 없습니다.",
  "invalid-cycle": "마감 시각이 유효하지 않습니다.", "cycle-changed": "기준 마감이 바뀌었습니다.",
  "no-comparable-observations": "동일 저장소로 비교 가능한 관측이 없습니다.",
  "below-threshold": "비교 가능한 관측은 있지만 공개 급상승 기준을 만족한 제품이 없습니다.",
  "filtered-out": "조건을 만족한 제품이 현재 공개 목록 필터에서 제외됐습니다.",
};
const count = (value: number | null) => value === null ? "미확인" : value.toLocaleString("ko-KR");

export function StarObservationCard({ page }: { page: StarGrowthPage | null }) {
  if (!page) return <section className="ops-panel" aria-label="8시간 스타 관측"><h2>8시간 스타 관측</h2><p>관측 자료를 읽지 못했습니다. 급상승 0건을 뜻하지 않습니다.</p></section>;
  const snapshot = page.snapshot, baseline = snapshot.baseline;
  return <section className="ops-panel" aria-label="8시간 스타 관측">
    <div className="ops-row"><h2>8시간 스타 관측</h2><span className="ops-badge">{STATUS[snapshot.status]}</span></div>
    <p>한국 시간 00·08·16시 마감 T와 직전 T−8h의 닫힌 자료를 비교합니다. 홈·급상승 목록과 같은 reader·기준입니다.</p>
    {snapshot.reason && <p className="mt-2 text-[14px] text-fg-2">{REASON[snapshot.reason]}</p>}
    <dl className="ops-facts mt-3">
      <div><dt>현재 마감 T</dt><dd>{formatDetailTime(snapshot.asOf)} · {snapshot.runStatus ? RUN[snapshot.runStatus] : "회차 미확인"}</dd></div>
      <div><dt>T 대상 / 성공 / 실패</dt><dd>{count(snapshot.targetCount)} / {count(snapshot.successCount)} / {count(snapshot.failureCount)}</dd></div>
      <div><dt>T 실제 관측 범위</dt><dd>{formatDetailTime(snapshot.firstObservedAt, "없음")} ~ {formatDetailTime(snapshot.lastObservedAt, "없음")}</dd></div>
      <div><dt>T 마감 완료 기록</dt><dd>{formatDetailTime(snapshot.closedAt, "없음")}</dd></div>
      <div><dt>직전 T−8h</dt><dd>{formatDetailTime(snapshot.baselineAsOf)} · {baseline ? RUN[baseline.status] : "회차 없음"}</dd></div>
      <div><dt>T−8h 대상 / 성공 / 실패</dt><dd>{baseline ? `${count(baseline.targetCount)} / ${count(baseline.successCount)} / ${count(baseline.failureCount)}` : "미확인"}</dd></div>
      <div><dt>T−8h 마감 완료 기록</dt><dd>{formatDetailTime(baseline?.closedAt, "없음")}</dd></div>
      <div><dt>비교 가능 / 공개 급상승</dt><dd>{snapshot.status === "ready" || snapshot.status === "no-results" ? `${count(snapshot.comparableCount)} / ${count(page.total)}` : "미집계 · 닫힌 두 회차가 필요합니다"}</dd></div>
      <div><dt>다음 마감</dt><dd>{formatDetailTime(snapshot.nextCycle)}</dd></div>
    </dl>
    <p className="mt-2 text-[13px] text-fg-3">작업의 마지막 성공은 유휴·재개 회차일 수 있습니다. 성공 관측 수가 대상 수와 같아도 수집 중인 회차는 마감 완료가 아닙니다. 닫힌 회차를 다시 수집하지 않습니다.</p>
    <div className="mt-3 flex gap-4 text-[13px]"><Link className="underline" href={jobHref("product-star-observation")}>관측 작업 상태</Link><Link className="underline" href="/rising">공개 급상승 목록</Link></div>
  </section>;
}
