import Link from "next/link";
import { publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { getTranslator } from "@/lib/i18n/dictionary";
import { localePath } from "@/lib/i18n/routing";
import { getRequestLocale } from "@/lib/i18n/server";
import { ME_TAB_PATHS, type MeTab } from "@/lib/me/contract";
import { MeIcon } from "./MeIcon";

/** 로그인해야 쓰는 탭의 로그아웃 화면 — 첫 행동 하나(로그인)만 크게 둔다. 돌아올 곳은 이 탭 */
export async function MeLoginRequired({ tab }: { tab: MeTab }) {
  const locale = await getRequestLocale();
  const t = await getTranslator(locale, "me");
  const returnTo = localePath(locale, ME_TAB_PATHS[tab]);
  return (
    <section className="me-login-required" aria-labelledby="me-login-required-title">
      <span className="me-empty-ic"><MeIcon name="lock" size={26} /></span>
      <h2 id="me-login-required-title">{t(`tabs.${tab}`)}</h2>
      <p>{t("loginRequired.body")}</p>
      {publicUserAuthEnabled() && <Link prefetch={false} className="me-btn me-btn-pri me-btn-lg" href={localePath(locale, `/login?returnTo=${encodeURIComponent(returnTo)}`)}>{t("loginRequired.cta")}</Link>}
    </section>
  );
}
