import type { StarGrowthItem } from "@/lib/domain/products/star-growth";
import { formatCount } from "@/lib/format/number";
import { formatDetailTime } from "@/lib/format/time";

/** 직전 8시간 회차 대비 증가량을 먼저, 총 스타 수를 보조로 표시한다. */
export function StarGrowthMetric({ value }: { value: StarGrowthItem["starGrowth"] }) {
  const detail = `최근 8시간 회차 대비 스타 +${formatCount(value.gain)}개 · 총 ${formatCount(value.stars)}개 · ${formatDetailTime(value.baselineObservedAt)} (${formatCount(value.baselineStars)}개) → ${formatDetailTime(value.observedAt)} (${formatCount(value.stars)}개)`;
  return (
    <span className="star-metric star-growth-metric" tabIndex={0} role="img" title={detail} aria-label={detail} style={{ position: "relative", zIndex: 1 }}>
      <strong className="star-change-up" aria-hidden="true">8시간 +{formatCount(value.gain)}</strong>
      <small aria-hidden="true">★ {formatCount(value.stars)}</small>
    </span>
  );
}
