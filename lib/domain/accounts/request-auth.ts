import { cookies } from "next/headers";
import type { PublicUser } from "@/lib/db/public-user-schema";
import { publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { PublicAuthError } from "./errors";
import { getSessionUser } from "./repository";
import { csrfForToken, isOpaqueToken, LOGIN_NONCE_COOKIE, matchesSecretHash, PUBLIC_SESSION_COOKIE } from "./session";
import { safePublicReturnUrl } from "@/lib/i18n/routing";

export { PublicAuthError } from "./errors";
export type { PublicUser } from "@/lib/db/public-user-schema";
export const PUBLIC_PRIVATE_HEADERS = { "Cache-Control": "private, no-store", Vary: "Cookie" };

export function requirePublicAuthEnabled(): void {
  if (!publicUserAuthEnabled()) throw new PublicAuthError(404, "public_auth_disabled");
}

export function requestCookie(request: Request, name: string): string | undefined {
  const values = (request.headers.get("cookie") ?? "").split(";")
    .map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`));
  if (values.length !== 1) return undefined;
  return values[0].slice(name.length + 1);
}

export function requirePublicOrigin(request: Request): void {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;
  let origin: string;
  try {
    if (!configured) throw new Error();
    const parsed = new URL(configured);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    origin = parsed.origin;
  } catch {
    throw new PublicAuthError(503, "public_auth_unconfigured");
  }
  if (request.headers.get("origin") !== origin) throw new PublicAuthError(403, "invalid_origin");
}

/** Keep navigation relative, including after percent-decoding browser parser escapes. */
export function safeReturnUrl(value: unknown): string {
  return safePublicReturnUrl(value);
}

export function requireLoginMutation(request: Request): string {
  requirePublicAuthEnabled();
  requirePublicOrigin(request);
  const nonce = requestCookie(request, LOGIN_NONCE_COOKIE);
  if (!isOpaqueToken(nonce) || !matchesSecretHash(csrfForToken(nonce, "login"), request.headers.get("x-csrf-token") ?? "")) {
    throw new PublicAuthError(403, "invalid_csrf");
  }
  return nonce;
}

export async function getPublicSession(request?: Request): Promise<{ user: PublicUser; csrfToken: string } | null> {
  if (!publicUserAuthEnabled()) return null;
  const token = request ? requestCookie(request, PUBLIC_SESSION_COOKIE) : (await cookies()).get(PUBLIC_SESSION_COOKIE)?.value;
  if (!isOpaqueToken(token)) return null;
  const user = await getSessionUser(token);
  return user ? { user, csrfToken: csrfForToken(token, "session") } : null;
}

export async function requirePublicMutation(request: Request): Promise<PublicUser> {
  requirePublicAuthEnabled();
  requirePublicOrigin(request);
  const session = await getPublicSession(request);
  if (!session) throw new PublicAuthError(401, "login_required");
  if (!matchesSecretHash(session.csrfToken, request.headers.get("x-csrf-token") ?? "")) throw new PublicAuthError(403, "invalid_csrf");
  return session.user;
}

export function publicAuthErrorResponse(error: unknown): Response {
  const failure = error instanceof PublicAuthError ? error : new PublicAuthError(500, "public_auth_unavailable");
  return Response.json({ error: failure.code }, { status: failure.status, headers: PUBLIC_PRIVATE_HEADERS });
}

export async function readLoginJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new PublicAuthError(415, "json_required");
  if (!request.body) throw new PublicAuthError(400, "invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2_048) {
        await reader.cancel();
        throw new PublicAuthError(413, "request_too_large");
      }
      chunks.push(value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PublicAuthError) throw error;
    throw new PublicAuthError(400, "invalid_request");
  } finally {
    reader.releaseLock();
  }
}
