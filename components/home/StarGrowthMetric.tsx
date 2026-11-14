"use client";

import type { StarGrowthItem } from "@/lib/domain/products/star-growth";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { StarGrowthView } from "@/components/cards/views";

/** 직전 8시간 회차 대비 증가량을 먼저, 총 스타 수를 보조로 표시한다. */
export function StarGrowthMetric({ value }: { value: StarGrowthItem["starGrowth"] }) {
  return <StarGrowthView value={value} locale={useLocale()} t={useTranslations("labels")} />;
}
