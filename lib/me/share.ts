import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { translatedCategory } from "@/components/home/i18n";
import { db } from "@/lib/db";
import { productReactions } from "@/lib/db/me-schema";
import { getProductIdentity } from "@/lib/domain/products/detail-view";
import { publicRead } from "@/lib/domain/products/public-reads";
import { selectProductTranslation } from "@/lib/domain/products/translations";
import { TRIED_BADGE_MIN } from "@/lib/domain/products/badge";
import { hiddenByDefault } from "@/lib/domain/products/visibility";
import { productReactionsEnabled } from "@/lib/domain/reactions/flags";
import { getTranslator } from "@/lib/i18n/dictionary";
import { formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/locales";
import { productTranslationSource, readTranslationsForProducts } from "@/lib/i18n/products";
import { logger } from "@/lib/observability/logger";
import { siteOrigin } from "@/lib/site";
import { talkPublicEnabled } from "@/lib/social/flags";
import { productTalk } from "@/lib/social/talk";

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

export type ShareCardData = {
  name: string; tagline: string; brandLine: string; chips: { text: string; hn?: true }[]; url: string; date: string;
};

/**
 * 공유 카드(SNS 설계 T13·M5) 글 — 이름·한 줄 소개(그 언어)·사실 칩. 화제 근거(HN 점수)가 있으면 앞에, 없으면 분야를 둔다.
 * 숫자는 카드를 만든 때의 값이라 날짜를 함께 적는다.
 */
export async function shareCardData(slug: string, locale: Locale, now = new Date()): Promise<ShareCardData | null> {
  const product = await publicProductIdentity(slug);
  if (!product) return null;
  const [me, common, labels, tried, translations, talk] = await Promise.all([
    getTranslator(locale, "me"), getTranslator(locale, "common"), getTranslator(locale, "labels"),
    productTriedCount(product.id),
    readTranslationsForProducts([product], locale).catch((error) => { logger.warn("me.share_card_translation_unavailable", { error }); return []; }),
    talkPublicEnabled() ? productTalk(product.id, product.repoUrl, now).catch(() => null) : Promise.resolve(null),
  ]);
  const tagline = locale === "ko" ? product.taglineKo?.trim() || product.tagline
    : selectProductTranslation(productTranslationSource(product), locale, "tagline", translations.find((row) => row.field === "tagline")).text;
  const hn = talk?.posts.filter((post) => post.source === "hn").sort((a, b) => b.points - a.points)[0];
  const chips: ShareCardData["chips"] = [];
  if (hn) chips.push({ text: me("share.cardHn", { points: formatNumber(hn.points, locale), comments: formatNumber(hn.comments, locale) }), hn: true });
  if (typeof product.stars === "number") chips.push({ text: me("share.cardStars", { count: formatNumber(product.stars, locale) }) });
  if (tried >= TRIED_BADGE_MIN) chips.push({ text: me("share.cardTried", { count: formatNumber(tried, locale) }) });
  if (!hn) chips.push({ text: translatedCategory(product.category, labels) });
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return {
    name: product.name, tagline, brandLine: common("site.tagline"), chips: chips.slice(0, 3),
    url: `${new URL(siteOrigin()).host}/p/${product.slug}`, date: me("share.cardDate", { date }),
  };
}
