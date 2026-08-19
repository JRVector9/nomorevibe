import { NextResponse } from "next/server";
import type { Product } from "@/lib/db/schema";
import {
  MakerResourceVersionMismatchError,
  makerResourceEtag,
} from "@/lib/domain/evidence/resource-version";
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

export function makerResourceResponse(body: unknown): Response {
  return NextResponse.json(body, {
    headers: {
      "cache-control": "private, no-store",
      etag: makerResourceEtag(body),
    },
  });
}

export function makerResourceVersion(request: Request) {
  const value = request.headers.get("if-match");
  return value
    ? { ok: true as const, value }
    : {
        ok: false as const,
        response: NextResponse.json(
          { error: "최신 리소스 버전을 먼저 조회하세요" },
          { status: 428 },
        ),
      };
}

export function makerResourcePreconditionResponse(error: unknown): Response | null {
  return error instanceof MakerResourceVersionMismatchError
    ? NextResponse.json(
        { error: "다른 변경이 먼저 저장됐습니다. 최신 정보를 다시 불러오세요" },
        { status: 412 },
      )
    : null;
}
