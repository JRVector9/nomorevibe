"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentAdmin } from "@/lib/auth/admin";
import { setAutomaticUpdateVisibility } from "@/lib/domain/evidence/admin";
import { queueProductRefresh } from "@/lib/domain/evidence/refresh-requests";
import { denyMaintainerEmail, MAINTAINER_EMAIL_DENY_ACTION } from "@/lib/domain/makers/maintainer-emails-admin";
import { findBySlug } from "@/lib/domain/products/repository";
import { recordAdminAction } from "@/lib/operations/admin-log";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const updateSchema = z.object({
  slug: slugSchema,
  updateId: z.coerce.number().int().positive(),
}).strict();

export type ProductEvidenceActionState = {
  ok?: true;
  issues?: string[];
  request?: { productId: number; requestedVersion: number };
} | null;

function paths(slug: string) {
  revalidatePath(`/admin/products/${slug}`);
  revalidatePath(`/p/${slug}`);
  revalidatePath("/admin/status");
}

export const forceProductRefresh = webWriteAction(async function forceProductRefresh(
  _previous: ProductEvidenceActionState,
  form: FormData,
): Promise<ProductEvidenceActionState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const parsed = slugSchema.safeParse(String(form.get("slug") ?? ""));
  if (!parsed.success) return { issues: ["제품 식별자를 확인해주세요."] };
  try {
    const result = await queueProductRefresh({ slug: parsed.data, actor: admin.login, force: true });
    await recordAdminAction(admin.login, { action: "product-refresh", target: parsed.data, detail: { requestedVersion: result.requestedVersion } });
    paths(parsed.data);
    return {
      ok: true,
      request: { productId: result.productId, requestedVersion: result.requestedVersion },
    };
  } catch (error) {
    await recordAdminAction(admin.login, { action: "product-refresh", target: parsed.data, ok: false,
      error: error instanceof Error ? error.message : String(error) });
    return { issues: ["갱신 요청을 접수하지 못했습니다. 잠시 후 다시 시도해주세요."] };
  }
});

async function changeAutomaticUpdate(
  visible: boolean,
  _previous: ProductEvidenceActionState,
  form: FormData,
): Promise<ProductEvidenceActionState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const parsed = updateSchema.safeParse({
    slug: String(form.get("slug") ?? ""),
    updateId: form.get("updateId"),
  });
  if (!parsed.success) return { issues: ["업데이트 식별자를 확인해주세요."] };
  const inputReason = String(form.get("reason") ?? "").trim();
  if (!visible && !inputReason) return { issues: ["숨김 사유를 입력해주세요."] };
  const reason = inputReason || "관리자 복원";
  const result = await setAutomaticUpdateVisibility({
    ...parsed.data,
    visible,
    reason,
    actor: admin.login,
  });
  await recordAdminAction(admin.login, { action: visible ? "update-restore" : "update-hide", target: parsed.data.slug,
    detail: { updateId: parsed.data.updateId, reason }, ok: result !== "not_found" && result !== "forbidden",
    error: result === "not_found" || result === "forbidden" ? result : null });
  if (result === "not_found") return { issues: ["업데이트를 찾을 수 없습니다."] };
  if (result === "forbidden") return { issues: ["메이커 업데이트는 이 제어로 바꿀 수 없습니다."] };
  paths(parsed.data.slug);
  return { ok: true };
}

export const hideAutomaticUpdate = webWriteAction(async function hideAutomaticUpdate(
  previous: ProductEvidenceActionState,
  form: FormData,
) {
  return await changeAutomaticUpdate(false, previous, form);
});

export const restoreAutomaticUpdate = webWriteAction(async function restoreAutomaticUpdate(
  previous: ProductEvidenceActionState,
  form: FormData,
) {
  return await changeAutomaticUpdate(true, previous, form);
});

export type MaintainerEmailDenyState = { ok?: true; deletedRows?: number; issues?: string[] } | null;
const denyKeySchema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * 제작자 이메일 「지우고 다시 모으지 않기」(관리자 전용, 0194) — 그 주소를 모든 저장소에서 지우고 거부 목록(해시)에 넣는다.
 * 양식은 주소 대신 해시(denyKey)를 보낸다. 저장소는 양식 값이 아니라 제품의 repo_url 로 정한다. 작업 로그에는 주소·해시를 남기지 않는다.
 */
export const denyMaintainerEmailAction = webWriteAction(async function denyMaintainerEmailAction(
  _previous: MaintainerEmailDenyState,
  form: FormData,
): Promise<MaintainerEmailDenyState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };
  const slug = slugSchema.safeParse(String(form.get("slug") ?? ""));
  const denyKey = denyKeySchema.safeParse(String(form.get("denyKey") ?? ""));
  if (!slug.success || !denyKey.success) return { issues: ["지울 주소를 확인해주세요."] };
  const product = await findBySlug(slug.data);
  if (!product) return { issues: ["제품을 찾을 수 없습니다."] };
  try {
    const result = await denyMaintainerEmail({ slug: slug.data, repoUrl: product.repoUrl, denyKey: denyKey.data, actor: admin.login });
    revalidatePath(`/admin/products/${slug.data}`);
    return { ok: true, deletedRows: result.deletedRows };
  } catch (error) {
    // 실패 기록에도 주소·해시는 남기지 않는다(오류 글은 DB 까닭만 — 값이 실린 SQL 을 담지 않는다)
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    await recordAdminAction(admin.login, { action: MAINTAINER_EMAIL_DENY_ACTION, target: slug.data, ok: false,
      error: (cause as { code?: unknown } | null)?.code ? String((cause as { code: unknown }).code) : "failed" });
    return { issues: ["주소를 지우지 못했습니다. 잠시 후 다시 시도해주세요."] };
  }
});
