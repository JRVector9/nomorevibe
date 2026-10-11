import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { PublicAuthError } from "./errors";

export const PUBLIC_SESSION_COOKIE = "nmv_user";
export const LOGIN_NONCE_COOKIE = "nmv_login_nonce";
export const PUBLIC_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export function publicAuthSecret(): string {
  const secret = process.env.PUBLIC_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new PublicAuthError(503, "public_auth_unconfigured");
  return secret;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function newPublicSession() {
  const token = randomBytes(32).toString("base64url");
  const createdAt = new Date();
  return { token, tokenHash: hashSessionToken(token), createdAt, expiresAt: new Date(createdAt.getTime() + PUBLIC_SESSION_TTL_SECONDS * 1000) };
}

export function isOpaqueToken(value: string | undefined): value is string {
  return !!value && /^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, "base64url").length === 32;
}

export function newEmailCode(): string {
  return randomInt(100_000_000).toString().padStart(8, "0");
}

export function hashEmailCode(challengeId: string, code: string): string {
  return createHmac("sha256", publicAuthSecret()).update(`otp:${challengeId}:${code}`).digest("hex");
}

export function csrfForToken(token: string, purpose: "login" | "session"): string {
  return createHmac("sha256", publicAuthSecret()).update(`csrf:${purpose}:${token}`).digest("hex");
}

export function privateRateKey(purpose: string, value: string): string {
  return `public-auth:${purpose}:${createHmac("sha256", publicAuthSecret()).update(value).digest("hex")}`;
}

export function matchesSecretHash(expected: string, candidate: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(expected) || !/^[a-f0-9]{64}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(candidate, "hex"));
}

export function publicSessionCookieOptions() {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge: PUBLIC_SESSION_TTL_SECONDS };
}

export function loginNonceCookieOptions() {
  return { ...publicSessionCookieOptions(), maxAge: 10 * 60 };
}
