import Link from "next/link";
import {
  formatResultCount,
  HOME_FIRST_PAGE,
  HOME_PAGE_SIZE,
  hrefWith,
  type BrowseState,
} from "@/components/home/browse-state";
import { ProjectCardMarkup, type CardProduct } from "@/components/cards/markup";
import { SaveToggle } from "@/components/cards/SaveToggle";
import { SavedOnlyGrid } from "@/components/cards/SavedOnlyGrid";
import "./cards.css";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";

/**
 * 목록 격자 — 서버가 카드를 글자로 그린다(2026-11-14 공개 HTML 줄이기). 저장 단추만 브라우저 부품이다.
 * 저장 목록 보기(?saved=1)는 서버가 후보 카드를 그려 두고 브라우저가 저장한 것만 남긴다(SavedOnlyGrid).
 */
export function ProjectGrid({
  products,
  browseState,
  initialOnlySaved = false,
  totalCount,
  start = 0,
  approximate = false,
  now,
  locale,
  t,
  labels,
  priorityCount = 0,
  cardHeading = 3,
}: {
  products: CardProduct[];
  browseState: BrowseState;
  initialOnlySaved?: boolean;
  totalCount?: number;
  /** 화면이 앞에서 접은 항목 수 — products 는 그다음부터다(shownWindow) */
  start?: number;
  /** 전체 수가 관련도순 검색(섞은 수)이라 '약 n'으로 써야 하는지 — 결과 줄과 같은 표기(browse-state.ts) */
  approximate?: boolean;
  /** 서버가 그린 시각 — 카드의 'n일 전'·'새 프로젝트' */
  now: Date;
  locale: Locale;
  t: Translator<"browse">;
  labels: Translator<"labels">;
  /** 앞에서 몇 장의 커버를 먼저 받을지 — 이 목록이 화면 첫 그림일 때만(PERF-03). 기본 0(모두 늦게 받기) */
  priorityCount?: number;
  /** 카드 제목·빈 화면 제목의 단계 — 위 제목 다음 단계(A11Y-05) */
  cardHeading?: 2 | 3;
}) {
  const ctx = { locale, t: labels, now };
  const count = (n: number) => formatNumber(n, locale);
  const card = (product: CardProduct, index: number) => (
    <ProjectCardMarkup key={product.slug} product={product} ctx={ctx} priority={index < priorityCount} headingLevel={cardHeading}
      save={<SaveToggle slug={product.slug} name={product.name} />} />
  );

  if (initialOnlySaved) {
    return <SavedOnlyGrid slugs={products.map((product) => product.slug)} cards={products.map(card)}
      allHref={hrefWith(browseState, {}, locale)} cardHeading={cardHeading} />;
  }

  const limit = browseState.shown ?? HOME_FIRST_PAGE;
  const visible = products.slice(0, limit - start);
  const total = Math.max(start + products.length, totalCount ?? products.length);
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
        {visible.map(card)}
      </div>
      {limit < total && (
        <Link prefetch={false}
          className="more-btn"
          href={hrefWith(browseState, { shown: Math.min(limit + HOME_PAGE_SIZE, total) }, locale)}
          scroll={false}
        >
          {t("saved.more", { shown: count(start + visible.length), total: formatResultCount(total, approximate, locale, t) })}
        </Link>
      )}
    </>
  );
}
