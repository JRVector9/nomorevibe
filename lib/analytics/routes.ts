import type { AnalyticsLocale, AnalyticsPageType } from "@/lib/analytics/events";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import { isLocaleExcludedPath, pathLocale, stripLocale } from "@/lib/i18n/routing";

/**
 * 어느 주소에서 방문 분석을 켜는가, 그 화면은 무슨 갈래인가(2026-10-22).
 *
 * 공개 화면에서만 켠다 — 관리자(/admin, 운영자 묶음 app/(operator)), 기계용 주소(/api·/go·/badge·피드·사이트맵·설치 스크립트),
 * 로그인 콜백(/api/auth/**·/oauth·/webhooks)은 끈다. 로더는 공개 화면 틀(components/home/PublicShell.tsx)에만 있어
 * 관리자 화면에는 처음부터 없다. 여기 규칙은 그 위에 한 번 더 거는 안전장치다.
 */

const AUTH_CALLBACK = /(?:^|\/)(?:callback|oauth)(?:\/|$)/;

/** 분석을 보내지 않는 주소 — 언어 접두가 붙어 있어도 같다 */
export function isAnalyticsExcludedPath(pathname: string): boolean {
  let path: string;
  try {
    path = stripLocale(pathname.split(/[?#]/, 1)[0] || "/");
  } catch {
    return true;
  }
  if (path === "/admin" || path.startsWith("/admin/")) return true;
  if (AUTH_CALLBACK.test(path)) return true;
  return isLocaleExcludedPath(path);
}

/** 홈 주소에 이 질의가 있으면 거르기·찾아보기 화면이다(SiteHeader 의 FILTER_PARAMS 와 같은 뜻) */
const BROWSE_PARAMS = ["category", "sort", "builder", "observedTool", "ai", "saved", "new", "metric"];

/** 주소 → 화면 갈래. 검색어(q)가 있는 홈은 search, 거르기가 있는 홈과 분야 주소는 browse */
export function pageType(pathname: string, search: string | URLSearchParams = ""): AnalyticsPageType {
  let path: string;
  try {
    path = stripLocale(pathname.split(/[?#]/, 1)[0] || "/").replace(/(.)\/$/, "$1");
  } catch {
    return "other";
  }
  const params = typeof search === "string" ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search) : search;
  if (path === "/") {
    if ((params.get("q") ?? "").trim()) return "search";
    return BROWSE_PARAMS.some((key) => params.has(key)) ? "browse" : "home";
  }
  const [, first, second, third] = path.split("/");
  switch (first) {
    case "c": return second ? "browse" : "other";
    case "p": return !second ? "other" : third === "github" ? "product_settings" : third ? "other" : "product";
    case "talk": return second ? "other" : "talk";
    case "popular": return second ? "other" : "popular";
    case "rising": return second ? "other" : "rising";
    case "rankings": return second ? "rankings" : "other";
    case "launch": return second ? "other" : "launch";
    case "policy": return second ? "other" : "policy";
    case "me": return "me";
    case "login": return second ? "other" : "login";
    case "feedback": return second ? "feedback" : "other";
    default: return "other";
  }
}

/** 주소의 언어 — 접두가 없으면 한국어 */
export function pageLocale(pathname: string): AnalyticsLocale {
  try {
    return pathLocale(pathname.split(/[?#]/, 1)[0] || "/") ?? DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}
