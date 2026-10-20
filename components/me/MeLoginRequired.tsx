import Link from "next/link";
import { getTranslator } from "@/lib/i18n/dictionary";
import { localePath } from "@/lib/i18n/routing";
import { getRequestLocale } from "@/lib/i18n/server";
import { ME_TAB_PATHS, type MeTab } from "@/lib/me/contract";

/** 로그인해야 쓰는 탭의 로그아웃 화면 — 첫 행동 하나(로그인)만 크게 둔다 */
export async function MeLoginRequired({ tab }: { tab: MeTab }) {
  const locale = await getRequestLocale();
  const t = await getTranslator(locale, "me");
  const returnTo = localePath(locale, ME_TAB_PATHS[tab]);
  return (
    <section className="me-login-required">
      <p>{t("loginRequired.body")}</p>
      <Link prefetch={false} className="me-login-required-cta" href={localePath(locale, `/login?returnTo=${encodeURIComponent(returnTo)}`)}>{t("loginRequired.cta")}</Link>
    </section>
  );
}
