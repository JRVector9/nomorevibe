import type { MetadataRoute } from "next";
import { listVerifiedSlugs } from "@/lib/domain/products/repository";
import { getCurrentSeason, getSeasonHistory } from "@/lib/domain/ranking/view";
import { siteOrigin } from "@/lib/site";

/**
 * 검색엔진에게 어디를 보라고 알린다.
 *
 * 지금까지는 링크를 타고 오는 것 말고는 상세 페이지를 찾을 길이 없었다.
 *
 * 검증된 제품만 싣는다. 상세 페이지가 검증되지 않은 제품을 noindex로 두므로(app/p/[slug]),
 * 여기 실어봐야 크롤러가 와서 색인하지 말라는 말을 듣고 돌아간다. 시즌 페이지는 닫힌 것과
 * 진행 중인 것을 모두 싣는다 — 당시 규칙이 잠긴 기록이라 바뀌지 않는다.
 *
 * DB를 읽으므로 빌드 시점에 굳히지 않는다. 홈과 같은 이유다.
 */
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  const [verified, current, closed] = await Promise.all([
    listVerifiedSlugs(50_000),
    getCurrentSeason(),
    getSeasonHistory(1_000),
  ]);
  const seasons = current ? [current, ...closed] : closed;

  return [
    { url: `${origin}/`, changeFrequency: "hourly", priority: 1 },
    { url: `${origin}/launch`, changeFrequency: "monthly", priority: 0.5 },
    ...verified.map((product) => ({
      url: `${origin}/p/${product.slug}`,
      lastModified: product.updatedAt,
      changeFrequency: "daily" as const,
      priority: 0.8,
    })),
    ...seasons.map((season) => ({
      url: `${origin}/rankings/${season.key}`,
      lastModified: season.refreshedAt ?? season.startsAt,
      changeFrequency: season.state === "active" ? ("hourly" as const) : ("yearly" as const),
      priority: season.state === "active" ? 0.7 : 0.4,
    })),
  ];
}
