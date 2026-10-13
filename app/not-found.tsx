import type { Metadata } from "next";
import { PublicNotFound } from "@/components/home/PublicNotFound";
import { PublicShell } from "@/components/home/PublicShell";
import { I18nProvider } from "@/lib/i18n/context";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getRequestLocale } from "@/lib/i18n/server";
import { BRAND } from "@/lib/copy/brand";

export const metadata: Metadata = { title: BRAND, robots: { index: false, follow: false } };

/** App-level missing paths do not pass through the locale provider or public shell. */
export default async function NotFound() {
  const locale = await getRequestLocale();
  const common = await getDictionary(locale, "common");
  const shell = await PublicShell({ locale, children: await PublicNotFound({ locale }) });
  return <I18nProvider locale={locale} dictionaries={{ common }}>{shell}</I18nProvider>;
}
