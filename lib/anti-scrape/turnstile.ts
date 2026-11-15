import { publicClientIp } from "@/lib/rate-limit";
import type { SessionRequest } from "./session";

export const TURNSTILE_ACTION = "api-session";
/** Public Cloudflare test secrets are the only exception to hostname/action validation. Never allow them in production. */
const TEST_SECRETS = new Set(["1x0000000000000000000000000000000AA", "2x0000000000000000000000000000000AA", "3x0000000000000000000000000000000AA"]);
export async function verifyTurnstile(token: unknown, secret: string, request: SessionRequest, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (typeof token !== "string" || !token.trim() || token.length > 2048 || !request.url) return false;
  const testing = TEST_SECRETS.has(secret);
  if (testing && process.env.NODE_ENV === "production") return false;
  try {
    const ip = publicClientIp(request);
    const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return false;
    const result = await response.json();
    return result.success === true && (testing || (result.hostname === new URL(request.url).hostname && result.action === TURNSTILE_ACTION));
  } catch { return false; } // Do not log Cloudflare payloads, tokens, or network errors containing request data.
}
