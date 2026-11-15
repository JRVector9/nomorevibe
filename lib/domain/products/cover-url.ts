import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 제품 표지(받아 둔 og 그림) 주소를 추측할 수 없게 — 2026-11-15 사람 결정(공개 HTML 이름·요약만, PR #964).
 *
 * 표지는 slug 만 알면 받을 수 있는 `/api/og-cache/<slug>` 가 아니라 `/api/og-cache/<slug>.<열쇠>` 로만 준다.
 * 열쇠는 서버 비밀에서 용도 라벨로 파생한 키로 slug 를 HMAC 한 값이라, 보호된 같은 출처 API(카드·상세·내 화면)가
 * 내준 주소를 받지 않고는 만들 수 없다. 서버 HTML·메타·JSON-LD 에는 이 주소도, slug 주소도 싣지 않는다.
 * 옛 slug 주소는 그림 대신 공유 카드로 보낸다(app/api/og-cache/[slug]/route.ts).
 *
 * 비밀: 새 env 를 두지 않고 두 웹 앱이 같은 값으로 갖는 VISITOR_HASH_SECRET 에서 라벨 `nomorevibe/og-cover-key/v1` 로 파생한다.
 * 비밀이 없거나 짧으면(32자 미만) 표지 주소를 내주지 않는다(null — 화면은 이름 글자 아이콘을 그린다).
 */

const PREFIX = "/api/og-cache/";
const LABEL = "nomorevibe/og-cover-key/v1";
const SLUG = /^[a-z0-9-]+$/;
/** 열쇠 — HMAC-SHA256 앞 16바이트(128비트)의 소문자 16진수 */
const KEY = /^[0-9a-f]{32}$/;

function coverSigningKey(secret = process.env.VISITOR_HASH_SECRET): Buffer | null {
  if (!secret || secret.length < 32) return null;
  return createHmac("sha256", secret).update(LABEL).digest();
}

/** slug 의 표지 열쇠 — 비밀이 없으면 null */
export function coverKey(slug: string, secret?: string): string | null {
  const signing = coverSigningKey(secret);
  if (!signing || !SLUG.test(slug)) return null;
  return createHmac("sha256", signing).update(slug).digest("hex").slice(0, 32);
}

/** 주소의 열쇠가 그 slug 의 것인가 — 시간 차이로 맞히지 못하게 고정 시간 비교 */
export function coverKeyMatches(slug: string, key: string, secret?: string): boolean {
  const expected = coverKey(slug, secret);
  if (!expected || !KEY.test(key)) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(key));
}

/**
 * og-cache 경로 한 칸 읽기 — `<slug>` 와 `<slug>.webp`(옛 공개 주소), `<slug>.<열쇠>` 와 `<slug>.<열쇠>.webp`(보호 주소).
 * 모양이 틀리면 null.
 */
export function parseCoverSegment(raw: string): { slug: string; key: string | null; webp: boolean } | null {
  const webp = raw.endsWith(".webp");
  const body = webp ? raw.slice(0, -".webp".length) : raw;
  const dot = body.indexOf(".");
  const slug = dot < 0 ? body : body.slice(0, dot);
  const key = dot < 0 ? null : body.slice(dot + 1);
  if (!SLUG.test(slug) || (key !== null && !KEY.test(key))) return null;
  return { slug, key, webp };
}

/**
 * DB 에 둔 표지 주소(`/api/og-cache/<slug>[?…]`)를 보호 주소(`/api/og-cache/<slug>.<열쇠>[?…]`)로 — 같은 출처 API 가 내보낼 때만 쓴다.
 * 우리 사본이 아니면(바깥 주소 등) 그대로, 이미 보호 주소면 그대로, 열쇠를 못 만들면 null.
 */
export function protectedCoverUrl(src: string | null | undefined): string | null {
  if (!src) return null;
  if (!src.startsWith(PREFIX)) return src;
  const [path, query] = src.split("?", 2);
  const parsed = parseCoverSegment(path.slice(PREFIX.length));
  if (!parsed) return null;
  if (parsed.key) return src;
  const key = coverKey(parsed.slug);
  if (!key) return null;
  return `${PREFIX}${parsed.slug}.${key}${parsed.webp ? ".webp" : ""}${query === undefined ? "" : `?${query}`}`;
}
