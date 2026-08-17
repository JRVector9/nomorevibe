import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "@/lib/auth/session";

/**
 * /admin 을 기본 차단한다.
 *
 * 페이지마다 자격 확인을 넣는 방식은 새 페이지에서 한 번 빠뜨리는 순간 열린다.
 * 기본 차단으로 두면 빠뜨려도 닫혀 있다.
 *
 * 여기서는 쿠키의 서명과 만료만 본다. 허용목록 확인은 화면에서 매 요청 다시 한다
 * (currentAdmin) — 쿠키를 발급한 뒤 목록에서 빠졌을 수 있다.
 *
 * Next 16에서 middleware가 proxy로 개명됐다. 예전 이름을 그대로 두면 지원이
 * 끊기는 순간 차단이 조용히 풀린다.
 */
export async function proxy(req: NextRequest) {
  const secret = process.env.AUTH_SECRET;
  const loginUrl = new URL("/admin/login", req.url);

  // 비밀키가 없으면 세션을 검증할 방법이 없다 — 열지 않는다
  if (!secret || secret.length < 32) {
    return NextResponse.redirect(loginUrl);
  }

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value, secret);
  if (!session) {
    return NextResponse.redirect(loginUrl);
  }
  return NextResponse.next();
}

export const config = {
  // 로그인 화면 자체는 열려 있어야 한다
  matcher: ["/admin", "/admin/((?!login).*)"],
};
