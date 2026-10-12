import type { StarGrowthItem } from "@/lib/domain/products/star-growth";
import { formatCount } from "@/lib/format/number";
import { formatDetailTime } from "@/lib/format/time";

/** 회차에 고정된 스타와 전일 동시간대 관측 대비 순증가. 일반 카드의 일평균 지표와 구별한다. */
export function StarGrowthMetric({ value }: { value: StarGrowthItem["starGrowth"] }) {
  const detail = `GitHub 스타 ${formatCount(value.stars)}개 · 전일 동시간대 관측 대비 +${formatCount(value.gain)}개 · ${formatDetailTime(value.baselineObservedAt)} (${formatCount(value.baselineStars)}개) → ${formatDetailTime(value.observedAt)} (${formatCount(value.stars)}개)`;
  return (
    <span className="star-metric" tabIndex={0} role="img" title={detail} aria-label={detail} style={{ position: "relative", zIndex: 1 }}>
      <span aria-hidden="true">★ {formatCount(value.stars)}</span>
      <small className="star-change-up" aria-hidden="true">+{formatCount(value.gain)}</small>
    </span>
  );
}
