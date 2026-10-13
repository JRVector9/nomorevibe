import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { EmailLoginForm } from "@/components/auth/EmailLoginForm";
import { GithubConnection } from "@/components/auth/GithubConnection";
import { emailLoginConfigured } from "@/lib/domain/accounts/email-delivery";
import { githubStarEnabled, publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { getPublicSession } from "@/lib/domain/accounts/request-auth";
import { getRequestLocale } from "@/lib/i18n/server";
import { getDictionary, getTranslator } from "@/lib/i18n/dictionary";
import { I18nProvider } from "@/lib/i18n/context";
import { localePath, safePublicReturnUrl, stripLocale } from "@/lib/i18n/routing";
import { localizedAlternates, localizedOpenGraph } from "@/lib/i18n/metadata";
import { DEFAULT_SHARE_IMAGE, shareMetadata } from "@/lib/copy/share";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getRequestLocale();
  const t = await getTranslator(locale, "auth");
  const title = t("login.metadataTitle");
  const share = shareMetadata({ title, description: t("login.description"), image: { ...DEFAULT_SHARE_IMAGE, alt: title } });
  return { ...share, title, robots: { index: false, follow: false },
    alternates: localizedAlternates(locale, "/login"), openGraph: { ...share.openGraph, ...localizedOpenGraph(locale) } };
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string | string[]; connectGithub?: string | string[] }> }) {
  if (!publicUserAuthEnabled()) notFound();
  const locale = await getRequestLocale();
  const [t, auth] = await Promise.all([getTranslator(locale, "auth"), getDictionary(locale, "auth")]);
  const params = await searchParams;
  const home = localePath(locale, "/");
  const returnTo = safePublicReturnUrl(params.returnTo, home);
  const session = await getPublicSession();
  const starEnabled = githubStarEnabled();
  const emailEnabled = emailLoginConfigured();
  if (session && !(starEnabled && params.connectGithub === "1")) {
    const destination = stripLocale(returnTo).split(/[?#]/, 1)[0].replace(/\/$/, "");
    redirect(destination === "/login" ? home : returnTo);
  }
  return (
    <I18nProvider locale={locale} dictionaries={{ auth }}>
    <main className="mx-auto flex min-h-[65vh] max-w-[460px] flex-col justify-center px-6 py-12">
      <section className="rounded-xl border border-line bg-bg-card p-7">
        <h1 className="text-[23px] font-bold tracking-tight">{session ? t("login.connectTitle") : t("login.title")}</h1>
        {!session && <p className="mt-3 text-[15px] leading-7 text-fg-2">{t("login.description")}</p>}
        {starEnabled && <GithubConnection returnTo={returnTo} signedIn={!!session} />}
        {!session && emailEnabled && <section className={starEnabled ? "mt-7 border-t border-line pt-6" : "mt-6"} aria-label={t("login.emailSection")}>
          <h2 className="text-[17px] font-semibold">{t("login.emailHeading")}</h2>
          <p className="mt-2 text-[14px] leading-6 text-fg-2">{t("login.emailDescription")}</p>
          <EmailLoginForm returnTo={returnTo} />
        </section>}
        {!starEnabled && !emailEnabled && <p className="mt-6 text-[14px] leading-6 text-fg-2" role="status">{t("login.unavailable")}</p>}
      </section>
    </main>
    </I18nProvider>
  );
}
