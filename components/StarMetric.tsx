"use client";

import type { StarObservation } from '@/lib/domain/products/star-change';
import { useLocale, useTranslations, useServerNow } from '@/lib/i18n/context';
import type { TimeInput } from '@/lib/format/time';
import { StarMetricView } from '@/components/cards/views';

/**
 * 스타 수와 직전 확인 대비 증감(components/cards/views.tsx StarMetricView). now 는 서버가 읽은 시각을 넘긴다(없으면 지금).
 */
export function StarMetric({ value, now, listedAt }: { value: StarObservation; now?: Date | string | number; listedAt?: TimeInput }) {
  const serverNow = useServerNow();
  return <StarMetricView value={value} now={now ?? serverNow} listedAt={listedAt} locale={useLocale()} t={useTranslations("labels")} />;
}
