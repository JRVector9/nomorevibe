import { redirect } from "next/navigation";
import { MeNow } from "@/components/me/MeNow";
import { SavedAccountList, SavedBrowserList } from "@/components/me/SavedTab";
import { publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { localePath } from "@/lib/i18n/routing";
import { getRequestLocale } from "@/lib/i18n/server";
import { ME_TAB_PATHS } from "@/lib/me/contract";
import { makerPendingReplies } from "@/lib/me/maker";
import { meMetadata } from "@/lib/me/metadata";
import { listSaved, type SavedPage } from "@/lib/me/saved";
import { getMeSession } from "@/lib/me/session";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";
export const generateMetadata = () => meMetadata("saved");

/**
 * /me 기본 탭 = 저장(Q1). 로그인했으면 계정 목록 첫 쪽을 서버에서 그리고, 아니면 이 브라우저 목록.
 * 답장 기다림이 있는 메이커는 내 프로젝트로 연다(Q3) — 탭·메뉴의 «저장»은 ?tab=saved 라 그대로 저장을 연다.
 * 답장 기다림 확인(메이커가 아니면 색인 한 번)과 저장 첫 쪽은 함께 읽는다
 */
export default async function MeSavedPage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const session = await getMeSession();
  if (!session) return <MeNow><SavedBrowserList authEnabled={publicUserAuthEnabled()} /></MeNow>;
  const [locale, { tab }] = await Promise.all([getRequestLocale(), searchParams]);
  const [pending, initial] = await Promise.all([
    tab === "saved" ? 0 : makerPendingReplies(session.user.id).catch(() => 0),
    listSaved(session.user.id, { sort: "recent", filter: "all", category: null, cursor: null }, locale).catch((error): SavedPage | null => {
      // 못 읽으면 브라우저가 다시 받는다
      logger.warn("me.saved_initial_failed", { error });
      return null;
    }),
  ]);
  if (pending > 0) redirect(localePath(locale, ME_TAB_PATHS.projects));
  return <MeNow><SavedAccountList initial={initial} /></MeNow>;
}
