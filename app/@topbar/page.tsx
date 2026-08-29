import { MarketStats } from "@/components/MarketStats";
import { marketStats, type MarketStats as Stats } from "@/lib/domain/products/stats";
import { getCurrentSeason } from "@/lib/domain/ranking/view";
import { logger } from "@/lib/observability/logger";

/**
 * 메인에서만 뜨는 상단 한 줄.
 *
 * 헤더가 루트 레이아웃에 있어서 페이지가 그 위에 무엇을 둘 수 없다. 병렬 라우트 슬롯으로
 * 두면 이 파일이 "/"에서만 렌더되고, 다른 경로는 [...catchAll]/page.tsx(소프트 내비게이션)와
 * default.tsx(하드 내비게이션)가 아무것도 내지 않는다. 그래서 상세·어드민 페이지는 이
 * 조회를 하지 않는다. 둘 중 하나만 두면 링크로 이동했을 때 이 줄이 따라온다.
 *
 * 조회는 try 안에서, JSX는 밖에서 만든다 — try/catch는 렌더 중 오류를 잡지 못한다.
 */
export default async function MarketStatsBar() {
  let loaded: { stats: Stats; windowHours: number } | null = null;
  try {
    const season = await getCurrentSeason();
    const windowHours = season?.policy.trend.windowHours ?? 24;
    loaded = { stats: await marketStats({ windowHours }), windowHours };
  } catch (error) {
    // 숫자 한 줄 때문에 헤더와 목록까지 못 보게 만들 수는 없다
    logger.warn("home.stats_unavailable", { error });
  }

  if (!loaded) return null;
  return <MarketStats stats={loaded.stats} windowHours={loaded.windowHours} />;
}
