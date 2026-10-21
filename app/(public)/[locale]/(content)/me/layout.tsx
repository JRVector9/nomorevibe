import "@/components/me/me.css";
import { MeHead } from "@/components/me/MeHead";
import { MeLoggedOut } from "@/components/me/MeLoggedOut";
import { MeTabs } from "@/components/me/MeTabs";
import { publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { I18nProvider } from "@/lib/i18n/context";
import { getDictionary } from "@/lib/i18n/dictionary";
import { createTranslator } from "@/lib/i18n/messages";
import { getRequestLocale } from "@/lib/i18n/server";
import { showsProjectsTab } from "@/lib/me/contract";
import { getMeSession } from "@/lib/me/session";
import { getMeSummary, type MeSummary } from "@/lib/me/summary";

/**
 * 마이페이지 틀 — 머리(로그인: 아바타·숫자, 로그아웃: 로그인하면 되는 것) 아래 탭 줄과 각 탭 화면(children).
 * 탭마다 주소가 따로 있다(/me, /me/tried …). 로그아웃이어도 탭과 화면은 그대로 둔다 — 저장·써봤어요는 이 브라우저 목록을 보여 준다.
 */
export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const locale = await getRequestLocale();
  const me = await getDictionary(locale, "me");
  const t = createTranslator("me", me);
  const session = await getMeSession();
  let summary: MeSummary | null = null;
  try {
    summary = session ? await getMeSummary(session.user.id) : null;
  } catch {
    // 숫자를 못 읽어도 탭 화면은 연다
  }
  const counts = summary ? { saved: summary.counts.saved, tried: summary.counts.tried, opinions: summary.counts.opinions,
    following: summary.counts.following, alerts: summary.counts.unreadAlerts } : undefined;
  return (
    <I18nProvider locale={locale} dictionaries={{ me }}>
      <main className="me-page">
        <h1 className="sr-only">{t("page.title")}</h1>
        {summary ? <MeHead summary={summary} locale={locale} t={t} now={new Date()} />
          : !session && <MeLoggedOut locale={locale} t={t} loginEnabled={publicUserAuthEnabled()} />}
        <MeTabs showProjects={showsProjectsTab(summary)} counts={counts} />
        {children}
      </main>
    </I18nProvider>
  );
}
