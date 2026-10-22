import { createHmac, randomInt } from "node:crypto";

/**
 * 방문 분석의 "누구" — 서버 이벤트를 브라우저 여정에 잇는 값들(2026-10-22, PR C).
 *
 * - client_id: gtag 가 남긴 `_ga` 쿠키(GA1.<깊이>.<난수>.<처음 본 초>)의 뒤 두 조각. 같은 브라우저의 page_view 와 서버 이벤트가
 *   이 값 하나로 한 사람의 흐름에 놓인다. 쿠키가 없으면 요청마다 새로 만든다(그 이벤트는 GA 에서 따로 떨어진 '사용자'다).
 * - session_id: `_ga_<측정 ID 에서 G- 를 뺀 것>` 쿠키. GS1(점으로 나눔)·GS2(`$` 로 나눔) 두 모양이 섞여 있다.
 * - user_id: 로그인한 사람의 가명 — HMAC-SHA256(ANALYTICS_USER_ID_SECRET, "user:" + 내부 id) 앞 32글자(hex).
 *   서버 이벤트와 브라우저 gtag 설정이 같은 값을 써서 여러 기기의 방문이 한 사람으로 묶인다. 되돌릴 수 없고, 비밀이 없으면 쓰지 않는다.
 *
 * 쿠키 원문·IP·User-Agent 는 어디에도 싣지 않는다.
 */

export const GA_COOKIE = "_ga";
/** 비밀은 VISITOR_HASH_SECRET 과 같은 하한 — `openssl rand -hex 32` */
export const USER_ID_SECRET_MIN = 32;
/** user_id 길이(hex) — 128비트. GA 한도(256자) 안이고 표에서 읽을 만하다 */
export const USER_ID_LENGTH = 32;

/** `_ga` → client_id. 모양이 다르면 null(남의 값을 그대로 보내지 않는다) */
export function parseGaClientId(cookie: string | null | undefined): string | null {
  if (!cookie) return null;
  const match = /^GA1\.\d{1,2}\.(\d{1,20}\.\d{1,20})$/.exec(cookie.trim());
  return match ? match[1] : null;
}

/** 측정 ID 의 세션 쿠키 이름 — G-ABC123 → _ga_ABC123 */
export function gaSessionCookieName(measurementId: string): string {
  return `_ga_${measurementId.replace(/^G-/, "")}`;
}

/**
 * `_ga_<스트림>` → session_id(세션이 시작된 초).
 * GS1.1.<session_id>.<n>.<engaged>.<last>.… / GS2.1.s<session_id>$o<n>$g<engaged>$t<last>…
 */
export function parseGaSessionId(cookie: string | null | undefined): string | null {
  if (!cookie) return null;
  const value = cookie.trim();
  const v1 = /^GS1\.\d{1,2}\.(\d{6,20})\./.exec(value);
  if (v1) return v1[1];
  const v2 = /^GS2\.\d{1,2}\.s(\d{6,20})(?:\$|$)/.exec(value);
  return v2 ? v2[1] : null;
}

/** gtag 가 만드는 것과 같은 모양의 일회용 client_id — 쿠키 없는 요청(CLI·curl) 하나에만 쓴다 */
export function randomClientId(now = Date.now()): string {
  return `${randomInt(1, 2_147_483_647)}.${Math.floor(now / 1000)}`;
}

/** user_id 를 만들 수 있는가(비밀이 있고 충분히 긴가) — 없으면 로그인 확인(DB)도 하지 않는다 */
export function analyticsUserIdEnabled(secret = process.env.ANALYTICS_USER_ID_SECRET): secret is string {
  return typeof secret === "string" && secret.length >= USER_ID_SECRET_MIN;
}

/** 로그인한 사람의 가명 user_id. 비밀이 없거나 짧거나 id 가 이상하면 null */
export function analyticsUserId(userId: number | null | undefined, secret = process.env.ANALYTICS_USER_ID_SECRET): string | null {
  if (!analyticsUserIdEnabled(secret)) return null;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) return null;
  return createHmac("sha256", secret).update(`user:${userId}`).digest("hex").slice(0, USER_ID_LENGTH);
}

/** 요청 쿠키 — 같은 이름이 둘이면 앞의 것(`_ga` 는 도메인 깊이마다 따로 남을 수 있다) */
export function requestCookies(request: Request): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (name && !cookies.has(name)) cookies.set(name, part.slice(index + 1).trim());
  }
  return cookies;
}
