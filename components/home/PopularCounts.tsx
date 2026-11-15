"use client";

import type { PopularCountsResponse } from "@/app/api/browse-counts/route";
import { FillLine } from "@/components/cards/fill-line";
import { useLocale } from "@/lib/i18n/context";
import { formatNumber } from "@/lib/i18n/format";
import { useCountsQuery } from "./browse-counts";

/**
 * /popular 의 수(2026-11-15 공개 HTML 이름·요약만) — 구간 탭·거르기 알약·목록 제목의 수를 서버 HTML 에 싣지 않고
 * /api/browse-counts?part=popular 로 한 번 받는다. 받는 동안은 글자 없는 자리, 못 받으면 수 없이 둔다.
 * pick: tier:<차례> · total · ai · personal · all · cat:<분야>
 */
function pickCount(data: PopularCountsResponse, pick: string): number | null {
  if (pick === "total") return data.total;
  if (pick.startsWith("tier:")) return data.totals[Number(pick.slice(5))] ?? null;
  const facets = data.facets;
  if (!facets) return null;
  if (pick === "ai" || pick === "personal" || pick === "all") return facets[pick];
  if (pick.startsWith("cat:")) return facets.categories.find((item) => item.category === pick.slice(4))?.count ?? 0;
  return null;
}

export function PopularCount({ query, pick, className }: { query: string; pick: string; className: string }) {
  const locale = useLocale();
  const data = useCountsQuery<PopularCountsResponse>(`part=popular&${query}`);
  if (data === null) return null;
  const value = data ? pickCount(data, pick) : undefined;
  if (value === null) return null;
  return <> <span className={className}>{value === undefined ? <FillLine width="2em" /> : formatNumber(value, locale)}</span></>;
}

/** 수가 든 문장 — 서버가 수 자리에서 나눈 앞뒤 글(parts)을 주고, 수만 받아 끼운다 */
export function PopularCountText({ query, pick, parts }: { query: string; pick: string; parts: [string, string] }) {
  const locale = useLocale();
  const data = useCountsQuery<PopularCountsResponse>(`part=popular&${query}`);
  const value = data ? pickCount(data, pick) : data;
  return <>{parts[0]}{value === undefined ? <FillLine width="3em" /> : value === null ? "—" : formatNumber(value, locale)}{parts[1]}</>;
}
