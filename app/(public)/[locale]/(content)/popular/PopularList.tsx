import { PopularRowMarkup, type CardProduct } from "@/components/cards/markup";
import { SaveToggle } from "@/components/cards/SaveToggle";
import type { Labels } from "@/components/cards/views";
import type { Locale } from "@/lib/i18n/locales";
import "@/components/home/cards.css";

/**
 * /popular·/rising 목록 보기 — 서버가 줄을 글자로 그린다(2026-11-14 공개 HTML 줄이기). 저장 단추만 브라우저 부품이다.
 * 좁은 화면은 커버를 줄이고 순위를 커버 위 숫자로 옮긴다(popular.css).
 */
export function PopularList({ items, now, locale, t }: { items: (CardProduct & { rank: number })[]; now: Date | string; locale: Locale; t: Labels }) {
  const ctx = { locale, t, now };
  return (
    <ol className="popular-list">
      {items.map((product) => (
        <PopularRowMarkup key={product.slug} product={product} rank={product.rank} ctx={ctx} save={<SaveToggle slug={product.slug} name={product.name} />} />
      ))}
    </ol>
  );
}
