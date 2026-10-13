/** One registry for URLs, document language, formatting, and language labels. */
export const LOCALES = ["ko", "en", "zh-Hans", "zh-Hant"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "ko";

export const LOCALE_CONFIG = {
  ko: { label: "한국어", intl: "ko-KR", htmlLang: "ko", openGraph: "ko_KR" },
  en: { label: "English", intl: "en-US", htmlLang: "en", openGraph: "en_US" },
  "zh-Hans": { label: "中文（简体）", intl: "zh-Hans", htmlLang: "zh-Hans", openGraph: "zh_CN" },
  "zh-Hant": { label: "中文（繁體）", intl: "zh-Hant", htmlLang: "zh-Hant", openGraph: "zh_TW" },
} as const satisfies Record<Locale, { label: string; intl: string; htmlLang: string; openGraph: string }>;

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && LOCALES.some((locale) => locale === value);
}
