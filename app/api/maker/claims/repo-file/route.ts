import { PUBLIC_PRIVATE_HEADERS, PublicAuthError, requirePublicMutation } from "@/lib/domain/accounts/request-auth";
import { webWriteRoute } from "@/lib/operations/dr/web-gate";
import { rateLimit } from "@/lib/rate-limit";
import { makerErrorResponse, makerFencedResponse, readMakerJson } from "@/lib/me/maker";
import { completeRepositoryProof, startRepositoryProof } from "@/lib/me/maker-repo-proof";
import { trackServer } from "@/lib/analytics/server";

/** Same public login, Origin, CSRF, body and account limits as personal repository claims. No user-supplied repository/ref. */
export const POST = webWriteRoute(async (request: Request) => {
  try {
    const user = await requirePublicMutation(request);
    const body = await readMakerJson(request, 4_096) as { productId?: unknown; token?: unknown } | null;
    if (!body || typeof body !== "object" || Array.isArray(body) || !Number.isSafeInteger(body.productId) || (body.productId as number) <= 0
      || (body.productId as number) > 2_147_483_647 || Object.keys(body).some((key) => key !== "productId" && key !== "token")
      || ("token" in body && (typeof body.token !== "string" || !body.token || body.token.length > 2_048))) throw new PublicAuthError(400, "invalid_request");
    if (!(await rateLimit(`maker:claims:user:${user.id}`, 12, 60 * 60_000))) throw new PublicAuthError(429, "rate_limited");
    if (typeof body.token !== "string") return Response.json(await startRepositoryProof(user.id, body.productId as number, request.signal), { headers: PUBLIC_PRIVATE_HEADERS });
    const result = await completeRepositoryProof(user.id, body.productId as number, body.token, request.signal);
    if (result.result === "verified") trackServer("product_claimed", { product_slug: result.slug, method: "other" }, { request, identity: "browser", userId: user.id });
    return Response.json(result, { headers: PUBLIC_PRIVATE_HEADERS });
  } catch (error) { return makerErrorResponse(error); }
}, makerFencedResponse);
