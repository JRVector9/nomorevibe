import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlTaglines, jobs, products, productSearchProfiles, secondReviews, textTranslations } from "@/lib/db/schema";
import { profileEvidence, profileHash } from "@/lib/domain/products/search-profile";
import { pendingProfiles, recordProfileResult } from "@/lib/domain/products/search-profiles";
import { collectSearchHealth } from "@/lib/domain/products/search-health";
import { readTextProgress } from "@/lib/operations/text-progress";
import { JobLeaseLostError, type JobLease } from "@/lib/jobs/control";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema, resetTables } from "./setup";

beforeAll(ensureSchema);
beforeEach(async () => {
  await resetTables();
  await db.delete(jobs);
  // The shared text monitor also reads crawler queues, which resetTables leaves
  // intact. Candidate deletion cascades to first-review translation sources.
  await db.delete(secondReviews);
  await db.delete(crawlCandidates);
  await db.delete(crawlTaglines);
  await db.delete(textTranslations);
});

async function seed(slug: string, overrides: Partial<typeof productSearchProfiles.$inferInsert> = {}) {
  const [product] = await db.insert(products).values({
    slug, name: slug, url: `https://${slug}.test`, tagline: "Calendar for meetings", description: "Manage meeting schedules",
    category: "Productivity", status: "seeded", source: "crawler", verifyToken: "fixture", editTokenHash: "fixture",
    searchKeywords: "calendar · 달력",
  }).returning();
  const [profile] = await db.insert(productSearchProfiles).values({
    productId: product.id, sourceHash: profileHash(profileEvidence(product, null)),
    keywordsEn: ["calendar"], keywordsKo: ["달력"], attempts: 5, errorCode: "network", needsRefresh: true,
    updatedAt: sql`now() - interval '2 hours'`, retryAt: sql`now() - interval '20 minutes'`,
    generatedAt: new Date("2026-10-01T00:00:00Z"), verifiedAt: new Date("2026-10-02T00:00:00Z"),
    repairVersion: 1, sourceRevision: 7, model: "original-model", verifyModel: "original-verifier",
    ...overrides,
  }).returning();
  return { product, profile };
}

async function current(id: number) {
  return (await db.select().from(productSearchProfiles).where(eq(productSearchProfiles.productId, id)))[0];
}

async function inJob(work: (lease: JobLease) => Promise<void>) {
  expect(await runJob("product-search-profile", async ctx => {
    await work(ctx.lease!);
    return { done: true };
  })).toMatchObject({ status: "completed", done: true });
}

describe("generation provider failures remain retryable without rewriting history", () => {
  it("re-enters seventeen capped network failures through the normal selector without a repair", async () => {
    for (let i = 0; i < 17; i++) await seed(`network-${i}`, { repairVersion: 0, attempts: 5 + i });
    const before = await db.select().from(productSearchProfiles);
    expect((await pendingProfiles(100)).map(task => task.product.id).sort((a, b) => a - b))
      .toEqual(before.map(profile => profile.productId).sort((a, b) => a - b));
    expect(await db.select().from(productSearchProfiles)).toEqual(before);
  });

  it("recognizes typed provider errors, obeys future backoff and preserves quality and timeout caps", async () => {
    const eligible = [];
    for (const errorCode of ["network", "no_key", "model_unavailable", "rate_limit", "rate_limited"]) {
      eligible.push((await seed(errorCode, { errorCode, attempts: 9 })).product.id);
    }
    await seed("future-network", { retryAt: new Date(Date.now() + 10 * 60_000) });
    for (const errorCode of ["invalid_output", "timeout", "http_502", "unknown"]) {
      await seed(`capped-${errorCode}`, { errorCode });
    }
    const belowCap = await seed("quality-below-cap", { errorCode: "invalid_output", attempts: 4 });
    expect((await pendingProfiles(100)).map(task => task.product.id).sort((a, b) => a - b))
      .toEqual([...eligible, belowCap.product.id].sort((a, b) => a - b));
  });

  it("counts provider-capped work as pending, keeps failure history visible, and monitors only due work", async () => {
    await seed("due-provider");
    await seed("future-provider", { retryAt: new Date(Date.now() + 60 * 60_000) });
    await seed("quality-exhausted", { errorCode: "invalid_output" });
    expect(await collectSearchHealth()).toMatchObject({ pendingGeneration: 2, exhausted: 1, repeatedFailures: 3 });
    expect(await readTextProgress()).toMatchObject({ oldestReadyMinutes: expect.any(Number) });
    expect((await readTextProgress()).oldestReadyMinutes).toBeGreaterThanOrEqual(19);
    await db.update(productSearchProfiles).set({ retryAt: sql`now() + interval '1 hour'` })
      .where(eq(productSearchProfiles.errorCode, "network"));
    expect((await readTextProgress()).oldestReadyMinutes).toBeNull();
  });

  it("backs off a new provider failure for thirty minutes with its first recorded attempt", async () => {
    const { product } = await seed("new-failure");
    await db.delete(productSearchProfiles).where(eq(productSearchProfiles.productId, product.id));
    const [task] = await pendingProfiles(1);
    await inJob(async lease => { expect(await recordProfileResult(task, lease, { kind: "failure", error: "no_key" })).toBe(true); });
    const saved = await current(product.id);
    expect(saved).toMatchObject({ errorCode: "no_key", attempts: 1, repairVersion: 0, generatedAt: null, verifiedAt: null });
    expect(saved.retryAt!.getTime() - saved.updatedAt.getTime()).toBe(30 * 60_000);
    expect(await pendingProfiles(1)).toHaveLength(0);
  });

  it("records another provider failure without losing original evidence, keywords or success timestamps", async () => {
    const { product, profile: before } = await seed("failure-history");
    const [task] = await pendingProfiles(1);
    expect(task).toBeDefined();
    await inJob(async lease => { expect(await recordProfileResult(task, lease, { kind: "failure", error: "network" })).toBe(true); });
    const after = await current(product.id);
    expect(after).toMatchObject({ attempts: before.attempts + 1, repairVersion: before.repairVersion,
      sourceHash: before.sourceHash, sourceRevision: before.sourceRevision, keywordsEn: before.keywordsEn,
      keywordsKo: before.keywordsKo, generatedAt: before.generatedAt, verifiedAt: before.verifiedAt,
      model: before.model, verifyModel: before.verifyModel, needsRefresh: before.needsRefresh, errorCode: "network" });
    expect(after.retryAt!.getTime() - after.updatedAt.getTime()).toBe(30 * 60_000);
  });

  it("can save a successful retry with cumulative attempts and actual generation time", async () => {
    const { product, profile: before } = await seed("successful-retry");
    const [task] = await pendingProfiles(1);
    expect(task).toBeDefined();
    await inJob(async lease => { expect(await recordProfileResult(task, lease,
      { kind: "success", en: ["meeting planner"], ko: ["회의 일정"], model: "test-model" })).toBe(true); });
    const after = await current(product.id);
    expect(after).toMatchObject({ attempts: 6, repairVersion: 1, sourceRevision: 7, sourceHash: before.sourceHash,
      needsRefresh: false, errorCode: null, retryAt: null, verifiedAt: null, keywordsEn: ["meeting planner"] });
    expect(after.generatedAt!.getTime()).toBeGreaterThan(before.generatedAt!.getTime());
    expect(await pendingProfiles(1)).toHaveLength(0);
  });

  it("rejects stale source and profile revisions before recording an external failure", async () => {
    const { product, profile } = await seed("stale-source", { attempts: 4 });
    const [task] = await pendingProfiles(1);
    await db.update(products).set({ tagline: "Changed source" }).where(eq(products.id, product.id));
    const afterSourceChange = await current(product.id);
    await inJob(async lease => { expect(await recordProfileResult(task, lease, { kind: "failure", error: "network" })).toBe(false); });
    expect(await current(product.id)).toEqual(afterSourceChange);
    const [fresh] = await pendingProfiles(1);
    await db.update(productSearchProfiles).set({ sourceRevision: profile.sourceRevision + 2 })
      .where(eq(productSearchProfiles.productId, product.id));
    const afterRevisionChange = await current(product.id);
    await inJob(async lease => { expect(await recordProfileResult(fresh, lease, { kind: "failure", error: "network" })).toBe(false); });
    expect(await current(product.id)).toEqual(afterRevisionChange);
  });

  it("rolls back the provider failure if the job loses its lease", async () => {
    const { product, profile: before } = await seed("lost-lease", { attempts: 4 });
    const [task] = await pendingProfiles(1);
    const outcome = await runJob("product-search-profile", async ctx => {
      await db.update(jobs).set({ leaseToken: "another-worker" }).where(eq(jobs.name, "product-search-profile"));
      await expect(recordProfileResult(task, ctx.lease!, { kind: "failure", error: "network" }))
        .rejects.toBeInstanceOf(JobLeaseLostError);
      return { done: true };
    });
    expect(outcome).toMatchObject({ status: "failed", error: "job_lease_lost" });
    expect(await current(product.id)).toEqual(before);
  });
});
