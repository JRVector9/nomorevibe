import { englishLang } from "@/lib/i18n/content-language";
import type { Locale } from "@/lib/i18n/locales";
import type { ProductTranslationSelection } from "./translation-policy";

/**
 * 공개 화면의 서버 HTML·RSC 데이터에 실어도 되는 제품 값(2026-11-15 사람 결정) — 주소(slug)·이름·요약(그 언어의 한 줄 소개)뿐이다.
 * 기준 문서: docs/tasks/2026-11-15-public-html-name-summary.md 1·2·4장.
 *
 * 서버 부품이 브라우저 부품에 넘기는 제품 값은 이 타입만 쓴다. 나머지 칸(@소유자·분류·스타·배지·표지·꼬리표·README·주소…)은
 * 같은 출처 API(/api/product-cards·/api/products/[slug]/details)로만 주고 화면 JS 가 채운다(components/cards/CardEnrich.tsx).
 * 모든 요청(봇 포함)에 같은 HTML 을 준다 — 검증된 봇에게도 더 주지 않는다.
 */
export type PublicTeaser = {
  slug: string;
  name: string;
  /** 서버가 그 언어로 고른 한 줄 — 고르는 규칙은 TaglineView(components/cards/views.tsx)와 같다 */
  summary: string;
  /** 요약 글의 언어(lang 속성) — 모르면 없다 */
  lang?: string;
};

/** 요약을 고를 때 읽는 칸 — 목록 행·상세 행·화제 행 어느 것이든 */
export type TeaserSource = {
  slug: string;
  name: string;
  tagline: string;
  taglineKo?: string | null;
  translation?: Pick<ProductTranslationSelection, "text" | "lang"> | null;
};

/** 그 언어의 한 줄 — 한국어는 taglineKo(없으면 원문), 다른 언어는 고른 번역(없으면 원문) */
export function teaserSummary(product: Omit<TeaserSource, "slug" | "name">, locale: Locale): { summary: string; lang?: string } {
  if (locale === "ko") {
    const korean = product.taglineKo?.trim() || null;
    return korean ? { summary: korean, lang: "ko" } : { summary: product.tagline, lang: englishLang(product.tagline) };
  }
  const translated = product.translation?.text;
  return translated ? { summary: translated, lang: product.translation?.lang } : { summary: product.tagline, lang: englishLang(product.tagline) };
}

/** 제품 행에서 공개 HTML 에 실을 세 값만 꺼낸다 — 나머지 칸은 결과에 없다(새 객체) */
export function publicTeaser(product: TeaserSource, locale: Locale): PublicTeaser {
  const { summary, lang } = teaserSummary(product, locale);
  return lang ? { slug: product.slug, name: product.name, summary, lang } : { slug: product.slug, name: product.name, summary };
}
