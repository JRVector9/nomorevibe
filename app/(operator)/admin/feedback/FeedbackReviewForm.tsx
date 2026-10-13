"use client";

import { useActionState } from "react";
import type { FeedbackReviewState } from "@/lib/domain/feedback/contract";
import { reviewFeedbackFormAction } from "./actions";

export function FeedbackReviewForm({ id, reviewState, csrfToken, expiresAt }: {
  id: string; reviewState: FeedbackReviewState; csrfToken: string; expiresAt: number;
}) {
  const [state, action, pending] = useActionState(reviewFeedbackFormAction, null);
  return <form action={action} className="space-y-3">
    <input type="hidden" name="id" value={id} /><input type="hidden" name="expectedReviewState" value={reviewState} />
    <input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="csrfExpiresAt" value={expiresAt} />
    <label className="block text-[14px]">처리 사유<input required name="reason" maxLength={1000} className="mt-1 block w-full rounded-lg border border-line p-3" /></label>
    <div className="flex gap-2">
      {reviewState !== "accepted" && <button disabled={pending} type="submit" name="decision" value="accepted"
        className="min-h-11 rounded-lg bg-accent-solid px-4 text-[14px] text-white disabled:opacity-50">{reviewState === "held" ? "공개 승인" : "공개 복원"}</button>}
      {reviewState !== "rejected" && <button disabled={pending} type="submit" name="decision" value="rejected"
        className="min-h-11 rounded-lg border border-line px-4 text-[14px] disabled:opacity-50">{reviewState === "held" ? "공개 거절" : "공개 숨김"}</button>}
    </div>
    <p aria-live="polite" className={`text-[13px] ${state?.error ? "text-down" : "text-fg-2"}`}>{pending ? "처리 중입니다." : state?.error ?? (state?.ok ? "반영했습니다." : "")}</p>
  </form>;
}
