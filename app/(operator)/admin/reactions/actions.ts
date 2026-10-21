"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { adminLocalLoginEnabled, adminOrigin, authSecret, currentAdmin, LOCAL_ADMIN_LOGIN } from "@/lib/auth/admin";
import { ReactionError } from "@/lib/domain/reactions/contract";
import { reviewHeldReactionComment } from "@/lib/domain/reactions/review";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { assertReactionAdminCsrf } from "./csrf";

export type ReactionReviewActionState = { ok?: true; error?: string } | null;

/**
 * 보류한 써봤어요 한 줄 공개·숨김 — 다른 관리자 쓰기와 같은 문: 재해 복구 쓰기 관문 → 관리자 세션 → 요청 확인(관리자 주소·세션 HMAC)
 * → 화면이 본 글이 그대로일 때만 바꾸고 작업 로그. POST 로 바로 부를 수 있으므로 받은 값은 모두 다시 검사한다.
 */
export const reviewReactionCommentAction = webWriteAction(async function reviewReactionCommentAction(_previous: ReactionReviewActionState, form: FormData): Promise<ReactionReviewActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "관리자 로그인이 필요합니다." };
  try {
    assertReactionAdminCsrf({ admin, secret: authSecret(), origin: (await headers()).get("origin"), configuredOrigin: adminOrigin(),
      token: form.get("csrfToken"), expiresAt: Number(form.get("csrfExpiresAt")), local: adminLocalLoginEnabled() && admin.login === LOCAL_ADMIN_LOGIN });
  } catch {
    return { error: "요청을 확인하지 못했습니다 — 화면을 새로고침한 뒤 다시 해 주세요." };
  }
  const id = form.get("id"), comment = form.get("comment"), decision = form.get("decision");
  if (typeof id !== "string" || typeof comment !== "string" || (decision !== "accepted" && decision !== "rejected")) return { error: "대상과 처리를 확인해 주세요." };
  try {
    await reviewHeldReactionComment({ id, comment, decision, adminLogin: admin.login });
  } catch (error) {
    if (error instanceof ReactionError) return { error: error.code === "reaction_conflict" ? "이미 처리했거나 글쓴이가 고쳤습니다. 새로고침해 주세요." : "한 줄을 찾을 수 없습니다." };
    throw error;
  }
  revalidatePath("/admin/reactions");
  return { ok: true };
});
