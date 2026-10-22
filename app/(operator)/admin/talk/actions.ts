"use server";

import { revalidatePath } from "next/cache";
import { currentAdmin } from "@/lib/auth/admin";
import { logger } from "@/lib/observability/logger";
import { recordAdminAction } from "@/lib/operations/admin-log";
import { webWriteAction } from "@/lib/operations/dr/web-gate";
import { REPOSITORY_KEY, setSocialPostsState, setTalkExcluded, setTalkHomeDecision } from "@/lib/social/admin";

export type TalkActionState = { ok?: string; error?: string } | null;

const MAX_POSTS = 200;
const DENIED = { error: "권한이 없습니다. 다시 로그인해주세요." };

/** 관리자 결정은 공개 화면 셋(홈·/talk·상세)에 바로 비친다 */
function revalidateTalk() {
  revalidatePath("/admin/talk");
  revalidatePath("/talk");
  revalidatePath("/");
}

/** 고른 글을 숨기거나 다시 보인다 */
export const decideTalkPosts = webWriteAction(async function decideTalkPosts(_previous: TalkActionState, form: FormData): Promise<TalkActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const decision = form.get("decision");
  if (decision !== "hidden" && decision !== "visible") return { error: "숨기기 또는 다시 보이기를 골라주세요." };
  const ids = [...new Set(form.getAll("id").map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return { error: "고른 글이 없습니다." };
  if (ids.length > MAX_POSTS) return { error: `한 번에 ${MAX_POSTS}건까지 바꿉니다.` };
  const changed = await setSocialPostsState(ids, decision);
  await recordAdminAction(admin.login, { action: decision === "hidden" ? "talk-post-hide" : "talk-post-show",
    target: ids.length === 1 ? `social_post:${ids[0]}` : `social_post:${ids.length}건`, detail: { ids, changed } });
  logger.info("admin.talk_posts_decided", { login: admin.login, decision, changed });
  revalidateTalk();
  return { ok: `${changed}건을 ${decision === "hidden" ? "숨겼습니다" : "다시 보이게 했습니다"}.` };
});

/** 저장소를 화제에서 빼거나 되돌린다 */
export const excludeTalkRepository = webWriteAction(async function excludeTalkRepository(_previous: TalkActionState, form: FormData): Promise<TalkActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const key = String(form.get("repository") ?? "").trim().toLowerCase();
  if (!REPOSITORY_KEY.test(key)) return { error: "저장소(owner/repo)를 확인해주세요." };
  const excluded = form.get("excluded") === "true";
  const reason = String(form.get("reason") ?? "").trim().slice(0, 200) || null;
  await setTalkExcluded(key, excluded, admin.login, reason);
  await recordAdminAction(admin.login, { action: excluded ? "talk-repository-exclude" : "talk-repository-include", target: key, detail: { reason } });
  logger.info("admin.talk_repository_decided", { login: admin.login, key, excluded });
  revalidateTalk();
  return { ok: excluded ? `${key} 를 화제에서 뺐습니다.` : `${key} 를 화제에 되돌렸습니다.` };
});

/** 홈 첫 화면 1위 자리 — 허용, /talk 에만 두기, 정하지 않음 */
export const decideTalkHome = webWriteAction(async function decideTalkHome(_previous: TalkActionState, form: FormData): Promise<TalkActionState> {
  const admin = await currentAdmin();
  if (!admin) return DENIED;
  const key = String(form.get("repository") ?? "").trim().toLowerCase();
  if (!REPOSITORY_KEY.test(key)) return { error: "저장소(owner/repo)를 확인해주세요." };
  const raw = form.get("decision");
  const decision = raw === "approved" || raw === "talk_only" ? raw : raw === "clear" ? null : undefined;
  if (decision === undefined) return { error: "허용·/talk 에만·정하지 않음 중에서 골라주세요." };
  await setTalkHomeDecision(key, decision, admin.login);
  await recordAdminAction(admin.login, { action: `talk-home-${decision ?? "clear"}`, target: key });
  logger.info("admin.talk_home_decided", { login: admin.login, key, decision });
  revalidateTalk();
  return { ok: decision === "approved" ? `${key} 를 홈 1위에 올릴 수 있게 했습니다.` : decision === "talk_only" ? `${key} 는 /talk 에만 둡니다.` : `${key} 의 홈 결정을 거두고 정하지 않음으로 되돌렸습니다.` };
});
