import { recordTrapHit } from "@/lib/http/anti-scrape";

/**
 * 함정 경로 — 사람과 규칙을 지키는 봇은 오지 않는 곳.
 *
 * /api/ 는 robots.txt 에서 Disallow 라 검색 엔진은 오지 않고, 화면에는 사람 눈에 안 보이는 링크(SiteFooter 의
 * TrapLink)로만 걸려 있다. 그러니 이 주소를 부른 것은 robots.txt 를 무시하고 숨은 링크까지 따라가는 수집기다.
 * 부른 IP 의 공개 API 읽기를 한동안(TRAP_BLOCK_MS) 막는다. 화면(HTML)은 막지 않는다 — 그것은 Cloudflare 몫이다.
 * 응답은 평범한 404 — 함정인지 드러내지 않는다. 엣지·브라우저가 담지 않게 no-store.
 */
const headers = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

async function trap(request: Request): Promise<Response> {
  await recordTrapHit(request);
  return Response.json({ error: "not_found" }, { status: 404, headers });
}

export const dynamic = "force-dynamic";
export const GET = trap;
export const HEAD = trap;
