"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { editIntro, keepIntro } from "@/lib/domain/products/intro-editor";
import { LIMITS } from "@/lib/domain/products/schema";
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

/**
 * '소개 확인 필요'의 소개 고치기(ADM-23) — 사람이 새 한 줄을 적는다. 고치기 전·후 소개를 작업 로그에 남긴다.
 * 공개 화면은 다음 요청부터 새 소개를 보이고, 검색 키워드·프로필은 검색 잡이 새 소개로 다시 짓는다.
 */
export async function editIntroAction(_prev: IntroKeepState, form: FormData): Promise<IntroKeepState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const slug = String(form.get("slug") ?? "");
  const tagline = String(form.get("tagline") ?? "").trim();
  if (!tagline) return { error: "새 소개를 적어 주세요" };
  if (tagline.length > LIMITS.tagline) return { error: `소개는 ${LIMITS.tagline}자까지입니다` };
  const edited = slug ? await editIntro(slug, tagline) : null;
  await recordAdminAction(admin.login, { action: "intro-edit", target: slug,
    detail: edited ? { before: edited.before, after: tagline } : undefined, ok: edited !== null, error: edited ? null : "stale" });
  if (!edited) return { error: "이미 처리했거나 소개가 바뀌었습니다. 새로고침해주세요." };

  logger.info("admin.intro_edited", { slug, login: admin.login });
  revalidatePath("/admin/products");
  revalidatePath(`/p/${slug}`);
  return { ok: true, message: "소개를 고쳤습니다" };
}
