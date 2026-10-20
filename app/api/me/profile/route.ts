import { publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, readLoginJson, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { changeDisplayName } from "@/lib/me/account";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";

/** 닉네임 바꾸기 — 30일에 한 번(409 display_name_change_limited) */
export const PATCH = webWriteRoute(async (request: Request) => {
  try {
    const user = await requirePublicMutation(request);
    const input = await readLoginJson(request);
    return Response.json(await changeDisplayName(user.id, input.displayName), { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}, publicAuthErrorResponse);
