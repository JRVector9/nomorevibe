"use client";

import Link from "next/link";
import { ProductIcon } from "@/components/ProductIcon";
import { FillLine } from "@/components/cards/fill-line";
import { useCardList } from "@/components/cards/CardEnrich";
import type { PublicTeaser } from "@/lib/domain/products/public-teaser";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import { translatedCategory } from "./i18n";

/** 활발한 목록의 채울 값 — 상품 카드 API(list=active)가 준다 */
export type ActiveFill = { slug: string; category: string; stars: number | null; ogImage: string | null; releases: number };

/**
 * 이번 주 가장 활발한 다섯(2026-11-15 공개 HTML 이름·요약만) — 서버 HTML 에는 차례·이름·링크만, 아이콘·분야·스타·새 버전 수는
 * 화면 JS 가 /api/product-cards?list=active 로 받아 채운다. 받는 동안은 같은 크기의 빈 자리, 못 받으면 빈 자리를 거둔다.
 */
export function ActiveRows({ rows }: { rows: Pick<PublicTeaser, "slug" | "name">[] }) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const labels = useTranslations("labels");
  const count = (n: number) => formatNumber(n, locale);
  const items = useCardList("list=active") as ActiveFill[] | null | undefined;
  const fills = new Map((items ?? []).map((item) => [item.slug, item]));
  return (
    <ol className="rank-list" aria-busy={items === undefined || undefined}>
      {rows.map((row, index) => {
        const fill = fills.get(row.slug);
        return (
          <li key={row.slug} className="rank-row">
            <span className="rank-no">{index + 1}</span>
            {fill ? <ProductIcon name={row.name} ogImage={fill.ogImage} size={28} category={fill.category} />
              : <span aria-hidden="true" style={{ width: 28, height: 28, background: "var(--bg-soft)" }} />}
            <span className="rank-name">
              <Link prefetch={false} href={localePath(locale, `/p/${row.slug}`)}>{row.name}</Link>
              <small>{fill ? `${translatedCategory(fill.category, labels)}${fill.stars !== null && fill.stars >= 100 ? ` · ★ ${count(fill.stars)}` : ""}`
                : items === undefined ? <FillLine width="7em" /> : null}</small>
            </span>
            <b className="rank-value">{fill ? t("count.releases", { count: count(fill.releases) }) : items === undefined ? <FillLine width="3em" /> : null}</b>
          </li>
        );
      })}
    </ol>
  );
}
