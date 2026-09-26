import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, products, productSearchProfiles } from "@/lib/db/schema";
import { productAuditCampaigns, productAuditItems } from "@/lib/db/product-audit-schema";
import { profileEvidence, profileHash } from "@/lib/domain/products/search-profile";
import { pendingProfiles, pendingVerifications, recordProfileResult, recordVerificationResult } from "@/lib/domain/products/search-profiles";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(jobs);
  await db.execute(sql`truncate product_audit_campaigns, product_audit_items, product_audit_attempts restart identity cascade`);
});

async function fixture(noteOnTarget: boolean) {
  const rows = await db.insert(products).values(["dummy", "target"].map(slug => ({
    slug, name: slug, url: `https://${slug}.test`, tagline: "Class scheduling", description: "Class scheduling",
    category: "Productivity", status: "seeded" as const, source: "crawler" as const, verifyToken: "v", editTokenHash: "e",
  }))).returning();
  const [campaign] = await db.insert(productAuditCampaigns).values({
    startedBy: "test", reason: "test", promptVersion: "v1", rulesVersion: "v1", provider: "test", model: "test",
  }).returning();
  const reason = "Calendar and class scheduling software";
  const [note] = await db.insert(productAuditItems).values({
    campaignId: campaign.id, productId: rows[noteOnTarget ? 1 : 0].id,
    slug: rows[noteOnTarget ? 1 : 0].slug, aiReason: reason,
  }).returning();
  // Audit item IDs are independent of product IDs in production.
  expect(note.id).not.toBe(rows[1].id);
  return { target: rows[1], reason: noteOnTarget ? reason : null };
}

describe("최신 심사 메모의 제품 상관관계", () => {
  it.each([true, false])("생성 저장은 해당 제품의 메모만 다시 읽는다 (메모 있음=%s)", async (noteOnTarget) => {
    const { target, reason } = await fixture(noteOnTarget);
    let saved = false;
    await runJob("product-search-profile", async ctx => {
      const [task] = await pendingProfiles(1);
      expect(task.product.id).toBe(target.id);
      expect(task.reviewerNote).toBe(reason);
      saved = await recordProfileResult(task, ctx.lease!, { kind: "success", en: ["class scheduling"], ko: [], model: "test" });
      return { done: true };
    });
    expect(saved).toBe(true);
    const [profile] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, target.id));
    expect(profile.sourceHash).toBe(profileHash(profileEvidence(target, reason)));
  });

  it("검수 저장은 다른 ID인 감사 항목의 메모를 놓치거나 재생성으로 잘못 넘기지 않는다", async () => {
    const { target, reason } = await fixture(true);
    await db.insert(productSearchProfiles).values({ productId: target.id,
      keywordsEn: ["class scheduling"], keywordsKo: [], model: "test", sourceHash: profileHash(profileEvidence(target, reason)) });
    let saved = false;
    await runJob("product-search-verify", async ctx => {
      const [task] = await pendingVerifications(1);
      expect(task.reviewerNote).toBe(reason);
      saved = await recordVerificationResult(task, ctx.lease!, { kind: "success", removed: [], model: "test" });
      return { done: true };
    });
    expect(saved).toBe(true);
    const [profile] = await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, target.id));
    expect(profile).toMatchObject({ needsRefresh: false, verifyError: null });
    expect(profile.verifiedAt).not.toBeNull();
  });
});
