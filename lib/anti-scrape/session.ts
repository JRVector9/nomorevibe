import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isIP, SocketAddress } from "node:net";
import { publicClientIp } from "@/lib/rate-limit";

export const SESSION_COOKIE = "nmv_api_session";
export const SESSION_SECONDS = 30 * 60;
export const SESSION_HEADERS = { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store" } as const;
export type SessionRequest = Pick<Request, "headers"> & Partial<Pick<Request, "url">>;
export type ApiSession = { v: 1; id: string; exp: number; ip: string };

/** Runtime env only. Never expose the two server secrets in config or logs. */
export function sessionConfig() {
  const siteKey = process.env.TURNSTILE_SITE_KEY?.trim();
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY?.trim();
  const signingSecret = process.env.PUBLIC_API_SESSION_SECRET?.trim();
  return siteKey && turnstileSecret && signingSecret ? { siteKey, turnstileSecret, signingSecret } : null;
}

function mac(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}
function network(request: SessionRequest): string {
  const ip = publicClientIp(request);
  if (!ip) return "unavailable"; // Keep the existing proxy trust boundary; never trust raw CF/XFF here.
  if (isIP(ip) === 4) return ip.split(".").slice(0, 3).join(".") + ".0/24";
  // Canonicalize equivalent IPv6 spellings, binding the /64 network instead of a temporary interface id.
  const address = new SocketAddress({ address: ip, port: 0, family: "ipv6" }).address;
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) return address.slice(7).split(".").slice(0, 3).join(".") + ".0/24";
  const [left, right = ""] = address.split("::");
  const a = left ? left.split(":") : [], b = right ? right.split(":") : [];
  return [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill("0"), ...b].slice(0, 4).map(x => parseInt(x, 16).toString(16)).join(":") + "::/64";
}
export function sessionIpHash(request: SessionRequest, secret: string): string {
  return mac(`ip:${network(request)}`, secret);
}
export function issueSession(request: SessionRequest, secret: string, now = Date.now(), id: string = randomUUID()): { value: string; session: ApiSession } {
  const session: ApiSession = { v: 1, id, exp: Math.floor(now / 1000) + SESSION_SECONDS, ip: sessionIpHash(request, secret) };
  const body = Buffer.from(JSON.stringify(session)).toString("base64url");
  return { value: `${body}.${mac(body, secret)}`, session };
}
export function readSession(request: SessionRequest, secret: string, now = Date.now()): ApiSession | null {
  const value = request.headers.get("cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  if (!value || value.length > 1024) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = mac(body, secret);
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    const seconds = Math.floor(now / 1000);
    return data.v === 1 && /^[0-9a-f-]{36}$/.test(data.id) && Number.isInteger(data.exp) && data.exp > seconds && data.exp <= seconds + SESSION_SECONDS
      && data.ip === sessionIpHash(request, secret) ? data : null;
  } catch { return null; }
}
