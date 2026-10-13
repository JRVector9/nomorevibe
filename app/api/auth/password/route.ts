import { NextResponse } from "next/server";
import { withRoute } from "@/lib/http/handler";
import { onPrimary } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";
import { adminIngressAllowed, adminMutationOriginAllowed, adminOrigin, adminPasswordSessionSecret } from "@/lib/auth/admin-access";
import { ADMIN_LOGIN_COOKIE, ADMIN_LOGIN_TTL_SECONDS, adminLoginCookie, adminPasswordConfig, matchesAdminLoginCsrf, newAdminLoginNonce, verifyAdminPassword } from "@/lib/auth/admin-password";
import { SESSION_COOKIE, sessionCookieOptions, signSession } from "@/lib/auth/session";

const privateHeaders = { "Cache-Control": "private, no-store" };
const notFound = () => new NextResponse(null, { status: 404, headers: privateHeaders });
function loginRedirect(origin: string, error?: string) {
  const url = new URL("/admin/login", origin);
  if (error) url.searchParams.set("error", error);
  return NextResponse.redirect(url, { status: 303, headers: privateHeaders });
}

/** Seed an HttpOnly CSRF nonce. No password or administrator session is issued here. */
export const GET = withRoute("auth.password.form", async (request: Request) => {
  const origin = adminOrigin();
  if (!origin || !adminIngressAllowed(request.headers)) return notFound();
  const error = new URL(request.url).searchParams.get("error");
  const response = loginRedirect(origin, error === "1" || error === "rate" ? error : undefined);
  response.cookies.set(ADMIN_LOGIN_COOKIE, newAdminLoginNonce(), { ...sessionCookieOptions, maxAge: ADMIN_LOGIN_TTL_SECONDS });
  return response;
});

/** Bound the streamed form too: Content-Length alone does not bound a chunked body. */
async function loginForm(request: Request): Promise<URLSearchParams | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/x-www-form-urlencoded" || !request.body) return null;
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  } finally { reader.releaseLock(); }
}

export const POST = withRoute("auth.password.login", async (request: Request) => {
  const origin = adminOrigin();
  if (!origin || !adminIngressAllowed(request.headers)) return notFound();
  if (!adminMutationOriginAllowed(request.headers)) return new NextResponse(null, { status: 403, headers: privateHeaders });
  const secret = adminPasswordSessionSecret(), configured = adminPasswordConfig();
  if (!secret || !configured) return new NextResponse(null, { status: 503, headers: privateHeaders });
  const form = await loginForm(request);
  if (!form || ["username", "password", "csrfToken"].some(name => form.getAll(name).length !== 1)
    || !matchesAdminLoginCsrf(adminLoginCookie(request.headers), form.get("csrfToken"))) {
    return new NextResponse(null, { status: 403, headers: privateHeaders });
  }
  // One configured account: client-selected names/IP headers cannot rotate the bucket.
  const allowed = await onPrimary(() => rateLimit("admin-password:login", 5, 15 * 60 * 1000));
  if (!allowed) return loginRedirect(origin, "rate");
  if (!await verifyAdminPassword(form.get("username")!, form.get("password")!)) {
    logger.warn("auth.denied", { method: "password", reason: "invalid_credentials" });
    return loginRedirect(origin, "1");
  }
  logger.info("auth.granted", { method: "password", login: configured.username });
  const response = NextResponse.redirect(new URL("/admin/inbox", origin), { status: 303, headers: privateHeaders });
  response.cookies.set(SESSION_COOKIE, await signSession(configured.username, secret), sessionCookieOptions);
  response.cookies.delete(ADMIN_LOGIN_COOKIE);
  return response;
});
