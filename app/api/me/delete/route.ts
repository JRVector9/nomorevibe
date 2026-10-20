import { NextResponse } from "next/server";
import { publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, readLoginJson, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { PUBLIC_SESSION_COOKIE, publicSessionCookieOptions } from "@/lib/domain/accounts/session";
import { deleteAccount } from "@/lib/me/account";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

/** 계정 삭제 — 지금 닉네임을 그대로 적어야 한다(confirm). 한 트랜잭션으로 익명화하고 쿠키를 지운다 */
export const POST = webWriteRoute(async (request: Request) => {
  try {
    const user = await requirePublicMutation(request);
    const input = await readLoginJson(request);
    await deleteAccount(user.id, input.confirm);
    const response = NextResponse.json({ ok: true }, { headers: PUBLIC_PRIVATE_HEADERS });
    response.cookies.set(PUBLIC_SESSION_COOKIE, "", { ...publicSessionCookieOptions(), maxAge: 0 });
    return response;
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}, publicAuthErrorResponse);
