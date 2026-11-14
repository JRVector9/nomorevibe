import type { ProductDetailView, PublicProduct } from "./detail-view";
import type { ProductListItem } from "./view";
import { compactCardItem, type CompactCardItem } from "@/components/home/compact-item";
import { detailFreshness, timelineSummary, type DetailFreshness, type TimelineSummary } from "@/components/product-detail/client-data";
import type { Locale } from "@/lib/i18n/locales";

/**
 * 상세의 부가 자료(2026-11-14 공개 HTML 줄이기) — 사실 칸(지표)·정보 카드·언어·업데이트·같은 분야 목록.
 *
 * 서버 HTML·RSC 데이터에서 빼고 같은 출처 API(/api/products/[slug]/details, 공개 API 읽기 관문)로 브라우저가 불러온다.
 * 부품이 실제로 읽는 칸만 담는다 — 내부 id·상태·판정 근거·원본 수집 값은 담지 않는다.
 */
export type DetailFactsProduct = Pick<PublicProduct, "accessMode" | "repoGone" | "repoUrl" | "createdAt">;
export type DetailInfoProduct = Pick<PublicProduct, "slug" | "url" | "accessMode" | "category" | "makerName" | "repoGone" | "repoUrl" | "stack">;

export type DetailExtras = {
  facts: {
    product: DetailFactsProduct;
    repository: ProductDetailView["repository"];
    license: ProductDetailView["license"];
    health: ProductDetailView["health"];
    visits: ProductDetailView["visits"];
  };
  info: {
    product: DetailInfoProduct;
    repository: ProductDetailView["repository"];
    freshness: DetailFreshness[];
    unclaimed: boolean;
  };
  timeline: TimelineSummary;
  related: { category: string; items: CompactCardItem[]; total: number | null; basis: ProductDetailView["relatedBasis"] };
};

export function detailExtras(detail: ProductDetailView, related: ProductListItem[], locale: Locale, now: Date): DetailExtras {
  const product = detail.product;
  return {
    facts: {
      product: { accessMode: product.accessMode, repoGone: product.repoGone, repoUrl: product.repoUrl, createdAt: product.createdAt },
      repository: detail.repository,
      license: detail.license,
      health: detail.health,
      visits: detail.visits,
    },
    info: {
      product: {
        slug: product.slug, url: product.url, accessMode: product.accessMode, category: product.category, makerName: product.makerName,
        repoGone: product.repoGone, repoUrl: product.repoUrl, stack: product.stack,
      },
      repository: detail.repository,
      freshness: detailFreshness(detail.freshness),
      unclaimed: detail.unclaimed,
    },
    timeline: timelineSummary(detail.updates, now),
    related: { category: product.category, items: related.map((item) => compactCardItem(item, locale)), total: detail.relatedTotal ?? null, basis: detail.relatedBasis },
  };
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** JSON 으로 온 시각 글자를 Date 로 — 부품이 서버에서 받던 값(Date)과 같은 모양으로 그린다 */
export function reviveDetailExtras(_key: string, value: unknown): unknown {
  return typeof value === "string" && ISO_TIME.test(value) ? new Date(value) : value;
}
