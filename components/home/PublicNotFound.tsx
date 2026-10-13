import type { Locale } from "@/lib/i18n/locales";
import Link from "next/link";
import { connection } from "next/server";
import { CompactRow } from "@/components/home/CompactRow";
import { pageTitle } from "@/lib/copy/brand";
import type { ProductListItem } from "@/lib/domain/products/view";
import { getStarGrowthPage } from "@/lib/domain/products/star-growth";
import { logger } from "@/lib/observability/logger";
import { getTranslator } from "@/lib/i18n/dictionary";
import { localePath } from "@/lib/i18n/routing";
import { localizeProductList } from "@/lib/i18n/products";

/**
 * 없는 주소 — Next 기본 영어 404 대신 길을 낸다(2026-10-08 UX 감사 UX-10).
 *
 * 검색창, 지금 뜨는 프로젝트 다섯, 홈 링크. 내려간 프로젝트 주소로 들어온 사람도 여기로 온다(상세 전용 안내는 the product route’s not-found.tsx).
 * 404 응답에는 Next 가 noindex 를 붙인다.
 */

/** 홈 '지금 뜨는' 띠와 같은 목록·같은 담기 열쇠(the shared home page) — 없는 주소가 몰려도 DB 를 더 부르지 않는다 */
const RISING_COUNT = 5;

async function risingProjects(): Promise<ProductListItem[]> {
  try {
    return (await getStarGrowthPage({ limit: RISING_COUNT })).items;
  } catch (error) {
    // 목록을 못 읽어도 안내와 검색창은 선다
    logger.warn("not_found.rising_unavailable", { error });
    return [];
  }
}

export async function PublicNotFound({ locale }: { locale: Locale }) {
  // 빌드 때 굳히지 않는다 — 그때는 DB 가 없어 빈 목록이 박히고, 헤더(검색어를 읽는다)가 브라우저에서야 그려진다
  await connection();
  const t = await getTranslator(locale, "common");
  const rising = await localizeProductList(await risingProjects(), locale);

  return (
    // 위아래 여백은 안쪽 상자에 — .wrap(app/home.css)이 레이어 밖 규칙이라 main 의 padding 유틸리티를 덮는다(error·global-error 도 같다)
    <main className="wrap">
      <div className="pb-16 pt-12">
        <title>{pageTitle(t("notFound.title"))}</title>
        <h1 className="text-[26px] font-semibold tracking-tight">{t("notFound.heading")}</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-fg-2">
          {t("notFound.description")}
        </p>
        <form action={localePath(locale, "/")} method="get" role="search" className="mt-6 flex max-w-[560px] gap-2">
          <label htmlFor="not-found-search" className="sr-only">{t("search.label")}</label>
          <input
            id="not-found-search"
            type="search"
            name="q"
            placeholder={t("search.placeholder")}
            autoComplete="off"
            maxLength={200}
            className="h-11 min-w-0 flex-1 rounded-full bg-bg-soft px-5 text-[15px] text-fg placeholder:text-fg-2"
          />
          <button type="submit" className="h-11 shrink-0 rounded-full bg-fg px-5 text-[15px] font-medium text-bg-card hover:opacity-90">
            {t("navigation.search")}
          </button>
        </form>
        <p className="mt-4 text-[14px]">
          <Link prefetch={false} href={localePath(locale, "/")} className="inline-flex min-h-11 items-center font-medium text-accent-ink underline underline-offset-4">
            {t("navigation.homeLink")}
          </Link>
        </p>
        <CompactRow id="rising" title={t("notFound.rising")} items={rising} trailing="category" more={{ href: localePath(locale, "/rising"), label: t("navigation.viewAll") }} />
      </div>
    </main>
  );
}
