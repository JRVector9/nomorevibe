import { NextResponse } from "next/server";
import { detailExtras } from "@/lib/domain/products/detail-extras";
import { detailPageData } from "@/lib/domain/products/detail-page-data";
import { getProductDetail } from "@/lib/domain/products/detail-view";
import { publicRead } from "@/lib/domain/products/public-reads";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { withRoute } from "@/lib/http/handler";
import { errorResponse } from "@/lib/http/respond";
import { localizeProductList } from "@/lib/i18n/products";
import { isLocale, DEFAULT_LOCALE } from "@/lib/i18n/locales";

type Params = { params: Promise<{ slug: string }> };

const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;

/**
 * 상세의 부가 자료(사실 칸·정보 카드·언어·업데이트·같은 분야 목록, 2026-11-15 부터 머리·소개·미리보기·운영자 상자까지) — 서버 HTML 에서 빼고 브라우저가 이 같은 출처 API 로 불러온다
 * (2026-11-14 공개 HTML 줄이기). 공개 API 읽기 관문을 그대로 거치고, 상세 화면과 같은 짧은 읽기 캐시(publicRead "detail")를 쓴다.
 * ?locale= 은 같은 분야 카드의 소개 언어다(모르는 값이면 기본 언어).
 */
export const GET = withRoute("products.details", async (req: Request, { params }: Params) => {
  const refused = await guardPublicApiRead(req, "products.details");
  if (refused) return refused;
  const { slug } = await params;
  const requested = new URL(req.url).searchParams.get("locale");
  const locale = requested && isLocale(requested) ? requested : DEFAULT_LOCALE;
  const detail = await publicRead("detail", ["detail", slug], () => getProductDetail(slug));
  if (!detail) return errorResponse({ kind: "not_found" });
  const [related, [product]] = await Promise.all([
    localizeProductList(detail.related, locale),
    localizeProductList([detail.product], locale, ["tagline", "description"]),
  ]);
  // 머리·소개·미리보기·운영자 상자(2026-11-15 공개 HTML 이름·요약만) — 상세 서버 HTML 에는 이름·요약만 남는다
  const page = await detailPageData(detail, product);
  return NextResponse.json({ ...detailExtras(detail, related, locale, new Date()), ...page }, { headers: NO_STORE });
});
