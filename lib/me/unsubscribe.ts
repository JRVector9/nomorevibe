import { createHmac, timingSafeEqual } from "node:crypto";
import { publicAuthSecret } from "@/lib/domain/accounts/session";
import { localePath } from "@/lib/i18n/routing";
import type { Locale } from "@/lib/i18n/locales";
import { siteOrigin } from "@/lib/site";
import { UNSUBSCRIBE_KEYS, type UnsubscribeKey } from "./notification-settings";

/**
 * 메일의 «이 알림 끄기» 열쇠 — `<계정 id>.<칸>.<서명>`. 로그인 없이 한 번 눌러 끄므로 서명이 곧 권한이다.
 * 서명은 공개 로그인과 같은 비밀(PUBLIC_AUTH_SECRET)로 하되 용도 글자를 앞에 붙여 다른 서명과 섞이지 않게 한다.
 * 기한은 두지 않는다 — 오래된 메일에서 눌러도 꺼져야 한다.
 */
const TOKEN = /^([1-9][0-9]{0,9})\.([A-Za-z]{1,24})\.([A-Za-z0-9_-]{43})$/;

function signature(userId: number, key: string, secret: string): string {
  return createHmac("sha256", secret).update(`unsubscribe:v1:${userId}:${key}`).digest("base64url");
}

export function signUnsubscribeToken(userId: number, key: UnsubscribeKey, secret = publicAuthSecret()): string {
  return `${userId}.${key}.${signature(userId, key, secret)}`;
}

export function verifyUnsubscribeToken(token: unknown, secret = publicAuthSecret()): { userId: number; key: UnsubscribeKey } | null {
  if (typeof token !== "string") return null;
  const match = TOKEN.exec(token);
  if (!match) return null;
  const userId = Number(match[1]);
  const key = match[2];
  if (!Number.isSafeInteger(userId) || !(UNSUBSCRIBE_KEYS as readonly string[]).includes(key)) return null;
  // 글자 그대로 견준다 — base64url 끝 글자의 남는 비트만 바꾼 다른 열쇠가 같은 바이트로 풀리지 않게
  const expected = Buffer.from(signature(userId, key, secret));
  const given = Buffer.from(match[3]);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { userId, key: key as UnsubscribeKey };
}

/** 메일에 넣는 끄기 주소 — 언어는 확인 화면의 글자만 고르고 서명에 들지 않는다 */
export function unsubscribeUrl(userId: number, key: UnsubscribeKey, locale: Locale): string {
  const query = new URLSearchParams({ token: signUnsubscribeToken(userId, key), lang: locale });
  return `${siteOrigin()}/api/me/notification-settings/unsubscribe?${query}`;
}

export function alertSettingsUrl(locale: Locale): string {
  return `${siteOrigin()}${localePath(locale, "/me/alerts")}`;
}
