import { createHmac, timingSafeEqual } from "node:crypto";

type AdminSession = { login: string; exp: number };
export function adminRecoveryCsrf(admin: AdminSession, secret: string): string {
  if (secret.length < 32) throw new Error("admin_auth_unconfigured");
  return createHmac("sha256", secret).update(`github-integration-admin:${admin.login}:${admin.exp}`).digest("hex");
}
export function assertAdminRecoveryCsrf(input: { admin: AdminSession; secret: string | null; origin: string | null; configuredOrigin: string | null; token: unknown; expiresAt: number; local: boolean }): void {
  const now = Math.floor(Date.now() / 1000);
  if (!input.secret || !input.configuredOrigin || input.origin !== input.configuredOrigin || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now
    || (input.local ? input.expiresAt > now + 12 * 3600 : input.expiresAt !== input.admin.exp) || typeof input.token !== "string" || !/^[a-f0-9]{64}$/.test(input.token)) throw new Error("forbidden");
  const expected = adminRecoveryCsrf({ login: input.admin.login, exp: input.expiresAt }, input.secret);
  if (!timingSafeEqual(Buffer.from(input.token, "hex"), Buffer.from(expected, "hex"))) throw new Error("forbidden");
}
