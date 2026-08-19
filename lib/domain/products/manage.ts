import type { Product, ProductStatus } from "@/lib/db/schema";
import type { UpdateInput } from "./schema";
import { type Result, ok, fail } from "./errors";
import { authenticate, type Credentials } from "./actor";
import * as repo from "./repository";

/** 제품을 찾고 수정 자격을 확인한다 — 자격의 종류는 actor.ts가 안다 */
async function authorize(slug: string, credentials: Credentials): Promise<Result<Product>> {
  const product = await repo.findBySlug(slug);
  if (!product) return fail({ kind: "not_found" });
  if (product.status === "banned") return fail({ kind: "forbidden", message: "차단된 제품입니다" });

  const outcome = authenticate(product, credentials);
  if (!outcome.ok) {
    return outcome.reason === "missing"
      ? fail({ kind: "unauthorized", message: "X-Edit-Token 헤더가 필요합니다" })
      : fail({ kind: "forbidden", message: "수정 키가 올바르지 않습니다" });
  }
  return ok(product);
}

export async function updateProduct(
  slug: string,
  credentials: Credentials,
  input: UpdateInput,
): Promise<Result<{ slug: string }>> {
  const auth = await authorize(slug, credentials);
  if (!auth.ok) return auth;

  // URL은 소유권의 기준이라 수정 대상에 없다 (스키마에서 이미 배제)
  const updates: Partial<Product> = {};
  if (input.name !== undefined) updates.name = input.name;
  if (input.tagline !== undefined) updates.tagline = input.tagline;
  if (input.description !== undefined) updates.description = input.description;
  if (input.category !== undefined) updates.category = input.category;
  if (input.builder !== undefined) updates.builder = input.builder;
  if (input.stack !== undefined) updates.stack = input.stack;
  if (input.maker_name !== undefined) updates.makerName = input.maker_name;
  if (input.repo_url !== undefined) updates.repoUrl = input.repo_url;

  await repo.update(auth.value.id, updates);
  return ok({ slug });
}

export async function deleteProduct(
  slug: string,
  credentials: Credentials,
): Promise<Result<{ slug: string }>> {
  const auth = await authorize(slug, credentials);
  if (!auth.ok) return auth;

  // slug는 다시 쓰이므로 제품 소유 데이터와 흔적을 한 트랜잭션에서 함께 지운다.
  const removed = await repo.removeProductAndEvidence(auth.value.id, slug);
  if (!removed) return fail({ kind: "not_found" });
  return ok({ slug });
}

/**
 * 어드민 차단 — 행을 지우지 않고 banned로 표시한다.
 * 행이 남아 있으므로 같은 URL의 재등록도 자동으로 막힌다.
 */
export async function banProduct(slug: string): Promise<Result<{ slug: string }>> {
  const product = await repo.findBySlug(slug);
  if (!product) return fail({ kind: "not_found" });
  if (product.status === "banned") return ok({ slug });

  const changed = await repo.setStatusWithAudit({
    id: product.id,
    slug,
    status: "banned",
    action: "admin.product.ban",
  });
  if (!changed) return fail({ kind: "not_found" });
  return ok({ slug });
}

/**
 * 차단 해제 — 차단 전 상태를 되돌린다.
 *
 * 이전 상태를 따로 저장하지 않지만 유도할 수 있다. 검증 시각이 남아 있으면 검증된 제품이었고,
 * 수집기가 올린 것이면 seeded, 나머지는 검증 대기다. 잘못 누른 차단을 되돌릴 길이 없으면
 * 차단 버튼을 누르는 것 자체가 무서운 일이 된다.
 */
export async function unbanProduct(slug: string): Promise<Result<{ slug: string; status: ProductStatus }>> {
  const product = await repo.findBySlug(slug);
  if (!product) return fail({ kind: "not_found" });
  if (product.status !== "banned") return ok({ slug, status: product.status });

  const status: ProductStatus = product.verifiedAt
    ? "verified"
    : product.source === "crawler"
      ? "seeded"
      : "unverified";
  const changed = await repo.setStatusWithAudit({
    id: product.id,
    slug,
    status,
    action: "admin.product.unban",
  });
  if (!changed) return fail({ kind: "not_found" });
  return ok({ slug, status });
}
