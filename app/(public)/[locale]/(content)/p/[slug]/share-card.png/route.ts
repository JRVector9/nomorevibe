import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { isLocale } from "@/lib/i18n/locales";
import { shareCardData } from "@/lib/me/share";
import { shareCardPng } from "@/lib/me/share-card";

type Params = { params: Promise<{ locale: string; slug: string }> };

/** Cloudflare 가 하루, 브라우저가 한 시간 — 숫자는 카드에 적힌 날짜의 값이다. 내린 제품은 p-<slug> 태그로 함께 지운다(lib/cdn/purge.ts) */
const CARD_CACHE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";

/**
 * 공유 카드(MY8, SNS 설계 T13) — `/p/<slug>/share-card.png`(언어마다 앞붙이기). 상세의 og:image 는 바꾸지 않는다 —
 * 메이커가 배지·공유 카드 칸(ShareKit)에서 이 그림 주소를 복사하거나 연다. 내려간·없는·검증 전(unverified) 제품은 404.
 */
export const GET = withRoute("products.share_card", async (_req: Request, { params }: Params) => {
  const { locale, slug } = await params;
  const data = isLocale(locale) ? await shareCardData(slug, locale) : null;
  if (!data || !isLocale(locale)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: { "cache-control": "public, max-age=300" } });
  const png = await shareCardPng(data, locale);
  return new NextResponse(new Uint8Array(png), {
    headers: { "content-type": "image/png", "cache-control": CARD_CACHE, "cache-tag": `p-${slug}` },
  });
});
