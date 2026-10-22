import { createHmac, timingSafeEqual } from "node:crypto";
import type { Session } from "@/lib/auth/session";

export type RequestScope = "maker-replies" | "contact-requests";
export function adminRequestToken(scope: RequestScope, admin: Session, secret: string): string {
  return createHmac("sha256", secret).update(`${scope}:${admin.login}:${admin.exp}`).digest("hex");
}
export function assertAdminRequestCsrf(input: {
  scope: RequestScope; admin: Session; secret: string | null; origin: string | null; configuredOrigin: string | null;
  token: FormDataEntryValue | null; expiresAt: number; local: boolean; now?: number;
}) {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!input.secret || !input.configuredOrigin || input.origin !== input.configuredOrigin
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now
    || (input.local ? input.expiresAt > now + 12 * 3600 : input.expiresAt !== input.admin.exp)
    || typeof input.token !== "string" || !/^[a-f0-9]{64}$/.test(input.token)) throw new Error("forbidden");
  const expected = adminRequestToken(input.scope, { ...input.admin, exp: input.expiresAt }, input.secret);
  if (!timingSafeEqual(Buffer.from(input.token, "hex"), Buffer.from(expected, "hex"))) throw new Error("forbidden");
}
