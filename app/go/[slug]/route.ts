import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { findBySlug } from "@/lib/domain/products/repository";
import {
  recordClick,
  isBotAgent,
  visitorId,
  VISITOR_COOKIE,
  visitorCookieOptions,
} from "@/lib/domain/products/clicks";
import { withRoute } from "@/lib/http/handler";
import { siteOrigin } from "@/lib/site";
import { trackServer } from "@/lib/analytics/server";
import { goFallbackPath, verifyGoToken } from "@/lib/domain/products/go-token";
import { guardGoRedirect } from "@/lib/http/anti-scrape";

type Params = { params: Promise<{ slug: string }> };

/** 사람마다 다른 답(토큰·쿠키)이라 어디에도 담지 않는다 */
const NO_STORE = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;

function redirect(location: string): NextResponse {
  const response = NextResponse.redirect(location, { status: 302 });
  for (const [name, value] of Object.entries(NO_STORE)) response.headers.set(name, value);
  return response;
}

/** /go?via= — 어디서 눌렀는지 표시하는 짧은 코드만 분석에 싣는다(그 밖의 질의는 버린다) */
const VIA = /^[a-z0-9_-]{1,32}$/;

/** 설치형 제품과 GitHub 주소는 저장소로 나간다 — 화면의 '저장소 열기'와 같은 갈래 */
function linkKind(product: { url: string; accessMode: string }): "site" | "repo" {
  if (product.accessMode === "installable") return "repo";
  try {
    return new URL(product.url).hostname === "github.com" ? "repo" : "site";
  } catch {
    return "site";
  }
}

/**
 * 제품으로 나가는 문.
 *
 * 목록에서 제품 주소로 바로 걸면 누가 무엇을 눌렀는지 알 수 없다. 한 번 거쳐 가게 해서
 * 세고 보낸다. JS 없이도 동작하고, 세는 쪽이 서버라 클라이언트가 조작할 수 없다.
 *
 * 차단된 제품은 내보내지 않는다 — 목록에서 내린 것을 링크로 우회할 수 있으면 내린 의미가 없다.
 *
 * 바깥 주소는 보호 API(/api/products/[slug]/details)가 내준 서명 토큰(?t=, go-token.ts)이 있을 때만 준다(2026-11-15).
 * 토큰이 없거나 틀리거나 지났으면 상세(/p/<slug>, 언어 접두 유지)로 돌려보내고 세지 않는다 — slug 만으로 바깥 주소를 얻지 못한다.
 * IP 마다 10분 60번 한도(넘치면 429), 응답은 담지 않는다(no-store).
 *
 * 세지 않는 경우가 둘 있다. 봇이거나(랭킹이 크롤 빈도순이 되면 안 된다), 기록이 실패한
 * 경우다. 어느 쪽이든 이동은 그대로 시킨다 — 사용자는 제품으로 가는 중이다.
 */
export const GET = withRoute("products.go", async (req: Request, { params }: Params) => {
  const limited = await guardGoRedirect(req);
  if (limited) return limited;
  const { slug } = await params;
  const origin = siteOrigin(req);
  const check = verifyGoToken(slug, new URL(req.url).searchParams.get("t"));
  if (check !== "valid") return redirect(`${origin}${goFallbackPath(slug, req, origin)}`);

  const product = await findBySlug(slug);
  if (!product || product.status === "banned") return redirect(origin);

  const response = redirect(product.url);
  if (isBotAgent(req.headers.get("user-agent"))) return response;

  /**
   * 방문 분석의 '실제로 나갔다'(outbound_visit) — 봇을 거른 뒤, 응답을 보낸 다음에 보낸다(이동 시간은 그대로).
   * DB 의 유효 방문과 다르다: 10분 중복을 묶지 않고, 분석에 동의한 브라우저(_ga)만 센다. 순위의 기준은 여전히 DB 다.
   */
  const via = new URL(req.url).searchParams.get("via");
  trackServer("outbound_visit", {
    product_slug: product.slug, link_kind: linkKind(product), ...(via && VIA.test(via) ? { via } : {}),
  }, { request: req, identity: "browser" });

  /**
   * 방문자 구분은 우리 쿠키로 한다. 원문은 응답 쿠키에만 쓰고, 기록 전에 제품별 HMAC으로
   * 바꾼다. IP는 프록시 설정(TRUSTED_PROXY_HOPS)에 기대지 않는다.
   */
  const existing = (await cookies()).get(VISITOR_COOKIE)?.value;
  const visitor = visitorId(existing);
  if (visitor !== existing) {
    response.cookies.set(VISITOR_COOKIE, visitor, visitorCookieOptions);
  }

  await recordClick(slug, visitor);
  return response;
});
