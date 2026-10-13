import "server-only";
import { after } from "next/server";
import { onReplica } from "@/lib/db";
import type { Locale } from "./locales";
import { readProductTranslations, requestProductTranslations, selectProductTranslation,
  type ProductTranslation, type ProductTranslationField, type ProductTranslationSource } from "@/lib/domain/products/translations";
import type { ProductTranslationSelection } from "@/lib/domain/products/translation-policy";
import { logger } from "@/lib/observability/logger";

type PublicTranslationProduct = {
  id?: number; name: string; translationName?: string; tagline: string; description?: string;
};
export type TranslatedProduct<T> = T & {
  translation?: ProductTranslationSelection;
  descriptionTranslation?: ProductTranslationSelection;
};

export function productTranslationSource(product: PublicTranslationProduct): ProductTranslationSource {
  return { id: product.id ?? 0, name: product.translationName ?? product.name,
    tagline: product.tagline, description: product.description };
}

/** Batches stay bounded while long browse windows retain their complete product set. */
export async function readTranslationsForProducts(products: readonly PublicTranslationProduct[], locale: Locale): Promise<ProductTranslation[]> {
  if (locale === "ko") return [];
  const sources = products.filter((product) => Number.isSafeInteger(product.id) && product.id! > 0).map(productTranslationSource);
  const batches: ProductTranslation[][] = [];
  for (let start = 0; start < sources.length; start += 80) {
    batches.push(await onReplica(() => readProductTranslations(sources.slice(start, start + 80), locale)));
  }
  return batches.flat();
}

/** Translation demand runs after the response on primary; rendering calls no model. */
export async function localizeProductList<T extends PublicTranslationProduct>(
  products: readonly T[], locale: Locale, fields: readonly ProductTranslationField[] = ["tagline"],
): Promise<TranslatedProduct<T>[]> {
  if (locale === "ko" || !products.length) return [...products];
  let rows: ProductTranslation[] = [];
  try { rows = await readTranslationsForProducts(products, locale); }
  catch (error) { logger.warn("i18n.product_translations_unavailable", { locale, error }); }
  const byField = new Map(rows.map((row) => [`${row.productId}:${row.field}`, row]));
  const result = products.map((product) => {
    const source = productTranslationSource(product);
    const translation = selectProductTranslation(source, locale, "tagline", byField.get(`${source.id}:tagline`));
    const descriptionTranslation = fields.includes("description")
      ? selectProductTranslation(source, locale, "description", byField.get(`${source.id}:description`)) : undefined;
    return { ...product, translation, ...(descriptionTranslation ? { descriptionTranslation } : {}) };
  });
  const ids = result.filter((product) => product.translation.pending || product.descriptionTranslation?.pending)
    .map((product) => product.id).filter((id): id is number => Number.isSafeInteger(id) && id! > 0).slice(0, 80);
  if (ids.length) after(async () => {
    try { await requestProductTranslations(ids, locale, fields); }
    catch (error) { logger.warn("i18n.product_translation_demand_failed", { locale, error }); }
  });
  return result;
}
