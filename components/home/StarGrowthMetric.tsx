"use client";

import type { StarGrowthItem } from "@/lib/domain/products/star-growth";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber, formatDateTime } from "@/lib/i18n/format";

/** 직전 8시간 회차 대비 증가량을 먼저, 총 스타 수를 보조로 표시한다. */
export function StarGrowthMetric({ value }: { value: StarGrowthItem["starGrowth"] }) {
  const locale = useLocale();
  const t = useTranslations("labels");
  const count = (n: number) => formatNumber(n, locale);
  const detail = t("stars.growthDetail", { gain: count(value.gain), stars: count(value.stars), before: formatDateTime(value.baselineObservedAt, value.observedAt, locale), baseline: count(value.baselineStars), after: formatDateTime(value.observedAt, value.observedAt, locale) });
  return (
    <span className="star-metric star-growth-metric" tabIndex={0} role="img" title={detail} aria-label={detail} style={{ position: "relative", zIndex: 1 }}>
      <strong className="star-change-up" aria-hidden="true">{t("stars.growth8h", { count: count(value.gain) })}</strong>
      <small aria-hidden="true">★ {count(value.stars)}</small>
    </span>
  );
}
