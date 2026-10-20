import { PUBLIC_PRIVATE_HEADERS, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { rateLimit } from "@/lib/rate-limit";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";
import { MakerError } from "@/lib/me/maker-claims";
import { editMakerIntro, makerErrorResponse, makerFencedResponse, parseIntroInput, readMakerJson } from "@/lib/me/maker";

/** 소개 고치기 — {productId, tagline?, description?}. 운영자로 확인한 계정만, 수정 키 경로와 같은 검사·같은 쓰기. 시간당 30번 */
export const PUT = webWriteRoute(async (request: Request) => {
  try {
    const user = await requirePublicMutation(request);
    const input = parseIntroInput(await readMakerJson(request, 32_768));
    if (!(await rateLimit(`maker:intro:user:${user.id}`, 30, 60 * 60_000))) throw new MakerError("rate_limited", 429);
    return Response.json(await editMakerIntro(user.id, input), { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) {
    return makerErrorResponse(error);
  }
}, makerFencedResponse);
