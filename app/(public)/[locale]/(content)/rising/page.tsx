import { localizeProductList } from "@/lib/i18n/products";
import { getRequestLocale } from "@/lib/i18n/server";
import { getTranslator, getDictionary } from "@/lib/i18n/dictionary";
import { I18nProvider } from "@/lib/i18n/context";
import { localePath } from "@/lib/i18n/routing";
import { formatNumber, formatDateTime } from "@/lib/i18n/format";
import Link from "next/link";
import type { Metadata, ResolvingMetadata } from "next";
import { localizedOpenGraph } from "@/lib/i18n/metadata";
import { canonicalAlternates } from "@/app/(public)/[locale]/(content)/page";
import { Icon } from "@/components/home/icons";
import { RankedCards } from "@/components/home/RankedCards";
import { PopularList } from "@/app/(public)/[locale]/(content)/popular/PopularList";
import { StarGrowthSummary } from "@/components/home/StarGrowthSummary";
import { starGrowthNote } from "@/components/home/star-growth-copy";
import { getStarGrowthPage, type StarGrowthPage } from "@/lib/domain/products/star-growth";
import { pageTitle } from "@/lib/copy/brand";
import { logger } from "@/lib/observability/logger";
import "@/app/(public)/[locale]/(content)/popular/popular.css";

export const dynamic = "force-dynamic";
export async function generateMetadata(props?: PageProps<"/[locale]/rising">, parent?: ResolvingMetadata): Promise<Metadata> {
  void props;
  const locale = await getRequestLocale();
  const t = await getTranslator(locale, "browse");
  const title = pageTitle(t("growth.title"));
  const description = t("growth.description");
  return {
    title, description, alternates: canonicalAlternates("/rising", locale),
    openGraph: { ...(await parent)?.openGraph, ...localizedOpenGraph(locale), title, description, url: localePath(locale, "/rising") },
  };
}

type SearchValue = string | string[] | undefined;
const firstValue = (value: SearchValue) => Array.isArray(value) ? value[0] : value;
const VIEWS = [{ key: "list", label: "nav.listView", icon: "list" }, { key: "cards", label: "nav.cardView", icon: "grid" }] as const;

export default async function RisingPage({ searchParams }: { searchParams: Promise<{ page?: SearchValue; cycle?: SearchValue; view?: SearchValue }> }) {
  const locale = await getRequestLocale();
  const [t,dictionary] = await Promise.all([getTranslator(locale,"browse"),getDictionary(locale,"browse")]);
  const count = (n: number) => formatNumber(n,locale);
  const params = await searchParams;
  const view = firstValue(params.view) === "cards" ? "cards" : "list";
  const now = new Date();
  let result: StarGrowthPage | null = null;
  try {
    result = await getStarGrowthPage({ pageSize: 15, page: firstValue(params.page), cycle: firstValue(params.cycle), now });
  } catch (error) {
    logger.error("rising.list_failed", { error });
  }
  const href = (page: number, nextView = view) => localePath(locale, `/rising?${new URLSearchParams({ cycle: result!.snapshot.asOf, page: String(page), view: nextView })}`);
  const first = result ? (result.page - 1) * result.pageSize + 1 : 1;
  const items = (await localizeProductList(result?.items ?? [],locale)).map((product, index) => ({ ...product, rank: first + index }));
  return (
    <I18nProvider locale={locale} dictionaries={{browse:dictionary}}><main className="wrap popular-page">
      <nav aria-label={t("nav.breadcrumb")} className="popular-crumbs">
        <Link prefetch={false} href={localePath(locale,"/")}>{t("nav.discover")}</Link><span aria-hidden="true">›</span><span aria-current="page">{t("growth.title")}</span>
      </nav>
      <div className="popular-heading">
        <h1 id="star-growth-title">{t("growth.title")}</h1>
        <p>{starGrowthNote(result?.snapshot ?? null,locale,t)} · <Link prefetch={false} href={localePath(locale,"/?metric=star-growth")}>{t("nav.methodology")}</Link></p>
      </div>
      <section id="star-growth-list" aria-labelledby="star-growth-list-title">
        <div className="popular-summary">
          <div>
            <h2 id="star-growth-list-title">{t("growth.order")}{result && <> · {t("count.projects", { count:count(result.total) })}</>}</h2>
            <p>{t("growth.legend")}</p>
          </div>
          {result && <nav className="tabs tabs-sm" aria-label={t("nav.view")}>
            {VIEWS.map((option) => <Link prefetch={false} key={option.key} href={href(result.page, option.key)}
              className={`tab tab-icon${view === option.key ? " active" : ""}`} aria-current={view === option.key ? "true" : undefined}
              aria-label={t(option.label)} title={t(option.label)}><Icon name={option.icon} size={16} /></Link>)}
          </nav>}
        </div>
        {!result || result.snapshot.status !== "ready" ? <div className="popular-empty" role="status">
          <StarGrowthSummary snapshot={result?.snapshot ?? null} now={now} />
        </div> : <>
          <p className="row-note">{t("growth.cycle", { asOf:formatDateTime(result.snapshot.asOf,now,locale),next:formatDateTime(result.snapshot.nextCycle,now,locale) })}</p>
          {view === "cards" ? <RankedCards items={items} now={now.toISOString()} /> : <PopularList items={items} now={now.toISOString()} />}
          <nav className="popular-pagination" aria-label={t("nav.pages")}>
            {result.page > 1 ? <Link prefetch={false} href={href(result.page - 1)}>‹ {t("nav.previous")}</Link> : <span aria-disabled="true">‹ {t("nav.previous")}</span>}
            <span aria-live="polite">{t("popular.position", { first:count(first),last:count(first+items.length-1),total:count(result.total) })}</span>
            {result.page < result.pages ? <Link prefetch={false} href={href(result.page + 1)}>{t("nav.next")} ›</Link> : <span aria-disabled="true">{t("nav.next")} ›</span>}
          </nav>
        </>}
      </section>
    </main></I18nProvider>
  );
}
