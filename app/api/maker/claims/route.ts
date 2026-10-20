import { PUBLIC_PRIVATE_HEADERS, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { rateLimit } from "@/lib/rate-limit";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";
import { claimProducts, MakerError, parseClaimInput } from "@/lib/me/maker-claims";
import { makerErrorResponse, makerFencedResponse, readMakerJson } from "@/lib/me/maker";

/**
 * 운영자 확인 — {productIds: number[] (20개까지)} 또는 {repoUrl}. 제품마다 GitHub 에 저장소 주인을 물어 결과를 하나씩 돌려준다.
 * 로그인·Origin·CSRF·계정 한도(시간당 12번). 이미 확인한 제품은 그대로 already_verified(멱등)
 */
export const POST = webWriteRoute(async (request: Request) => {
  try {
    const user = await requirePublicMutation(request);
    const input = parseClaimInput(await readMakerJson(request, 4_096));
    if (!(await rateLimit(`maker:claims:user:${user.id}`, 12, 60 * 60_000))) throw new MakerError("rate_limited", 429);
    const results = await claimProducts(user.id, input, { signal: request.signal });
    return Response.json({ results }, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return makerErrorResponse(error);
  }
}, makerFencedResponse);
