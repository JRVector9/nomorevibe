"use client";

import { useActionState } from "react";
import { reviewReactionCommentAction } from "./actions";

/** 보류한 한 줄 하나의 공개·숨김 — 본 글(comment)을 함께 보내 그 사이 고친 글을 모르고 공개하지 않게 한다 */
export function ReactionReviewForm({ id, comment, csrfToken, expiresAt }: { id: string; comment: string; csrfToken: string; expiresAt: number }) {
  const [state, action, pending] = useActionState(reviewReactionCommentAction, null);
  return <form action={action} className="space-y-2">
    <input type="hidden" name="id" value={id} /><input type="hidden" name="comment" value={comment} />
    <input type="hidden" name="csrfToken" value={csrfToken} /><input type="hidden" name="csrfExpiresAt" value={expiresAt} />
    <div className="flex gap-2">
      <button disabled={pending || state?.ok} type="submit" name="decision" value="accepted"
        className="min-h-11 rounded-lg bg-accent-solid px-4 text-[14px] text-white disabled:opacity-50">공개</button>
      <button disabled={pending || state?.ok} type="submit" name="decision" value="rejected"
        className="min-h-11 rounded-lg border border-line px-4 text-[14px] disabled:opacity-50">숨김</button>
    </div>
    <p aria-live="polite" className={`text-[13px] ${state?.error ? "text-down" : "text-fg-2"}`}>{pending ? "처리 중입니다." : state?.error ?? (state?.ok ? "반영했습니다." : "")}</p>
  </form>;
}
