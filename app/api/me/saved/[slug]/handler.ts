import { PublicAuthError, publicAuthErrorResponse, PUBLIC_PRIVATE_HEADERS, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { onPrimary } from "@/lib/db";
import { deleteSaved, isProductSlug, putSaved } from "@/lib/me/saved";
import { rateLimit } from "@/lib/rate-limit";

/** 저장 넣기·빼기 — 둘 다 멱등. 카드·상세·마이페이지의 책갈피가 부른다. 관문(webWriteRoute)은 route 가 씌운다 */
export async function savedWrite(action: "put" | "delete", request: Request, slug: string): Promise<Response> {
  try {
    const user = await requirePublicMutation(request);
    if (!isProductSlug(slug)) throw new PublicAuthError(400, "invalid_slug");
    if (!await onPrimary(() => rateLimit(`me-saved:${user.id}`, 120, 60_000))) throw new PublicAuthError(429, "saved_rate_limited");
    const result = action === "put" ? await putSaved(user.id, slug) : await deleteSaved(user.id, slug);
    return Response.json(result, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return publicAuthErrorResponse(error);
  }
}
