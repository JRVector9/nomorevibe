import type { FreshnessView, ProductUpdateView, PublicProduct } from "@/lib/domain/products/detail-view";

/**
 * 상세의 브라우저 부품에 넘기는 값 — 부품이 실제로 읽는 칸만 고른다(2026-11-11 상세 HTML 줄이기).
 *
 * 브라우저 부품의 속성은 HTML 안 RSC 데이터에 한 번 더 실린다. 제품 행 전체(긴 설명·내부 시각·색인 판단 값),
 * 출처의 원본 수집 값(GitHub 응답 사본까지), 업데이트 50건을 그대로 넘기면 화면에 보이지 않는 글이 상세마다 수~수십 KB 붙었다.
 * 서버 부품(소개·README·JSON-LD)은 여전히 원래 값을 쓴다.
 */

/** 히어로·사실 칸·정보 카드·미리보기가 읽는 제품 칸 */
export type DetailClientProduct = Pick<PublicProduct,
  | "slug" | "url" | "accessMode" | "name" | "tagline" | "taglineSource" | "taglineKo" | "translation"
  | "category" | "stack" | "ogImage" | "makerName" | "repoUrl" | "repoGone" | "stars" | "status" | "createdAt">;

export function detailClientProduct(product: PublicProduct): DetailClientProduct {
  return {
    slug: product.slug, url: product.url, accessMode: product.accessMode, name: product.name,
    tagline: product.tagline, taglineSource: product.taglineSource, taglineKo: product.taglineKo, translation: product.translation,
    category: product.category, stack: product.stack, ogImage: product.ogImage, makerName: product.makerName,
    repoUrl: product.repoUrl, repoGone: product.repoGone, stars: product.stars, status: product.status, createdAt: product.createdAt,
  };
}

/** 정보 카드의 '정보 갱신' 줄 — 어디서(provider) 언제(lastSuccessAt) 읽었는지만 */
export type DetailFreshness = Pick<FreshnessView, "provider" | "lastSuccessAt">;

export function detailFreshness(freshness: FreshnessView[]): DetailFreshness[] {
  return freshness.map(({ provider, lastSuccessAt }) => ({ provider, lastSuccessAt }));
}

/** 업데이트 목록은 최신 세 줄만 그린다 — 나머지는 건수로만 쓴다 */
export const TIMELINE_LIMIT = 3;
const DAY = 86_400_000;

export type TimelineUpdate = Pick<ProductUpdateView, "id" | "sourceKind" | "canonicalUrl" | "title" | "publishedAt" | "observedAt">;
export type TimelineSummary = { rows: TimelineUpdate[]; total: number; recent: number };

/**
 * 최신순으로 정렬된 업데이트(상세 조회)에서 그릴 세 줄과 두 수 — 전체 건수, 최근 30일 건수(발행일이 없으면 처음 본 날로 센다).
 * now 는 화면이 날짜를 그리는 서버 시각과 같아야 30일 셈이 화면의 날짜와 맞는다.
 */
export function timelineSummary(updates: ProductUpdateView[], now: Date): TimelineSummary {
  const since = now.getTime() - 30 * DAY;
  return {
    rows: updates.slice(0, TIMELINE_LIMIT).map(({ id, sourceKind, canonicalUrl, title, publishedAt, observedAt }) =>
      ({ id, sourceKind, canonicalUrl, title, publishedAt, observedAt })),
    total: updates.length,
    recent: updates.filter((update) => (update.publishedAt ?? update.observedAt).getTime() >= since).length,
  };
}
