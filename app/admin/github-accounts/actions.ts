"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { saveGitHubCollectorAccount, setGitHubCollectorAccountEnabled } from "@/lib/crawl/github-accounts";
import { recordAdminAction } from "@/lib/operations/admin-log";

export type TokenActionState = { ok?: string; error?: string } | null;
const messages: Record<string, string> = {
  github_collector_secret_missing: "서버의 수집 토큰 암호화 키가 설정되지 않았습니다.",
  github_token_invalid: "GitHub가 토큰을 거부했습니다. 토큰 값과 만료일을 확인하세요.",
  github_identity_unavailable: "GitHub 계정 확인에 실패했습니다. 잠시 후 다시 시도하세요.",
  github_quota_unavailable: "GitHub 한도 조회에 실패했습니다. 잠시 후 다시 시도하세요.",
  github_identity_invalid: "GitHub 계정 응답을 확인할 수 없습니다.",
  github_account_mismatch: "선택한 계정과 새 토큰의 GitHub 계정이 다릅니다.",
};

export async function saveCollectorToken(_previous: TokenActionState, form: FormData): Promise<TokenActionState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "관리자 로그인이 필요합니다." };
  const token = form.get("token");
  if (typeof token !== "string") return { error: "토큰을 입력하세요." };
  const expected = form.get("replaceUserId");
  const expectedId = expected ? Number(expected) : undefined;
  if (expectedId !== undefined && (!Number.isSafeInteger(expectedId) || expectedId <= 0)) return { error: "교체 계정이 잘못됐습니다." };
  try {
    const identity = await saveGitHubCollectorAccount(token.trim(), admin.login, expectedId);
    revalidatePath("/admin/github-accounts");
    return { ok: `${identity.login} 계정의 수집 토큰을 저장했습니다.` };
  } catch (error) {
    // 저장한 것은 저장 트랜잭션이 남긴다. 토큰 값은 어디에도 남기지 않는다
    await recordAdminAction(admin.login, { action: "github-collector-token-save", target: expectedId ? String(expectedId) : "new",
      ok: false, error: error instanceof Error ? error.message : "unknown" });
    return { error: error instanceof Error ? messages[error.message] ?? "토큰 저장에 실패했습니다. 운영 로그를 확인하세요." : "토큰 저장에 실패했습니다." };
  }
}

export async function toggleCollectorAccount(form: FormData): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) throw new Error("unauthorized");
  const userId = Number(form.get("userId"));
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error("invalid_user_id");
  const enabled = form.get("enabled") === "true";
  await setGitHubCollectorAccountEnabled(userId, enabled, admin.login);
  revalidatePath("/admin/github-accounts");
}
