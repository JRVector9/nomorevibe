import { PublicAuthError, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { onPrimary } from "@/lib/db";
import { SAVED_LIMIT } from "@/lib/me/contract";
import { MERGE_BODY_BYTES, mergeSaved, readSavedJson, readSlugList } from "@/lib/me/saved";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";
import { rateLimit } from "@/lib/rate-limit";
import { savedWrite } from "../[slug]/handler";

/** 첫 로그인 합치기(L4) — 이 브라우저 저장 목록을 계정으로. 두 번 보내도 한 번만 들어간다 */
export const POST = webWriteRoute(async (request: Request): Promise<Response> => {
  try {
    const user = await requirePublicMutation(request);
    if (!await onPrimary(() => rateLimit(`me-saved-merge:${user.id}`, 10, 60 * 60_000))) throw new PublicAuthError(429, "saved_rate_limited");
    const slugs = readSlugList(await readSavedJson(request, MERGE_BODY_BYTES), SAVED_LIMIT);
    return Response.json(await mergeSaved(user.id, slugs), { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}, publicAuthErrorResponse);

// 이 주소가 [slug] 보다 앞선다 — 'merge' 라는 제품도 넣고 뺄 수 있게 같은 처리로 넘긴다
export const PUT = webWriteRoute((request: Request) => savedWrite("put", request, "merge"), publicAuthErrorResponse);
export const DELETE = webWriteRoute((request: Request) => savedWrite("delete", request, "merge"), publicAuthErrorResponse);
