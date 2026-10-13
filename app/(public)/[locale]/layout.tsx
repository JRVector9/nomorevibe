import type { Metadata } from "next";
import { BRAND } from "@/lib/copy/brand";
import { DEFAULT_SHARE_IMAGE } from "@/lib/copy/share";
import { siteOrigin } from "@/lib/site";
import { notFound } from "next/navigation";
import { I18nProvider } from "@/lib/i18n/context";
import { getDictionary } from "@/lib/i18n/dictionary";
import { isLocale, LOCALE_CONFIG } from "@/lib/i18n/locales";
import { createTranslator } from "@/lib/i18n/messages";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = createTranslator("common", await getDictionary(locale, "common"));
  return {
    /**
     * 제목 틀(title.template)은 두지 않는다 — 화면마다 pageTitle(lib/copy/brand.ts)로 완성된 제목을 넘긴다.
     * 틀을 두면 이미 브랜드를 붙여 쓰는 관리자 화면 제목에 브랜드가 두 번 붙는다.
     */
    title: `${BRAND} — ${t("site.tagline")}`,
    // 약속은 실제와 맞춘다(UX-05) — 예전 "우리가 직접 확인한 것만 보여줍니다"는 찾아 올린 목록과 어긋났다(lib/copy/share.ts)
    description: t("site.description"),
    /** 공유 미리보기의 상대 주소(그림 등)를 절대 주소로 — robots.ts·sitemap.ts 와 같은 siteOrigin() */
    metadataBase: new URL(siteOrigin()),
    /** 공유 미리보기 기본값 — 사이트 이름·한국어·기본 그림(SEO-01·UX-07). 제품 상세는 제 그림과 소개로 바꾼다 */
    openGraph: { siteName: BRAND, locale: LOCALE_CONFIG[locale].openGraph, type: "website", images: [{ ...DEFAULT_SHARE_IMAGE, alt: `${BRAND} — ${t("site.tagline")}` }] },
    twitter: { card: "summary_large_image", images: [DEFAULT_SHARE_IMAGE.url] },
    /** 피드 리더가 /feed.xml을 스스로 찾게 한다 — 주소를 알려주지 않으면 있어도 없는 것이다 */
    alternates: {
      types: { "application/rss+xml": `${siteOrigin()}/feed.xml` },
    },
  };
}

/** Validate the URL locale and pass only selected shared namespaces to clients. */
export default async function PublicLocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const [common, labels] = await Promise.all([getDictionary(locale, "common"), getDictionary(locale, "labels")]);
  return <I18nProvider locale={locale} dictionaries={{ common, labels }} now={new Date().toISOString()}>{children}</I18nProvider>;
}
