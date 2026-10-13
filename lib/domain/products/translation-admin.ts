import "server-only";
import { and, asc, count, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit, productIntroChecks, products, productTranslations, takedownRequests,
  type ProductTranslationField, type ProductTranslationLocale, type ProductTranslationStatus } from "@/lib/db/schema";
import { adminAuditRow } from "@/lib/operations/admin-log";
import { detectTranslationSourceLocale, isProductTranslationField, productTranslationSourceHash, translationSourceText,
  PRODUCT_TRANSLATION_MAX_ATTEMPTS } from "./translation-policy";
import { PRODUCT_TRANSLATION_JOB, productTranslationEligible, requestProductTranslations } from "./translations";
import { requestJob } from "@/lib/jobs/control";

const t = productTranslations;
const LOCALES = ["en", "zh-Hans", "zh-Hant"] as const;
const STATES = ["pending", "ready", "failed", "reviewed", "all"] as const;
const iso = (value: AnyColumn | SQL) => sql<string | null>`to_char(${value}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const timestamp = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.getUTCFullYear() > 0 && date.toISOString().slice(0, 19) === value.slice(0, 19);
};
const hash = (value: string) => /^[a-f0-9]{64}$/.test(value);
const selection = {
  productId: t.productId, slug: products.slug, name: products.name, locale: t.locale, field: t.field, status: t.status,
  sourceHash: t.sourceHash, sourceLocale: t.sourceLocale, text: t.text, attempts: t.attempts, errorCode: t.errorCode,
  model: t.model, updatedAt: iso(t.updatedAt), retryAt: iso(t.retryAt),
  source: { id: products.id, name: products.name, tagline: products.tagline, description: products.description },
  eligible: sql<boolean>`(${productTranslationEligible})`,
  productStatus: products.status,
  takedownPending: sql<boolean>`exists (select 1 from ${takedownRequests} r where r.slug = ${products.slug} and r.handled_at is null)`,
  introHold: sql<boolean>`exists (select 1 from ${productIntroChecks} i where i.product_id = ${products.id}
    and i.checked_tagline = ${products.tagline} and i.outcome = 'needs_editor')`,
};

export type ProductTranslationAdminFilter = {
  state?: ProductTranslationStatus | "all"; locale?: ProductTranslationLocale; field?: ProductTranslationField;
  q?: string; cursor?: string; limit?: number;
};
export type ProductTranslationAdminItem = {
  productId: number; slug: string; name: string; locale: ProductTranslationLocale; field: ProductTranslationField;
  status: ProductTranslationStatus; sourceHash: string; currentSourceHash: string; sourceText: string;
  sourceLocale: string | null; text: string | null; attempts: number; errorCode: string | null; model: string;
  updatedAt: string; retryAt: string | null; eligible: boolean; sourceMatches: boolean;
  holdReason: "product_not_public" | "takedown_pending" | "intro_editor_hold" | null;
  recovery: "retry" | "new_source" | null; recoveryReason: string;
};

function item(row: {
  productId: number; slug: string; name: string; locale: ProductTranslationLocale; field: ProductTranslationField;
  status: ProductTranslationStatus; sourceHash: string; sourceLocale: string | null; text: string | null;
  attempts: number; errorCode: string | null; model: string; updatedAt: string | null; retryAt: string | null;
  source: { id: number; name: string; tagline: string; description: string }; eligible: boolean;
  productStatus: string; takedownPending: boolean; introHold: boolean;
}, now: Date): ProductTranslationAdminItem {
  const { source, productStatus, takedownPending, introHold, ...value } = row;
  const currentSourceHash = productTranslationSourceHash(source, row.field), sourceText = translationSourceText(source, row.field);
  const sourceMatches = currentSourceHash === row.sourceHash;
  const holdReason = !["seeded", "verified"].includes(productStatus) ? "product_not_public" as const
    : takedownPending ? "takedown_pending" as const : introHold ? "intro_editor_hold" as const : null;
  const recoveryReason = !row.eligible ? holdReason ?? "ineligible" : row.status !== "failed" ? "not_failed"
    : !sourceText.trim() ? "empty_source" : detectTranslationSourceLocale(sourceText) === row.locale ? "source_native"
      : sourceText.length > 4_000 ? "source_too_long" : !sourceMatches ? "new_source"
        : row.attempts >= PRODUCT_TRANSLATION_MAX_ATTEMPTS ? "exhausted"
          : row.retryAt && new Date(row.retryAt) > now ? "retry_wait" : "retry";
  return { ...value, updatedAt: row.updatedAt!, currentSourceHash, sourceText, sourceMatches, holdReason,
    recovery: recoveryReason === "retry" || recoveryReason === "new_source" ? recoveryReason : null, recoveryReason };
}

function cursor(value?: string): [string, number, ProductTranslationLocale, ProductTranslationField] | null {
  if (!value || value.length > 250) return null;
  try {
    const result = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return Array.isArray(result) && result.length === 4 && timestamp(result[0]) && Number.isSafeInteger(result[1]) && result[1] > 0
      && LOCALES.includes(result[2]) && isProductTranslationField(result[3]) ? result as ReturnType<typeof cursor> : null;
  } catch { return null; }
}

/** Count and oldest-five inbox preview use the same ledger predicate as the administrator list. */
export function productTranslationAdminQueue(input: ProductTranslationAdminFilter = {}): Promise<{
  count: number; items: ProductTranslationAdminItem[]; nextCursor: string | null;
}> {
  const state = STATES.includes(input.state ?? "failed") ? input.state ?? "failed" : "failed";
  const q = input.q?.trim().slice(0, 120), pattern = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const predicate = and(state === "all" ? undefined : eq(t.status, state),
    input.locale && LOCALES.includes(input.locale) ? eq(t.locale, input.locale) : undefined,
    isProductTranslationField(input.field) ? eq(t.field, input.field) : undefined,
    pattern ? sql`(${products.slug} ilike ${pattern} or ${products.name} ilike ${pattern} or ${products.id}::text ilike ${pattern})` : undefined);
  const position = cursor(input.cursor);
  const after = position ? sql`(${t.updatedAt}, ${t.productId}, ${t.locale}, ${t.field}) >
    (${position[0]}::timestamp, ${position[1]}::int, ${position[2]}, ${position[3]})` : undefined;
  const limit = Number.isSafeInteger(input.limit) ? Math.max(1, Math.min(100, input.limit!)) : 50;
  return onPrimary(() => db.transaction(async (tx) => {
    const [summary] = await tx.select({ total: count() }).from(t).innerJoin(products, eq(products.id, t.productId)).where(predicate);
    const rows = await tx.select(selection).from(t).innerJoin(products, eq(products.id, t.productId)).where(and(predicate, after))
      .orderBy(asc(t.updatedAt), asc(t.productId), asc(t.locale), asc(t.field)).limit(limit + 1);
    const items = rows.slice(0, limit).map((row) => item(row, new Date()));
    const last = items.at(-1);
    return { count: summary.total, items, nextCursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify([last.updatedAt, last.productId, last.locale, last.field])).toString("base64url") : null };
  }, { isolationLevel: "repeatable read", accessMode: "read only" }));
}

/** Persisted states, not a claim that every ready row is eligible for current-source public rendering. */
export function productTranslationAdminSummary() {
  return onPrimary(() => db.select({ locale: t.locale, field: t.field,
    pending: sql<number>`count(*) filter (where ${t.status} = 'pending')::int`,
    ready: sql<number>`count(*) filter (where ${t.status} in ('ready', 'reviewed'))::int`,
    failed: sql<number>`count(*) filter (where ${t.status} = 'failed')::int`,
    exhausted: sql<number>`count(*) filter (where ${t.status} = 'failed' and ${t.attempts} >= ${PRODUCT_TRANSLATION_MAX_ATTEMPTS})::int`,
    retryWaiting: sql<number>`count(*) filter (where ${t.status} = 'failed' and ${t.attempts} < ${PRODUCT_TRANSLATION_MAX_ATTEMPTS} and ${t.retryAt} > now())::int`,
    held: sql<number>`count(*) filter (where not (${productTranslationEligible}))::int`,
    oldestFailedAt: iso(sql`min(${t.updatedAt}) filter (where ${t.status} = 'failed')`),
    lastSavedAt: iso(sql`max(${t.updatedAt}) filter (where ${t.status} in ('ready', 'reviewed'))`),
  }).from(t).innerJoin(products, eq(products.id, t.productId)).groupBy(t.locale, t.field).orderBy(t.locale, t.field));
}

export class ProductTranslationAdminError extends Error {
  constructor(public readonly code: "invalid" | "conflict" | "blocked") { super(code); }
}
export type ProductTranslationRetryInput = {
  productId: number; locale: ProductTranslationLocale; field: ProductTranslationField; expectedSourceHash: string;
  expectedCurrentSourceHash: string; expectedAttempts: number; expectedRetryAt: string | null; expectedUpdatedAt: string;
  reason: string; adminLogin: string;
};

/** One existing failed demand only. Never clears backoff or replenishes the current source's attempt budget. */
export function retryProductTranslation(input: ProductTranslationRetryInput): Promise<{ slug: string; kind: "retry" | "new_source" }> {
  if (!Number.isSafeInteger(input.productId) || input.productId < 1 || !LOCALES.includes(input.locale) || !isProductTranslationField(input.field)
    || !hash(input.expectedSourceHash) || !hash(input.expectedCurrentSourceHash) || !Number.isSafeInteger(input.expectedAttempts) || input.expectedAttempts < 0
    || !timestamp(input.expectedUpdatedAt) || (input.expectedRetryAt !== null && !timestamp(input.expectedRetryAt))
    || !input.reason.trim() || input.reason.length > 1000 || !input.adminLogin.trim() || input.adminLogin.length > 120) throw new ProductTranslationAdminError("invalid");
  return onPrimary(() => db.transaction(async (tx) => {
    // The worker and demand writer also lock product before the translation row.
    const [product] = await tx.select({ ...selection.source, slug: products.slug }).from(products).where(eq(products.id, input.productId)).for("share");
    if (!product || productTranslationSourceHash(product, input.field) !== input.expectedCurrentSourceHash) throw new ProductTranslationAdminError("conflict");
    const predicate = and(eq(t.productId, input.productId), eq(t.locale, input.locale), eq(t.field, input.field));
    const [row] = await tx.select(selection).from(t).innerJoin(products, eq(products.id, t.productId)).where(predicate).for("update", { of: t });
    if (!row || row.status !== "failed" || row.sourceHash !== input.expectedSourceHash || row.attempts !== input.expectedAttempts
      || row.updatedAt !== input.expectedUpdatedAt || row.retryAt !== input.expectedRetryAt) throw new ProductTranslationAdminError("conflict");
    const current = item(row, new Date());
    if (!current.recovery) throw new ProductTranslationAdminError("blocked");
    if (current.recovery === "new_source") {
      // A changed source receives its existing demand policy; a same-hash exhausted row never enters this path.
      if (await requestProductTranslations([input.productId], input.locale, [input.field], tx) !== 1) throw new ProductTranslationAdminError("conflict");
    } else {
      const updated = await tx.update(t).set({ status: "pending", updatedAt: sql`now()` }).where(and(predicate, eq(t.status, "failed"),
        eq(t.sourceHash, input.expectedSourceHash), eq(t.attempts, input.expectedAttempts),
        sql`${t.updatedAt} = ${input.expectedUpdatedAt}::timestamp`,
        input.expectedRetryAt === null ? sql`${t.retryAt} is null` : sql`${t.retryAt} = ${input.expectedRetryAt}::timestamp`)).returning({ id: t.productId });
      if (updated.length !== 1) throw new ProductTranslationAdminError("conflict");
      await requestJob(PRODUCT_TRANSLATION_JOB, tx);
    }
    await tx.insert(operationsAudit).values(await adminAuditRow(input.adminLogin, { action: "product-translation-retry", target: product.slug,
      detail: { locale: input.locale, field: input.field, kind: current.recovery, attempts: row.attempts,
        sourceHash: row.sourceHash, currentSourceHash: current.currentSourceHash, reason: input.reason.trim() } }));
    return { slug: product.slug, kind: current.recovery };
  }));
}
