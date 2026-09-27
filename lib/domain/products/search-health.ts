import { emptySearchHealth } from "@/lib/operations/search-health-model";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productSearchProfiles } from "@/lib/db/schema";
import { keywordText, profileEvidence, profileHash } from "./search-profile";

/** One snapshot, bounded pages; never mark or repair data from an audit. */
export async function collectSearchHealth(hasBudget = () => true) {
  const deadline = Date.now() + 30_000;
  const assertBudget = () => {
    if (!hasBudget() || Date.now() >= deadline) throw new Error("search_health_budget_exhausted");
  };
  assertBudget();
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    await tx.execute(sql`SET LOCAL jit = off`);
    const [clock] = await tx.execute<{ at: string }>(sql`select now()::text as at`);
    const now = new Date(clock.at).getTime();
    const c = emptySearchHealth();
    let afterId = 0;
    while (true) {
      assertBudget();
      const rows = await tx.select({ product: {
        id: products.id, name: products.name, url: products.url, category: products.category,
        tagline: products.tagline, description: products.description, searchTopics: products.searchTopics,
        searchPageText: products.searchPageText, searchReadme: products.searchReadme,
        searchKeywords: products.searchKeywords, createdAt: products.createdAt, verifiedAt: products.verifiedAt,
      }, profile: productSearchProfiles,
      reviewerNote: sql<string | null>`(select a.ai_reason from product_audit_items a
        where a.product_id = products.id and a.ai_reason is not null order by a.id desc limit 1)` })
        .from(products).leftJoin(productSearchProfiles, eq(products.id, productSearchProfiles.productId))
        .where(and(inArray(products.status, ["seeded", "verified"]), gt(products.id, afterId)))
        .orderBy(products.id).limit(500);
      if (!rows.length) break;
      for (const row of rows) {
        c.total++;
        const p = row.profile;
        if (!p) {
          c.missing++; c.pendingGeneration++;
          if (now - (row.product.verifiedAt ?? row.product.createdAt).getTime() >= 30 * 60_000) c.oldMissing++;
          continue;
        }
        if (p.sourceHash !== profileHash(profileEvidence(row.product, row.reviewerNote))) {
          c.mismatched++;
          if (!p.needsRefresh) c.unmarked++;
        }
        if (p.needsRefresh || p.errorCode) c.pendingGeneration++;
        if (p.errorCode && p.attempts >= 5 || p.verifyError && p.verifyAttempts >= 5) c.exhausted++;
        if (p.errorCode && p.attempts >= 3 || p.verifyError && p.verifyAttempts >= 3) c.repeatedFailures++;
        const removed = new Set(p.removedKeywords);
        const expected = keywordText(p.keywordsEn.filter(k => !removed.has(k)), p.keywordsKo.filter(k => !removed.has(k)));
        if (row.product.searchKeywords !== expected) c.copiesMismatched++;
        if (p.generatedAt && now - p.generatedAt.getTime() < 15 * 60_000) c.generatedRecent++;
        if (!p.needsRefresh && !p.errorCode) {
          if (!p.verifiedAt && p.keywordsEn.length + p.keywordsKo.length > 0) {
            c.pendingVerification++;
            c.oldestVerificationMinutes = Math.max(c.oldestVerificationMinutes, (now - p.updatedAt.getTime()) / 60_000);
          }
          if (p.verifiedAt && now - p.verifiedAt.getTime() < 15 * 60_000) c.verifiedRecent++;
        }
      }
      afterId = rows.at(-1)!.product.id;
    }
    assertBudget();
    return c;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
