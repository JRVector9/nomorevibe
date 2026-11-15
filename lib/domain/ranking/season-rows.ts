import type { ProductStatus } from "@/lib/db/schema";
import type { RankingListItem } from "./view";

/**
 * 시즌 랭킹 표의 채우기 값(2026-11-15 공개 HTML 이름·요약만) — 서버 HTML 에는 순위 자리·이름·요약·링크만 두고,
 * 점수·변동·가중치·지난 순위·상태 배지·응답 없음 표시는 브라우저가 /api/rankings/[key] 로 받아 채운다(components/RankingTable.tsx).
 * 표가 그리는 칸만 담는다. 화면(브라우저)과 API(서버)가 함께 쓴다 — DB 를 부르지 않는다.
 */
export type RankingRowData = {
  slug: string;
  status: ProductStatus;
  unclaimed: boolean;
  down: boolean;
  validClicks: number;
  uniqueVisitors: number;
  changePercent: number | null;
  cooldownFactorBasisPoints: number;
  previousRank: number | null;
};

/** GET /api/rankings/[key] */
export type SeasonRankingResponse = { items: RankingRowData[] };

/** 새 객체로 칸을 골라 담는다 — 제품의 다른 칸(주소·메이커·분류…)은 빠진다 */
export function rankingRowData(item: RankingListItem): RankingRowData {
  return {
    slug: item.slug, status: item.status, unclaimed: item.unclaimed, down: Boolean(item.health?.down),
    validClicks: item.validClicks, uniqueVisitors: item.uniqueVisitors, changePercent: item.changePercent,
    cooldownFactorBasisPoints: item.cooldownFactorBasisPoints, previousRank: item.previousRank,
  };
}
