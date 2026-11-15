"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ProductCardsResponse } from "@/app/api/product-cards/route";
import { HOME_FIRST_PAGE, HOME_PAGE_SIZE } from "@/components/home/browse-state";
import { Icon } from "@/components/home/icons";
import { useSavedSlugs } from "@/components/home/useSavedSlugs";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { MAX_SLUGS } from "./CardEnrich";
import { SkeletonCards } from "./LazyRest";
import { useMarkup } from "./markup-loader";
import { SaveToggle } from "./SaveToggle";

type Items = ProductCardsResponse["items"];

/** 저장한 slug 의 카드 — 60개씩 끊어 받는다(공개 목록 밖이 된 제품은 오지 않는다) */
async function loadSaved(slugs: string[], locale: string): Promise<Items | null> {
  const chunks: string[][] = [];
  for (let index = 0; index < slugs.length; index += MAX_SLUGS) chunks.push(slugs.slice(index, index + MAX_SLUGS));
  try {
    const parts = await Promise.all(chunks.map(async (chunk) => {
      const response = await fetch(`/api/product-cards?${new URLSearchParams({ slugs: chunk.join(","), full: "1", locale })}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(String(response.status));
      return (await response.json() as ProductCardsResponse).items;
    }));
    const found = new Map(parts.flat().map((item) => [item.slug, item]));
    return slugs.map((slug) => found.get(slug)).filter((item): item is Items[number] => Boolean(item));
  } catch {
    return null;
  }
}

/**
 * 저장 목록 보기(?saved=1, 2026-11-15 공개 HTML 이름·요약만) — 서버는 후보 카드를 그리지 않는다(후보 100장이 2쪽 너머의 목록이었다).
 * 이 브라우저에 저장한 slug 로 같은 출처 API(/api/product-cards?slugs=&full=1)에서 카드를 받아 그린다.
 */
export function SavedOnlyGrid({ allHref, cardHeading = 3 }: {
  /** '전체 목록 보기' — 지금 거르기 그대로 저장 보기만 푼 주소 */
  allHref: string;
  cardHeading?: 2 | 3;
}) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const labels = useTranslations("labels");
  const now = useServerNow();
  const count = (n: number) => formatNumber(n, locale);
  const [saved] = useSavedSlugs();
  const key = [...saved].join(",");
  const [state, setState] = useState<{ key: string; items: Items | null } | null>(null);
  const [limit, setLimit] = useState(HOME_FIRST_PAGE);
  useEffect(() => {
    let alive = true;
    const slugs = key ? key.split(",") : [];
    if (slugs.length === 0) { queueMicrotask(() => { if (alive) setState({ key, items: [] }); }); return () => { alive = false; }; }
    void loadSaved(slugs, locale).then((items) => { if (alive) setState({ key, items }); });
    return () => { alive = false; };
  }, [key, locale]);
  const markup = useMarkup();
  const rows = state?.key === key ? state.items : undefined;
  const EmptyHeading = cardHeading === 2 ? "h2" : "h3";
  if (rows === undefined || (rows?.length && !markup)) return <div className="projects-grid" aria-busy="true"><SkeletonCards count={Math.min(Math.max(saved.size, 3), HOME_FIRST_PAGE)} /></div>;
  if (!rows || rows.length === 0) {
    return (
      <div className="projects-grid">
        <div className="empty-state">
          <Icon name="bookmark" size={29} />
          <EmptyHeading>{t(rows ? "saved.empty" : "error.load")}</EmptyHeading>
          {rows && <p>{t("saved.hint")}</p>}
          <Link prefetch={false} className="secondary" href={allHref}>{t("saved.all")}</Link>
        </div>
      </div>
    );
  }
  if (!markup) return null;
  const visible = rows.slice(0, limit);
  const ctx = { locale, t: labels, now };
  return (
    <>
      <div className="saved-banner">
        {t("saved.banner", { count: count(rows.length) })}
        <Link prefetch={false} className="text-button" href={allHref}>{t("saved.full")}</Link>
      </div>
      <div className="projects-grid" id="project-grid" role="tabpanel" aria-label={t("home.projects")}>
        {visible.map((product) => <markup.ProjectCardMarkup key={product.slug} product={product} ctx={ctx} headingLevel={cardHeading}
          save={<SaveToggle slug={product.slug} name={product.name} />} />)}
      </div>
      {limit < rows.length && (
        <button type="button" className="more-btn" onClick={() => setLimit((current) => current + HOME_PAGE_SIZE)}>
          {t("saved.more", { shown: count(visible.length), total: count(rows.length) })}
        </button>
      )}
    </>
  );
}
