import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { adminPasswordConfig } from "./admin-password";
import { verifySession, type Session } from "./session";

export const ADMIN_INGRESS_HEADER = "x-nmv-admin-ingress-token";

/** Network enforcement is mandatory in production, and opt-in for local checks. */
export function adminIngressRequired(): boolean {
  return process.env.NODE_ENV === "production" || !!process.env.ADMIN_ORIGIN || !!process.env.ADMIN_INGRESS_SECRET;
}

export function adminLocalLoginEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.ADMIN_LOCAL_LOGIN === "1";
}

/** A private HTTPS origin is configured separately from the public site. */
export function adminOrigin(): string | null {
  const configured = process.env.ADMIN_ORIGIN ?? (process.env.NODE_ENV !== "production" ? process.env.NEXT_PUBLIC_SITE_URL : undefined);
  try {
    if (!configured) return null;
    const parsed = new URL(configured);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
      || !["https:", ...(process.env.NODE_ENV !== "production" ? ["http:"] : [])].includes(parsed.protocol)) return null;
    if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_SITE_URL
      && parsed.origin === new URL(process.env.NEXT_PUBLIC_SITE_URL).origin) return null;
    return parsed.origin;
  } catch { return null; }
}

/** Only a secret injected by the private ingress proves this boundary; IP/Host do not. */
export function adminIngressAllowed(headers: Pick<Headers, "get">): boolean {
  if (!adminIngressRequired()) return true;
  const secret = process.env.ADMIN_INGRESS_SECRET;
  const proof = headers.get(ADMIN_INGRESS_HEADER);
  if (!adminOrigin() || !secret || Buffer.byteLength(secret) < 32 || !proof || proof.length > 1024) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(secret), digest(proof));
}

export function adminMutationOriginAllowed(headers: Pick<Headers, "get">): boolean {
  const origin = adminOrigin();
  return !!origin && headers.get("origin") === origin;
}

export function isAdminProtectedPath(pathname: string): boolean {
  return ["/admin", "/api/admin", "/api/auth/github", "/api/auth/logout", "/api/auth/password"]
    .some(path => pathname === path || pathname.startsWith(`${path}/`));
}

export function authSecret(): string | null {
  const secret = process.env.AUTH_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

export function adminLogins(): string[] {
  return (process.env.ADMIN_GITHUB_LOGINS ?? "").split(",").map(login => login.trim().toLowerCase()).filter(Boolean);
}

export function isAdminLogin(login: string): boolean {
  const normalized = login.trim().toLowerCase();
  return (adminLocalLoginEnabled() && normalized === "local") || adminLogins().includes(normalized);
}

/** Credential replacement revokes password cookies without adding a session store. */
export function adminPasswordSessionSecret(): string | null {
  const secret = authSecret(), configured = adminPasswordConfig();
  return secret && configured ? createHmac("sha256", secret).update(`admin-password:${configured.username}\0${configured.hash}`).digest("hex") : null;
}

export async function verifyAdminSession(cookie: string | undefined): Promise<Session | null> {
  const passwordSecret = adminPasswordSessionSecret();
  if (passwordSecret) {
    const session = await verifySession(cookie, passwordSecret);
    if (session && session.login === adminPasswordConfig()?.username) return { login: session.login, exp: session.exp, method: "password" };
  }
  const secret = authSecret();
  const session = secret ? await verifySession(cookie, secret) : null;
  return session && isAdminLogin(session.login) ? { login: session.login, exp: session.exp, method: "github" } : null;
}
