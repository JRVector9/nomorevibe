import Link from "next/link";
import {
  HOME_FIRST_PAGE,
  HOME_PAGE_SIZE,
  hrefWith,
  type BrowseState,
} from "@/components/home/browse-state";
import { LazyProjectCards, MoreLink } from "@/components/cards/LazyRest";
import { SavedOnlyGrid } from "@/components/cards/SavedOnlyGrid";
import { TeaserProjectCard } from "@/components/cards/TeaserCards";
import type { PublicTeaser } from "@/lib/domain/products/public-teaser";
import "./cards.css";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";

/**
 * 목록 격자(2026-11-15 공개 HTML 이름·요약만, 문서 4.1·4.2) — 서버 HTML 에는 첫 쪽(HOME_FIRST_PAGE) 카드의 이름·요약·링크만 둔다.
 * 카드의 나머지 칸은 화면 JS 가 /api/product-cards?slugs= 로 한 번에 채운다(CardEnrich). 더 보기(?shown=)로 늘린 첫 쪽 뒤 카드는
 * 서버 HTML 에 없고 같은 목록 API(rest.source)로 받는다 — 그 주소는 noindex,follow 다(page.tsx generateMetadata).
 * 검색 결과는 질의마다 결과라 늘린 카드도 서버가 이름·요약으로 그린다(rest 없음).
 * 저장 목록 보기(?saved=1)는 서버가 후보를 그리지 않는다 — 브라우저가 저장한 slug 로 카드를 받는다(SavedOnlyGrid).
 */
export function ProjectGrid({
  teasers,
  rest,
  browseState,
  initialOnlySaved = false,
  totalCount,
  searchTotal,
  start = 0,
  approximate = false,
  locale,
  t,
  priorityCount = 0,
  cardHeading = 3,
}: {
  /** 서버가 이름·요약으로 그리는 카드 — 화면 차례 그대로 */
  teasers: PublicTeaser[];
  /** 서버 HTML 에 없는 뒷카드 — 목록 API 주소 값과 장 수 */
  rest?: { source: string; count: number } | null;
  browseState: BrowseState;
  initialOnlySaved?: boolean;
  /** 지금 목록의 전체 수 — 더 보기를 둘지 정한다(수 자체는 화면에 싣지 않는다) */
  totalCount: number;
  /** 검색 결과 수 — 검색 화면만 서버가 더 보기 글에 적는다. 나머지는 API 로 받는다 */
  searchTotal?: number;
  /** 화면이 앞에서 접은 항목 수(shownWindow) */
  start?: number;
  approximate?: boolean;
  locale: Locale;
  t: Translator<"browse">;
  labels?: Translator<"labels">;
  /** 앞에서 몇 장의 커버를 먼저 받을지 — 이 목록이 화면 첫 그림일 때만(PERF-03). 기본 0(모두 늦게 받기) */
  priorityCount?: number;
  /** 카드 제목·빈 화면 제목의 단계 — 위 제목 다음 단계(A11Y-05) */
  cardHeading?: 2 | 3;
}) {
  const count = (n: number) => formatNumber(n, locale);

  if (initialOnlySaved) {
    return <SavedOnlyGrid allHref={hrefWith(browseState, {}, locale)} cardHeading={cardHeading} />;
  }

  const limit = browseState.shown ?? HOME_FIRST_PAGE;
  const shown = start + teasers.length + (rest?.count ?? 0);
  return (
    <>
      {start > 0 && (
        <div className="saved-banner">
          {t("saved.folded", { count: count(start) })}
          <Link prefetch={false} className="text-button" href={hrefWith(browseState, { shown: undefined }, locale)}>
            {t("saved.first")}
          </Link>
        </div>
      )}
      <div className="projects-grid" id="project-grid" role="tabpanel" aria-label={t("home.projects")}>
        {teasers.map((teaser, index) => (
          <TeaserProjectCard key={teaser.slug} teaser={teaser} priority={index < priorityCount} headingLevel={cardHeading} />
        ))}
        {rest && rest.count > 0 && <LazyProjectCards source={rest.source} count={rest.count} headingLevel={cardHeading} />}
      </div>
      {limit < totalCount && (
        <MoreLink href={hrefWith(browseState, { shown: Math.min(limit + HOME_PAGE_SIZE, totalCount) }, locale)}
          shown={shown} state={browseState} searchTotal={searchTotal} approximate={approximate} />
      )}
    </>
  );
}
