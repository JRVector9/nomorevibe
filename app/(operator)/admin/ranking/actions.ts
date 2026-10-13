"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import {
  cancelScheduledPolicy,
  schedulePolicy,
} from "@/lib/domain/ranking/policies";
import { recordAdminAction } from "@/lib/operations/admin-log";

export type RankingPolicyActionState = {
  ok?: true;
  issues?: string[];
  warnings?: string[];
} | null;

export async function saveRankingPolicy(
  _previous: RankingPolicyActionState,
  form: FormData,
): Promise<RankingPolicyActionState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };

  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get("policy") ?? ""));
  } catch {
    return { issues: ["설정 형식을 읽을 수 없습니다."] };
  }

  const result = await schedulePolicy(raw, admin.login);
  await recordAdminAction(admin.login, result.ok
    ? { action: "ranking-schedule", target: `revision:${result.revision.id}`, detail: { policy: raw as Record<string, unknown> } }
    : { action: "ranking-schedule", target: "ranking_policy", detail: { policy: raw as Record<string, unknown> }, ok: false, error: result.issues.join(" · ") });
  if (!result.ok) return { issues: result.issues };

  revalidatePath("/admin/ranking");
  return { ok: true, warnings: result.warnings };
}

export async function cancelRankingPolicy(): Promise<void> {
  const admin = await currentAdmin();
  if (!admin) return;

  await cancelScheduledPolicy(admin.login);
  await recordAdminAction(admin.login, { action: "ranking-cancel", target: "ranking_policy" });
  revalidatePath("/admin/ranking");
}
