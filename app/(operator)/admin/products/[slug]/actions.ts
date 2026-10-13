"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentAdmin } from "@/lib/auth/admin";
import { setAutomaticUpdateVisibility } from "@/lib/domain/evidence/admin";
import { queueProductRefresh } from "@/lib/domain/evidence/refresh-requests";
import { recordAdminAction } from "@/lib/operations/admin-log";

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

export async function forceProductRefresh(
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
}

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

export async function hideAutomaticUpdate(
  previous: ProductEvidenceActionState,
  form: FormData,
) {
  return await changeAutomaticUpdate(false, previous, form);
}

export async function restoreAutomaticUpdate(
  previous: ProductEvidenceActionState,
  form: FormData,
) {
  return await changeAutomaticUpdate(true, previous, form);
}
