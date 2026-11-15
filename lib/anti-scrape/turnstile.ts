import { logger } from "@/lib/observability/logger";
import { publicClientIp } from "@/lib/rate-limit";
import type { SessionRequest } from "./session";

export const TURNSTILE_ACTION = "api-session";
/** Public Cloudflare test secrets are the only exception to hostname/action validation. Never allow them in production. */
const TEST_SECRETS = new Set(["1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000AA"]);
export type TurnstileMode = "observe" | "enforce";
/** Read only when the hostname check cannot pass; any failure falls back to the stricter enforce behavior. */
export type TurnstileModeSource = () => Promise<TurnstileMode>;

/**
 * The canonical public hostname from NEXT_PUBLIC_SITE_URL (the server runtime value lib/site.ts siteOrigin() prefers).
 * Not request.url: behind Cloudflare→Traefik, Next rebuilds request.url from the bind host (e.g. http://web:3000).
 * Unlike siteOrigin() this never falls back to the request, so a missing value is visible as null.
 */
export function canonicalSiteHostname(): string | null {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return (url.protocol === "https:" || url.protocol === "http:") && url.hostname ? url.hostname.toLowerCase() : null;
  } catch { return null; }
}

/** Cloudflare's reported hostname, bounded for logs. Anything that is not a plain hostname is recorded only as "invalid". */
function reportedHostname(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const host = value.toLowerCase();
  return host.length <= 253 && /^[a-z0-9.-]+$/.test(host) ? host : "invalid";
}

async function resolveMode(mode: TurnstileModeSource | undefined): Promise<TurnstileMode> {
  if (!mode) return "enforce";
  try { return (await mode()) === "observe" ? "observe" : "enforce"; } catch { return "enforce"; }
}

export async function verifyTurnstile(
  token: unknown, secret: string, request: SessionRequest, fetcher: typeof fetch = fetch, mode?: TurnstileModeSource,
): Promise<boolean> {
  if (typeof token !== "string" || !token.trim() || token.length > 2048 || !request.url) return false;
  const testing = TEST_SECRETS.has(secret);
  if (testing && process.env.NODE_ENV === "production") return false;
  let result;
  try {
    const ip = publicClientIp(request);
    const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return false;
    result = await response.json();
  } catch { return false; } // Do not log Cloudflare payloads, tokens, or network errors containing request data.
  if (result?.success !== true) return false;
  if (testing) return true;
  if (result.action !== TURNSTILE_ACTION) return false;
  const expected = canonicalSiteHostname();
  const actual = reportedHostname(result.hostname);
  if (expected && actual === expected) return true;
  // Only hostnames and the mode are logged — never the token, secret, IP or the rest of the Cloudflare payload.
  const current = await resolveMode(mode);
  const outcome = current === "observe" ? "allowed" : "refused";
  if (!expected) logger.warn("anti_scrape.turnstile_hostname_unconfigured", { mode: current, outcome, actual });
  else logger.info("anti_scrape.turnstile_hostname_mismatch", { mode: current, outcome, expected, actual });
  return current === "observe";
}
