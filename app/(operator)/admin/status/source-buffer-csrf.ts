import { createHmac, timingSafeEqual } from "node:crypto";

type AdminSession = { login: string; exp: number };

/** 원본 공급 조절 스위치의 요청 확인 값 — 관리자 세션(로그인·만료)에 묶인 HMAC. 운영센터가 그리고 서버 액션이 견준다 */
export function sourceBufferCsrf(admin: AdminSession, secret: string): string {
  return createHmac("sha256", secret).update(`source-buffer-admin:${admin.login}:${admin.exp}`).digest("hex");
}

/** 공개 번역·댓글·GitHub 연동 복구 액션과 같은 검사 — 설정된 관리자 주소에서 온 요청이고, 세션 만료와 HMAC 이 맞아야 한다 */
export function assertSourceBufferCsrf(input: { admin: AdminSession; secret: string | null; origin: string | null; configuredOrigin: string | null;
  token: unknown; expiresAt: number; local: boolean }): void {
  const now = Math.floor(Date.now() / 1000);
  if (!input.secret || !input.configuredOrigin || input.origin !== input.configuredOrigin || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now
    || (input.local ? input.expiresAt > now + 12 * 3600 : input.expiresAt !== input.admin.exp) || typeof input.token !== "string" || !/^[a-f0-9]{64}$/.test(input.token)) throw new Error("forbidden");
  const expected = sourceBufferCsrf({ login: input.admin.login, exp: input.expiresAt }, input.secret);
  if (!timingSafeEqual(Buffer.from(input.token, "hex"), Buffer.from(expected, "hex"))) throw new Error("forbidden");
}
