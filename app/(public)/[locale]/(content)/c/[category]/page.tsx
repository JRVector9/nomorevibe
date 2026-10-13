import { getRequestLocale } from "@/lib/i18n/server";
import { getTranslator,getDictionary } from "@/lib/i18n/dictionary";
import { I18nProvider } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { canonicalAlternates, HomeScreen, type HomeParams } from "@/app/(public)/[locale]/(content)/page";
import { browseTitle, categoryRedirect, categorySlug, parseCategory } from "@/components/home/browse-state";
import { pageTitle } from "@/lib/copy/brand";
import { translatedCategory } from "@/components/home/i18n";
import type { Locale } from "@/lib/i18n/locales";
import type { Translator } from "@/lib/i18n/messages";
import { hiddenByDefault } from "@/lib/domain/products/visibility";
import { CategoryLinks } from "./CategoryLinks";

export const dynamic = "force-dynamic";

/**
 * 분야 화면 — /c/finance 가 정식 주소다(2026-10-08 UX 감사 UX-40, 계약 C4). 홈과 같은 목록을 그 분야로 거른다.
 *
 * - 대문자가 섞이면(/c/Finance) 소문자 주소로 보낸다. 옛 주소 /?category=… 도 홈이 여기로 보낸다.
 * - 모르는 분야는 '없는 분야입니다'(not-found.tsx).
 * - 기본 목록에서 빼는 분야(개인 프로필, 계약 C3)는 목록 대신 왜 없는지 말한다 — 검색에 싣지 않는다(noindex).
 * - 분야 안 검색(?q=)은 홈 검색처럼 색인하지 않고, 정렬·거르기 같은 보기 조건이 붙은 주소는 /c/<분야>를 정식 주소로 둔다(SEO-04).
 */
type Props = {
  params: Promise<{ category: string }>;
  searchParams: Promise<HomeParams>;
};

const queryOf = (params: HomeParams) => {
  const value = Array.isArray(params.q) ? params.q[0] : params.q;
  return value?.trim().slice(0, 200) || undefined;
};

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const locale=await getRequestLocale();
  const [t,labels]=await Promise.all([getTranslator(locale,"browse"),getTranslator(locale,"labels")]);
  const [{ category: raw }, search] = await Promise.all([params, searchParams]);
  const category = parseCategory(raw);
  if (!category) return { title: pageTitle(t("category.missing")), robots: { index: false, follow: true } };
  if (hiddenByDefault(category)) return { title: pageTitle(t("home.categoryTitle", {category:translatedCategory(category,labels)})), robots: { index: false, follow: true } };
  const query = queryOf(search);
  if (query) return { title: browseTitle({query,category},locale,t,labels), robots: { index: false, follow: true } };
  return { title: browseTitle({category},locale,t,labels), alternates: canonicalAlternates(localePath(locale,`/c/${categorySlug(category)}`)) };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const locale=await getRequestLocale();
  const [t,labels,dictionary]=await Promise.all([getTranslator(locale,"browse"),getTranslator(locale,"labels"),getDictionary(locale,"browse")]);
  const [{ category: raw }, search] = await Promise.all([params, searchParams]);
  const category = parseCategory(raw);
  if (!category) notFound();
  // 정식 주소는 소문자 하나 — 나머지 조건은 그대로 붙여 보낸다(홈의 옛 주소와 같은 규칙)
  if (raw !== categorySlug(category)) redirect(categoryRedirect({ ...search, category },locale) ?? localePath(locale,`/c/${categorySlug(category)}`));
  if (hiddenByDefault(category)) return <I18nProvider locale={locale} dictionaries={{browse:dictionary}}><HiddenCategory locale={locale} t={t} label={translatedCategory(category,labels)} /></I18nProvider>;
  return HomeScreen({ params: { ...search, category } });
}

/** 기본 목록에서 뺀 분야 — 지운 것이 아니라 본인이 등록·확인한 것만 보인다(운영자 결정 D2) */
function HiddenCategory({label,locale,t}:{label:string;locale:Locale;t:Translator<"browse">}) {
  return (
    <main className="wrap">
      <section className="feed" aria-labelledby="category-hidden-title">
        <div className="empty-state">
          <h1 id="category-hidden-title" className="row-title">{t("category.hidden", {category:label})}</h1>
          <p>
            {t("category.hiddenHint")}{" "}
            <Link prefetch={false} href={localePath(locale,"/policy#excluded")}>{t("nav.listingPolicy")}</Link>
          </p>
          <CategoryLinks />
          <Link prefetch={false} href={localePath(locale,"/")} className="secondary">{t("nav.home")}</Link>
        </div>
      </section>
    </main>
  );
}
