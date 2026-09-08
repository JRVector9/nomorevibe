import { beforeAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, products, productEvidenceAudit } from "@/lib/db/schema";
import { productRefreshRequests } from "@/lib/db/product-evidence-schema";
import { queueProductRefresh, beginProductRefresh, getProductRefreshRequest, saveProductRefreshProgress,
  dueProductRefreshRequests } from "@/lib/domain/evidence/refresh-requests";
import { queueMakerRefresh } from "@/lib/domain/evidence/maker";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(productRefreshRequests);
  await db.delete(jobs);
  await resetTables();
});
async function product() {
  const [row] = await db.insert(products).values({ slug: "refresh-test", url: "https://refresh-test.example",
    name: "Refresh", tagline: "Refresh", description: "Refresh", category: "Dev", status: "verified",
    verifyToken: "refresh-test", editTokenHash: "a".repeat(64) }).returning();
  return row;
}
const complete = { sourcesAttempted: 1, sourcesFailed: 0, factsChanged: 0, eventsInserted: 0, mediaInserted: 0, complete: true };

it("atomically queues maker refresh, audit and job without forcing recent media", async () => {
  const row = await product();
  await queueMakerRefresh({ slug: row.slug, productId: row.id, actor: "maker:test" });
  expect(await getProductRefreshRequest(row.slug)).toMatchObject({ requestedVersion: 1, completedVersion: 0, force: false });
  expect(await db.select().from(jobs)).toMatchObject([{ name: "product-evidence-refresh", requestedVersion: 1 }]);
  expect(await db.select().from(productEvidenceAudit)).toMatchObject([{ action: "maker.refresh.queue", actor: "maker:test" }]);
});

it("coalesces queued duplicate force requests and retains a later request during an active run", async () => {
  const row = await product();
  const input = { slug: row.slug, productId: row.id, actor: "admin:test", force: true };
  const first = await queueProductRefresh(input);
  expect(await queueProductRefresh(input)).toEqual(first);
  const active = (await beginProductRefresh((await getProductRefreshRequest(row.slug))!, new Date()))!;
  await saveProductRefreshProgress(active, { completedKeys: ["first-url"], retryAfterByKey: {} }, { now: new Date() });
  expect(await queueProductRefresh(input)).toMatchObject({ requestedVersion: 2 });
  expect(await queueProductRefresh(input)).toMatchObject({ requestedVersion: 2 });
  expect(await getProductRefreshRequest(row.slug)).toMatchObject({ activeVersion: 1, progress: { completedKeys: ["first-url"] } });
  await saveProductRefreshProgress(active, { completedKeys: ["first-url"], retryAfterByKey: {} }, { now: new Date(), result: complete });
  expect(await getProductRefreshRequest(row.slug)).toMatchObject({ requestedVersion: 2, completedVersion: 1, activeVersion: null });
  const second = (await beginProductRefresh((await getProductRefreshRequest(row.slug))!, new Date()))!;
  expect(second).toMatchObject({ activeVersion: 2, activeForce: true, progress: { completedKeys: [] } });
});

it("does not turn a later maker request into force or downgrade the running force request", async () => {
  const row = await product();
  await queueProductRefresh({ slug: row.slug, actor: "admin:test", force: true });
  const active = (await beginProductRefresh((await getProductRefreshRequest(row.slug))!, new Date()))!;
  await queueMakerRefresh({ slug: row.slug, actor: "maker:test" });
  expect(await getProductRefreshRequest(row.slug)).toMatchObject({ activeForce: true, force: false, requestedVersion: 2 });
  await saveProductRefreshProgress(active, { completedKeys: [], retryAfterByKey: {} }, { now: new Date(), result: complete });
  expect(await beginProductRefresh((await getProductRefreshRequest(row.slug))!, new Date())).toMatchObject({ activeForce: false });
});

it("keeps failed sources pending until retry and prevents an old worker from completing them", async () => {
  const row = await product();
  await queueProductRefresh({ slug: row.slug, actor: "admin:test", force: true });
  const active = (await beginProductRefresh((await getProductRefreshRequest(row.slug))!, new Date()))!;
  const now = new Date();
  const nextAttemptAt = new Date(now.getTime() + 3600_000);
  await saveProductRefreshProgress(active, { completedKeys: [], retryAfterByKey: { source: nextAttemptAt.toISOString() } },
    { now, result: { ...complete, complete: false, sourcesFailed: 1, nextAttemptAt } });
  expect(await dueProductRefreshRequests(now)).toEqual([]);
  expect(await getProductRefreshRequest(row.slug)).toMatchObject({ completedVersion: 0, activeVersion: 1, nextAttemptAt });
  await db.insert(jobs).values({ name: "product-evidence-refresh", lockedAt: now, leaseToken: "new-owner" })
    .onConflictDoUpdate({ target: jobs.name, set: { lockedAt: now, leaseToken: "new-owner" } });
  await expect(saveProductRefreshProgress(active, { completedKeys: ["source"], retryAfterByKey: {} }, {
    now, result: complete, lease: { name: "product-evidence-refresh", token: "old-owner", requestedVersion: 1 },
  })).rejects.toThrow("job_lease_lost");
  expect(await getProductRefreshRequest(row.slug)).toMatchObject({ completedVersion: 0 });
});

it("does not attach a deleted product's request to the same slug's new generation", async () => {
  const old = await product();
  await queueProductRefresh({ slug: old.slug, productId: old.id, actor: "admin:test", force: true });
  const active = (await beginProductRefresh((await getProductRefreshRequest(old.slug))!, new Date()))!;
  await db.delete(products).where(eq(products.id, old.id));
  const replacement = await product();
  expect(replacement.id).not.toBe(old.id);
  expect(await getProductRefreshRequest(old.slug)).toBeNull();
  await expect(saveProductRefreshProgress(active, { completedKeys: [], retryAfterByKey: {} }, { now: new Date(), result: complete }))
    .rejects.toThrow("product generation changed");
  await expect(queueProductRefresh({ slug: old.slug, productId: old.id, actor: "admin:test", force: true }))
    .rejects.toThrow("product generation changed");
});
