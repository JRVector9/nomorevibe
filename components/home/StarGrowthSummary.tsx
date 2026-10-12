import Link from "next/link";
import type { StarGrowthSnapshot } from "@/lib/domain/products/star-growth";
import { formatCount } from "@/lib/format/number";
import { formatPublicDateTime } from "@/lib/format/time";

export const STAR_GROWTH_TITLE = "최근 8시간 스타 급상승";

export function starGrowthNote(snapshot: StarGrowthSnapshot | null) {
  const policy = snapshot?.policy;
  return `스타 ${formatCount(policy?.minStars ?? 50)}~${formatCount((policy?.maxStarsExclusive ?? 2000) - 1)}개 · 직전 8시간 회차 대비 증가량순 · 8시간마다 갱신`;
}

const REASONS: Partial<Record<NonNullable<StarGrowthSnapshot["reason"]>, string>> = {
  "run-not-closed": "이번 회차 관측이 아직 마감되지 않아 집계가 지연되고 있습니다.",
  "run-failed": "이번 회차 관측에 실패해 순위를 만들 수 없습니다.",
  "missing-baseline": "8시간 전 회차의 비교 관측을 준비하고 있습니다. 두 회차가 확보되면 증가량순으로 보여드립니다.",
  "baseline-not-closed": "8시간 전 회차의 관측이 정상 마감되지 않아 비교할 수 없습니다.",
  "invalid-policy": "이번 회차의 집계 기준을 확인할 수 없습니다.",
  "invalid-cycle": "유효하지 않은 회차 주소입니다. 최신 회차를 다시 확인해 주세요.",
  "cycle-changed": "새 회차로 갱신되어 이 목록의 회차가 만료되었습니다.",
  "no-comparable-observations": "두 회차에서 비교 조건을 충족한 관측 자료가 없습니다.",
};

/** 홈과 모두 보기에서 동일한 회차 시각·관측 수·빈 결과 이유를 표시한다. */
export function StarGrowthSummary({ snapshot, now }: { snapshot: StarGrowthSnapshot | null; now: Date | string }) {
  if (!snapshot) return <p className="row-note" role="status">급상승 집계를 불러오지 못했습니다. 잠시 후 <Link prefetch={false} href="/rising">다시 확인해 주세요.</Link></p>;
  const countsKnown = snapshot.targetCount !== null && snapshot.successCount !== null && snapshot.failureCount !== null;
  const successRate = countsKnown && snapshot.targetCount! > 0 ? Math.round(snapshot.successCount! / snapshot.targetCount! * 100) : null;
  const expired = snapshot.reason === "cycle-changed" || snapshot.reason === "invalid-cycle";
  const message = snapshot.reason === "missing-run"
    ? snapshot.status === "warming" ? "두 회차의 비교 관측을 준비하고 있습니다. 자료가 쌓이면 증가량순으로 보여드립니다." : "이번 예정 회차의 관측 자료가 없어 집계가 지연되고 있습니다."
    : snapshot.reason === "below-threshold" ? `비교 가능한 관측 ${formatCount(snapshot.comparableCount)}개 중 최근 8시간 회차에 스타가 늘어난 프로젝트가 없습니다.`
      : snapshot.reason ? REASONS[snapshot.reason] : null;
  return (
    <>
      <p className="row-note">기준 회차 {formatPublicDateTime(snapshot.asOf, now)} KST · 다음 예정 {formatPublicDateTime(snapshot.nextCycle, now)} KST</p>
      <p className="row-note">{countsKnown
        ? <>관측 성공 {formatCount(snapshot.successCount!)} / 대상 {formatCount(snapshot.targetCount!)}{successRate !== null && ` (${successRate}%)`} · 실패 {formatCount(snapshot.failureCount!)}</>
        : "이번 회차의 관측 수를 아직 확인할 수 없습니다."}</p>
      {message && <p className="row-note" role="status">{message}{expired && <> <Link prefetch={false} href="/rising">최신 회차로 새로고침</Link></>}</p>}
    </>
  );
}
