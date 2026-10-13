import Link from "next/link";
import type { Metadata } from "next";
import { canonicalAlternates } from "@/app/(public)/[locale]/page";
import { Icon } from "@/components/home/icons";
import { RankedCards } from "@/components/home/RankedCards";
import { PopularList } from "@/app/(public)/[locale]/popular/PopularList";
import { StarGrowthSummary, STAR_GROWTH_TITLE, starGrowthNote } from "@/components/home/StarGrowthSummary";
import { getStarGrowthPage, type StarGrowthPage } from "@/lib/domain/products/star-growth";
import { pageTitle } from "@/lib/copy/brand";
import { formatCount } from "@/lib/format/number";
import { formatPublicDateTime } from "@/lib/format/time";
import { logger } from "@/lib/observability/logger";
import "@/app/(public)/[locale]/popular/popular.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: pageTitle(STAR_GROWTH_TITLE),
  description: "GitHub 스타 50~1,999개 프로젝트 중 직전 8시간 회차 대비 스타가 많이 늘어난 순. KST 00시·08시·16시에 갱신합니다.",
  alternates: canonicalAlternates("/rising"),
};

type SearchValue = string | string[] | undefined;
const firstValue = (value: SearchValue) => Array.isArray(value) ? value[0] : value;
const VIEWS = [{ key: "list", label: "목록으로 보기", icon: "list" }, { key: "cards", label: "카드로 보기", icon: "grid" }] as const;

export default async function RisingPage({ searchParams }: { searchParams: Promise<{ page?: SearchValue; cycle?: SearchValue; view?: SearchValue }> }) {
  const params = await searchParams;
  const view = firstValue(params.view) === "cards" ? "cards" : "list";
  const now = new Date();
  let result: StarGrowthPage | null = null;
  try {
    result = await getStarGrowthPage({ pageSize: 15, page: firstValue(params.page), cycle: firstValue(params.cycle), now });
  } catch (error) {
    logger.error("rising.list_failed", { error });
  }
  const href = (page: number, nextView = view) => `/rising?${new URLSearchParams({ cycle: result!.snapshot.asOf, page: String(page), view: nextView })}`;
  const first = result ? (result.page - 1) * result.pageSize + 1 : 1;
  const items = result?.items.map((product, index) => ({ ...product, rank: first + index })) ?? [];
  return (
    <main className="wrap popular-page">
      <nav aria-label="경로" className="popular-crumbs">
        <Link prefetch={false} href="/">발견하기</Link><span aria-hidden="true">›</span><span aria-current="page">{STAR_GROWTH_TITLE}</span>
      </nav>
      <div className="popular-heading">
        <h1 id="star-growth-title">{STAR_GROWTH_TITLE}</h1>
        <p>{starGrowthNote(result?.snapshot ?? null)} · <Link prefetch={false} href="/?metric=star-growth">집계 기준</Link></p>
      </div>
      <section id="star-growth-list" aria-labelledby="star-growth-list-title">
        <div className="popular-summary">
          <div>
            <h2 id="star-growth-list-title">8시간 증가량순{result && <> · {formatCount(result.total)}개</>}</h2>
            <p>8시간 +숫자는 직전 회차보다 늘어난 스타 · ★는 총 스타 수</p>
          </div>
          {result && <nav className="tabs tabs-sm" aria-label="보기">
            {VIEWS.map((option) => <Link prefetch={false} key={option.key} href={href(result.page, option.key)}
              className={`tab tab-icon${view === option.key ? " active" : ""}`} aria-current={view === option.key ? "true" : undefined}
              aria-label={option.label} title={option.label}><Icon name={option.icon} size={16} /></Link>)}
          </nav>}
        </div>
        {!result || result.snapshot.status !== "ready" ? <div className="popular-empty" role="status">
          <StarGrowthSummary snapshot={result?.snapshot ?? null} now={now} />
        </div> : <>
          <p className="row-note">기준 {formatPublicDateTime(result.snapshot.asOf, now)} KST · 다음 갱신 {formatPublicDateTime(result.snapshot.nextCycle, now)} KST</p>
          {view === "cards" ? <RankedCards items={items} now={now.toISOString()} /> : <PopularList items={items} now={now.toISOString()} />}
          <nav className="popular-pagination" aria-label="페이지 이동">
            {result.page > 1 ? <Link prefetch={false} href={href(result.page - 1)}>‹ 이전</Link> : <span aria-disabled="true">‹ 이전</span>}
            <span aria-live="polite">{formatCount(first)}–{formatCount(first + items.length - 1)}위 / {formatCount(result.total)}</span>
            {result.page < result.pages ? <Link prefetch={false} href={href(result.page + 1)}>다음 ›</Link> : <span aria-disabled="true">다음 ›</span>}
          </nav>
        </>}
      </section>
    </main>
  );
}
