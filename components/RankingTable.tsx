"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { StatusBadge } from "@/components/TrustBadges";
import type { PublicTeaser } from "@/lib/domain/products/public-teaser";
import type { RankingRowData, SeasonRankingResponse } from "@/lib/domain/ranking/season-rows";
import type { RankingListItem } from "@/lib/domain/ranking/view";
import { useLocale,useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import type { Translator } from "@/lib/i18n/messages";

/**
 * 시즌 랭킹 표(2026-11-15 공개 HTML 이름·요약만) — 서버가 넘기는 값은 순위 자리·slug·이름·요약(rows)과 시즌 열쇠뿐이다.
 * 점수·변동·가중치·지난 순위·상태 배지·응답 없음 표시는 /api/rankings/[key] 를 한 번 받아 채운다. 받는 동안 그 칸은 글자 없는 자리(aria-busy),
 * 못 받으면 비워 둔다(순위·이름·요약·링크는 남는다). 채우기 값을 이미 가진 쪽은 details 로 바로 넘긴다.
 */
export type RankingTeaser = PublicTeaser & { rank: number };

function changeLabel(change: number | null, t: Translator<"browse">, count: (n:number)=>string): string {
  if (change === null) return t("ranking.new");
  return `${change > 0 ? "+" : ""}${count(change)}%`;
}

function seasonStatus(item: RankingRowData,t:Translator<"browse">,count:(n:number)=>string): string {
  return item.previousRank === null ? t("ranking.firstSeason") : t("ranking.previousRank", {rank:count(item.previousRank)});
}

const loads = new Map<string, Promise<RankingRowData[] | null>>();
/** 받아 둔 값 — 같은 시즌을 다시 열면(앱 안 이동) 자리 없이 바로 그린다 */
const loaded = new Map<string, RankingRowData[]>();

export function loadSeasonRows(seasonKey: string): Promise<RankingRowData[] | null> {
  let load = loads.get(seasonKey);
  if (!load) {
    load = fetch(`/api/rankings/${encodeURIComponent(seasonKey)}`, { headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? (await response.json() as SeasonRankingResponse).items : null)
      .catch(() => null)
      .then((items) => {
        // 실패는 담아 두지 않는다 — 다음에 열면 다시 받는다
        if (items) loaded.set(seasonKey, items); else loads.delete(seasonKey);
        return items;
      });
    loads.set(seasonKey, load);
  }
  return load;
}

/** details 가 있으면 그대로, 없으면 시즌 열쇠로 받는다. done 이 false 면 받는 중 */
function useSeasonRows(seasonKey: string | undefined, details: RankingRowData[] | undefined): { rows: RankingRowData[] | null; done: boolean } {
  const known = seasonKey ? loaded.get(seasonKey) : undefined;
  const [state, setState] = useState<{ key: string | undefined; rows: RankingRowData[] | null; done: boolean }>(
    () => known ? { key: seasonKey, rows: known, done: true } : { key: seasonKey, rows: null, done: false });
  const skip = Boolean(details) || !seasonKey;
  useEffect(() => {
    if (skip || !seasonKey) return;
    let alive = true;
    loadSeasonRows(seasonKey).then((rows) => { if (alive) setState({ key: seasonKey, rows, done: true }); });
    return () => { alive = false; };
  }, [seasonKey, skip]);
  if (details) return { rows: details, done: true };
  if (!seasonKey) return { rows: null, done: true };
  if (state.key === seasonKey) return state;
  return known ? { rows: known, done: true } : { rows: null, done: false };
}

/** 받는 동안의 칸 자리 — 글자 없이 한 줄 높이만 */
function Pending({ className = "" }: { className?: string }) {
  return <span aria-busy="true" className={`block h-[18px] min-w-10 rounded-[6px] bg-bg-soft motion-safe:animate-pulse ${className}`} />;
}

function ProductIdentity({ row, detail, mobileDetails }: {
  row: RankingTeaser;
  detail: RankingRowData | null;
  mobileDetails?: React.ReactNode;
}) {
  const locale=useLocale();
  const labels=useTranslations("labels");
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Link prefetch={false} href={localePath(locale,`/p/${row.slug}`)} className="min-w-0 truncate font-bold hover:text-accent">
          {row.name}
        </Link>
        {detail && <StatusBadge status={detail.status} unclaimed={detail.unclaimed} />}
        {detail?.down && (
          <span className="shrink-0 rounded-full border border-down/40 bg-down/10 px-2 py-0.5 text-[13px] font-semibold text-down">
            {labels("card.down")}
          </span>
        )}
      </div>
      {/* 좁은 표 칸이라 한 줄로 자른다 — 요약은 서버가 그 언어로 고른 값(public-teaser.ts) */}
      <p className="block max-w-64 truncate text-[13px] text-fg-2" title={row.summary} lang={row.lang}>{row.summary}</p>
      {mobileDetails}
    </>
  );
}

export function RankingTable({
  rows,
  seasonKey,
  details,
  windowHours,
  scoreMode,
  mode = "season",
}: {
  rows: RankingTeaser[];
  /** 채우기 값을 받을 시즌 — details 가 없을 때 */
  seasonKey?: string;
  /** 이미 받은 채우기 값(시험·다른 화면) */
  details?: RankingRowData[];
  windowHours: number;
  scoreMode: RankingListItem["scoreMode"];
  mode?: "season" | "all-time";
}) {
  const locale=useLocale();
  const t=useTranslations("browse");
  const count=(n:number)=>formatNumber(n,locale);
  const { rows: filled, done } = useSeasonRows(seasonKey, details);
  const bySlug = new Map((filled ?? []).map((item) => [item.slug, item]));
  const seasonal = mode === "season";
  const uniqueScoring = seasonal && scoreMode === "unique_visitors";
  const desktopPrimaryHeader = t(seasonal ? uniqueScoring ? "ranking.unique" : "ranking.seasonVisits" : "ranking.totalVisits");
  const mobilePrimaryHeader = t(seasonal ? uniqueScoring ? "ranking.unique" : "ranking.visits" : "ranking.totalVisits");
  const desktopTrendHeader = t("ranking.trend", {hours:count(windowHours),metric:t(uniqueScoring?"ranking.unique":"ranking.visits")});
  const mobileTrendHeader = t("ranking.mobileTrend", {hours:count(windowHours)});

  return (
    <div className="overflow-x-auto rounded-[12px] border border-line bg-bg-card">
      <table className="w-full min-w-full sm:min-w-[760px] text-left text-[13px]" data-track-list="table">
        <thead className="text-fg-2">
          <tr>
            <th className="w-8 px-2 py-3 font-medium sm:w-12 sm:px-4">#</th>
            <th className="w-full min-w-28 px-2 py-3 font-medium sm:min-w-48 sm:px-3">{t("ranking.product")}</th>
            <th className="whitespace-nowrap px-2 py-3 text-right font-medium sm:px-3">
              <span className="sm:hidden">{mobilePrimaryHeader}</span>
              <span className="hidden sm:inline">{desktopPrimaryHeader}</span>
            </th>
            {seasonal && (
              <>
                <th className="whitespace-nowrap px-2 py-3 text-right font-medium sm:px-3">
                  <span className="sm:hidden">{mobileTrendHeader}</span>
                  <span className="hidden sm:inline">{desktopTrendHeader}</span>
                </th>
                <th className="hidden sm:table-cell whitespace-nowrap px-3 py-3 text-right font-medium">{t("ranking.weight")}</th>
                <th className="hidden sm:table-cell whitespace-nowrap px-4 py-3 text-right font-medium">{t("season.status")}</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const item = bySlug.get(row.slug) ?? null;
            const pending = !done;
            const factor = item ? item.cooldownFactorBasisPoints / 100 : 100;
            const status = item ? seasonStatus(item,t,count) : null;
            return (
              <tr key={row.slug} className="border-t border-line">
                <td className="px-2 py-3 font-mono text-[13px] font-extrabold sm:px-4">{count(row.rank)}</td>
                <td className="min-w-0 px-2 py-3 sm:px-3">
                  <ProductIdentity
                    row={row}
                    detail={item}
                    mobileDetails={seasonal ? (
                      pending ? <Pending className="mt-1 w-24 sm:hidden" /> : item && (
                        <span className="mt-1 flex flex-wrap gap-x-2 text-[13px] text-fg-2 sm:hidden">
                          <span className={factor < 100 ? "font-semibold text-down" : undefined}>{t("ranking.weightValue", {factor:count(factor)})}</span>
                          <span>{status}</span>
                        </span>
                      )
                    ) : undefined}
                  />
                </td>
                <td className="whitespace-nowrap px-2 py-3 text-right font-mono font-bold sm:px-3">
                  {pending ? <Pending className="ml-auto" /> : item && <>
                    <span className="block">
                      {count(uniqueScoring ? item.uniqueVisitors : item.validClicks)}
                    </span>
                    {uniqueScoring && (
                      <span className="block text-[13px] font-medium text-fg-2">
                        {t("ranking.visitValue", {count:count(item.validClicks)})}
                      </span>
                    )}
                  </>}
                </td>
                {seasonal && (
                  <>
                    <td className={`whitespace-nowrap px-2 py-3 text-right font-mono font-semibold sm:px-3 ${
                      !item || item.changePercent === null ? "text-fg-2" : item.changePercent < 0 ? "text-down" : "text-up"
                    }`}>
                      {pending ? <Pending className="ml-auto" /> : item && changeLabel(item.changePercent,t,count)}
                    </td>
                    <td className={`hidden px-3 py-3 text-right font-mono font-bold sm:table-cell ${
                      factor < 100 ? "text-down" : "text-fg-2"
                    }`}>
                      {pending ? <Pending className="ml-auto" /> : item && `${count(factor)}%`}
                    </td>
                    <td className="hidden px-4 py-3 text-right text-fg-2 sm:table-cell">{pending ? <Pending className="ml-auto w-20" /> : status}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
