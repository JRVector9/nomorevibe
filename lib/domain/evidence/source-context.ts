import { and, eq, sql } from "drizzle-orm";
import { evidenceSettings, productEvidenceSources, products, productRefreshRequests } from "@/lib/db/schema";
import { lockProductGeneration, type ProductTransaction } from "@/lib/domain/products/generation";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { evidenceSettingsSchema, type EvidenceSettings } from "./settings";
import { db } from "@/lib/db";
import { evidenceSourceControl } from "@/lib/db/evidence-source-claims-schema";
import { canonicalSourcePolicyHash, type CanonicalSourceBinding } from "./source-contract";

export async function lockCanonicalPolicy(tx: ProductTransaction): Promise<EvidenceSettings> {
  // The sole settings writer takes the exclusive counterpart, including absent-row INSERT.
  await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext('evidence-settings-policy'))`);
  const [row] = await tx.select().from(evidenceSettings).where(eq(evidenceSettings.id, 1)).for("share");
  return evidenceSettingsSchema.parse(row?.values ?? {});
}
export async function lockCanonicalContext(tx: ProductTransaction, productId: number) {
  const [hint] = await tx.select({ slug: products.slug }).from(products).where(eq(products.id, productId));
  if (!hint || !(await lockProductGeneration(tx, productId, hint.slug))) return null;
  const [product] = await tx.select({ id: products.id, slug: products.slug, url: products.url, status: products.status, accessMode: products.accessMode,
    updatedAt: sql<string>`${products.updatedAt}::text` }).from(products).where(eq(products.id, productId));
  const settings = await lockCanonicalPolicy(tx);
  const [stored] = await tx.select().from(productEvidenceSources).where(and(eq(productEvidenceSources.slug, product.slug),
    eq(productEvidenceSources.kind, "documentation"), eq(productEvidenceSources.sourceKey, "canonical_site"))).for("update");
  const [raw] = await tx.execute<{ value: unknown }>(sql`select to_jsonb(s) as value from product_evidence_sources s
    where s.slug=${product.slug} and s.kind='documentation' and s.source_key='canonical_site'`);
  const [request] = await tx.select().from(productRefreshRequests).where(eq(productRefreshRequests.productId, productId)).for("update");
  const binding: CanonicalSourceBinding = { version: 1, productId, slug: product.slug, kind: "documentation", sourceKey: "canonical_site",
    sourceUrl: product.url, productUpdatedAt: product.updatedAt, policyHash: canonicalSourcePolicyHash(settings),
    sourceRevision: raw ? reviewHash(raw.value) : null, requestVersion: request?.activeVersion ?? null };
  return { product, settings, stored, request, binding };
}
/** Legacy registration can collect before publication. Capture that actual state;
 * a later unpublish/status edit must not inherit this response. */
export async function captureCanonicalInput(input: { productId: number; slug: string; url: string }) {
  const [row] = await db.select({ status: products.status, accessMode: products.accessMode,
    updatedAt: sql<string>`${products.updatedAt}::text` }).from(products).where(and(eq(products.id, input.productId),eq(products.slug,input.slug),eq(products.url,input.url)));
  if (!row || row.status === "banned") throw new Error("evidence_source_input_changed");
  return row;
}
export async function assertCanonicalInput(tx: ProductTransaction, input: { productId: number; slug: string; url: string }, settings: EvidenceSettings,
  original: Awaited<ReturnType<typeof captureCanonicalInput>>) {
  const [control] = await tx.select().from(evidenceSourceControl).where(eq(evidenceSourceControl.id, 1)).for("share");
  if (control?.enabled) throw new Error("evidence_source_claim_required");
  if (!(await lockProductGeneration(tx, input.productId, input.slug))) throw new Error("evidence_source_input_changed");
  const [product] = await tx.select({ url: products.url, status: products.status, accessMode: products.accessMode,
    updatedAt: sql<string>`${products.updatedAt}::text` }).from(products).where(eq(products.id, input.productId));
  const current = await lockCanonicalPolicy(tx);
  if (!product || product.accessMode !== original.accessMode || product.url !== input.url || product.status !== original.status || product.updatedAt !== original.updatedAt
    || canonicalSourcePolicyHash(current) !== canonicalSourcePolicyHash(settings)) throw new Error("evidence_source_input_changed");
}
