/** One registry for URLs, document language, formatting, and language labels. */
export const LOCALES = ["ko", "en", "zh-Hans", "ja"] as const;
export type PublicLocale = (typeof LOCALES)[number];
/** Legacy values remain readable in saved preferences, source language and the dispatch ledger. */
export type Locale = PublicLocale | "zh-Hant";
export const PRODUCT_TRANSLATION_LOCALES: readonly Exclude<PublicLocale, "ko">[] = ["en", "zh-Hans", "ja"];
export function isActiveTranslationLocale(value: unknown): value is Exclude<PublicLocale, "ko"> {
  return PRODUCT_TRANSLATION_LOCALES.some(locale => locale === value);
}
export const DEFAULT_LOCALE: Locale = "ko";
/** Proxy overwrites this request header; callers cannot choose its value. */
export const PUBLIC_LOCALE_HEADER = "x-nmv-public-locale";

export const LOCALE_CONFIG = {
  ko: { label: "한국어", intl: "ko-KR", htmlLang: "ko", openGraph: "ko_KR" },
  ja: { label: "日本語", intl: "ja-JP", htmlLang: "ja", openGraph: "ja_JP" },
  en: { label: "English", intl: "en-US", htmlLang: "en", openGraph: "en_US" },
  "zh-Hans": { label: "中文（简体）", intl: "zh-Hans", htmlLang: "zh-Hans", openGraph: "zh_CN" },
  "zh-Hant": { label: "中文（繁體）", intl: "zh-Hant", htmlLang: "zh-Hant", openGraph: "zh_TW" },
} as const satisfies Record<Locale, { label: string; intl: string; htmlLang: string; openGraph: string }>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (value === "zh-Hant" || LOCALES.some((locale) => locale === value));
}
