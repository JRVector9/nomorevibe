import Link from "next/link";
import type { Metadata } from "next";
import { canonicalAlternates } from "@/app/page";
import { CompactCard } from "@/components/home/CompactCard";
import { StarGrowthSummary, STAR_GROWTH_TITLE, starGrowthTitle, starGrowthNote } from "@/components/home/StarGrowthSummary";
import { getStarGrowthPage, type StarGrowthPage } from "@/lib/domain/products/star-growth";
import { pageTitle } from "@/lib/copy/brand";
import { formatCount } from "@/lib/format/number";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: pageTitle(STAR_GROWTH_TITLE),
  description: "GitHub 스타 50~1,999개, 전날 같은 회차보다 10개 이상 증가한 프로젝트. KST 00시·08시·16시에 갱신합니다.",
  alternates: canonicalAlternates("/rising"),
};

type SearchValue = string | string[] | undefined;
const firstValue = (value: SearchValue) => Array.isArray(value) ? value[0] : value;

export default async function RisingPage({ searchParams }: { searchParams: Promise<{ page?: SearchValue; cycle?: SearchValue }> }) {
  const params = await searchParams;
  const now = new Date();
  let result: StarGrowthPage | null = null;
  try {
    result = await getStarGrowthPage({ pageSize: 15, page: firstValue(params.page), cycle: firstValue(params.cycle), now });
  } catch (error) {
    logger.error("rising.list_failed", { error });
  }
  const href = (page: number) => `/rising?${new URLSearchParams({ cycle: result!.snapshot.asOf, page: String(page) })}`;
  return (
    <main className="wrap">
      <section id="star-growth-list" className="row-section" aria-labelledby="star-growth-title">
        <div className="row-head">
          <div>
            <h1 id="star-growth-title" className="row-title">{starGrowthTitle(result?.snapshot ?? null)}</h1>
            <p className="row-note">{starGrowthNote(result?.snapshot ?? null)} · <Link prefetch={false} href="/?metric=star-growth">집계 기준</Link></p>
          </div>
          <Link prefetch={false} href="/#rising" className="row-more">홈으로</Link>
        </div>
        <StarGrowthSummary snapshot={result?.snapshot ?? null} now={now} />
        {(result?.snapshot.status === "ready" || result?.snapshot.status === "observing") && <>
          <p className="row-note">{result.snapshot.status === "observing" ? "이번 회차 스타가 많은 순" : "전일 대비 순증가가 많은 순"} · {formatCount(result.total)}개</p>
          <div className="compact-grid">
            {result.items.map((product, index) => <CompactCard key={product.slug} product={product} trailing="category" priority={index < 3} headingLevel={2} />)}
          </div>
          {result.pages > 1 && <nav className="row-head" aria-label="스타 급상승 페이지">
            {result.page > 1 ? <Link prefetch={false} href={href(result.page - 1)}>이전</Link> : <span aria-disabled="true">이전</span>}
            <span aria-live="polite">{result.page} / {result.pages}</span>
            {result.page < result.pages ? <Link prefetch={false} href={href(result.page + 1)}>다음</Link> : <span aria-disabled="true">다음</span>}
          </nav>}
        </>}
      </section>
    </main>
  );
}
