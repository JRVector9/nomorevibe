import { NextResponse } from "next/server";
import { readSeasonByKey } from "@/lib/domain/ranking/season-read";
import { rankingRowData, type SeasonRankingResponse } from "@/lib/domain/ranking/season-rows";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { withRoute } from "@/lib/http/handler";
import { errorResponse } from "@/lib/http/respond";

type Params = { params: Promise<{ key: string }> };

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;

/**
 * 시즌 랭킹 표 채우기(2026-11-15 공개 HTML 이름·요약만) — /rankings/[key] 서버 HTML 에는 순위 자리·이름·요약·링크만 있다.
 * 점수·변동·가중치·지난 순위·상태 배지·응답 없음 표시는 브라우저가 여기서 받는다(시즌 화면과 같은 읽기·같은 열쇠).
 * 공개 API 읽기 관문을 그대로 거치고 엣지에 담지 않는다. 없는 시즌은 404.
 */
export const GET = withRoute("rankings.season", async (req: Request, { params }: Params) => {
  const refused = await guardPublicApiRead(req, "rankings.season");
  if (refused) return refused;
  const { key } = await params;
  const result = await readSeasonByKey(key);
  if (!result) return errorResponse({ kind: "not_found" });
  return NextResponse.json({ items: result.items.map(rankingRowData) } satisfies SeasonRankingResponse, { headers: NO_STORE });
});
