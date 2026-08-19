"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { currentAdmin } from "@/lib/auth/admin";
import { setAutomaticUpdateVisibility } from "@/lib/domain/evidence/admin";
import { refreshProductEvidence } from "@/lib/domain/evidence/refresh";

const slugSchema = z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/);
const updateSchema = z.object({
  slug: slugSchema,
  updateId: z.coerce.number().int().positive(),
}).strict();

export type ProductEvidenceActionState = {
  ok?: true;
  issues?: string[];
  summary?: {
    attempted: number;
    failed: number;
    facts: number;
    updates: number;
    media: number;
    complete: boolean;
  };
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
    const result = await refreshProductEvidence(parsed.data, { force: true });
    paths(parsed.data);
    return {
      ok: true,
      summary: {
        attempted: result.sourcesAttempted,
        failed: result.sourcesFailed,
        facts: result.factsChanged,
        updates: result.eventsInserted,
        media: result.mediaInserted,
        complete: result.complete,
      },
    };
  } catch {
    return { issues: ["근거 갱신을 완료하지 못했습니다. 작업 상태를 확인해주세요."] };
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
