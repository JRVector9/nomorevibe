import type { ReactNode } from "react";
import { getDictionary } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/locales";
import { createTranslator } from "@/lib/i18n/messages";
import { publicUserAuthEnabled } from "@/lib/domain/github-integration/flags";
import { talkPublicEnabled } from "@/lib/social/flags";
import { SiteHeader } from "./SiteHeader";
import { SiteFooter } from "./SiteFooter";
import { MobileNav } from "./MobileNav";
import { SavedToast } from "./SavedToast";

/** Shared by regular routes and the locale root's 404 boundary. */
export async function PublicShell({ locale, children, seasonfooter }: {
  locale: Locale; children: ReactNode; seasonfooter?: ReactNode;
}) {
  const messages = await getDictionary(locale, "common");
  const t = createTranslator("common", messages);
  return (
    <>
      <a className="skip" href="#main">{t("accessibility.skipToContent")}</a>
      {/* Only the query-reading header pieces suspend, keeping the initial header visible. */}
      <SiteHeader authEnabled={publicUserAuthEnabled()} talkEnabled={talkPublicEnabled()} />
      <div className="flex-1" id="main" tabIndex={-1}>{children}</div>
      <SiteFooter locale={locale} messages={messages}>{seasonfooter}</SiteFooter>
      <MobileNav authEnabled={publicUserAuthEnabled()} talkEnabled={talkPublicEnabled()} />
      <SavedToast />
    </>
  );
}
