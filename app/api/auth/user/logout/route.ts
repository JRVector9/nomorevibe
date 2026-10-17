import { NextResponse } from "next/server";
import { revokePublicSession } from "@/lib/domain/accounts/repository";
import { publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requestCookie, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { PUBLIC_SESSION_COOKIE, publicSessionCookieOptions } from "@/lib/domain/accounts/session";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

export const POST = webWriteRoute(async (request: Request) => {
  try {
    await requirePublicMutation(request);
    await revokePublicSession(requestCookie(request, PUBLIC_SESSION_COOKIE)!);
    const response = NextResponse.json({ ok: true }, { headers: PUBLIC_PRIVATE_HEADERS });
    response.cookies.set(PUBLIC_SESSION_COOKIE, "", { ...publicSessionCookieOptions(), maxAge: 0 });
    return response;
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}, publicAuthErrorResponse);
