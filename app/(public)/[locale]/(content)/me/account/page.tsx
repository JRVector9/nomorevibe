import "@/components/me/account.css";
import Link from "next/link";
import { cookies } from "next/headers";
import { DeleteAccount, ExportData, LogoutButton, ProfileForm } from "@/components/me/AccountForms";
import { MeLoginRequired } from "@/components/me/MeLoginRequired";
import { SessionList } from "@/components/me/SessionList";
import { hashSessionToken, isOpaqueToken, PUBLIC_SESSION_COOKIE } from "@/lib/domain/accounts/session";
import { githubStarEnabled } from "@/lib/domain/github-integration/flags";
import { getTranslator } from "@/lib/i18n/dictionary";
import { formatDate } from "@/lib/i18n/format";
import { localePath } from "@/lib/i18n/routing";
import { getRequestLocale } from "@/lib/i18n/server";
import { getAccountView } from "@/lib/me/account";
import { meMetadata } from "@/lib/me/metadata";
import { getMeSession } from "@/lib/me/session";

export const dynamic = "force-dynamic";
export const generateMetadata = () => meMetadata("account");

/** 계정 탭(시안 3.5 · 로그인 설계 L3) — 프로필, 로그인 수단, GitHub 스타 권한(따로), 로그인된 기기, 내 데이터, 개인정보 */
export default async function MeAccountPage() {
  const [locale, session] = await Promise.all([getRequestLocale(), getMeSession()]);
  if (!session) return <MeLoginRequired tab="account" />;
  const token = (await cookies()).get(PUBLIC_SESSION_COOKIE)?.value;
  const [t, view] = await Promise.all([getTranslator(locale, "me"), getAccountView(session.user.id, isOpaqueToken(token) ? hashSessionToken(token) : null)]);
  if (!view) return <MeLoginRequired tab="account" />;
  const now = new Date();
  const date = (value: string) => formatDate(value, now, locale);
  const star: "active" | "needs_reconnect" | "revoked" | "none" = view.github?.state ?? "none";
  return (
    <div className="me-account">
      <section className="me-box" id="profile" aria-labelledby="me-account-profile">
        <h2 className="me-box-h" id="me-account-profile">{t("account.profile")}</h2>
        <ProfileForm csrfToken={session.csrfToken} displayName={view.displayName} nextNameChangeAt={view.nextNameChangeAt} />
        <p className="me-hint">{t("account.joined", { date: date(view.createdAt) })}</p>
      </section>

      <section className="me-box" aria-labelledby="me-account-methods">
        <h2 className="me-box-h" id="me-account-methods">{t("account.methods")}</h2>
        <ul className="me-kvs">
          {view.identities.map((identity, index) => (
            <li className="me-kv" key={`${identity.provider}-${index}`}>
              <div className="me-kv-l">
                <span className={`me-logo me-logo-${identity.provider}`} aria-hidden="true">{identity.provider === "github" ? "gh" : "@"}</span>
                <div className="me-kv-x">
                  <span className="me-kv-t">{t(`account.method.${identity.provider}`)}{identity.label && ` · ${identity.provider === "github" ? `@${identity.label}` : identity.label}`}</span>
                  <span className="me-kv-s">
                    {t("account.method.since", { date: date(identity.createdAt) })}
                    {identity.lastUsedAt && ` · ${t("account.method.lastUsed", { date: date(identity.lastUsedAt) })}`}
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
        <p className="me-hint">{t("account.methodsHint")}</p>
      </section>

      {githubStarEnabled() && (
        <section className="me-box me-box-dash" aria-labelledby="me-account-star">
          <div className="me-box-row">
            <h2 className="me-box-h" id="me-account-star">{t("account.star")}</h2>
            <span className={`me-state me-state-${star === "active" ? "on" : star === "needs_reconnect" ? "warn" : "off"}`}>
              {star === "active" ? t("account.star.active", { login: view.github?.login ?? "" }) : t(`account.star.${star}`)}
            </span>
          </div>
          <p className="me-desc">{t("account.star.body")}</p>
          <div className="me-acts">
            <Link prefetch={false} className="me-btn" href={localePath(locale, `/login?connectGithub=1&returnTo=${encodeURIComponent(localePath(locale, "/me/account"))}`)}>
              {t(star === "active" ? "account.star.manage" : "account.star.connect")}
            </Link>
          </div>
        </section>
      )}

      <section className="me-box" aria-labelledby="me-account-sessions">
        <h2 className="me-box-h" id="me-account-sessions">{t("account.sessions")}</h2>
        <SessionList csrfToken={session.csrfToken} sessions={view.sessions} />
        <p className="me-hint">{t("account.session.hint")}</p>
      </section>

      <section className="me-box" aria-labelledby="me-account-data">
        <h2 className="me-box-h" id="me-account-data">{t("account.data")}</h2>
        <div className="me-kvs">
          <ExportData />
          <DeleteAccount csrfToken={session.csrfToken} displayName={view.displayName} />
        </div>
      </section>

      <section className="me-box" aria-labelledby="me-account-privacy">
        <h2 className="me-box-h" id="me-account-privacy">{t("account.privacy")}</h2>
        <p className="me-desc">{t("account.privacyStored")}</p>
        <p className="me-desc">{t("account.privacyNotStored")}</p>
        <p className="me-desc"><Link prefetch={false} className="me-link" href={localePath(locale, "/policy")}>{t("account.privacyPolicy")}</Link></p>
      </section>

      <LogoutButton csrfToken={session.csrfToken} />
    </div>
  );
}
