import { NextResponse } from "next/server";
import type { Product } from "@/lib/db/schema";
import { authorizeMaker } from "@/lib/domain/products/maker-auth";
import { MakerRequestBodyError, readBoundedJson } from "@/lib/domain/evidence/maker";
import { errorResponse, tooManyRequests } from "@/lib/http/respond";
import { rateLimit, trustedClientIp } from "@/lib/rate-limit";

export async function authorizeMakerRoute(
  request: Request,
  slug: string,
): Promise<{ ok: true; product: Product; actor: string } | { ok: false; response: Response }> {
  const result = await authorizeMaker(slug, { editToken: request.headers.get("x-edit-token") });
  if (!result.ok) return { ok: false, response: errorResponse(result.error) };
  return { ok: true, product: result.value, actor: `maker:${result.value.id}` };
}

export async function allowMakerMutation(
  request: Request,
  productId: number,
  resource: string,
  productLimit = 30,
): Promise<Response | null> {
  const ip = trustedClientIp(request);
  const ipAllowed = ip === null
    ? true
    : await rateLimit(`maker:${resource}:ip:${ip}`, 120, 60 * 60 * 1_000);
  const productAllowed = await rateLimit(
    `maker:${resource}:product:${productId}`,
    productLimit,
    60 * 60 * 1_000,
  );
  return ipAllowed && productAllowed ? null : tooManyRequests();
}

export async function makerJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  try {
    return { ok: true, value: await readBoundedJson(request) };
  } catch (error) {
    if (error instanceof MakerRequestBodyError) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: error.kind === "too_large" ? "요청 본문이 너무 큽니다" : "잘못된 JSON 본문입니다" },
          { status: error.kind === "too_large" ? 413 : 400 },
        ),
      };
    }
    throw error;
  }
}
