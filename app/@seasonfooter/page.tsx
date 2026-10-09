import { SeasonFooter } from "@/components/SeasonFooter";
import { publicRead } from "@/lib/domain/products/public-reads";
import { seasonKeysWithEntries } from "@/lib/domain/ranking/season-entries";
import { getCurrentSeason, getSeasonHistory, type SeasonSummary } from "@/lib/domain/ranking/view";
import { logger } from "@/lib/observability/logger";

/**
 * 메인 푸터에만 붙는 시즌 줄.
 *
 * 푸터가 루트 레이아웃에 있어서 페이지가 그 안에 무엇을 넣을 수 없다. 병렬 라우트 슬롯이면
 * "/"에서만 이 파일이 렌더되고, 다른 경로는 [...catchAll]/page.tsx(소프트 내비게이션)와
 * default.tsx(하드 내비게이션)가 비운다 — 상세·어드민 페이지가 시즌을 조회하지 않는다.
 *
 * 순위에 오른 제품이 없는 시즌이면 줄째로 그리지 않는다(2026-10-08 UX 감사 UX-09) — 줄의 링크가 표 머리뿐인
 * 빈 랭킹으로 보냈다. 지난 시즌 링크도 그 시즌에 제품이 있을 때만 둔다. 다시 순위가 생기면 저절로 돌아온다.
 */
export default async function SeasonFooterSlot() {
  let loaded: { season: SeasonSummary; latestClosed: SeasonSummary | null } | null = null;
  try {
    const [season, history] = await Promise.all([getCurrentSeason(), getSeasonHistory(1)]);
    const closed = history[0] ?? null;
    if (season) {
      const keys = [season.key, ...(closed ? [closed.key] : [])];
      const listed = await publicRead("count", ["season-listed", ...keys], () => seasonKeysWithEntries(keys));
      if (listed.includes(season.key)) {
        loaded = { season, latestClosed: closed && listed.includes(closed.key) ? closed : null };
      }
    }
  } catch (error) {
    // 시즌 한 줄 때문에 푸터를 통째로 잃을 수는 없다
    logger.warn("home.season_footer_unavailable", { error });
  }

  if (!loaded) return null;
  return <SeasonFooter season={loaded.season} latestClosed={loaded.latestClosed} now={new Date()} />;
}
