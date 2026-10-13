import type { Metadata } from "next";
import { selectProductTranslation, type ProductTranslationReadiness, type ProductTranslationSource } from "@/lib/domain/products/translation-policy";
import { siteOrigin } from "@/lib/site";
import { DEFAULT_LOCALE, isLocale, LOCALES, LOCALE_CONFIG, type Locale } from "./locales";
import { isLocaleExcludedPath, localePath, stripLocale } from "./routing";

/** One reciprocal set, independent of the locale currently rendering the same product. */
export function productReadyLocales(
  source: ProductTranslationSource, translations: readonly ProductTranslationReadiness[], contentEligible = true,
): Locale[] {
  return LOCALES.filter((locale) => locale === DEFAULT_LOCALE || (contentEligible
    && (["tagline", "description"] as const).every((field) => selectProductTranslation(source, locale, field,
      translations.find((row) => row.productId === source.id && row.locale === locale && row.field === field)).ready)));
}

/** Self canonical is retained even when the requested locale is still noindex. */
export function localizedAlternates(
  locale: Locale, logicalPath: string, readyLocales: readonly Locale[] = LOCALES,
): NonNullable<Metadata["alternates"]> {
  if (!isLocale(locale)) throw new Error("Unsupported locale");
  const path = stripLocale(logicalPath).split(/[?#]/, 1)[0];
  if (isLocaleExcludedPath(path)) throw new Error("Machine endpoints cannot have localized metadata");
  const origin = siteOrigin();
  const ready = LOCALES.filter((candidate) => readyLocales.includes(candidate));
  const languages = Object.fromEntries(ready.map((candidate) => [candidate, `${origin}${localePath(candidate, path)}`]));
  if (ready.includes(DEFAULT_LOCALE)) languages["x-default"] = `${origin}${localePath(DEFAULT_LOCALE, path)}`;
  return { canonical: `${origin}${localePath(locale, path)}`, languages };
}

export function localizedOpenGraph(locale: Locale, readyLocales: readonly Locale[] = LOCALES) {
  if (!isLocale(locale)) throw new Error("Unsupported locale");
  return { locale: LOCALE_CONFIG[locale].openGraph,
    alternateLocale: LOCALES.filter((candidate) => candidate !== locale && readyLocales.includes(candidate))
      .map((candidate) => LOCALE_CONFIG[candidate].openGraph) };
}

/** Base visibility/indexability stays owned by the existing product indexing rules. */
export function productLocaleMetadata(
  locale: Locale, logicalPath: string, source: ProductTranslationSource,
  translations: readonly ProductTranslationReadiness[], baseIndexable: boolean, contentEligible = true,
): Pick<Metadata, "alternates" | "robots" | "openGraph"> {
  const ready = baseIndexable ? productReadyLocales(source, translations, contentEligible) : [];
  return { alternates: localizedAlternates(locale, logicalPath, ready),
    robots: { index: baseIndexable && ready.includes(locale), follow: baseIndexable },
    openGraph: localizedOpenGraph(locale, ready) };
}
