"use client";

import { useLocale, useTranslations } from "@/lib/i18n/context";
import type { ProductActivity } from "@/lib/domain/products/activity";
import { ActivityView } from "@/components/cards/views";

/** 카드 메타 줄의 활동(components/cards/views.tsx ActivityView) — 브라우저 부품용 */
export function ProductActivityRow({ activity, now }: { activity?: ProductActivity; now: Date | string | number }) {
  return <ActivityView activity={activity} now={now} locale={useLocale()} t={useTranslations("labels")} />;
}
