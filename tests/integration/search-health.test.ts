import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { products, productSearchProfiles, jobs, operationsObservations } from "@/lib/db/schema";
import { profileEvidence, profileHash } from "@/lib/domain/products/search-profile";
import { collectSearchHealth } from "@/lib/domain/products/search-health";
import { auditSearchHealth } from "@/lib/jobs/products/search-health";
import { runJob } from "@/lib/jobs/runner";
import { readSearchHealth } from "@/lib/operations/search-health-model";
import { ensureSchema, resetTables } from "./setup";

beforeAll(ensureSchema);
beforeEach(resetTables);
async function seed(slug: string, profile = true) {
  const [p] = await db.insert(products).values({ slug, name: slug, url: `https://${slug}.test`,
    tagline: slug, description: slug, category: "Dev", status: "seeded", source: "crawler",
    verifyToken: "fixture", editTokenHash: "fixture", searchKeywords: "calendar" }).returning();
  if (profile) await db.insert(productSearchProfiles).values({ productId: p.id,
    sourceHash: profileHash(profileEvidence(p, null)), keywordsEn: ["calendar"], verifiedAt: new Date() });
  return p;
}
describe("read only consistent search audit", () => {
  it("counts hashes, copies, missing, capped retries and waiting without modifying data", async () => {
    const good = await seed("good");
    const unmarked = await seed("unmarked");
    const dirty = await seed("dirty");
    const missing = await seed("missing", false);
    const hidden = await seed("hidden", false);
    await db.update(products).set({ status: "banned" }).where(eq(products.id, hidden.id));
    await db.update(products).set({ createdAt: sql`now() - interval '2 hours'` }).where(eq(products.id, missing.id));
    await db.update(products).set({ tagline: "Changed" }).where(eq(products.id, dirty.id));
    await db.update(productSearchProfiles).set({ sourceHash: "wrong", needsRefresh: false,
      verifiedAt: null, updatedAt: sql`now() - interval '2 hours'`, verifyError: "invalid_output", verifyAttempts: 5 })
      .where(eq(productSearchProfiles.productId, unmarked.id));
    await db.update(products).set({ searchKeywords: "broken" }).where(eq(products.id, good.id));
    const before = await db.select().from(productSearchProfiles);
    expect(await collectSearchHealth()).toMatchObject({ total: 4, missing: 1, oldMissing: 1,
      mismatched: 2, unmarked: 1, copiesMismatched: 1, pendingGeneration: 2,
      pendingVerification: 1, repeatedFailures: 1, exhausted: 1, oldestVerificationMinutes: expect.any(Number) });
    expect(await db.select().from(productSearchProfiles)).toEqual(before);
  });
  it("does not emit a partial audit when execution budget is lost", async () => {
    await seed("stop");
    await expect(collectSearchHealth(() => false)).rejects.toThrow("search_health_budget_exhausted");
  });
  it("gives newly verified old registrations a missing-profile grace period", async () => {
    const p = await seed("just-verified", false);
    await db.update(products).set({ createdAt: sql`now() - interval '2 days'`, status: "verified", verifiedAt: new Date() })
      .where(eq(products.id, p.id));
    expect(await collectSearchHealth()).toMatchObject({ missing: 1, oldMissing: 0 });
  });
  it("checks the preserved search copy during dirty-source regeneration and backoff", async () => {
    const p = await seed("dirty-copy");
    await db.update(products).set({ tagline: "New source", searchKeywords: "corrupt" }).where(eq(products.id, p.id));
    await db.update(productSearchProfiles).set({ errorCode: "timeout", attempts: 2, retryAt: sql`now() + interval '1 hour'` })
      .where(eq(productSearchProfiles.productId, p.id));
    expect(await collectSearchHealth()).toMatchObject({ copiesMismatched: 1, pendingGeneration: 1, unmarked: 0 });
  });
  it("does not count a periodic profile reuse as generation progress", async () => {
    await seed("periodic-reuse");
    expect(await collectSearchHealth()).toMatchObject({ generatedRecent: 0 });
  });
  it("does not report old verification failures after the source was invalidated", async () => {
    const p = await seed("obsolete-verification");
    await db.update(productSearchProfiles).set({ verifyError: "invalid_output", verifyAttempts: 5 })
      .where(eq(productSearchProfiles.productId, p.id));
    await db.update(products).set({ tagline: "New source" }).where(eq(products.id, p.id));
    expect(await collectSearchHealth()).toMatchObject({ pendingGeneration: 1, repeatedFailures: 0, exhausted: 0 });
  });
  it("persists owned audit counts and a continuous stalled-generation warning", async () => {
    await seed("waiting", false);
    const name = "product-search-health";
    await db.delete(jobs).where(eq(jobs.name, name));
    await db.insert(jobs).values({ name, cursor: { generationIdleSince: Date.now() - 31 * 60_000 } });
    expect(await runJob(name, auditSearchHealth)).toMatchObject({ status: "completed", done: true });
    const [o] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, `job:${name}`));
    expect(readSearchHealth({ ...o, observedAt: o.observedAt.toISOString() }))
      .toMatchObject({ total: 1, pendingGeneration: 1, generationIdleMinutes: expect.any(Number) });
    expect(o.value).toMatchObject({ events: expect.arrayContaining([
      { event: "search_health.alert.generation-stalled", counts: { count: 1 } },
    ]) });
    const [job] = await db.select().from(jobs).where(eq(jobs.name, name));
    expect(job.cursor).toHaveProperty("generationIdleSince");
  });
});
