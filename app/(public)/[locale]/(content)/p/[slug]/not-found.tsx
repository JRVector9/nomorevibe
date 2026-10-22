import { getTranslator } from "@/lib/i18n/dictionary";
import { getRequestLocale } from "@/lib/i18n/server";
import { localePath } from "@/lib/i18n/routing";
import Link from "next/link";
import { TrackOnMount } from "@/components/analytics/TrackOnMount";

/**
 * 상세가 없을 때 — 없는 주소이거나 내려간 프로젝트(차단·내려달라는 요청)다(2026-10-08 UX 감사 UX-10).
 * 영어 기본 404 대신 그럴 수 있는 까닭과 다음 걸음(검색·홈)을 준다. 사이트 전체의 404 는 app/not-found.tsx 다.
 */
export default async function ProductNotFound() {
  const locale = await getRequestLocale();
  const [t, common] = await Promise.all([getTranslator(locale, "detail"), getTranslator(locale, "common")]);
  return (
    <main className="wrap" data-track-page-type="not_found">
      <TrackOnMount name="app_error" params={{ error_code: "product_not_found", page_type: "not_found" }} />
      {/* 위아래 여백은 안쪽에 — .wrap 의 padding 이 바깥 여백 유틸리티를 덮는다(app/home.css) */}
      <section aria-labelledby="not-found-title" className="mx-auto flex max-w-[560px] flex-col gap-3 pb-14 pt-16">
        <h1 id="not-found-title" className="text-[28px] font-semibold leading-[1.2] tracking-[-0.02em] text-fg">{t("notFound.title")}</h1>
        <p className="text-[15px] leading-[1.6] text-fg-2">
          {t("notFound.description")}
        </p>
        <form action={localePath(locale, "/")} method="get" role="search" className="mt-2 flex gap-2">
          <label htmlFor="not-found-search" className="sr-only">{common("search.label")}</label>
          <input id="not-found-search" type="search" name="q" maxLength={200} autoComplete="off" placeholder={common("search.placeholder")}
            className="min-h-11 min-w-0 flex-1 rounded-full border border-line bg-bg-card px-4 text-[15px] text-fg outline-none focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" />
          <button type="submit" className="min-h-11 shrink-0 rounded-full bg-accent-solid px-5 text-[14px] font-medium text-white hover:opacity-90">{common("navigation.search")}</button>
        </form>
        <Link prefetch={false} href={localePath(locale, "/")} className="inline-flex min-h-11 items-center self-start text-[14px] text-accent-ink hover:underline">{common("navigation.homeLink")} ›</Link>
      </section>
    </main>
  );
}
