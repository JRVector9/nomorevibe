"use client";

import { Suspense, useSyncExternalStore } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useLocale, useTranslations } from "@/lib/i18n/context";
import { LOCALES, LOCALE_CONFIG } from "@/lib/i18n/locales";
import { switchLocale } from "@/lib/i18n/routing";

function subscribeHash(listener: () => void) {
  window.addEventListener("hashchange", listener);
  return () => window.removeEventListener("hashchange", listener);
}

function LanguageLinks({ query = "" }: { query?: string }) {
  const locale = useLocale();
  const pathname = usePathname();
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash, () => "");
  const current = `${pathname}${query}${hash}`;
  return (
    <ul>
      {LOCALES.map((target) => (
        <li key={target}>
          {/* Full document navigation guarantees the root language changes with the URL. */}
          <a
            href={switchLocale(current, target)}
            lang={target}
            hrefLang={target}
            aria-current={locale === target ? "true" : undefined}
            onClick={(event) => {
              // Read the latest hash/query at click time, including replaceState changes.
              event.currentTarget.href = switchLocale(`${window.location.pathname}${window.location.search}${window.location.hash}`, target);
            }}
          >
            {LOCALE_CONFIG[target].label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function LanguageLinksWithQuery() {
  const query = useSearchParams().toString();
  return <LanguageLinks query={query ? `?${query}` : ""} />;
}

export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations("common");
  return (
    <details className="language-switcher">
      <summary><span className="sr-only">{t("language.label")}: </span>{LOCALE_CONFIG[locale].label}</summary>
      <Suspense fallback={<LanguageLinks />}><LanguageLinksWithQuery /></Suspense>
    </details>
  );
}
