import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { isLocale } from "@/lib/i18n/locales";
import { shareCardData } from "@/lib/me/share";
import { shareCardJpeg } from "@/lib/me/share-card";

type Params = { params: Promise<{ locale: string; slug: string }> };

/** share-card.png 와 같다 — Cloudflare 하루, 브라우저 한 시간. 내린 제품은 p-<slug> 태그로 함께 지운다(lib/cdn/purge.ts) */
const CARD_CACHE = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400";

/**
 * 상세 og:image·twitter:image — `/p/<slug>/og.jpg`(언어마다 앞붙이기, lib/copy/share.ts productOgImage).
 * 공유 카드(share-card.png)와 같은 그림(이름·요약·사이트 표기, 칩 없음)을 1200×630 JPEG 로 준다.
 * 내려간·없는·검증 전(unverified) 제품은 404.
 */
export const GET = withRoute("products.og_image", async (_req: Request, { params }: Params) => {
  const { locale, slug } = await params;
  const data = isLocale(locale) ? await shareCardData(slug, locale) : null;
  // 404 도 그 제품의 태그를 단다 — 감사 보류가 풀리면 그 지우기(p-<slug>)가 이 사본도 지운다. 주소 모양이 아니면 달지 않는다
  if (!data || !isLocale(locale)) return NextResponse.json({ error: "not_found" }, { status: 404,
    headers: { "cache-control": "public, max-age=300", ...(/^[a-z0-9-]{1,80}$/.test(slug) ? { "cache-tag": `p-${slug}` } : {}) } });
  const jpeg = await shareCardJpeg(data, locale);
  return new NextResponse(new Uint8Array(jpeg), {
    headers: { "content-type": "image/jpeg", "cache-control": CARD_CACHE, "cache-tag": `p-${slug}` },
  });
});
