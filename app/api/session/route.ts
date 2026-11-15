import { NextResponse } from "next/server";
import { onPrimary } from "@/lib/db";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { withRoute } from "@/lib/http/handler";
import { publicClientIp, rateLimitWindow } from "@/lib/rate-limit";
import { publicApiMode } from "@/lib/anti-scrape/control";
import { issueSession, readSession, sessionConfig, SESSION_COOKIE, SESSION_HEADERS, SESSION_SECONDS } from "@/lib/anti-scrape/session";
import { verifyTurnstile } from "@/lib/anti-scrape/turnstile";

export const dynamic = "force-dynamic";

/** Uncached runtime sitekey, separate from cached HTML and the CI-built shared web image. */
export const GET = withRoute("session.config", async (request: Request) => {
  const refused = await guardPublicApiRead(request, "session");
  if (refused) return refused;
  const config = sessionConfig();
  if (!config) return NextResponse.json({ enabled: false }, { headers: SESSION_HEADERS });
  const session = readSession(request, config.signingSecret);
  const mode = await publicApiMode();
  return NextResponse.json({ enabled: true, siteKey: config.siteKey, mode, expiresAt: session ? session.exp * 1000 : null }, { headers: SESSION_HEADERS });
});

export const POST = withRoute("session.issue", async (request: Request) => {
  const refused = await guardPublicApiRead(request, "session");
  if (refused) return refused;
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return NextResponse.json({ error: "invalid_origin" }, { status: 403, headers: SESSION_HEADERS });
  }
  const config = sessionConfig();
  if (!config) return NextResponse.json({ enabled: false }, { headers: SESSION_HEADERS });
  const ip = publicClientIp(request);
  if (ip) {
    const rate = await onPrimary(() => rateLimitWindow(`api-session-issue:${ip}`, 10, 10 * 60_000));
    if (!rate.allowed) return NextResponse.json({ error: "rate_limited" }, { status: 429,
      headers: { ...SESSION_HEADERS, "Retry-After": String(rate.retryAfterSeconds) } });
  }
  // Bound actual bytes as well as Content-Length before decoding untrusted JSON.
  if (Number(request.headers.get("content-length")) > 4096) return NextResponse.json({ error: "body_too_large" }, { status: 413, headers: SESSION_HEADERS });
  let token: unknown;
  try {
    if (!request.body) throw new Error();
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 4096) { await reader.cancel(); return NextResponse.json({ error: "body_too_large" }, { status: 413, headers: SESSION_HEADERS }); }
      chunks.push(value);
    }
    token = JSON.parse(Buffer.concat(chunks).toString("utf8")).token;
  } catch { return NextResponse.json({ error: "invalid_json" }, { status: 400, headers: SESSION_HEADERS }); }
  if (!await verifyTurnstile(token, config.turnstileSecret, request)) {
    return NextResponse.json({ error: "turnstile_failed" }, { status: 401, headers: SESSION_HEADERS });
  }
  // A valid existing session retains its id/quota; only expired or absent sessions start a new window.
  const issued = issueSession(request, config.signingSecret, Date.now(), readSession(request, config.signingSecret)?.id);
  const response = NextResponse.json({ enabled: true, expiresAt: issued.session.exp * 1000 }, { headers: SESSION_HEADERS });
  response.cookies.set(SESSION_COOKIE, issued.value, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
    path: "/api", maxAge: SESSION_SECONDS });
  return response;
}, { dbWrite: false });
