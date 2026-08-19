import type { Product } from "@/lib/db/schema";
import { authenticate, type Credentials } from "./actor";
import { type Result, fail, ok } from "./errors";
import { findBySlug } from "./repository";

/** 메이커 쓰기 경로가 공유하는 제품 조회·차단·수정키 인증 경계. */
export async function authorizeMaker(
  slug: string,
  credentials: Credentials,
): Promise<Result<Product>> {
  const product = await findBySlug(slug);
  if (!product) return fail({ kind: "not_found" });
  if (product.status === "banned") {
    return fail({ kind: "forbidden", message: "차단된 제품입니다" });
  }

  const outcome = authenticate(product, credentials);
  if (!outcome.ok) {
    return outcome.reason === "missing"
      ? fail({ kind: "unauthorized", message: "X-Edit-Token 헤더가 필요합니다" })
      : fail({ kind: "forbidden", message: "수정 키가 올바르지 않습니다" });
  }
  return ok(product);
}
