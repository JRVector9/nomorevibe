"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { saveSettings } from "@/lib/crawl/settings";
import { requestJob } from "@/lib/jobs/control";
import { logger } from "@/lib/observability/logger";
import { NEWS_JOB, setNewsState } from "@/lib/news/repository";
import { NEWS_SOURCE_KEYS } from "@/lib/news/sources";

export type NewsActionState = { ok?: string; error?: string } | null;

const MAX_DECISIONS = 200;
const DENIED = { error: "권한이 없습니다. 다시 로그인해주세요." };

/** 고른 글을 게시하거나 숨긴다. 숨긴 글은 다시 수집돼도 되살아나지 않는다 */
export async function decideNews(_previous: NewsActionState, form: FormData): Promise<NewsActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const decision = form.get("decision");
  if (decision !== "approved" && decision !== "hidden") return { error: "게시 또는 숨김을 골라주세요." };
  const ids = [...new Set(form.getAll("id").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return { error: "고른 글이 없습니다." };
  if (ids.length > MAX_DECISIONS) return { error: `한 번에 ${MAX_DECISIONS}건까지 바꿉니다.` };

  const changed = await setNewsState(ids, decision, admin.login);
  logger.info("admin.news_decided", { login: admin.login, decision, changed });
  revalidatePath("/admin/news");
  revalidatePath("/");
  return { ok: `${changed}건을 ${decision === "approved" ? "게시" : "숨김"}했습니다.` };
}

/** 자동 승인과 켜 둘 출처. 체크하지 않은 출처는 수집하지 않는다 */
export async function saveNewsSettings(_previous: NewsActionState, form: FormData): Promise<NewsActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const enabled = new Set(form.getAll("source").map(String));
  const result = await saveSettings({
    news: {
      autoApprove: form.get("autoApprove") === "on",
      disabledSources: NEWS_SOURCE_KEYS.filter((key) => !enabled.has(key)),
    },
  }, admin.login);
  if (!result.ok) return { error: result.issues.join(" · ") };
  revalidatePath("/admin/news");
  return { ok: "저장했습니다. 다음 수집부터 적용됩니다." };
}

/** 한 시간을 기다리지 않고 지금 한 바퀴 돌린다 */
export async function refreshNewsNow(): Promise<NewsActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  await requestJob(NEWS_JOB);
  logger.info("admin.news_refresh_requested", { login: admin.login });
  return { ok: "수집을 요청했습니다. 1~2분 뒤 새로고침하면 보입니다." };
}
