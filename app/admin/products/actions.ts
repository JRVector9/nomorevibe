"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { keepIntro } from "@/lib/domain/products/intro-editor";
import { logger } from "@/lib/observability/logger";
import { recordAdminAction } from "@/lib/operations/admin-log";

export type IntroKeepState = { error?: string; ok?: true; message?: string } | null;

/**
 * '소개 확인 필요'의 그대로 두기(2026-10-08 UX 감사 ADM-23) — 검수가 사람에게 넘긴 지금 소개를 두기로 정한다.
 * 목록에서 빠지고, 소개가 바뀌기 전에는 검수가 다시 넘기지 않는다.
 */
export async function keepIntroAction(_prev: IntroKeepState, form: FormData): Promise<IntroKeepState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const slug = String(form.get("slug") ?? "");
  const kept = slug ? await keepIntro(slug) : false;
  await recordAdminAction(admin.login, { action: "intro-keep", target: slug, ok: kept, error: kept ? null : "stale" });
  if (!kept) return { error: "이미 처리했거나 소개가 바뀌었습니다. 새로고침해주세요." };

  logger.info("admin.intro_kept", { slug, login: admin.login });
  revalidatePath("/admin/products");
  return { ok: true, message: "소개를 그대로 둡니다" };
}
