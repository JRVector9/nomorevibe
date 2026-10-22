"use server";
import { revalidatePath } from "next/cache";
import { authorizeAdminRequest } from "@/lib/operations/admin-requests-action-auth";
import { AdminRequestError } from "@/lib/operations/admin-requests-contract";
import { createContactRequest, updateContactRequest } from "@/lib/operations/contact-requests";
import { webWriteAction } from "@/lib/operations/dr/web-gate";

type State = { ok?: true; error?: string } | null;
const errorState = (error: unknown): State => ({ error: error instanceof AdminRequestError
  ? error.code === "conflict" ? "다른 관리자가 처리했습니다. 새로고침해 주세요." : "입력 내용과 문의를 확인해 주세요."
  : "처리하지 못했습니다. 새로고침하고 로그인 상태를 확인해 주세요." });
export const createContactAction = webWriteAction(async function createContactAction(_previous: State, form: FormData): Promise<State> {
  try {
    const actor = await authorizeAdminRequest("contact-requests", form);
    const received = form.get("receivedAt");
    await createContactRequest({ senderEmail: form.get("senderEmail"), subject: form.get("subject"), body: form.get("body"),
      receivedAt: typeof received === "string" ? `${received}:00.000Z` : received }, actor);
  } catch (error) { return errorState(error); }
  revalidatePath("/admin/requests"); revalidatePath("/admin/inbox");
  return { ok: true };
});
export const updateContactAction = webWriteAction(async function updateContactAction(_previous: State, form: FormData): Promise<State> {
  try {
    const actor = await authorizeAdminRequest("contact-requests", form);
    await updateContactRequest({ id: form.get("id"), version: Number(form.get("version")), status: form.get("status"), handlingNote: form.get("handlingNote") }, actor);
  } catch (error) { return errorState(error); }
  revalidatePath("/admin/requests"); revalidatePath("/admin/inbox");
  return { ok: true };
});
