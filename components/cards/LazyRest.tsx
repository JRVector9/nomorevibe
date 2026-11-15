"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { formatResultCount, type BrowseState } from "@/components/home/browse-state";
import { browseCountsQuery, useBrowseCounts } from "@/components/home/browse-counts";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { useCardList } from "./CardEnrich";
import { FillLine } from "./fill-line";
import { useMarkup } from "./markup-loader";
import { SaveToggle } from "./SaveToggle";

/**
 * 첫 쪽 뒤의 카드(2026-11-15 공개 HTML 이름·요약만, 문서 4장 결정 4) — 서버 HTML 에는 카드 없이 같은 크기의 빈 틀만 둔다.
 * 화면 JS 가 같은 출처 API(/api/product-cards?list=…)로 받아 그 자리에 다 그린 카드를 그린다. 못 받으면 틀을 거둔다.
 * 2쪽부터 서버 HTML 로 주면 분류·AI 거르기 목록을 쪽마다 넘겨 소속을 모을 수 있다 — 제품 발견은 사이트맵이 맡는다.
 */

/** 받는 동안의 카드 틀 — 첫 쪽 골격(FeedSkeleton)과 같은 모양 */
export function SkeletonCards({ count, compact = false }: { count: number; compact?: boolean }) {
  return Array.from({ length: count }, (_, index) => (
    <div key={index} className="skeleton-card" aria-hidden="true" style={compact ? { borderRadius: 16 } : undefined}>
      <div className="skeleton-visual" />
      <div className="skeleton-body"><div className="skeleton-line" /><div className="skeleton-line skeleton-short" /></div>
    </div>
  ));
}

/** 큰 카드 격자 안의 뒷카드 — fillFrom 은 list=home&… 같은 목록 주소 값 */
export function LazyProjectCards({ fillFrom, count, headingLevel = 3 }: { fillFrom: string; count: number; headingLevel?: 2 | 3 }) {
  const locale = useLocale();
  const t = useTranslations("labels");
  const now = useServerNow();
  const items = useCardList(fillFrom);
  const markup = useMarkup();
  if (items === undefined || (items && !markup)) return <SkeletonCards count={count} />;
  if (!items || !markup) return null;
  const ctx = { locale, t, now };
  return items.map((product) => (
    <markup.ProjectCardMarkup key={product.slug} product={product} ctx={ctx} headingLevel={headingLevel}
      save={<SaveToggle slug={product.slug} name={product.name} />} />
  ));
}

/** 작은 카드 격자 안의 뒷카드(/?new=1 2쪽부터) */
export function LazyCompactCardsGrid({ fillFrom, count, trailing, headingLevel = 3 }: { fillFrom: string; count: number; trailing: "category" | "listed"; headingLevel?: 2 | 3 }) {
  const locale = useLocale();
  const t = useTranslations("labels");
  const now = useServerNow();
  const items = useCardList(fillFrom);
  const markup = useMarkup();
  if (items === undefined || (items && !markup)) return <SkeletonCards count={count} compact />;
  if (!items || !markup) return null;
  return items.map((product) => <markup.CompactCardMarkup key={product.slug} product={product} ctx={{ locale, t, now }} trailing={trailing} headingLevel={headingLevel} />);
}

/**
 * 홈·분야 '더 보기' — 전체 수(분류별 수)는 서버 HTML 에 싣지 않고 /api/browse-counts 로 받는다.
 * 검색 결과 수는 질의마다 결과라 서버가 준다(searchTotal).
 */
export function MoreLink({ href, shown, state, searchTotal, approximate = false, children }: {
  href: string; shown: number; state: BrowseState; searchTotal?: number; approximate?: boolean; children?: ReactNode;
}) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const remote = useBrowseCounts(searchTotal === undefined ? browseCountsQuery(state) : null);
  const total = searchTotal ?? remote?.resultCount;
  // 수를 받기 전에는 그 자리만 글자 없는 자리로 — 문구의 다른 부분은 그대로
  const [before, after = ""] = t("saved.more", { shown: formatNumber(shown, locale), total: "\u0000" }).split("\u0000");
  const label = total === undefined ? <>{before}<FillLine width="3em" />{after}</>
    : t("saved.more", { shown: formatNumber(shown, locale), total: formatResultCount(total, approximate, locale, t) });
  return <Link prefetch={false} className="more-btn" href={href} scroll={false}>{label}{children}</Link>;
}
