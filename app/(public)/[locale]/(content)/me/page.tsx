import { SavedAccountList, SavedBrowserList } from "@/components/me/SavedTab";
import { publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { getRequestLocale } from "@/lib/i18n/server";
import { meMetadata } from "@/lib/me/metadata";
import { listSaved, type SavedPage } from "@/lib/me/saved";
import { getMeSession } from "@/lib/me/session";
import { logger } from "@/lib/observability/logger";

export const dynamic = "force-dynamic";
export const generateMetadata = () => meMetadata("saved");

/** /me 기본 탭 = 저장(Q1). 로그인했으면 계정 목록 첫 쪽을 서버에서 그리고, 아니면 이 브라우저 목록 */
export default async function MeSavedPage() {
  const session = await getMeSession();
  if (!session) return <SavedBrowserList authEnabled={publicUserAuthEnabled()} />;
  let initial: SavedPage | null = null;
  try {
    initial = await listSaved(session.user.id, { sort: "recent", filter: "all", category: null, cursor: null }, await getRequestLocale());
  } catch (error) {
    // 못 읽으면 브라우저가 다시 받는다
    logger.warn("me.saved_initial_failed", { error });
  }
  return <SavedAccountList initial={initial} />;
}
