import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productLinks, productEvidenceAudit, type DeclarationSource } from "@/lib/db/schema";
import { lockProductGeneration, ProductGenerationChangedError, type ProductTransaction } from "@/lib/domain/products/generation";
import { normalizeTypedLink } from "./contracts";

export type RepositoryLinkSyncResult = {
  action: "created" | "updated" | "unchanged" | "preserved_hidden" | "review_required";
  linkId: number | null;
};
type SyncInput = { productId: number; slug: string; repoUrl: string | null; declarationSource: DeclarationSource; mode: "explicit" | "backfill" };

/** Must run inside the product write transaction. Removed links leave audit tombstones. */
export async function syncRepositoryLink(input: SyncInput, transaction?: ProductTransaction): Promise<RepositoryLinkSyncResult> {
  if (!transaction) return db.transaction(tx => syncRepositoryLink(input, tx));
  const tx = transaction;
  if (!(await lockProductGeneration(tx, input.productId, input.slug))) throw new ProductGenerationChangedError();
  if (!input.repoUrl) return { action: "unchanged", linkId: null };
  const normalized = normalizeTypedLink("repository", input.repoUrl);
  if (!normalized) return { action: "review_required", linkId: null };
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`product-evidence-maker-links:${input.slug}`}))`);
  const [product] = await tx.select({ repoUrl: products.repoUrl, source: products.source, claimedAt: products.claimedAt, status: products.status })
    .from(products).where(eq(products.id, input.productId));
  if (input.mode === "backfill" && (product.status === "banned"
    || !product.repoUrl || normalizeTypedLink("repository", product.repoUrl)?.normalizedKey !== normalized.normalizedKey)) {
    return { action: "review_required", linkId: null };
  }
  const [existing] = await tx.select().from(productLinks).where(and(eq(productLinks.slug, input.slug), eq(productLinks.kind, "repository"), eq(productLinks.normalizedKey, normalized.normalizedKey)));
  if (existing) return { action: existing.visible ? "unchanged" : "preserved_hidden", linkId: existing.id };
  const audit = await tx.select({ action: productEvidenceAudit.action, metadata: productEvidenceAudit.metadata })
    .from(productEvidenceAudit).where(and(eq(productEvidenceAudit.slug, input.slug), sql`${productEvidenceAudit.action} like 'maker.links.%'`));
  if (audit.some(row => row.action === "maker.links.remove" && Array.isArray(row.metadata.keys) && row.metadata.keys.includes(`repository:${normalized.normalizedKey}`))) {
    return { action: "preserved_hidden", linkId: null };
  }
  if (input.mode === "backfill") {
    if (audit.length > 0 || product.source !== "crawler" || product.claimedAt !== null) return { action: "review_required", linkId: null };
  }
  const [created] = await tx.insert(productLinks).values({ slug: input.slug, kind: "repository", declarationSource: input.declarationSource, ...normalized }).returning({ id: productLinks.id });
  return { action: "created", linkId: created.id };
}
