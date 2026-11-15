import "server-only";
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/lib/i18n/locales";
import { localePath, pathLocale } from "@/lib/i18n/routing";

/**
 * /go/<slug> 서명 토큰(2026-11-15 사람 결정: 이름·요약 밖의 프로젝트 연결 정보는 보호 API 를 거쳐서만).
 *
 * slug 만 알면 /go/<slug> 로 바깥 주소(GitHub·사이트)를 얻을 수 있었다. 이제 /go 는 보호 API(/api/products/[slug]/details)가
 * 내준 짧은 토큰이 있을 때만 바깥으로 보내고, 없거나 틀리거나 지났으면 상세(/p/<slug>)로 돌려보낸다.
 *
 * 토큰 = `<만료 시각(초, 36진)>.<HMAC-SHA256(파생 열쇠, "go\0" + slug + "\0" + 만료)의 앞 16바이트 base64url>`.
 * 열쇠는 새 env 를 만들지 않고 두 웹 앱에 이미 같은 값으로 있는 VISITOR_HASH_SECRET 에서 용도 라벨(go-link-v1)로 HKDF 파생한다 —
 * 방문자 HMAC 과 같은 열쇠를 그대로 쓰지 않는다. 비밀이 없거나 짧으면(32자 미만) 발급도 검증도 실패한다(안전한 쪽: 상세로).
 */

/** 토큰 유효 시간 — 상세를 열고 단추를 누르기까지 충분하고, 모아 둔 주소 목록이 금방 못 쓰게 될 만큼 짧게 */
export const GO_TOKEN_TTL_MS = 15 * 60_000;
/** 서버 간 시계 차이 — 앞날 만료가 TTL 보다 이만큼 넘게 길면 위조로 본다 */
const CLOCK_SKEW_MS = 60_000;
const LABEL = "go-link-v1";
const SIG_BYTES = 16;
const TOKEN = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]{22})$/;

function derivedKey(secret = process.env.VISITOR_HASH_SECRET): Buffer | null {
  if (!secret || secret.length < 32) return null;
  return Buffer.from(hkdfSync("sha256", secret, "nomorevibe", LABEL, 32));
}

function signature(key: Buffer, slug: string, expires: string): Buffer {
  return createHmac("sha256", key).update("go\0").update(slug).update("\0").update(expires).digest().subarray(0, SIG_BYTES);
}

/** 토큰 발급 — 비밀이 없으면 null(링크는 토큰 없는 /go → 상세로 돌아온다) */
export function issueGoToken(slug: string, now = Date.now(), secret?: string): { token: string; expiresAt: number } | null {
  const key = derivedKey(secret);
  if (!key) return null;
  const expiresAt = Math.ceil((now + GO_TOKEN_TTL_MS) / 1000) * 1000;
  const expires = (expiresAt / 1000).toString(36);
  return { token: `${expires}.${signature(key, slug, expires).toString("base64url")}`, expiresAt };
}

export type GoTokenCheck = "valid" | "missing" | "malformed" | "expired" | "invalid" | "unconfigured";

/** 토큰 검증 — slug 와 만료 시각이 같이 서명돼 있어 다른 제품의 토큰·늘린 만료는 통과하지 못한다 */
export function verifyGoToken(slug: string, token: string | null, now = Date.now(), secret?: string): GoTokenCheck {
  if (!token) return "missing";
  const match = TOKEN.exec(token);
  if (!match) return "malformed";
  const key = derivedKey(secret);
  if (!key) return "unconfigured";
  const expiresAt = parseInt(match[1], 36) * 1000;
  if (!Number.isSafeInteger(expiresAt)) return "malformed";
  const expected = signature(key, slug, match[1]);
  const given = Buffer.from(match[2], "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "invalid";
  if (expiresAt <= now) return "expired";
  if (expiresAt > now + GO_TOKEN_TTL_MS + CLOCK_SKEW_MS) return "invalid";
  return "valid";
}

/** 보호 API 가 내주는 /go 주소 — 비밀이 없으면 null */
export function signedGoLink(slug: string, options: { locale?: Locale; via?: string; now?: number } = {}): { href: string; expiresAt: number } | null {
  const issued = issueGoToken(slug, options.now);
  if (!issued) return null;
  const query = new URLSearchParams({ t: issued.token });
  if (options.locale && options.locale !== DEFAULT_LOCALE) query.set("lang", options.locale);
  if (options.via) query.set("via", options.via);
  return { href: `/go/${encodeURIComponent(slug)}?${query}`, expiresAt: issued.expiresAt };
}

/**
 * 토큰이 맞지 않을 때 돌려보낼 상세 주소(언어 접두 유지). /go 는 언어 밖 경로라 언어를 ?lang= 으로 받고,
 * 없으면 같은 사이트의 Referer 경로에서 읽는다. 둘 다 없으면 기본 언어(접두 없음).
 */
export function goFallbackPath(slug: string, request: Pick<Request, "url" | "headers">, origin: string): string {
  const lang = new URL(request.url).searchParams.get("lang");
  let locale: Locale = lang && isLocale(lang) ? lang : DEFAULT_LOCALE;
  if (!lang || !isLocale(lang)) {
    const referer = request.headers.get("referer");
    try {
      const from = referer ? new URL(referer) : null;
      const found = from && from.origin === origin ? pathLocale(from.pathname) : null;
      if (found) locale = found;
    } catch { /* 잘못된 Referer 는 무시 */ }
  }
  return localePath(locale, `/p/${encodeURIComponent(slug)}`);
}
