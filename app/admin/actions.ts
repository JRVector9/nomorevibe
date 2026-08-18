"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { saveSettings, resetSettings } from "@/lib/crawl/settings";
import { decideCandidate, type ReviewDecision } from "@/lib/crawl/review";
import { resolveTakedown, type TakedownAction } from "@/lib/domain/products/takedown";
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

export type ReviewState = { error?: string } | null;

/**
 * 심사 결정.
 *
 * 설정 저장과 같은 이유로 여기서도 자격을 다시 확인한다 — 서버 액션은 URL 없이
 * 호출될 수 있으므로 middleware가 막아주지 않는다.
 */
export async function decideCrawlCandidate(_prev: ReviewState, form: FormData): Promise<ReviewState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const decision = String(form.get("decision") ?? "");
  if (decision !== "approve" && decision !== "reject") return { error: "알 수 없는 결정입니다" };

  const result = await decideCandidate({
    repo: String(form.get("repo") ?? ""),
    decision: decision as ReviewDecision,
    reason: String(form.get("reason") ?? ""),
    admin: admin.login,
  });
  if (!result.ok) {
    logger.warn("admin.review_rejected", { login: admin.login, message: result.message });
    return { error: result.message };
  }

  revalidatePath("/admin/review");
  return null;
}

/**
 * 내려달라는 요청 처리.
 *
 * 내릴 때 행을 지우지 않고 banned로 둔다 — 지우면 수집기가 다음 바퀴에 같은 URL을 다시
 * 주워 온다. 유스케이스가 그렇게 하고, 여기서는 자격 확인과 파싱만 한다.
 */
export async function resolveTakedownRequest(_prev: ReviewState, form: FormData): Promise<ReviewState> {
  const admin = await currentAdmin();
  if (!admin) return { error: "권한이 없습니다. 다시 로그인해주세요." };

  const action = String(form.get("action") ?? "");
  if (action !== "remove" && action !== "dismiss") return { error: "알 수 없는 결정입니다" };

  const result = await resolveTakedown(String(form.get("slug") ?? ""), action as TakedownAction, admin.login);
  if (!result.ok) {
    logger.warn("admin.takedown_rejected", { login: admin.login, error: result.error });
    return { error: "요청을 처리하지 못했습니다" };
  }

  revalidatePath("/admin/review");
  return null;
}

/**
 * 기준을 코드 기본값으로 되돌린다.
 *
 * 판정 규칙을 고쳐도 저장된 설정이 있으면 그 값이 이긴다. 배포 환경이 옛 기준으로 도는 것을
 * 손으로 고치게 두지 않는다. 수집 스위치는 건드리지 않는다.
 */
export async function resetCrawlSettings(): Promise<SaveState> {
  const admin = await currentAdmin();
  if (!admin) return { issues: ["권한이 없습니다. 다시 로그인해주세요."] };

  const result = await resetSettings(admin.login);
  if (!result.ok) {
    logger.warn("admin.settings_reset_failed", { login: admin.login, issues: result.issues });
    return { issues: result.issues };
  }

  logger.info("admin.settings_reset", { login: admin.login });
  revalidatePath("/admin");
  return { ok: true };
}
