import { createHmac, timingSafeEqual } from 'node:crypto';

type AdminSession = { login: string; exp: number };
export function jobControlCsrf(admin: AdminSession, secret: string): string {
  return createHmac('sha256', secret).update(`job-control-admin:${admin.login}:${admin.exp}`).digest('hex');
}
export function assertJobControlCsrf(input: { admin: AdminSession; secret: string | null; origin: string | null; configuredOrigin: string | null;
  token: unknown; expiresAt: number; local: boolean }): void {
  const now = Math.floor(Date.now() / 1000);
  if (!input.secret || !input.configuredOrigin || input.origin !== input.configuredOrigin || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now
    || (input.local ? input.expiresAt > now + 12 * 3600 : input.expiresAt !== input.admin.exp)
    || typeof input.token !== 'string' || !/^[a-f0-9]{64}$/.test(input.token)) throw new Error('forbidden');
  const expected = jobControlCsrf({ login: input.admin.login, exp: input.expiresAt }, input.secret);
  if (!timingSafeEqual(Buffer.from(input.token, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('forbidden');
}
