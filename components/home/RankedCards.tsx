import { TeaserProjectCard } from "@/components/cards/TeaserCards";
import type { PublicTeaser } from "@/lib/domain/products/public-teaser";
import type { ReactNode } from "react";
import "./cards.css";

/** 순위 목록의 한 칸 — 서버는 차례와 이름·요약만 안다(2026-11-15 공개 HTML 이름·요약만) */
export type RankedTeaser = { teaser: PublicTeaser; rank: number };

/**
 * 자리가 붙은 카드 격자 — 발견하기 카드 모양에 제목 앞 순위를 단다. 서버 HTML 에는 이름·요약·링크만 있고
 * 나머지 칸은 그 목록의 API(fillFrom)를 한 번 받아 채운다(TeaserProjectCard). /popular·/rising 카드 보기가 함께 쓴다.
 */
export function RankedCards({ items, fillFrom, headingLevel = 3, rest }: {
  items: RankedTeaser[];
  /** 목록 API 주소 값(예: list=popular-page&…&from=0) — 증가·순위 줄 같은 목록 맥락 값까지 채운다 */
  fillFrom: string;
  headingLevel?: 2 | 3;
  /** 서버가 그리지 않은 뒷칸의 자리(LazyPopularRest) — 같은 격자 안 마지막에 */
  rest?: ReactNode;
}) {
  return (
    <div className="projects-grid">
      {items.map(({ teaser, rank }) => <TeaserProjectCard key={teaser.slug} teaser={teaser} fillFrom={fillFrom} rank={rank} headingLevel={headingLevel} />)}
      {rest}
    </div>
  );
}
