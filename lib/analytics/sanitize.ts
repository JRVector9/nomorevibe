/**
 * 방문 분석으로 내보내기 전에 값을 정리한다 — 개인정보 규칙의 실제 구현(2026-10-22).
 *
 * 보내지 않는 것
 * - 이메일·이름·IP·토큰·비밀번호처럼 사람이나 자격을 가리키는 값: 키 이름으로 막고(FORBIDDEN_PARAM_KEYS), 값에 이메일이 보이면 지운다.
 * - 비밀이 든 주소: 질의는 허용 목록(via·utm_*·tab·sort·new)만 남기고 # 뒤는 버린다. 로그인 돌아갈 곳(returnTo)·검색어(q)·
 *   확인 코드·설치 대기 표시처럼 허용 목록 밖은 모두 빠진다.
 * - 자유 입력 검색어: 소문자·공백 정리 뒤 64자로 자르고, 이메일·긴 숫자(전화·코드)·토큰처럼 보이는 조각은 지운다.
 *
 * GA4 의 값 한도(100자)를 넘는 문자열은 자른다. 객체·배열 값은 버린다(items 는 client.ts 가 따로 만든다).
 * IP 는 GA4 가 저장하지 않는다(대략의 위치를 정하는 데만 쓰고 버린다) — 우리도 보내지 않는다.
 */

/** 주소에 남기는 질의 키 — 유입 경로(via·utm_*)와 같은 화면의 갈래(tab·sort·new) */
export const ALLOWED_QUERY_KEYS: readonly string[] = ["via", "tab", "sort", "new"];
const ALLOWED_QUERY_PREFIX = "utm_";

/** 이 키는 값과 상관없이 보내지 않는다 — 소문자로 비교한다 */
export const FORBIDDEN_PARAM_KEYS: readonly string[] = [
  "email", "e_mail", "mail", "name", "first_name", "last_name", "full_name", "user_name", "username", "nickname", "display_name",
  "ip", "ip_address", "ip_addr", "user_ip", "token", "access_token", "refresh_token", "id_token", "csrf", "csrf_token",
  "password", "secret", "api_key", "apikey", "session", "session_id", "cookie", "authorization", "code", "otp",
  "phone", "phone_number", "address", "user_id", "github_login", "github_id", "query", "q", "return_to", "returnto",
];

/** GA4 표준 속성의 매개변수 값 한도 — 화면 주소·앞 화면·제목만 더 길다 */
export const PARAM_VALUE_MAX = 100;
const LONG_PARAM_MAX: Readonly<Record<string, number>> = { page_location: 1_000, page_referrer: 420, page_title: 300 };
export const SEARCH_TERM_MAX = 64;

const EMAIL = /[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi;
const LONG_DIGITS = /\d[\d\s-]{5,}\d/g;
/** 글자와 숫자가 섞인 24자 이상 덩어리 — 토큰·해시. 하이픈으로 끊긴 slug 는 걸리지 않는다 */
const TOKEN_LIKE = /\b(?=[A-Za-z0-9_]*\d)(?=[A-Za-z0-9_]*[A-Za-z])[A-Za-z0-9_]{24,}\b/g;

export function isForbiddenParamKey(key: string): boolean {
  return FORBIDDEN_PARAM_KEYS.includes(key.toLowerCase());
}

function allowedQueryKey(key: string): boolean {
  return ALLOWED_QUERY_KEYS.includes(key) || (key.startsWith(ALLOWED_QUERY_PREFIX) && key.length <= 40);
}

/** 이메일·토큰처럼 보이는 조각을 지운다 */
function redact(value: string): string {
  return value.replace(EMAIL, "").replace(TOKEN_LIKE, "");
}

function capText(value: string, max = PARAM_VALUE_MAX): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** 질의는 허용 목록만, # 뒤는 버린다 — 같은 순서·같은 값이면 같은 결과 */
export function sanitizeSearch(search: string | URLSearchParams): string {
  const params = typeof search === "string" ? new URLSearchParams(search.startsWith("?") ? search.slice(1) : search) : search;
  const kept = new URLSearchParams();
  for (const [key, value] of params) {
    if (!allowedQueryKey(key)) continue;
    const clean = capText(redact(value), 60);
    if (clean) kept.append(key, clean);
  }
  const text = kept.toString();
  return text ? `?${text}` : "";
}

/**
 * 절대 주소를 보낼 꼴로 정리한다. 같은 사이트가 아니면 origin+경로만 남긴다(바깥 주소의 질의는 남의 비밀일 수 있다).
 * 해석하지 못하면 빈 문자열 — 보내지 않는다.
 */
export function sanitizeUrl(href: string, siteOrigin?: string): string {
  try {
    const url = new URL(href, siteOrigin);
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    const sameSite = siteOrigin ? url.origin === new URL(siteOrigin).origin : true;
    const path = redact(url.pathname);
    return capText(`${url.origin}${path}${sameSite ? sanitizeSearch(url.searchParams) : ""}`, 1_000);
  } catch {
    return "";
  }
}

/** 경로만(질의·# 없이) */
export function sanitizePath(pathname: string): string {
  const path = pathname.split(/[?#]/, 1)[0] || "/";
  return capText(redact(path), PARAM_VALUE_MAX) || "/";
}

/**
 * 검색어 정리 — 소문자, 공백 하나로, 이메일·긴 숫자·토큰 같은 조각 지움, 64자 제한.
 * 남는 것이 없으면 null(보내지 않는다).
 */
export function sanitizeSearchTerm(term: unknown): string | null {
  if (typeof term !== "string") return null;
  const clean = term.normalize("NFKC").toLowerCase()
    .replace(EMAIL, " ").replace(LONG_DIGITS, " ").replace(TOKEN_LIKE, " ")
    .replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return Array.from(clean).slice(0, SEARCH_TERM_MAX).join("").trim() || null;
}

export type CleanParams = Record<string, string | number | boolean>;

/**
 * 이벤트 매개변수를 보낼 꼴로 — 금지 키·빈 값·객체 값을 버리고, 문자열은 지우고 자른다.
 * 주소처럼 생긴 문자열 값은 sanitizeUrl 을 거친다(page_location·page_referrer 포함).
 */
export function sanitizeParams(params: Record<string, unknown>, siteOrigin?: string): CleanParams {
  const clean: CleanParams = {};
  for (const [key, value] of Object.entries(params)) {
    if (isForbiddenParamKey(key) || key.length > 40) continue;
    if (typeof value === "number") {
      if (Number.isFinite(value)) clean[key] = value;
    } else if (typeof value === "boolean") {
      clean[key] = value;
    } else if (typeof value === "string") {
      const max = LONG_PARAM_MAX[key] ?? PARAM_VALUE_MAX;
      const text = capText(/^https?:\/\//i.test(value) ? sanitizeUrl(value, siteOrigin) : redact(value).trim(), max);
      if (text) clean[key] = text;
    }
  }
  return clean;
}
