import type { Metadata, Viewport } from "next";
import { LOCALE_CONFIG } from "@/lib/i18n/locales";
import { getRequestLocale } from "@/lib/i18n/server";
import { siteOrigin, THEME_COLOR_DARK, THEME_COLOR_LIGHT } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = { metadataBase: new URL(siteOrigin()) };

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR_LIGHT },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR_DARK },
  ],
};

/** One shared document root supports regular routes and localized unmatched URLs. */
export default async function DocumentLayout({ children }: { children: React.ReactNode }) {
  const locale = await getRequestLocale();
  return (
    <html lang={LOCALE_CONFIG[locale].htmlLang} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col font-sans">{children}</body>
    </html>
  );
}
