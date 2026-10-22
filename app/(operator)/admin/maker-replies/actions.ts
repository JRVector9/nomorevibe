"use server";
import { revalidatePath } from "next/cache";
import { authorizeAdminRequest } from "@/lib/operations/admin-requests-action-auth";
import { AdminRequestError } from "@/lib/operations/admin-requests-contract";
import { reviewMakerReply } from "@/lib/operations/maker-reply-review";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

type State = { ok?: true; error?: string } | null;
export const reviewMakerReplyAction = webWriteAction(async function reviewMakerReplyAction(_previous: State, form: FormData): Promise<State> {
  try {
    const actor = await authorizeAdminRequest("maker-replies", form);
    const reply = await reviewMakerReply({ id: form.get("id"), version: Number(form.get("version")), expectedState: form.get("expectedState"), decision: form.get("decision") }, actor);
    if (reply.targetType === "feedback") revalidatePath(`/feedback/${reply.targetId}`);
  } catch (error) {
    return { error: error instanceof AdminRequestError ? error.code === "conflict"
      ? "작성자 또는 다른 관리자가 바꿨습니다. 새로고침해 주세요." : "답장과 공개할 대상을 확인해 주세요."
      : "처리하지 못했습니다. 새로고침하고 로그인 상태를 확인해 주세요." };
  }
  revalidatePath("/admin/maker-replies"); revalidatePath("/admin/inbox"); revalidatePath("/me");
  return { ok: true };
});
