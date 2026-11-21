"use client";

import { useActionState } from "react";
import type { ProductTranslationAdminItem } from "@/lib/domain/products/translation-admin";
import { revertSourceNativeAction } from "./actions";

/** A ready source_native row (the model kept the source as already English): put it back to failed when the source is not English. */
export function SourceNativeRevertForm({ item, csrfToken, expiresAt }: {
  item: Pick<ProductTranslationAdminItem, "productId" | "locale" | "field" | "sourceHash" | "updatedAt">;
  csrfToken: string; expiresAt: number;
}) {
  const [state, action, pending] = useActionState(revertSourceNativeAction, null);
  const fields = { productId: item.productId, locale: item.locale, field: item.field, expectedStatus: "ready",
    expectedSourceHash: item.sourceHash, expectedUpdatedAt: item.updatedAt, csrfToken, csrfExpiresAt: expiresAt };
  return <form action={action} className="mt-3 space-y-2">
    {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
    <label className="block text-[13px]">되돌리는 사유<input required name="reason" maxLength={1000} className="mt-1 block w-full rounded-lg border border-line p-2" /></label>
    <button disabled={pending || state?.ok} className="min-h-11 rounded-lg border border-line px-4 text-[14px] disabled:opacity-50">
      {pending ? "되돌리는 중" : "영어 아님 — 실패로 되돌리기"}
    </button>
    <p aria-live="polite" className={`text-[13px] ${state?.error ? "text-down" : "text-fg-2"}`}>
      {state?.error ?? (state?.ok ? "되돌렸습니다. 영어 화면은 다시 번역 대기로 보이고, 같은 원문은 자동으로 다시 부르지 않습니다." : "")}
    </p>
  </form>;
}
