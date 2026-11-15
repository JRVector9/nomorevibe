import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { isLocale } from "@/lib/i18n/locales";
import { shareCardData } from "@/lib/me/share";
import { shareCardPng } from "@/lib/me/share-card";

type Params = { params: Promise<{ locale: string; slug: string }> };

/** Cloudflare 가 하루, 브라우저가 한 시간. 내린 제품은 p-<slug> 태그로 함께 지운다(lib/cdn/purge.ts) */
const CARD_CACHE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";

/**
 * 공유 카드(MY8, SNS 설계 T13) — `/p/<slug>/share-card.png`(언어마다 앞붙이기). 메이커가 배지·공유 카드 칸(ShareKit)에서
 * 이 그림 주소를 복사하거나 연다. 공개 주소라 이름·요약·사이트 표기만 그린다(칩 없음).
 * 상세 페이지의 공유 미리보기(og:image·twitter:image·JSON-LD image)도 이 카드다(2026-11-15 사람 결정) — 상세가 열리는 제품이면 나오고,
 * 내려간(banned)·없는 제품은 404. 옛 표지 주소(/api/og-cache/<slug>)도 여기로 넘어온다.
 */
export const GET = withRoute("products.share_card", async (_req: Request, { params }: Params) => {
  const { locale, slug } = await params;
  const data = isLocale(locale) ? await shareCardData(slug, locale) : null;
  // 404 도 그 제품의 태그를 단다 — 감사 보류가 풀리면 그 지우기(p-<slug>)가 이 사본도 지운다. 주소 모양이 아니면 달지 않는다
  if (!data || !isLocale(locale)) return NextResponse.json({ error: "not_found" }, { status: 404,
    headers: { "cache-control": "public, max-age=300", ...(/^[a-z0-9-]{1,80}$/.test(slug) ? { "cache-tag": `p-${slug}` } : {}) } });
  const png = await shareCardPng(data, locale);
  return new NextResponse(new Uint8Array(png), {
    headers: { "content-type": "image/png", "cache-control": CARD_CACHE, "cache-tag": `p-${slug}` },
  });
});
