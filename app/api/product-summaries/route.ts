import { PublicAuthError } from "@/lib/domain/accounts/request-auth";
import { publicRead } from "@/lib/domain/products/public-reads";
import { withRoute } from "@/lib/http/handler";
import { DEFAULT_LOCALE, isLocale } from "@/lib/i18n/locales";
import { localizeSummaries, readSavedJson, readSlugList, savedSummaries, SUMMARY_BODY_BYTES, SUMMARY_SLUG_LIMIT } from "@/lib/me/saved";
import { logger } from "@/lib/observability/logger";

/** 쿠키를 읽지 않는 공개 읽기 — 누가 불러도 같은 답이다. 몸이 있는 요청이라 엣지·브라우저는 담지 않는다 */
const headers = { "Cache-Control": "no-store" };

/**
 * 로그아웃 마이페이지의 '이 브라우저에 있는 것' 카드(시안 MY2·3.7) — 이 브라우저가 저장한 주소 중 공개 제품만, 보낸 순서대로.
 * 주소 목록은 개인 정보라 주소창(GET)에 싣지 않는다. 읽기는 복제본에서 30초 담는다(public-reads.ts) — 내린 제품은 상세와 같이 빠진다.
 * /api/products/[slug] 와 겹치지 않게 따로 둔다('summaries' 라는 제품의 공개 API 를 가리지 않는다). 읽기지만 POST 라 다른 POST 처럼 쓰기 관문을 지난다
 * (fenced DB 동안은 503 — 브라우저 목록은 그대로고 카드만 못 그린다).
 */
export const POST = withRoute("products.summaries", async (request: Request) => {
  try {
    const body = await readSavedJson(request, SUMMARY_BODY_BYTES);
    const slugs = [...new Set(readSlugList(body, SUMMARY_SLUG_LIMIT))];
    const items = await publicRead("list", ["saved-summaries", slugs], () => savedSummaries(slugs));
    return Response.json({ items: await localizeSummaries(items, isLocale(body.locale) ? body.locale : DEFAULT_LOCALE) }, { headers });
  } catch (error) {
    if (error instanceof PublicAuthError) return Response.json({ error: error.code }, { status: error.status, headers });
    logger.warn("products.summaries_failed", { error });
    return Response.json({ error: "summaries_unavailable" }, { status: 503, headers });
  }
});
