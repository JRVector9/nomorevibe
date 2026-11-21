import { and, eq, gt, inArray, isNotNull, not, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { operationsAudit, products, productSearchProfiles } from "@/lib/db/schema";
import { MAX_PROFILE_ATTEMPTS, profileGenerationRetryAllowedSql } from "@/lib/domain/products/search-profile-retry";
import { requestJob } from "@/lib/jobs/control";
import { adminAuditRow } from "./admin-log";

const PAGE_SIZE = 30;
const LISTED = ["seeded", "verified"] as const;
const profile = productSearchProfiles;
const exhausted = and(isNotNull(profile.errorCode), not(profileGenerationRetryAllowedSql(profile.errorCode, profile.attempts)));

export async function listExhaustedKeywordGenerations(afterId: number) {
  const rows = await onPrimary(() => db.select({
    id: products.id, slug: products.slug, name: products.name, attempts: profile.attempts,
    errorCode: profile.errorCode, updatedAt: profile.updatedAt, sourceRevision: profile.sourceRevision,
  }).from(profile).innerJoin(products, eq(products.id, profile.productId))
    .where(and(inArray(products.status, LISTED), gt(products.id, afterId), exhausted))
    .orderBy(products.id).limit(PAGE_SIZE + 1));
  const page = rows.slice(0, PAGE_SIZE);
  return { rows: page, nextId: rows.length > PAGE_SIZE ? page.at(-1)!.id : null };
}

/** Called inside the web write gate. Re-check the displayed revision after locking the product and profile. */
export async function retryExhaustedKeywordGeneration(input: { productId: number; sourceRevision: number }, actor: string) {
  return onPrimary(() => db.transaction(async tx => {
    const [product] = await tx.select({ slug: products.slug }).from(products)
      .where(and(eq(products.id, input.productId), inArray(products.status, LISTED))).for("update");
    if (!product) return false;

    const target = and(eq(profile.productId, input.productId), eq(profile.sourceRevision, input.sourceRevision));
    const [previous] = await tx.select({ attempts: profile.attempts, errorCode: profile.errorCode }).from(profile)
      .where(and(target, exhausted)).for("update");
    if (!previous) return false;

    // Keep the error and the published keywords. One more counted failure reaches the normal cap again.
    const attempts = MAX_PROFILE_ATTEMPTS - 1;
    await tx.update(profile).set({ attempts, retryAt: null, sourceRevision: sql`${profile.sourceRevision} + 1` }).where(target);
    const { requestedVersion } = await requestJob("product-search-profile", tx);
    await tx.insert(operationsAudit).values(await adminAuditRow(actor, {
      action: "keyword-generation-retry", target: product.slug,
      detail: { ...input, previousAttempts: previous.attempts, errorCode: previous.errorCode, attempts, requestedVersion },
    }));
    return true;
  }));
}
