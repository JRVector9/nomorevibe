"use client";

import type { PublicTeaser } from "@/lib/domain/products/public-teaser";
import { useLocale, useServerNow, useTranslations } from "@/lib/i18n/context";
import { useCardFill } from "./CardEnrich";
import { CompactCardMarkup, PopularRowMarkup, ProjectCardMarkup } from "./markup";
import { SaveToggle } from "./SaveToggle";
import { CompactCardTeaser, PopularRowTeaser, ProjectCardTeaser } from "./teaser-markup";

/**
 * 서버가 이름·요약만 넘긴 카드(2026-11-15 공개 HTML 이름·요약만) — 서버 HTML·RSC 데이터에는 teaser(slug·이름·요약)만 실린다.
 * 화면이 열린 뒤 같은 출처 API 로 나머지 칸을 받아(CardEnrich) 다 그린 카드(markup.tsx)로 바꾼다. 받는 동안은 같은 크기의 빈 자리.
 * fillFrom: 목록 맥락 값(8시간 증가·순위 줄)을 그 목록 API 로 채울 때만(예: "list=rising").
 */
type Common = { teaser: PublicTeaser; fillFrom?: string; priority?: boolean; headingLevel?: 2 | 3 };

function useCtx() {
  return { locale: useLocale(), t: useTranslations("labels"), now: useServerNow() };
}

export function TeaserProjectCard({ teaser, fillFrom, priority = false, headingLevel = 3, rank }: Common & { rank?: number }) {
  const ctx = useCtx();
  const fill = useCardFill(teaser.slug, fillFrom);
  const save = <SaveToggle slug={teaser.slug} name={teaser.name} />;
  if (fill) return <ProjectCardMarkup product={{ ...fill, slug: teaser.slug, name: teaser.name }} ctx={ctx} save={save} priority={priority} headingLevel={headingLevel} rank={rank} />;
  return <ProjectCardTeaser teaser={teaser} ctx={ctx} save={save} pending={fill === undefined} headingLevel={headingLevel} rank={rank} />;
}

export function TeaserCompactCard({ teaser, fillFrom, priority = false, headingLevel = 3, trailing }: Common & { trailing: "category" | "listed" }) {
  const ctx = useCtx();
  const fill = useCardFill(teaser.slug, fillFrom);
  if (fill) return <CompactCardMarkup product={{ ...fill, slug: teaser.slug, name: teaser.name }} ctx={ctx} trailing={trailing} priority={priority} headingLevel={headingLevel} />;
  return <CompactCardTeaser teaser={teaser} ctx={ctx} pending={fill === undefined} headingLevel={headingLevel} />;
}

export function TeaserPopularRow({ teaser, fillFrom, rank }: Common & { rank: number }) {
  const ctx = useCtx();
  const fill = useCardFill(teaser.slug, fillFrom);
  const save = <SaveToggle slug={teaser.slug} name={teaser.name} />;
  if (fill) return <PopularRowMarkup product={{ ...fill, slug: teaser.slug, name: teaser.name }} rank={rank} ctx={ctx} save={save} />;
  return <PopularRowTeaser teaser={teaser} rank={rank} ctx={ctx} save={save} pending={fill === undefined} />;
}
