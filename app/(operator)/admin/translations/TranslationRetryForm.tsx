"use client";

import { useActionState } from "react";
import type { ProductTranslationAdminItem } from "@/lib/domain/products/translation-admin";
import { retryTranslationAction } from "./actions";

export function TranslationRetryForm({ item, csrfToken, expiresAt }: {
  item: Pick<ProductTranslationAdminItem, "productId" | "locale" | "field" | "sourceHash" | "currentSourceHash" | "attempts" | "retryAt" | "updatedAt" | "recovery">;
  csrfToken: string; expiresAt: number;
}) {
  const [state, action, pending] = useActionState(retryTranslationAction, null);
  const fields = { productId: item.productId, locale: item.locale, field: item.field, expectedStatus: "failed",
    expectedSourceHash: item.sourceHash, expectedCurrentSourceHash: item.currentSourceHash, expectedAttempts: item.attempts,
    expectedRetryAt: item.retryAt ?? "", expectedUpdatedAt: item.updatedAt, csrfToken, csrfExpiresAt: expiresAt };
  return <form action={action} className="mt-3 space-y-2">
    {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
    <label className="block text-[13px]">재요청 사유<input required name="reason" maxLength={1000} className="mt-1 block w-full rounded-lg border border-line p-2" /></label>
    <button disabled={pending || state?.ok} className="min-h-11 rounded-lg border border-line px-4 text-[14px] disabled:opacity-50">
      {pending ? "접수 중" : item.recovery === "new_source" ? "현재 원문으로 한 건 접수" : "상한 내 한 건 재요청"}
    </button>
    <p aria-live="polite" className={`text-[13px] ${state?.error ? "text-down" : "text-fg-2"}`}>{state?.error ?? (state?.ok ? "접수했습니다. 기존 text 워커가 처리합니다." : "")}</p>
  </form>;
}
