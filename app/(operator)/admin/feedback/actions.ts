"use server";

import { createHmac, timingSafeEqual } from "node:crypto";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { adminLocalLoginEnabled, adminOrigin, authSecret, currentAdmin, LOCAL_ADMIN_LOGIN } from "@/lib/auth/admin";
import { reviewFeedback } from "@/lib/domain/feedback/review";
import { FeedbackError } from "@/lib/domain/feedback/contract";

export async function reviewFeedbackAction(form: FormData): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) throw new Error("unauthorized");
  const secret = authSecret();
  const origin = (await headers()).get("origin");
  const configuredOrigin = adminOrigin();
  if (!secret || !configuredOrigin || origin !== configuredOrigin) throw new Error("forbidden");
  const nonce = form.get("csrfToken");
  const expiresAt = Number(form.get("csrfExpiresAt"));
  const now = Math.floor(Date.now() / 1000);
  const local = adminLocalLoginEnabled() && admin.login === LOCAL_ADMIN_LOGIN;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || (local ? expiresAt > now + 12 * 3600 : expiresAt !== admin.exp)) throw new Error("forbidden");
  const expected = createHmac("sha256", secret).update(`feedback-admin:${admin.login}:${expiresAt}`).digest("hex");
  if (typeof nonce !== "string" || !/^[a-f0-9]{64}$/.test(nonce) || !timingSafeEqual(Buffer.from(nonce, "hex"), Buffer.from(expected, "hex"))) throw new Error("forbidden");
  const id = form.get("id"), decision = form.get("decision"), reason = form.get("reason"), expectedReviewState = form.get("expectedReviewState");
  if (typeof id !== "string" || (decision !== "accepted" && decision !== "rejected") || typeof reason !== "string"
    || (expectedReviewState !== "accepted" && expectedReviewState !== "held" && expectedReviewState !== "rejected")) throw new FeedbackError("feedback_invalid", 400);
  await reviewFeedback({ id, expectedReviewState, decision, reason, adminLogin: admin.login });
  revalidatePath("/admin/feedback");
  revalidatePath("/admin/inbox");
  revalidatePath("/admin/github-integrations");
  revalidatePath(`/feedback/${id}`);
}

export type FeedbackReviewActionState = { ok?: true; error?: string } | null;
export async function reviewFeedbackFormAction(_previous: FeedbackReviewActionState, form: FormData): Promise<FeedbackReviewActionState> {
  try {
    await reviewFeedbackAction(form);
    return { ok: true };
  } catch (error) {
    if (error instanceof FeedbackError) return { error: error.code === "feedback_conflict"
      ? "이미 처리했거나 상태가 바뀌었습니다. 새로고침해주세요." : error.code === "feedback_invalid"
        ? "대상과 처리 사유를 확인해주세요." : "댓글 또는 공개할 제품을 찾을 수 없습니다." };
    return { error: "처리하지 못했습니다. 로그인 상태를 확인하고 다시 시도해주세요." };
  }
}
