import { ProjectCardMarkup, type CardProduct } from "@/components/cards/markup";
import { SaveToggle } from "@/components/cards/SaveToggle";
import type { Labels } from "@/components/cards/views";
import type { Locale } from "@/lib/i18n/locales";
import "./cards.css";

/**
 * 자리가 붙은 카드 격자 — 발견하기 카드 마크업을 그대로 쓰고 제목 앞에 순위를 단다. 서버가 글자로 그린다(저장 단추만 브라우저).
 * 홈 '많이 쓰이는 프로젝트'(구간마다 상위 3)·/popular·/rising 카드 보기가 함께 쓴다.
 */
export function RankedCards({ items, now, locale, t, headingLevel = 3 }: {
  items: (CardProduct & { rank: number })[];
  now: Date | string;
  locale: Locale;
  t: Labels;
  headingLevel?: 2 | 3;
}) {
  const ctx = { locale, t, now };
  return (
    <div className="projects-grid">
      {items.map((product) => (
        <ProjectCardMarkup key={product.slug} product={product} rank={product.rank} ctx={ctx} headingLevel={headingLevel}
          save={<SaveToggle slug={product.slug} name={product.name} />} />
      ))}
    </div>
  );
}
