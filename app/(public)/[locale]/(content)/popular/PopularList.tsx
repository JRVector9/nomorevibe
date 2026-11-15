import { TeaserPopularRow } from "@/components/cards/TeaserCards";
import type { RankedTeaser } from "@/components/home/RankedCards";
import type { ReactNode } from "react";
import "@/components/home/cards.css";

/**
 * /popular·/rising 목록 보기 — 서버 HTML 에는 차례·이름·요약·링크만(2026-11-15 공개 HTML 이름·요약만).
 * 커버·@소유자·분야·스타와 증감은 그 목록의 API(source)를 한 번 받아 채운다. 좁은 화면은 커버를 줄이고 순위를 커버 위 숫자로 옮긴다(popular.css).
 */
export function PopularList({ items, source, rest }: {
  items: RankedTeaser[];
  source: string;
  /** 서버가 그리지 않은 뒷줄의 자리(LazyPopularRest) — 같은 목록 안 마지막에 */
  rest?: ReactNode;
}) {
  return (
    <ol className="popular-list">
      {items.map(({ teaser, rank }) => <TeaserPopularRow key={teaser.slug} teaser={teaser} source={source} rank={rank} />)}
      {rest}
    </ol>
  );
}
