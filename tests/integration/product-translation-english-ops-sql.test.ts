import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productTranslations } from "@/lib/db/schema";
import { productTranslationSourceHash } from "@/lib/domain/products/translation-policy";
import { productTranslationAdminQueue, productTranslationAdminSummary, retryProductTranslation, revertSourceNativeTranslation,
  ProductTranslationAdminError } from "@/lib/domain/products/translation-admin";
import { pendingProductTranslations } from "@/lib/domain/products/translations";
import { englishUncertainRequeueSql, sourceNativeRollbackSql } from "@/scripts/ops/product-translation-english-sql";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

vi.mock("server-only", () => ({}));
beforeAll(ensureSchema);
beforeEach(resetTables);

type Row = Partial<typeof productTranslations.$inferInsert>;
async function demand(slug: string, tagline: string, row: Row) {
  const [product] = await db.insert(products).values({ slug, name: slug, url: `https://${slug}.test`, tagline, description: "",
    category: "Dev", status: "seeded", source: "crawler", taglineSource: "ai_page", verifyToken: "v", editTokenHash: "e" }).returning();
  await db.insert(productTranslations).values({ productId: product.id, locale: "en", field: "tagline", sourceHash: productTranslationSourceHash(product, "tagline"),
    provenance: { kind: "machine", source: "ai_page", policy: "public-fields-v1" }, model: "m", attempts: 0, status: "pending", ...row });
  return product;
}
const state = async (id: number) => (await db.execute<Record<string, unknown>>(sql`SELECT status, text, attempts, error_code, retry_at IS NULL AS no_retry,
  source_locale, provenance->>'kind' AS kind FROM product_translations WHERE product_id = ${id}`)).map(row => ({ ...row }));
const run = async (text: string) => (await db.execute<{ rows: number }>(sql.raw(text))).map(row => row.rows);
const dbNow = async () => (await db.execute<{ now: string }>(sql`SELECT now()::timestamp::text AS now`))[0].now;
async function withMaxAttempts<T>(maxAttempts: number | null, load: () => Promise<T>): Promise<T> {
  const [saved] = await db.execute<{ values: unknown }>(sql`SELECT "values" FROM runtime_settings WHERE id = 1`);
  try {
    if (maxAttempts === null) await db.execute(sql`DELETE FROM runtime_settings WHERE id = 1`);
    else await db.execute(sql`INSERT INTO runtime_settings (id, "values", updated_by) VALUES (1, ${JSON.stringify({ version: 1,
      translation: { product: { maxAttempts } } })}::jsonb, 'test') ON CONFLICT (id) DO UPDATE SET "values" = excluded."values"`);
    return await load();
  } finally {
    if (saved) await db.execute(sql`INSERT INTO runtime_settings (id, "values", updated_by) VALUES (1, ${JSON.stringify(saved.values)}::jsonb, 'test')
      ON CONFLICT (id) DO UPDATE SET "values" = excluded."values"`);
    else await db.execute(sql`DELETE FROM runtime_settings WHERE id = 1`);
  }
}
const failed = { status: "failed" as const, errorCode: "rejected:english_uncertain", retryAt: null };

it("re-queues only exhausted pre-cut-off english_uncertain rows, at the last dispatchable attempt, with one audit row per batch", async () => {
  const old = sql`now() - interval '1 hour'` as unknown as Date;
  const exhausted = await demand("exhausted", "Color picker", { ...failed, attempts: 4, updatedAt: old });
  const waiting = await demand("waiting", "Habit tracker", { ...failed, attempts: 2, updatedAt: old });
  const otherError = await demand("other", "Gradient tool", { ...failed, errorCode: "rejected:name_lost", attempts: 4, updatedAt: old });
  const before = await dbNow();
  const after = await demand("after", "Notes app", { ...failed, attempts: 4 });
  await db.update(productTranslations).set({ updatedAt: sql`now() + interval '1 second'` }).where(eq(productTranslations.productId, after.id));
  const floor = await auditFloor();
  await withMaxAttempts(null, async () => {
    expect(await run(englishUncertainRequeueSql({ before, actor: "jr" }))).toEqual([1]);
    expect(await run(englishUncertainRequeueSql({ before, actor: "jr" }))).toEqual([]); // repeated run ends: nothing left, no audit row
  });
  expect(await state(exhausted.id)).toEqual([{ status: "pending", text: null, attempts: 3, error_code: null, no_retry: true, source_locale: null, kind: "machine" }]);
  for (const id of [waiting.id, otherError.id, after.id]) expect((await state(id))[0].status).toBe("failed");
  expect((await pendingProductTranslations(8, { owner: undefined })).map(task => task.source.id)).toContain(exhausted.id);
  const audit = await auditRowsAfter(floor, "product-translation-english-requeue");
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor: "jr", actorKind: "local", target: "product_translations:en:rejected:english_uncertain",
    detail: { rows: 1, before, attempts: 3, limit: 2000, pr: 1019 } });
});

it("derives the re-queued attempt from the live maxAttempts, so the selector still dispatches it", async () => {
  const old = sql`now() - interval '1 hour'` as unknown as Date;
  const row = await demand("low-max", "Color picker", { ...failed, attempts: 2, updatedAt: old });
  const before = await dbNow();
  await withMaxAttempts(2, async () => {
    expect(await run(englishUncertainRequeueSql({ before, actor: "jr" }))).toEqual([1]);
    expect((await state(row.id))[0]).toMatchObject({ status: "pending", attempts: 1 });
  });
});

it("rolls back source_native rows written since the cut-off, stops their retries, and audits the batch", async () => {
  const since = await dbNow();
  const native = await demand("native", "Color picker", { status: "ready", text: "Color picker", attempts: 1, sourceLocale: "en",
    provenance: { kind: "source_native", source: "ai_page", policy: "public-fields-v1" } });
  const machine = await demand("machine", "색 고르기", { status: "ready", text: "Color picker", attempts: 1 });
  const earlier = await demand("earlier", "Habit tracker", { status: "ready", text: "Habit tracker", attempts: 1, sourceLocale: "en",
    provenance: { kind: "source_native", source: "ai_page", policy: "public-fields-v1" }, updatedAt: sql`now() - interval '1 hour'` as unknown as Date });
  const floor = await auditFloor();
  await withMaxAttempts(null, async () => {
    expect(await run(sourceNativeRollbackSql({ since, actor: "jr" }))).toEqual([1]);
  });
  expect(await state(native.id)).toEqual([{ status: "failed", text: null, attempts: 4, error_code: "source_native_reverted", no_retry: true,
    source_locale: null, kind: "machine" }]);
  expect((await state(machine.id))[0]).toMatchObject({ status: "ready", kind: "machine" });
  expect((await state(earlier.id))[0]).toMatchObject({ status: "ready", kind: "source_native" });
  expect((await pendingProductTranslations(8, { owner: undefined })).map(task => task.source.id)).not.toContain(native.id);
  expect(await auditRowsAfter(floor, "product-translation-source-native-rollback")).toEqual([expect.objectContaining({ actor: "jr",
    detail: { rows: 1, since, until: null, limit: 2000, pr: 1019 } })]);
});

it("shows provenance in the admin queue and reverts one source_native row through the audited admin path", async () => {
  const native = await demand("native", "Color picker", { status: "ready", text: "Color picker", attempts: 1, sourceLocale: "en",
    provenance: { kind: "source_native", source: "ai_page", policy: "public-fields-v1" } });
  await demand("machine", "색 고르기", { status: "ready", text: "Color picker", attempts: 1 });
  const listed = await productTranslationAdminQueue({ state: "ready", provenance: "source_native" });
  expect(listed.items.map(item => [item.slug, item.provenance])).toEqual([["native", "source_native"]]);
  expect((await productTranslationAdminQueue({ state: "ready" })).items.map(item => item.provenance).sort()).toEqual(["machine", "source_native"]);
  expect((await productTranslationAdminSummary()).find(row => row.locale === "en" && row.field === "tagline")).toMatchObject({ ready: 2, sourceNative: 1 });
  const [item] = listed.items, floor = await auditFloor();
  const input = { productId: native.id, locale: "en" as const, field: "tagline" as const, expectedSourceHash: item.sourceHash,
    expectedUpdatedAt: item.updatedAt, reason: "Indonesian, not English", adminLogin: "jr" };
  await expect(revertSourceNativeTranslation({ ...input, expectedUpdatedAt: "2020-01-01T00:00:00.000000Z" })).rejects.toBeInstanceOf(ProductTranslationAdminError);
  expect(await revertSourceNativeTranslation(input)).toEqual({ slug: "native" });
  expect(await state(native.id)).toEqual([{ status: "failed", text: null, attempts: 4, error_code: "source_native_reverted", no_retry: true,
    source_locale: null, kind: "machine" }]);
  await expect(revertSourceNativeTranslation(input)).rejects.toBeInstanceOf(ProductTranslationAdminError); // no longer ready
  expect(await auditRowsAfter(floor, "product-translation-source-native-revert")).toEqual([expect.objectContaining({ target: "native",
    detail: expect.objectContaining({ locale: "en", field: "tagline", text: "Color picker", attemptsAfter: 4, reason: "Indonesian, not English" }) })]);
  // The reverted row is exhausted: the retry form does not offer it.
  const [reverted] = (await productTranslationAdminQueue({ state: "failed" })).items;
  expect(reverted).toMatchObject({ recovery: null, recoveryReason: "exhausted" });
  await expect(retryProductTranslation({ productId: native.id, locale: "en", field: "tagline", expectedSourceHash: reverted.sourceHash,
    expectedCurrentSourceHash: reverted.currentSourceHash, expectedAttempts: reverted.attempts, expectedRetryAt: reverted.retryAt,
    expectedUpdatedAt: reverted.updatedAt, reason: "x", adminLogin: "jr" })).rejects.toBeInstanceOf(ProductTranslationAdminError);
});
