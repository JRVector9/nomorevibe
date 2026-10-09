import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { RankingTable } from "@/components/RankingTable";
import { SeasonPolicy } from "@/components/SeasonPolicy";
import { pageTitle } from "@/lib/copy/brand";
import { seasonLabel } from "@/lib/domain/ranking/season-label";
import { getSeasonByKey, type SeasonSummary } from "@/lib/domain/ranking/view";

export const dynamic = "force-dynamic";

/** 제목(generateMetadata)과 본문이 같은 요청에서 시즌을 한 번만 읽는다 */
const loadSeason = cache((key: string) => getSeasonByKey(key));

/**
 * 시즌 이름 — 열쇠("2026-W41")가 아니라 "2026년 41주"로(2026-10-08 UX 감사 UX-09·UX-39).
 * 순위가 빈 시즌은 sitemap 에서 빠지고(app/sitemap.ts) 여기서도 색인하지 말라고 한다.
 */
export async function generateMetadata({ params }: PageProps<"/rankings/[key]">): Promise<Metadata> {
  const { key } = await params;
  const result = await loadSeason(key);
  if (!result) return {};
  return {
    title: pageTitle(`${seasonLabel(result.season.key)} 랭킹`),
    robots: result.items.length > 0 ? undefined : { index: false, follow: true },
  };
}

/** 빈 시즌 안내 — 진행 중이면 "아직", 끝났으면 그 기간에 없었다고 말한다 */
function emptyMessage(season: SeasonSummary): string {
  const monthly = season.cadence === "monthly";
  return season.state === "active"
    ? `${monthly ? "이번 달은" : "이번 주는"} 아직 집계된 제품이 없습니다`
    : `${monthly ? "이 달에는" : "이 주에는"} 집계된 제품이 없었습니다`;
}

export default async function RankingSeasonPage({
  params,
}: PageProps<"/rankings/[key]">) {
  const { key } = await params;
  const result = await loadSeason(key);
  if (!result) notFound();

  return (
    <main className="mx-auto max-w-[1280px] px-6 pb-20 pt-9">
      <h1 className="text-[26px] font-extrabold">{seasonLabel(result.season.key)} 랭킹</h1>
      <div className="mt-6">
        {result.items.length > 0 ? (
          <RankingTable
            items={result.items}
            windowHours={result.season.policy.trend.windowHours}
            scoreMode={result.season.policy.scoring.mode}
            mode="season"
          />
        ) : (
          <p className="rounded-[12px] border border-dashed border-line bg-bg-card px-5 py-10 text-center text-[15px] text-fg-2">
            {emptyMessage(result.season)} —{" "}
            <Link prefetch={false} href="/#rising" className="font-semibold text-accent-ink underline underline-offset-4">
              지금 뜨는 프로젝트 보기
            </Link>
          </p>
        )}
      </div>
      {/* 시즌 규칙 값은 순위를 보는 데 필요하지 않다 — 궁금한 사람만 연다 */}
      <details className="mt-6 rounded-[12px] border border-line bg-bg-card">
        <summary className="flex min-h-11 cursor-pointer items-center px-5 text-[14px] font-semibold text-fg">
          집계 기준
        </summary>
        <div className="border-t border-line p-5">
          <SeasonPolicy season={result.season} now={new Date()} />
        </div>
      </details>
    </main>
  );
}
