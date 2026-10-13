"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Locale } from "./locales";
import { createTranslator, type ClientDictionaries, type Namespace, type Translator } from "./messages";

const I18nContext = createContext<{ locale: Locale; dictionaries: ClientDictionaries } | null>(null);

/** Only server-selected namespace slices cross the server/client boundary. */
export function I18nProvider({ locale, dictionaries, children }: {
  locale: Locale; dictionaries: ClientDictionaries; children: ReactNode;
}) {
  const parent = useContext(I18nContext);
  const inherited = parent?.locale === locale ? parent.dictionaries : undefined;
  return <I18nContext.Provider value={{ locale, dictionaries: { ...inherited, ...dictionaries } }}>{children}</I18nContext.Provider>;
}

function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("Missing I18nProvider");
  return value;
}

export function useLocale(): Locale {
  return useI18n().locale;
}

export function useTranslations<N extends Namespace>(namespace: N): Translator<N> {
  const catalog = useI18n().dictionaries[namespace];
  if (!catalog) throw new Error(`Missing client namespace: ${namespace}`);
  return createTranslator(namespace, catalog);
}
