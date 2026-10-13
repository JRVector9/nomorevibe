import { localizeProductList } from "@/lib/i18n/products";
import { getRequestLocale } from "@/lib/i18n/server";
import { getTranslator,getDictionary } from "@/lib/i18n/dictionary";
import { I18nProvider } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import type { Metadata, ResolvingMetadata } from "next";
import { LOCALES } from "@/lib/i18n/locales";
import { localizedOpenGraph } from "@/lib/i18n/metadata";
import { canonicalAlternates } from "@/app/(public)/[locale]/(content)/page";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { RankingTable } from "@/components/RankingTable";
import { SeasonPolicy } from "@/components/SeasonPolicy";
import { pageTitle } from "@/lib/copy/brand";
import { translatedSeason } from "@/components/home/i18n";
import type { Translator } from "@/lib/i18n/messages";
import { seasonLabel } from "@/lib/domain/ranking/season-label";
import { getSeasonByKey, type SeasonSummary } from "@/lib/domain/ranking/view";

export const dynamic = "force-dynamic";

/** 제목(generateMetadata)과 본문이 같은 요청에서 시즌을 한 번만 읽는다 */
const loadSeason = cache((key: string) => getSeasonByKey(key));

/**
 * 시즌 이름 — 열쇠("2026-W41")가 아니라 "2026년 41주"로(2026-10-08 UX 감사 UX-09·UX-39).
 * 순위가 빈 시즌은 sitemap 에서 빠지고(app/sitemap.ts) 여기서도 색인하지 말라고 한다.
 */
export async function generateMetadata({ params }: PageProps<"/[locale]/rankings/[key]">, parent: ResolvingMetadata): Promise<Metadata> {
  const locale = await getRequestLocale();
  const t = await getTranslator(locale, "browse");
  const { key } = await params;
  const result = await loadSeason(key);
  const path = `/rankings/${encodeURIComponent(result?.season.key ?? key)}`;
  const indexable = Boolean(result && result.items.length > 0);
  const readyLocales = indexable ? LOCALES : [];
  const title = result ? pageTitle(t("ranking.title", { season: translatedSeason(result.season.key, seasonLabel(result.season.key), t) }))
    : pageTitle(t("ranking.notFound"));
  return {
    title,
    ...(indexable ? {} : { robots: { index: false, follow: true } }),
    alternates: canonicalAlternates(path, locale, readyLocales),
    openGraph: { ...(await parent)?.openGraph, ...localizedOpenGraph(locale, readyLocales), title, url: localePath(locale, path) },
  };
}

/** 빈 시즌 안내 — 진행 중이면 "아직", 끝났으면 그 기간에 없었다고 말한다 */
function emptyMessage(season:SeasonSummary,t:Translator<"browse">):string {
  return t(season.state === "active" ? season.cadence === "monthly" ? "ranking.emptyActiveMonth" : "ranking.emptyActiveWeek" : season.cadence === "monthly" ? "ranking.emptyClosedMonth" : "ranking.emptyClosedWeek");
}

export default async function RankingSeasonPage({
  params,
}: PageProps<"/[locale]/rankings/[key]">) {
  const locale=await getRequestLocale();
  const [t,dictionary]=await Promise.all([getTranslator(locale,"browse"),getDictionary(locale,"browse")]);
  const { key } = await params;
  const result = await loadSeason(key);
  if (!result) notFound();
  const items=await localizeProductList(result.items,locale);

  return (
    <I18nProvider locale={locale} dictionaries={{browse:dictionary}} now={new Date().toISOString()}><main className="mx-auto max-w-[1280px] px-6 pb-20 pt-9">
      <h1 className="text-[26px] font-extrabold">{t("ranking.title",{season:translatedSeason(result.season.key,seasonLabel(result.season.key),t)})}</h1>
      <div className="mt-6">
        {result.items.length > 0 ? (
          <RankingTable
            items={items}
            windowHours={result.season.policy.trend.windowHours}
            scoreMode={result.season.policy.scoring.mode}
            mode="season"
          />
        ) : (
          // 왜 비었는지 말한다 — 랭킹은 메이커가 등록·확인한 최근 프로젝트만 센다(refresh.ts 후보: status verified, 출시 참가 기간 안).
          // 수집한 프로젝트는 들어가지 않으므로 등록이 없으면 늘 빈다(2026-10-11 운영 확인: 확인된 제품 0건)
          <div className="rounded-[12px] border border-dashed border-line bg-bg-card px-5 py-10 text-center">
            <p className="text-[15px] font-semibold text-fg">{emptyMessage(result.season,t)}</p>
            <p className="mx-auto mt-2 max-w-[560px] text-[14px] leading-6 text-fg-2">
              {t("ranking.explanation")}
            </p>
            <p className="mt-4 flex flex-wrap justify-center gap-x-6 gap-y-2 text-[15px]">
              <Link prefetch={false} href={localePath(locale,"/launch")} className="inline-flex min-h-11 items-center font-semibold text-accent-ink underline underline-offset-4">
                {t("ranking.launch")}
              </Link>
              <Link prefetch={false} href={localePath(locale,"/#rising")} className="inline-flex min-h-11 items-center font-semibold text-accent-ink underline underline-offset-4">
                {t("ranking.browse")}
              </Link>
            </p>
          </div>
        )}
      </div>
      {/* 시즌 규칙 값은 순위를 보는 데 필요하지 않다 — 궁금한 사람만 연다 */}
      <details className="mt-6 rounded-[12px] border border-line bg-bg-card">
        {/* 제목 단계 h1 → h2 → h3(SeasonPolicy 안 묶음 제목) — 건너뛰지 않게 여기서 h2 를 둔다(A11Y-05) */}
        <summary className="flex min-h-11 cursor-pointer items-center px-5 text-[14px] font-semibold text-fg">
          <h2 className="text-[14px] font-semibold">{t("nav.methodology")}</h2>
        </summary>
        <div className="border-t border-line p-5">
          <SeasonPolicy locale={locale} messages={dictionary} season={result.season} now={new Date()} />
        </div>
      </details>
    </main></I18nProvider>
  );
}
