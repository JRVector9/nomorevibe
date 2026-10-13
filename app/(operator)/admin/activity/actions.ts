"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { adminLocalLoginEnabled, currentAdmin, normalizeOperatorName, OPERATOR_COOKIE } from "@/lib/auth/admin";
import { recordAdminAction } from "@/lib/operations/admin-log";

export type OperatorNameState = { error?: string; message?: string } | null;

/** 1년 — 브라우저마다 한 번 적으면 된다 */
const OPERATOR_COOKIE_SECONDS = 365 * 24 * 60 * 60;

/**
 * 로컬 로그인의 "내 이름"을 이 브라우저에 적는다(ADM-21). 비우면 지운다 — 그 뒤로는 다시 'local' 로 남는다.
 * 바꾼 사실도 작업 로그에 남긴다(전·후 이름).
 */
export async function saveOperatorName(_previous: OperatorNameState, form: FormData): Promise<OperatorNameState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };
  if (!adminLocalLoginEnabled()) return { error: "GitHub 로그인은 계정 이름으로 남습니다." };
  const store = await cookies();
  const before = normalizeOperatorName(store.get(OPERATOR_COOKIE)?.value);
  const name = normalizeOperatorName(form.get("name"));
  await recordAdminAction(admin.login, { action: "operator-name", target: "local-session", detail: { before, after: name } });
  if (name) {
    store.set(OPERATOR_COOKIE, name, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      path: "/admin", maxAge: OPERATOR_COOKIE_SECONDS });
  } else store.delete({ name: OPERATOR_COOKIE, path: "/admin" });
  revalidatePath("/admin/activity");
  return { message: name ? `이제부터 "${name}"(으)로 남습니다.` : "이름을 지웠습니다. 다시 local 로 남습니다." };
}
