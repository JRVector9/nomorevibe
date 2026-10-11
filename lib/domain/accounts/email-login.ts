import { randomUUID } from "node:crypto";
import { PublicAuthError } from "./errors";
import { sendLoginEmail, type LoginEmailDelivery } from "./email-delivery";
import { consumeEmailChallenge, limitEmailLogin, recordEmailDelivery, replaceEmailChallenge, type VerifyEmailInput } from "./repository";
import { requirePublicAuthEnabled, safeReturnUrl } from "./request-auth";
import { hashEmailCode, hashSessionToken, isOpaqueToken, newEmailCode, publicAuthSecret } from "./session";

export function normalizeLoginEmail(value: unknown): string {
  if (typeof value !== "string") throw new PublicAuthError(400, "invalid_email");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email)) throw new PublicAuthError(400, "invalid_email");
  return email;
}

export async function startEmailLogin(input: { email: unknown; browserNonce: string; ip: string | null; returnTo?: unknown }, deliver: LoginEmailDelivery = sendLoginEmail) {
  requirePublicAuthEnabled();
  publicAuthSecret();
  const email = normalizeLoginEmail(input.email);
  if (!isOpaqueToken(input.browserNonce)) throw new PublicAuthError(403, "invalid_csrf");
  // Validate delivery configuration before invalidating a previous working code.
  if (deliver === sendLoginEmail && (!process.env.LOGIN_EMAIL_API_KEY || !process.env.LOGIN_EMAIL_FROM)) throw new PublicAuthError(503, "public_auth_unconfigured");
  await limitEmailLogin(email, input.ip);
  const challengeId = randomUUID();
  const code = newEmailCode();
  await replaceEmailChallenge({ id: challengeId, email, codeHash: hashEmailCode(challengeId, code), browserNonceHash: hashSessionToken(input.browserNonce), returnTo: safeReturnUrl(input.returnTo) });
  const state = await deliver({ challengeId, email, code });
  await recordEmailDelivery(challengeId, state);
  if (state === "rejected") throw new PublicAuthError(503, "email_delivery_failed");
  return { challengeId, expiresIn: 600, delivery: state };
}

export async function verifyEmailLogin(input: VerifyEmailInput) {
  requirePublicAuthEnabled();
  publicAuthSecret();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.challengeId) || typeof input.code !== "string" || input.code.length > 32 || !isOpaqueToken(input.browserNonce)) {
    throw new PublicAuthError(400, "invalid_code");
  }
  return consumeEmailChallenge(input);
}
