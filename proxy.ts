import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { adminIngressAllowed, adminLocalLoginEnabled, adminOrigin, isAdminProtectedPath, verifyAdminSession } from "@/lib/auth/admin-access";
import { DEFAULT_LOCALE, PUBLIC_LOCALE_HEADER, type Locale } from "@/lib/i18n/locales";
import { isLocaleExcludedPath, pathLocale, stripLocale } from "@/lib/i18n/routing";

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
  const pathname = req.nextUrl.pathname;
  const locale = pathLocale(pathname);
  if (isAdminProtectedPath(stripLocale(pathname))) {
    if (locale || !adminIngressAllowed(req.headers)) return new NextResponse(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  }
  // Keep the administrator gate first, independently of all locale routing.
  if (pathname === "/admin" || pathname.startsWith("/admin/")) {
    if (pathname === "/admin/login" || pathname === "/admin/login/") return passThrough(req, DEFAULT_LOCALE);
    return protectAdmin(req);
  }

  // A prefixed machine/admin address is never normalized into an endpoint alias.
  if (locale && isLocaleExcludedPath(stripLocale(pathname))) return passThrough(req, locale);
  if (!locale && isLocaleExcludedPath(pathname)) return passThrough(req, DEFAULT_LOCALE);
  if (locale === DEFAULT_LOCALE) {
    const canonical = req.nextUrl.clone();
    canonical.pathname = stripLocale(pathname);
    return NextResponse.redirect(canonical, 308);
  }
  // Locale-prefixed machine/admin paths stay in the public tree and become 404s.
  if (locale) return passThrough(req, locale);

  const internal = req.nextUrl.clone();
  internal.pathname = `/${DEFAULT_LOCALE}${pathname === "/" ? "" : pathname}`;
  return NextResponse.rewrite(internal, { request: { headers: localeHeaders(req, DEFAULT_LOCALE) } });
}

function localeHeaders(req: NextRequest, locale: Locale): Headers {
  const headers = new Headers(req.headers);
  headers.set(PUBLIC_LOCALE_HEADER, locale);
  return headers;
}

function passThrough(req: NextRequest, locale: Locale) {
  return NextResponse.next({ request: { headers: localeHeaders(req, locale) } });
}

async function protectAdmin(req: NextRequest) {
  // GitHub OAuth 없이 로컬에서 어드민을 연다. 운영에는 ADMIN_LOCAL_LOGIN을 넣지 않는다.
  if (adminLocalLoginEnabled()) {
    return passThrough(req, DEFAULT_LOCALE);
  }

  const loginUrl = new URL("/admin/login", adminOrigin() ?? req.url);
  const session = await verifyAdminSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.redirect(loginUrl);
  }
  return passThrough(req, DEFAULT_LOCALE);
}

export const config = {
  // The function excludes APIs/files explicitly; never narrow away the admin gate.
  matcher: ["/((?!_next/static|_next/image).*)"],
};
