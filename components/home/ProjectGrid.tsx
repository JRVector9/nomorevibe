"use client";

import Link from "next/link";
import { useMemo, useState, useSyncExternalStore } from "react";
import {
  formatResultCount,
  HOME_FIRST_PAGE,
  HOME_PAGE_SIZE,
  hrefWith,
  type BrowseState,
} from "@/components/home/browse-state";
import { Icon } from "@/components/home/icons";
import { ProjectCard } from "@/components/home/ProjectCard";
import { parseSaved, savedSnapshot, subscribeSaved, toggleSaved } from "@/components/home/saved";
import type { HomeCardProduct } from "@/components/home/types";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";


export function ProjectGrid({
  products,
  browseState,
  initialOnlySaved = false,
  totalCount,
  start = 0,
  approximate = false,
  now,
  priorityCount = 0,
  cardHeading = 3,
}: {
  products: HomeCardProduct[];
  browseState: BrowseState;
  initialOnlySaved?: boolean;
  totalCount?: number;
  /** 화면이 앞에서 접은 항목 수 — products 는 그다음부터다(shownWindow) */
  start?: number;
  /** 전체 수가 관련도순 검색(섞은 수)이라 '약 n'으로 써야 하는지 — 결과 줄과 같은 표기(browse-state.ts) */
  approximate?: boolean;
  /** 서버가 그린 시각(ISO) — 카드의 'n일 전'·'새 프로젝트'가 서버와 브라우저에서 같은 글자를 낸다 */
  now?: string;
  /** 앞에서 몇 장의 커버를 먼저 받을지 — 이 목록이 화면 첫 그림일 때만(PERF-03). 기본 0(모두 늦게 받기) */
  priorityCount?: number;
  /** 카드 제목·빈 화면 제목의 단계 — 위 제목 다음 단계(A11Y-05) */
  cardHeading?: 2 | 3;
}) {
  const locale = useLocale();
  const t = useTranslations("browse");
  const count = (n: number) => formatNumber(n, locale);
  const raw = useSyncExternalStore(subscribeSaved, savedSnapshot, () => "[]");
  const saved = useMemo(() => parseSaved(raw), [raw]);
  const onlySaved = initialOnlySaved;
  const [localLimit, setLocalLimit] = useState(HOME_FIRST_PAGE);
  const limit = onlySaved ? localLimit : (browseState.shown ?? HOME_FIRST_PAGE);

  function toggleSave(slug: string) {
    toggleSaved(slug, !saved.has(slug));
  }

  const rows = onlySaved ? products.filter((product) => saved.has(product.slug)) : products;
  const visible = rows.slice(0, limit - start);
  const total = onlySaved ? rows.length : Math.max(start + rows.length, totalCount ?? rows.length);

  const EmptyHeading = cardHeading === 2 ? "h2" : "h3";
  if (rows.length === 0) {
    return (
      <div className="projects-grid">
        <div className="empty-state">
          <Icon name="bookmark" size={29} />
          <EmptyHeading>{t("saved.empty")}</EmptyHeading>
          <p>{t("saved.hint")}</p>
          <Link prefetch={false} className="secondary" href={hrefWith(browseState, {}, locale)}>
            {t("saved.all")}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      {onlySaved && (
        <div className="saved-banner">
          {t("saved.banner", { count: count(rows.length) })}
          <Link prefetch={false} className="text-button" href={hrefWith(browseState, {}, locale)}>
            {t("saved.full")}
          </Link>
        </div>
      )}
      {start > 0 && (
        <div className="saved-banner">
          {t("saved.folded", { count: count(start) })}
          <Link prefetch={false} className="text-button" href={hrefWith(browseState, { shown: undefined }, locale)}>
            {t("saved.first")}
          </Link>
        </div>
      )}
      <div className="projects-grid" id="project-grid" role="tabpanel" aria-label={t("home.projects")}>
        {visible.map((product, index) => (
          <ProjectCard
            key={product.slug}
            priority={index < priorityCount}
            headingLevel={cardHeading}
            product={product}
            saved={saved.has(product.slug)}
            onToggleSave={toggleSave}
            browseState={browseState}
            now={now}
          />
        ))}
      </div>
      {limit < total && (
        onlySaved ? (
          <button type="button" className="more-btn" onClick={() => setLocalLimit((current) => current + HOME_PAGE_SIZE)}>
            {t("saved.more", { shown: count(visible.length), total: count(total) })}
          </button>
        ) : (
          <Link prefetch={false}
            className="more-btn"
            href={hrefWith(browseState, { shown: Math.min(limit + HOME_PAGE_SIZE, total) }, locale)}
            scroll={false}
          >
            {t("saved.more", { shown: count(start + visible.length), total: formatResultCount(total, approximate, locale, t) })}
          </Link>
        )
      )}
    </>
  );
}
