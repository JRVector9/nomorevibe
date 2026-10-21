import { AlertSettings } from "@/components/me/AlertSettings";
import { AlertsView } from "@/components/me/AlertsView";
import { MeLoginRequired } from "@/components/me/MeLoginRequired";
import { getRequestLocale } from "@/lib/i18n/server";
import { loadInbox } from "@/lib/me/inbox";
import { meMetadata } from "@/lib/me/metadata";
import { getMeSession } from "@/lib/me/session";

export const dynamic = "force-dynamic";
export const generateMetadata = () => meMetadata("alerts");

/** 알림 탭 — 첫 쪽은 서버가 그 언어의 한 줄로 지어 그리고, 더 보기·읽음은 화면에서. 설정 칸은 MY7(AlertSettings) */
export default async function MeAlertsPage() {
  const session = await getMeSession();
  if (!session) return <MeLoginRequired tab="alerts" />;
  const inbox = await loadInbox(session.user.id, await getRequestLocale());
  return <AlertsView initial={inbox} settings={<AlertSettings csrfToken={session.csrfToken} />} />;
}
