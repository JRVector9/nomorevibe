"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { saveSettings } from "@/lib/crawl/settings";
import { logger } from "@/lib/observability/logger";

export type SaveState = { ok?: true; issues?: string[] } | null;

/** 여러 줄 입력을 배열로 (빈 줄과 공백 제거) */
function lines(value: FormDataEntryValue | null): string[] {
  return String(value ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function num(value: FormDataEntryValue | null): number {
  return Number(String(value ?? ""));
}

/**
 * 설정 저장.
 *
 * middleware가 /admin을 막지만 서버 액션은 별도 진입점이므로 자격을 다시 확인한다 —
 * 액션은 URL 없이도 호출될 수 있다.
 */
export async function saveCrawlSettings(_prev: SaveState, form: FormData): Promise<SaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };

  // 검색 신호는 행 단위로 들어온다
  const queryCount = num(form.get("queryCount"));
  const queries = Array.from({ length: Number.isFinite(queryCount) ? queryCount : 0 }, (_, i) => ({
    label: String(form.get(`query.${i}.label`) ?? ""),
    query: String(form.get(`query.${i}.query`) ?? ""),
    enabled: form.get(`query.${i}.enabled`) === "on",
    priority: num(form.get(`query.${i}.priority`)),
  })).filter((q) => q.label && q.query);

  const patch = {
    enabled: form.get("enabled") === "on",
    discover: {
      queries,
      windowDays: num(form.get("windowDays")),
      sort: String(form.get("sort") ?? "relevance"),
      pagesPerTick: num(form.get("pagesPerTick")),
    },
    judge: {
      maxStars: num(form.get("maxStars")),
      minStars: num(form.get("minStars")),
      maxPushAgeDays: num(form.get("maxPushAgeDays")),
      excludeForks: form.get("excludeForks") === "on",
      excludeOrganizations: form.get("excludeOrganizations") === "on",
      blockedHomepageDomains: lines(form.get("blockedHomepageDomains")),
      excludedRepoPatterns: lines(form.get("excludedRepoPatterns")),
      holdAmbiguous: form.get("holdAmbiguous") === "on",
    },
  };

  const result = await saveSettings(patch, admin.login);
  if (!result.ok) {
    logger.warn("admin.settings_rejected", { login: admin.login, issues: result.issues });
    return { issues: result.issues };
  }

  revalidatePath("/admin");
  return { ok: true };
}
