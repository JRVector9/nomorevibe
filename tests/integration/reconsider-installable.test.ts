import { beforeAll, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, operationsAudit } from "@/lib/db/schema";
import { ensureSchema, resetTables } from "./setup";
import { judgementQueue } from "@/lib/crawl/repository";
import { planReconsideration, applyReconsideration } from "@/lib/crawl/reconsider";

beforeAll(ensureSchema);
beforeEach(async () => {
  await resetTables();
  await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlFrontier); await db.delete(crawlSettings);
});
async function rejected(repo: string, decidedBy: "auto" | "admin" = "auto", stars = 500) {
  await db.insert(crawlDocuments).values({ repo, productUrl: null, repoMeta: { stargazers_count: stars, description: "An editor plugin" }, fetchedAt: new Date(Date.now() - 60000) });
  await db.insert(crawlCandidates).values({ repo, state: "rejected", reason: "no_homepage", decidedBy });
}
it("dry run preserves data; apply audits and waits for fresh source before rejudging", async () => {
  await rejected("maker/plugin"); await rejected("maker/manual", "admin"); await rejected("maker/small", "auto", 499);
  const plan = await planReconsideration();
  expect(plan.entries.map(row => row.repo)).toEqual(["maker/plugin"]);
  expect((await db.select().from(crawlCandidates)).every(row => row.state === "rejected")).toBe(true);
  const result = await applyReconsideration(plan, "test-policy-change");
  expect(result.queued).toEqual(["maker/plugin"]);
  expect(await judgementQueue(10)).toHaveLength(0);
  expect(await db.select().from(crawlFrontier)).toMatchObject([{ repo: "maker/plugin", state: "pending" }]);
  await db.update(crawlDocuments).set({ fetchedAt: new Date() }).where(eq(crawlDocuments.repo, "maker/plugin"));
  expect((await judgementQueue(10)).map(row => row.document.repo)).toEqual(["maker/plugin"]);
  expect(await db.select().from(operationsAudit).where(eq(operationsAudit.action, "reconsider-installable"))).not.toHaveLength(0);
  expect((await applyReconsideration(plan, "test-policy-change")).queued).toEqual([]);
});
it("preserves a decision or source changed after the dry run", async () => {
  await rejected("maker/changed");
  const plan = await planReconsideration();
  await db.update(crawlCandidates).set({ decidedBy: "admin" }).where(eq(crawlCandidates.repo, "maker/changed"));
  expect((await applyReconsideration(plan, "test-policy-change")).queued).toEqual([]);
  expect((await db.select().from(crawlCandidates))[0].decidedBy).toBe("admin");
});
it("does not mistake PostgreSQL microseconds for a fresh collection", async () => {
  await rejected("maker/precision");
  await db.update(crawlDocuments).set({ fetchedAt: sql`'2026-09-20 00:00:00.123456'::timestamp` }).where(eq(crawlDocuments.repo, "maker/precision"));
  await applyReconsideration(await planReconsideration(), "test-policy-change");
  expect(await judgementQueue(10)).toHaveLength(0);
});
