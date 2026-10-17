"use client";

import { useLocale, useTranslations } from "@/lib/i18n/context";
import { translatedCategory } from "@/components/home/i18n";
import { localePath } from "@/lib/i18n/routing";
import { formatNumber } from "@/lib/i18n/format";
import { categoryHref } from "@/components/home/browse-state";
import { CompactRow } from "@/components/home/CompactRow";
import type { ProductListItem } from "@/lib/domain/products/view";

/**
 * 상세 끝 — 같은 분야에서 지금 뜨는. 홈의 가로 띠와 같은 부품.
 * '모두 보기'는 그 분야를 거른 홈의 기본 목록('추천' = 같은 급상승 순서)으로 가고, 숫자는 그 목록의 개수다.
 * 개수를 못 세면 숫자 없이 '모두 보기'.
 * 8시간 회차로 못 채운 줄(basis="category")은 그 기본 목록(AI로 제작·최근 등록순)의 앞부분이라 '지금 뜨는'이라 하지 않는다.
 */
export function RelatedRow({ category, items, total, basis = "growth" }: {
  category: string; items: ProductListItem[]; total: number | null; basis?: "growth" | "category";
}) {
  const t = useTranslations("detail");
  const locale = useLocale();
  const label = translatedCategory(category, useTranslations("labels"));
  const growth = basis === "growth";
  return (
    <CompactRow
      id="related"
      title={t(growth ? "related.title" : "related.otherTitle", { category: label })}
      note={t(growth ? "related.note" : "related.otherNote")}
      more={{
        href: localePath(locale, categoryHref(category)),
        label: total === null ? t("related.all") : t("related.count", { count: formatNumber(total, locale) }),
      }}
      items={items}
      trailing="category"
    />
  );
}
