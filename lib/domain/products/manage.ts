import type { Product } from "@/lib/db/schema";
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

  await repo.remove(auth.value.id);
  await repo.deleteOgImage(slug);
  return ok({ slug });
}

/**
 * 어드민 차단 — 행을 지우지 않고 banned로 표시한다.
 * 행이 남아 있으므로 같은 URL의 재등록도 자동으로 막힌다.
 */
export async function banProduct(slug: string): Promise<Result<{ slug: string }>> {
  const product = await repo.findBySlug(slug);
  if (!product) return fail({ kind: "not_found" });

  await repo.update(product.id, { status: "banned" });
  return ok({ slug });
}
