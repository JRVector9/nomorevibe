import type { MetadataRoute } from "next";
import { createMemo } from "@/lib/cache/memo";
import { onReplica } from "@/lib/db";
import { CATEGORIES } from "@/lib/domain/products/categories";
import { listIndexableSlugs } from "@/lib/domain/products/indexing";
import { hiddenByDefault } from "@/lib/domain/products/visibility";
import { seasonKeysWithEntries } from "@/lib/domain/ranking/season-entries";
import { getCurrentSeason, getSeasonHistory } from "@/lib/domain/ranking/view";
import { siteOrigin } from "@/lib/site";

/**
 * 검색엔진에게 어디를 보라고 알린다.
 *
 * 상세는 색인해도 되는 제품만 싣는다(lib/domain/products/indexing.ts, 2026-10-09 운영자 결정 D1) — 주인이 있는 공개 제품과,
 * 주인이 없어도 AI 근거가 확인된 공개 제품. 내려달라는 요청이 걸린 것은 빠진다. 상세 페이지의 robots 와 같은 규칙이라
 * 여기 실린 주소가 noindex 를 내지 않는다.
 * 분야 목록(/c/<분야>)은 기본 목록에서 가리는 분야(개인 프로필, visibility.ts)를 뺀 전부, 랭킹은 순위에 오른 제품이 있는
 * 시즌만 싣는다 — 빈 랭킹은 표 머리뿐이다(UX-09). 닫힌 시즌은 당시 규칙이 잠긴 기록이라 바뀌지 않는다.
 *
 * 파일 하나에 주소 5만 개까지다(sitemaps.org). 상세 49,000 + 시즌 최대 501 + 분야·고정 화면 스물몇 개로 그 아래를 지킨다.
 *
 * DB를 읽으므로 빌드 시점에 굳히지 않는다. 홈과 같은 이유다.
 */
export const dynamic = "force-dynamic";

/** 상세 주소 상한 — 나머지 자리는 시즌·분야·고정 화면 몫이다 */
const SITEMAP_PRODUCT_LIMIT = 49_000;
/** 닫힌 시즌 상한 — 주간이면 10년 치 */
const SITEMAP_SEASON_LIMIT = 500;

/**
 * 색인할 제품 목록은 10분 들고 있는다. 공개 3.7만 건을 훑으며 제품마다 근거 색인을 짚는 조회라 요청마다 돌리지 않는다.
 * 내려달라는 요청으로 빠진 제품이 그동안 sitemap 에 남아도 상세 페이지가 그 즉시 noindex 를 낸다.
 */
const indexable = createMemo<{ slug: string; updatedAt: Date }[]>({ ttlMs: 10 * 60_000, max: 1 });

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  const [products, current, closed] = await Promise.all([
    indexable.get("products", () => onReplica(() => listIndexableSlugs(SITEMAP_PRODUCT_LIMIT))),
    getCurrentSeason(),
    getSeasonHistory(SITEMAP_SEASON_LIMIT),
  ]);
  const seasons = current ? [current, ...closed] : closed;
  const listed = new Set(await seasonKeysWithEntries(seasons.map((season) => season.key)));

  return [
    { url: `${origin}/`, changeFrequency: "hourly", priority: 1 },
    { url: `${origin}/popular`, changeFrequency: "daily", priority: 0.7 },
    { url: `${origin}/launch`, changeFrequency: "monthly", priority: 0.5 },
    { url: `${origin}/policy`, changeFrequency: "monthly", priority: 0.3 },
    ...CATEGORIES.filter((category) => !hiddenByDefault(category)).map((category) => ({
      url: `${origin}/c/${category.toLowerCase()}`,
      changeFrequency: "daily" as const,
      priority: 0.6,
    })),
    ...products.map((product) => ({
      url: `${origin}/p/${product.slug}`,
      lastModified: product.updatedAt,
      changeFrequency: "daily" as const,
      priority: 0.8,
    })),
    ...seasons.filter((season) => listed.has(season.key)).map((season) => ({
      url: `${origin}/rankings/${season.key}`,
      lastModified: season.refreshedAt ?? season.startsAt,
      changeFrequency: season.state === "active" ? ("hourly" as const) : ("yearly" as const),
      priority: season.state === "active" ? 0.7 : 0.4,
    })),
  ];
}
