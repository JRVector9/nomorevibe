"use client";

import Link from "next/link";
import { Fragment, useState, type ReactNode } from "react";
import { HOME_FIRST_PAGE, HOME_PAGE_SIZE } from "@/components/home/browse-state";
import { Icon } from "@/components/home/icons";
import { useSavedSlugs } from "@/components/home/useSavedSlugs";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";

/**
 * 저장 목록 보기(?saved=1) — 서버가 후보 카드를 그려 두고, 브라우저가 이 브라우저에 저장한 것만 남긴다.
 * 넘어오는 값은 카드 차례의 slug 들과 이미 그린 카드뿐이다(제품 값은 JSON 으로 싣지 않는다).
 */
export function SavedOnlyGrid({ slugs, cards, allHref, cardHeading = 3 }: {
  slugs: string[];
  cards: ReactNode[];
  /** '전체 목록 보기' — 지금 거르기 그대로 저장 보기만 푼 주소 */
  allHref: string;
  cardHeading?: 2 | 3;
}) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const count = (n: number) => formatNumber(n, locale);
  const [saved] = useSavedSlugs();
  const [limit, setLimit] = useState(HOME_FIRST_PAGE);
  const rows = slugs.map((slug, index) => ({ slug, card: cards[index] })).filter((row) => saved.has(row.slug));
  const visible = rows.slice(0, limit);
  const EmptyHeading = cardHeading === 2 ? "h2" : "h3";
  if (rows.length === 0) {
    return (
      <div className="projects-grid">
        <div className="empty-state">
          <Icon name="bookmark" size={29} />
          <EmptyHeading>{t("saved.empty")}</EmptyHeading>
          <p>{t("saved.hint")}</p>
          <Link prefetch={false} className="secondary" href={allHref}>{t("saved.all")}</Link>
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="saved-banner">
        {t("saved.banner", { count: count(rows.length) })}
        <Link prefetch={false} className="text-button" href={allHref}>{t("saved.full")}</Link>
      </div>
      <div className="projects-grid" id="project-grid" role="tabpanel" aria-label={t("home.projects")}>
        {visible.map((row) => <Fragment key={row.slug}>{row.card}</Fragment>)}
      </div>
      {limit < rows.length && (
        <button type="button" className="more-btn" onClick={() => setLimit((current) => current + HOME_PAGE_SIZE)}>
          {t("saved.more", { shown: count(visible.length), total: count(rows.length) })}
        </button>
      )}
    </>
  );
}
