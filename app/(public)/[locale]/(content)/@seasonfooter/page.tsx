import { getDictionary } from "@/lib/i18n/dictionary";
import { getRequestLocale } from "@/lib/i18n/server";
import { SeasonFooter } from "@/components/SeasonFooter";
import { OnlyOnHome } from "@/components/home/OnlyOnHome";
import { publicRead } from "@/lib/domain/products/public-reads";
import { seasonKeysWithEntries } from "@/lib/domain/ranking/season-entries";
import { getCurrentSeason, getSeasonHistory, type SeasonSummary } from "@/lib/domain/ranking/view";
import { logger } from "@/lib/observability/logger";

/**
 * 메인 푸터에만 붙는 시즌 줄.
 *
 * 푸터가 루트 레이아웃에 있어서 페이지가 그 안에 무엇을 넣을 수 없다. 병렬 라우트 슬롯이면
 * "/"에서만 이 파일이 렌더되고, 다른 경로를 새로 열면 default.tsx 가 비운다 — 상세·어드민 페이지가 시즌을 조회하지 않는다.
 * 홈에서 링크로 옮길 때 슬롯에 남는 줄은 OnlyOnHome 이 경로로 가린다(catch-all 은 루트 404 를 깨서 뺐다, ROB-01).
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
  const locale=await getRequestLocale();
  const messages=await getDictionary(locale,"browse");
  return <OnlyOnHome><SeasonFooter locale={locale} messages={messages} season={loaded.season} latestClosed={loaded.latestClosed} now={new Date()} /></OnlyOnHome>;
}
