"use client";

import Link from "next/link";
import { ProductTagline } from "@/components/ProductTagline";
import { StatusBadge } from "@/components/TrustBadges";
import type { RankingListItem } from "@/lib/domain/ranking/view";
import { useLocale,useTranslations } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import type { Translator } from "@/lib/i18n/messages";

function changeLabel(change: number | null, t: Translator<"browse">, count: (n:number)=>string): string {
  if (change === null) return t("ranking.new");
  return `${change > 0 ? "+" : ""}${count(change)}%`;
}

function seasonStatus(item: RankingListItem,t:Translator<"browse">,count:(n:number)=>string): string {
  return item.previousRank === null ? t("ranking.firstSeason") : t("ranking.previousRank", {rank:count(item.previousRank)});
}

function ProductIdentity({ item, mobileDetails }: {
  item: RankingListItem;
  mobileDetails?: React.ReactNode;
}) {
  const locale=useLocale();
  const labels=useTranslations("labels");
  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Link prefetch={false} href={localePath(locale,`/p/${item.slug}`)} className="min-w-0 truncate font-bold hover:text-accent">
          {item.name}
        </Link>
        <StatusBadge status={item.status} unclaimed={item.unclaimed} />
        {item.health?.down && (
          <span className="shrink-0 rounded-full border border-down/40 bg-down/10 px-2 py-0.5 text-[13px] font-semibold text-down">
            {labels("card.down")}
          </span>
        )}
      </div>
      {/* 좁은 표 칸이라 출처 줄은 끈다 — 소개는 ProductTagline 으로만 그린다(한국어 소개가 붙을 자리) */}
      <ProductTagline translation={item.translation} tagline={item.tagline} taglineKo={item.taglineKo} source={item.taglineSource} showSource={false} className="block max-w-64 truncate text-[13px] text-fg-2" />
      {mobileDetails}
    </>
  );
}

export function RankingTable({
  items,
  windowHours,
  scoreMode,
  mode = "season",
}: {
  items: RankingListItem[];
  windowHours: number;
  scoreMode: RankingListItem["scoreMode"];
  mode?: "season" | "all-time";
}) {
  const locale=useLocale();
  const t=useTranslations("browse");
  const count=(n:number)=>formatNumber(n,locale);
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
          {items.map((item) => {
            const factor = item.cooldownFactorBasisPoints / 100;
            const status = seasonStatus(item,t,count);
            return (
              <tr key={item.slug} className="border-t border-line">
                <td className="px-2 py-3 font-mono text-[13px] font-extrabold sm:px-4">{count(item.rank)}</td>
                <td className="min-w-0 px-2 py-3 sm:px-3">
                  <ProductIdentity
                    item={item}
                    mobileDetails={seasonal ? (
                      <span className="mt-1 flex flex-wrap gap-x-2 text-[13px] text-fg-2 sm:hidden">
                        <span className={factor < 100 ? "font-semibold text-down" : undefined}>{t("ranking.weightValue", {factor:count(factor)})}</span>
                        <span>{status}</span>
                      </span>
                    ) : undefined}
                  />
                </td>
                <td className="whitespace-nowrap px-2 py-3 text-right font-mono font-bold sm:px-3">
                  <span className="block">
                    {count(uniqueScoring ? item.uniqueVisitors : item.validClicks)}
                  </span>
                  {uniqueScoring && (
                    <span className="block text-[13px] font-medium text-fg-2">
                      {t("ranking.visitValue", {count:count(item.validClicks)})}
                    </span>
                  )}
                </td>
                {seasonal && (
                  <>
                    <td className={`whitespace-nowrap px-2 py-3 text-right font-mono font-semibold sm:px-3 ${
                      item.changePercent === null ? "text-fg-2" : item.changePercent < 0 ? "text-down" : "text-up"
                    }`}>
                      {changeLabel(item.changePercent,t,count)}
                    </td>
                    <td className={`hidden px-3 py-3 text-right font-mono font-bold sm:table-cell ${
                      factor < 100 ? "text-down" : "text-fg-2"
                    }`}>
                      {count(factor)}%
                    </td>
                    <td className="hidden px-4 py-3 text-right text-fg-2 sm:table-cell">{status}</td>
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
