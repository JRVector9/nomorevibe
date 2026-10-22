import { NextResponse } from "next/server";
import { BADGE_CONTENT_TYPE, listedBadgeSvg, triedBadgeSvg, TRIED_BADGE_MIN, verifiedBadgeSvg } from "@/lib/domain/products/badge";
import { withRoute } from "@/lib/http/handler";
import { productTriedCount, publicProductIdentity } from "@/lib/me/share";
import { trackServer } from "@/lib/analytics/server";

type Params = { params: Promise<{ slug: string }> };

/** 브라우저·GitHub 이미지 프록시 한 시간, 지난 사본은 하루까지. 내린 제품은 상세와 같은 p-<slug> 태그로 함께 지운다 */
const BADGE_CACHE = "public, max-age=3600, stale-while-revalidate=86400";

/**
 * README용 배지.
 *
 * 메이커가 등록해서 얻는 것이 상세 페이지 하나였다. 배지는 메이커에게는 신뢰 표시이고 우리에게는 백링크다.
 * 검증된 제품은 지금처럼 «✓ verified»(주소·모양 그대로). 수집된 공개 제품(seeded)은 «listed»(SNS 설계 T12 — 미확인 제품에도 사실만 말하는 배지).
 * `?style=tried` 는 써본 사람이 3명 이상일 때 «tried by N», 그 전에는(써봤어요를 껐을 때도) 기본 배지와 같다. `?lang=ko` 는 한국어 글자.
 * 없거나 내려간 제품, 검증 진행 중(unverified — 누구나 아무 주소로 등록한다)인 제품, 목록에서 빼는 주인 없는 개인 프로필은 404다 — 배지가 없는 것이 곧 정보다.
 */
/** 캐시 태그에 실을 수 있는 주소 — 제품 slug 의 모양(영소문자·숫자·하이픈) */
const SLUG_TAG = /^[a-z0-9-]{1,80}$/;

export const GET = withRoute("products.badge", async (req: Request, { params }: Params) => {
  const { slug: raw } = await params;
  // 마크다운에서 이미지처럼 읽히도록 .svg를 붙여 부를 수 있게 한다
  const slug = raw.endsWith(".svg") ? raw.slice(0, -4) : raw;
  const query = new URL(req.url).searchParams;
  const lang = query.get("lang") === "ko" ? "ko" : "en";

  const product = await publicProductIdentity(slug);
  if (!product) {
    // 404 도 그 제품의 태그를 단다 — 감사 보류가 풀리거나 검증되면 그 지우기(p-<slug>)가 이 사본도 지운다. 주소 모양이 아니면 달지 않는다
    return NextResponse.json({ error: "공개된 제품에만 배지를 내줍니다" }, { status: 404,
      headers: { "cache-control": "public, max-age=300", ...(SLUG_TAG.test(slug) ? { "cache-tag": `p-${slug}` } : {}) } });
  }
  const tried = query.get("style") === "tried" ? await productTriedCount(product.id) : 0;
  const style = tried >= TRIED_BADGE_MIN ? "tried" : product.status === "verified" ? "verified" : "listed";
  const svg = style === "tried" ? triedBadgeSvg(product.name, tried, lang)
    : style === "verified" ? verifiedBadgeSvg() : listedBadgeSvg(product.name, lang);
  /**
   * 방문 분석: 배지를 내줬다 — 사람을 잇지 않는 합계(aggregate). 브라우저·GitHub 이미지 프록시가 한 시간 들고 있으므로
   * 캐시가 빈 때만 여기 온다(노출의 하한). README 를 본 사람 수가 아니다.
   */
  trackServer("badge_impression", { product_slug: slug, badge_style: style, badge_lang: lang }, { request: req, identity: "aggregate" });

  return new NextResponse(svg, {
    headers: { "content-type": BADGE_CONTENT_TYPE, "cache-control": BADGE_CACHE, "cache-tag": `p-${slug}` },
  });
});
