import Link from "next/link";
import { categoryHref } from "@/components/home/browse-state";
import { CATEGORIES } from "@/lib/domain/products/categories";
import { translatedCategory } from "@/components/home/i18n";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { hiddenByDefault } from "@/lib/domain/products/visibility";

/**
 * 고를 수 있는 분야 전부 — 기본 목록에서 빼는 분야(계약 C3)는 없다. 개수를 세지 않는 자리(없는 분야 안내)에 쓴다.
 * 서버 부품이다(2026-11-14) — 없는 분야 화면은 모든 분야 화면의 RSC 데이터에 404 경계로 실려, 목록 사전 전체(약 26KB)를 브라우저로 넘기지 않게 한다.
 */
export function CategoryLinks({ locale, t, labels }: { locale: Locale; t: Translator<"browse">; labels: Translator<"labels"> }) {
  return (
    <nav className="empty-suggest" aria-label={t("filter.category")}>
      <h4>{t("empty.categoryIdeas")}</h4>
      <ul className="chips">
        {CATEGORIES.filter((category) => !hiddenByDefault(category)).map((category) => (
          <li key={category}><Link prefetch={false} href={categoryHref(category,{},locale)} className="chip">{translatedCategory(category,labels)}</Link></li>
        ))}
      </ul>
    </nav>
  );
}
