import { NextResponse } from "next/server";
import { publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requestCookie, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { hashSessionToken, PUBLIC_SESSION_COOKIE, publicSessionCookieOptions } from "@/lib/domain/accounts/session";
import { revokeSession } from "@/lib/me/account";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

/** 기기 하나 로그아웃 — 내 세션 안에서만 id 를 찾는다. 지금 기기면 쿠키도 지운다 */
export const DELETE = webWriteRoute(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  try {
    const user = await requirePublicMutation(request);
    const { id } = await params;
    const result = await revokeSession(user.id, id, hashSessionToken(requestCookie(request, PUBLIC_SESSION_COOKIE)!));
    const response = NextResponse.json({ ok: true, current: result.current }, { headers: PUBLIC_PRIVATE_HEADERS });
    if (result.current) response.cookies.set(PUBLIC_SESSION_COOKIE, "", { ...publicSessionCookieOptions(), maxAge: 0 });
    return response;
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}, publicAuthErrorResponse);
