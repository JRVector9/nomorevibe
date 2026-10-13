import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { productIntroChecks, products, productTranslations, takedownRequests,
  type ProductTranslation, type ProductTranslationField, type ProductTranslationLocale } from "@/lib/db/schema";
import { isLocale, type Locale } from "@/lib/i18n/locales";
import { assertJobLease, requestJob, type JobLease } from "@/lib/jobs/control";
import { detectTranslationSourceLocale, isProductTranslationField, productTranslationSourceHash, translationSourceText,
  PRODUCT_TRANSLATION_DEMAND_LIMIT, PRODUCT_TRANSLATION_MAX_ATTEMPTS, PRODUCT_TRANSLATION_POLICY,
  type ProductTranslationReadiness, type ProductTranslationSource } from "./translation-policy";

export { selectProductTranslation, productTranslationSourceHash, detectTranslationSourceLocale } from "./translation-policy";
export type { ProductTranslationSource, ProductTranslationSelection } from "./translation-policy";
export type { ProductTranslation, ProductTranslationField } from "@/lib/db/schema";
export const PRODUCT_TRANSLATION_JOB = "product-translate";
const t = productTranslations;
const sourceColumns = { id: products.id, name: products.name, tagline: products.tagline, description: products.description };
// The intro-review queue is neither requested nor resumed. Current editor holds and takedowns block translation.
export const productTranslationEligible = sql`${products.status} in ('seeded', 'verified')
  and not exists (select 1 from ${takedownRequests} r where r.slug = ${products.slug} and r.handled_at is null)
  and not exists (select 1 from ${productIntroChecks} i where i.product_id = ${products.id}
    and i.checked_tagline = ${products.tagline} and i.outcome = 'needs_editor')`;
const eligible = productTranslationEligible;

/** Detail/query extras can expose the same current-source hold guard to metadata. */
export const productTranslationEligibilityField = {
  translationEligible: sql<boolean>`(${eligible})`.as("translation_eligible"),
};

function demandIds(ids: readonly number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, PRODUCT_TRANSLATION_DEMAND_LIMIT).sort((a, b) => a - b);
}
function requireLocale(locale: Locale): void {
  if (!isLocale(locale)) throw new Error("invalid_translation_locale");
}

/** Batch read only. Safe inside a replica/cache loader; never requests work or calls a model. */
export async function readProductTranslations(sources: readonly ProductTranslationSource[], locale: Locale): Promise<ProductTranslation[]> {
  requireLocale(locale);
  if (locale === "ko") return [];
  const ids = demandIds(sources.map((source) => source.id));
  if (!ids.length) return [];
  const visible = new Map(sources.slice(0, PRODUCT_TRANSLATION_DEMAND_LIMIT).map((source) => [source.id, source]));
  const rows = await db.select({ translation: t, source: sourceColumns }).from(t)
    .innerJoin(products, eq(products.id, t.productId))
    .where(and(inArray(t.productId, ids), eq(t.locale, locale), inArray(t.status, ["ready", "reviewed"]), eligible));
  return rows.flatMap(({ translation, source }) => {
    const requested = visible.get(source.id);
    return requested && translation.sourceHash === productTranslationSourceHash(requested, translation.field)
      && translation.sourceHash === productTranslationSourceHash(source, translation.field) ? [translation] : [];
  });
}

/** SEO reads all ready locales together so every HTML language emits the same reciprocal set. */
export async function readProductTranslationReadiness(sources: readonly ProductTranslationSource[]): Promise<ProductTranslationReadiness[]> {
  const ids = demandIds(sources.map((source) => source.id));
  if (!ids.length) return [];
  const visible = new Map(sources.slice(0, PRODUCT_TRANSLATION_DEMAND_LIMIT).map((source) => [source.id, source]));
  const rows = await db.select({ translation: {
    productId: t.productId, locale: t.locale, field: t.field, sourceHash: t.sourceHash, status: t.status, errorCode: t.errorCode,
    text: sql<string | null>`case when length(btrim(${t.text})) > 0 then 'present' end`,
  }, source: sourceColumns }).from(t).innerJoin(products, eq(products.id, t.productId))
    .where(and(inArray(t.productId, ids), inArray(t.status, ["ready", "reviewed"]), eligible));
  return rows.flatMap(({ translation, source }) => {
    const requested = visible.get(source.id);
    return requested && translation.sourceHash === productTranslationSourceHash(requested, translation.field)
      && translation.sourceHash === productTranslationSourceHash(source, translation.field) ? [translation] : [];
  });
}

/** Post-render demand only. Primary scope is explicit, even if a caller accidentally retains replica scope. */
export async function requestProductTranslations(
  productIds: readonly number[], locale: Locale, fields: readonly ProductTranslationField[] = ["tagline"],
): Promise<number> {
  requireLocale(locale);
  if (fields.some((field) => !isProductTranslationField(field))) throw new Error("invalid_translation_field");
  if (locale === "ko") return 0;
  const ids = demandIds(productIds), requestedFields = [...new Set(fields)].sort();
  if (!ids.length || !requestedFields.length) return 0;
  return onPrimary(() => db.transaction(async (tx) => {
    const sources = await tx.select({ ...sourceColumns, sourceOrigin: products.taglineSource })
      .from(products).where(and(inArray(products.id, ids), eligible)).orderBy(products.id).for("share");
    const values: (typeof t.$inferInsert)[] = [];
    for (const source of sources) for (const field of requestedFields) {
      const text = translationSourceText(source, field);
      if (!text.trim() || detectTranslationSourceLocale(text) === locale) continue;
      values.push({
        productId: source.id, locale, field, sourceHash: productTranslationSourceHash(source, field),
        sourceLocale: detectTranslationSourceLocale(text), text: null, status: "pending" as const,
        provenance: { kind: "machine" as const, source: source.sourceOrigin, policy: PRODUCT_TRANSLATION_POLICY },
        model: "", attempts: 0, errorCode: null, retryAt: null,
      });
    }
    if (!values.length) return 0;
    const inserted = await tx.insert(t).values(values).onConflictDoUpdate({ target: [t.productId, t.locale, t.field],
      set: { sourceHash: sql`excluded.source_hash`, sourceLocale: sql`excluded.source_locale`, text: null, status: "pending",
        provenance: sql`excluded.provenance`, model: "", attempts: 0, errorCode: null, retryAt: null, updatedAt: sql`now()` },
      setWhere: sql`${t.sourceHash} <> excluded.source_hash or ${t.errorCode} in ('ineligible', 'stale_source')`,
    }).returning({ productId: t.productId });
    const requested = inserted.length;
    if (requested) await requestJob(PRODUCT_TRANSLATION_JOB, tx);
    return requested;
  }));
}

export type ProductTranslationTask = {
  source: ProductTranslationSource; locale: ProductTranslationLocale; field: ProductTranslationField;
  sourceHash: string; attempts: number; eligible: boolean;
};

/** Only demanded rows. Never scans the product catalog to generate a blanket backfill. */
export async function pendingProductTranslations(limit = 4): Promise<ProductTranslationTask[]> {
  const rows = await db.select({ source: sourceColumns, locale: t.locale, field: t.field,
    sourceHash: t.sourceHash, attempts: t.attempts, eligible: sql<boolean>`(${eligible})` }).from(t)
    .innerJoin(products, eq(products.id, t.productId))
    .where(and(inArray(t.status, ["pending", "failed"]), sql`${t.attempts} < ${PRODUCT_TRANSLATION_MAX_ATTEMPTS}`,
      sql`${t.retryAt} is null or ${t.retryAt} <= now()`))
    .orderBy(asc(t.updatedAt), asc(t.productId), asc(t.locale), asc(t.field)).limit(Math.max(1, Math.min(8, limit)));
  return rows;
}

export type ProductTranslationResult = { ok: true; text: string; model: string } | { ok: false; error: string; model: string };

/** Product lock + source/version CAS + final job lease check prevent stale saves and lost-owner commits. */
export async function recordProductTranslations(
  entries: readonly { task: ProductTranslationTask; result: ProductTranslationResult }[], lease: JobLease,
): Promise<number> {
  if (lease.name !== PRODUCT_TRANSLATION_JOB) throw new Error("translation_job_lease_required");
  return onPrimary(() => db.transaction(async (tx) => {
    let stored = 0;
    for (const { task, result } of [...entries].sort((a, b) => a.task.source.id - b.task.source.id)) {
      const [source] = await tx.select({ ...sourceColumns, eligible: sql<boolean>`(${eligible})` })
        .from(products).where(eq(products.id, task.source.id)).for("share");
      if (!source) continue;
      const current = source.eligible && productTranslationSourceHash(source, task.field) === task.sourceHash;
      const error = current ? (result.ok ? null : result.error.slice(0, 60)) : source.eligible ? "stale_source" : "ineligible";
      const updated = await tx.update(t).set({
        text: current && result.ok ? result.text : null,
        status: current && result.ok ? "ready" : "failed", model: result.model.slice(0, 160), errorCode: error,
        attempts: current && (result.ok || result.error !== "source_too_long") ? task.attempts + 1 : PRODUCT_TRANSLATION_MAX_ATTEMPTS,
        retryAt: current && !result.ok && result.error !== "source_too_long" && task.attempts + 1 < PRODUCT_TRANSLATION_MAX_ATTEMPTS
          ? sql`now() + least(interval '24 hours', interval '5 minutes' * power(2, ${task.attempts}))` : null,
        updatedAt: sql`now()`,
      }).where(and(eq(t.productId, task.source.id), eq(t.locale, task.locale), eq(t.field, task.field),
        eq(t.sourceHash, task.sourceHash), eq(t.attempts, task.attempts), inArray(t.status, ["pending", "failed"])))
        .returning({ id: t.productId });
      stored += updated.length;
    }
    await assertJobLease(tx, lease);
    return stored;
  }));
}
