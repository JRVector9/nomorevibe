"use client";

import { CompactCardMarkup } from "@/components/cards/markup";
import { useLocale, useTranslations, useServerNow } from "@/lib/i18n/context";
import type { CompactCardItem } from "./compact-item";
import "./cards.css";

/** 가로 띠의 작은 카드 — 브라우저 부품판(상세 '같은 분야' 띠). 서버 화면은 CompactCardMarkup 을 바로 쓴다 */
export function CompactCard({ product, trailing, priority = false, headingLevel = 3 }: {
  product: CompactCardItem;
  trailing: "category" | "listed";
  priority?: boolean;
  headingLevel?: 2 | 3;
}) {
  const ctx = { locale: useLocale(), t: useTranslations("labels"), now: useServerNow() };
  return <CompactCardMarkup product={product} trailing={trailing} ctx={ctx} priority={priority} headingLevel={headingLevel} />;
}
