"use server";

import { createHmac, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { adminLocalLoginEnabled, adminOrigin, authSecret, currentAdmin, LOCAL_ADMIN_LOGIN } from "@/lib/auth/admin";
import { ProductTranslationAdminError, retryProductTranslation } from "@/lib/domain/products/translation-admin";
import { isProductTranslationField } from "@/lib/domain/products/translation-policy";
import type { ProductTranslationLocale } from "@/lib/db/schema";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

export type TranslationActionState = { ok?: true; error?: string; kind?: "retry" | "new_source" } | null;

function field(form: FormData, name: string): string {
  const values = form.getAll(name);
  if (values.length !== 1 || typeof values[0] !== "string") throw new ProductTranslationAdminError("invalid");
  return values[0];
}

export const retryTranslationAction = webWriteAction(async function retryTranslationAction(_previous: TranslationActionState, form: FormData): Promise<TranslationActionState> {
  try {
    const admin = await currentAdmin();
    if (!admin) throw new Error("unauthorized");
    const secret = authSecret(), origin = (await headers()).get("origin");
    const configuredOrigin = adminOrigin();
    const nonce = field(form, "csrfToken"), expiresAt = Number(field(form, "csrfExpiresAt")), now = Math.floor(Date.now() / 1000);
    const local = adminLocalLoginEnabled() && admin.login === LOCAL_ADMIN_LOGIN;
    if (!secret || !configuredOrigin || origin !== configuredOrigin || !Number.isSafeInteger(expiresAt) || expiresAt <= now
      || (local ? expiresAt > now + 12 * 3600 : expiresAt !== admin.exp) || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error("forbidden");
    const expected = createHmac("sha256", secret).update(`product-translation-admin:${admin.login}:${expiresAt}`).digest("hex");
    if (!timingSafeEqual(Buffer.from(nonce, "hex"), Buffer.from(expected, "hex"))) throw new Error("forbidden");
    const locale = field(form, "locale"), targetField = field(form, "field");
    if (!["en", "zh-Hans", "zh-Hant"].includes(locale) || !isProductTranslationField(targetField)
      || field(form, "expectedStatus") !== "failed") throw new ProductTranslationAdminError("invalid");
    const result = await retryProductTranslation({ productId: Number(field(form, "productId")), locale: locale as ProductTranslationLocale,
      field: targetField, expectedSourceHash: field(form, "expectedSourceHash"), expectedCurrentSourceHash: field(form, "expectedCurrentSourceHash"),
      expectedAttempts: Number(field(form, "expectedAttempts")), expectedRetryAt: field(form, "expectedRetryAt") || null,
      expectedUpdatedAt: field(form, "expectedUpdatedAt"), reason: field(form, "reason"), adminLogin: admin.login });
    revalidatePath("/admin/translations");
    revalidatePath("/admin/inbox");
    revalidatePath("/admin/status");
    revalidatePath(`/admin/products/${result.slug}`);
    return { ok: true, kind: result.kind };
  } catch (error) {
    if (error instanceof ProductTranslationAdminError) return { error: error.code === "conflict"
      ? "원문 또는 실패 상태가 바뀌었습니다. 새로고침해주세요." : error.code === "blocked"
        ? "보류·재시도 대기·시도 상한을 확인해주세요. 현재는 재요청할 수 없습니다." : "대상과 재요청 사유를 확인해주세요." };
    return { error: "재요청하지 못했습니다. 로그인 상태를 확인하고 다시 시도해주세요." };
  }
});
