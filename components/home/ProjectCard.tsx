"use client";

import { ProjectCardMarkup, SaveButtonMarkup, type CardProduct } from "@/components/cards/markup";
import type { BrowseState } from "@/components/home/browse-state";
import { useLocale, useTranslations, useServerNow } from "@/lib/i18n/context";
import "./cards.css";

/**
 * 홈 카드의 브라우저 부품판 — 마이페이지 저장 탭·내 프로젝트처럼 브라우저가 받은 값으로 그릴 때 쓴다.
 * 공개 목록은 서버가 같은 마크업(components/cards/markup.tsx ProjectCardMarkup)으로 그린다.
 */
export function ProjectCard({ product, saved, onToggleSave, now, priority = false, headingLevel = 3, rank, children }: {
  product: CardProduct;
  saved: boolean;
  onToggleSave: (slug: string) => void;
  browseState?: BrowseState;
  /** 서버가 읽은 시각 — 넘기면 서버와 브라우저가 같은 'n일 전'을 그린다. 없으면 지금 */
  now?: Date | string | number;
  priority?: boolean;
  headingLevel?: 2 | 3;
  rank?: number;
  /** 메타 줄 아래 한 줄 — 마이페이지 저장 탭의 써봤는지·저장한 날 */
  children?: React.ReactNode;
}) {
  const serverNow = useServerNow();
  const locale = useLocale();
  const t = useTranslations("labels");
  return (
    <ProjectCardMarkup product={product} ctx={{ locale, t, now: now ?? serverNow }} priority={priority} headingLevel={headingLevel} rank={rank}
      save={<SaveButtonMarkup slug={product.slug} name={product.name} saved={saved} onClick={() => onToggleSave(product.slug)} t={t} />}>
      {children}
    </ProjectCardMarkup>
  );
}
