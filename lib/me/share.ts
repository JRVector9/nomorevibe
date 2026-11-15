import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { productReactions } from "@/lib/db/me-schema";
import { getProductIdentity } from "@/lib/domain/products/detail-view";
import { publicRead } from "@/lib/domain/products/public-reads";
import { teaserSummary } from "@/lib/domain/products/public-teaser";
import { selectProductTranslation } from "@/lib/domain/products/translations";
import { hiddenByDefault } from "@/lib/domain/products/visibility";
import { productReactionsEnabled } from "@/lib/domain/reactions/flags";
import { getTranslator } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/locales";
import { productTranslationSource, readTranslationsForProducts } from "@/lib/i18n/products";
import { logger } from "@/lib/observability/logger";
import { siteOrigin } from "@/lib/site";

/** 배지·공유 카드는 공개 목록에 오른 제품에만 — 아무 주소나 등록한 검증 전(unverified) 줄에 내주면 피싱에 쓰인다. 감사 보류 중인 것도 목록 밖이다 */
const CATALOG_STATUSES = ["seeded", "verified"] as const;

/**
 * 배지·공유 카드(MY8)가 읽는 공개 값 — 상세와 같은 기본 정보(목록 밖 제품은 null)와 써본 사람 수.
 * 둘 다 공개 읽기 캐시(30초, 복제본)를 탄다. 상세의 identity 열쇠를 그대로 써서 같은 값을 나눠 쓴다.
 * 주인 없는 수집 개인 프로필(Profile)은 공개 목록 어디에도 없고 noindex 라(visibility.ts, listedByDefault) «소개됨» 배지·카드도 내주지 않는다
 */
export async function publicProductIdentity(slug: string) {
  const product = await publicRead("detail", ["identity", slug], () => getProductIdentity(slug));
  if (!product || !(CATALOG_STATUSES as readonly string[]).includes(product.status) || product.auditHoldAt) return null;
  return hiddenByDefault(product.category) && product.source === "crawler" && !product.claimedAt ? null : product;
}

/** 써본 사람 — 써봤어요 평가 수. 랭킹에서 뺀 평가(의심·고장 표시)는 세지 않는다. 써봤어요를 끄면(PRODUCT_REACTIONS_ENABLED) 0 */
export async function productTriedCount(productId: number): Promise<number> {
  if (!productReactionsEnabled()) return 0;
  return publicRead("count", ["tried", productId], async () => {
    const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(productReactions)
      .where(and(eq(productReactions.productId, productId), eq(productReactions.rankingExcluded, false)));
    return row?.count ?? 0;
  });
}

export type ShareCardData = { name: string; tagline: string; brandLine: string; url: string };

/**
 * 공유 카드(SNS 설계 T13·M5)·상세 og 그림 글 — 이름·요약(그 언어의 한 줄)·사이트 표기뿐이다.
 * 공개 주소로 나가는 그림이라 스타·HN 점수·써본 사람·분야 칩과 그 날짜는 싣지 않는다(2026-11-15 사람 결정, 공개 출력은 주소·이름·요약).
 */
export async function shareCardData(slug: string, locale: Locale): Promise<ShareCardData | null> {
  const product = await publicProductIdentity(slug);
  if (!product) return null;
  const [common, translations] = await Promise.all([
    getTranslator(locale, "common"),
    readTranslationsForProducts([product], locale).catch((error) => { logger.warn("me.share_card_translation_unavailable", { error }); return []; }),
  ]);
  const translation = locale === "ko" ? null
    : selectProductTranslation(productTranslationSource(product), locale, "tagline", translations.find((row) => row.field === "tagline"));
  const { summary } = teaserSummary({ tagline: product.tagline, taglineKo: product.taglineKo, translation }, locale);
  return { name: product.name, tagline: summary, brandLine: common("site.tagline"), url: `${new URL(siteOrigin()).host}/p/${product.slug}` };
}
