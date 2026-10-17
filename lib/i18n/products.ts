import "server-only";
import { cache } from "react";
import { after } from "next/server";
import { onReplica } from "@/lib/db";
import type { Locale } from "./locales";
import { readProductTranslations, requestProductTranslations, selectProductTranslation,
  type ProductTranslation, type ProductTranslationField, type ProductTranslationSource } from "@/lib/domain/products/translations";
import type { ProductTranslationSelection } from "@/lib/domain/products/translation-policy";
import { PRODUCT_TRANSLATION_DEMAND_LIMIT } from "@/lib/domain/products/translation-policy";
import { logger } from "@/lib/observability/logger";
import { webWritable } from "@/lib/operations/dr/web-gate";

type PublicTranslationProduct = {
  id?: number; name: string; translationName?: string; tagline: string; description?: string;
};
export type TranslatedProduct<T> = T & {
  translation?: ProductTranslationSelection;
  descriptionTranslation?: ProductTranslationSelection;
};

// React cache scopes this budget to one render request, across every visible list.
const responseDemand = cache(() => ({
  fields: new Map<number, Set<ProductTranslationField>>(), scheduled: false,
}));

function requestVisibleTranslations(ids: readonly number[], locale: Locale, fields: readonly ProductTranslationField[]) {
  const demand = responseDemand();
  for (const id of ids) {
    if (!demand.fields.has(id) && demand.fields.size >= PRODUCT_TRANSLATION_DEMAND_LIMIT) continue;
    const requested = demand.fields.get(id) ?? new Set<ProductTranslationField>();
    fields.forEach((field) => requested.add(field));
    demand.fields.set(id, requested);
  }
  if (demand.scheduled || !demand.fields.size) return;
  demand.scheduled = true;
  after(async () => {
    // fenced DB 에는 번역 수요를 쓰지 않는다(캐시 관문만 — 목록마다 fence 행을 잠그지 않는다)
    if (!await webWritable()) return;
    // Keep description demand exclusive to products whose descriptions are visible.
    const groups = new Map<string, { ids: number[]; fields: ProductTranslationField[] }>();
    for (const [id, requested] of demand.fields) {
      const fields = [...requested].sort(), key = fields.join(",");
      const group = groups.get(key) ?? { ids: [], fields };
      group.ids.push(id);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      try { await requestProductTranslations(group.ids, locale, group.fields); }
      catch (error) { logger.warn("i18n.product_translation_demand_failed", { locale, error }); }
    }
  });
}

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
  if (ids.length) requestVisibleTranslations(ids, locale, fields);
  return result;
}
