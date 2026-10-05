import { beforeAll, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, jobs, products } from "@/lib/db/schema";
import { getSettings, resetSettings, saveSettings } from "@/lib/crawl/settings";
import { requeueResolvedCandidates } from "@/lib/crawl/admin-review";
import { pipelineFlow } from "@/lib/operations/pipeline";
import { auditFloor, auditRowsAfter, ensureSchema, resetTables } from "./setup";

beforeAll(ensureSchema);
let floor = 0;
beforeEach(async () => {
  await resetTables();
  for (const table of [crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings, jobs]) {
    await db.delete(table);
  }
  floor = await auditFloor();
});

it.each(["needs_review", "approved"] as const)("does not requeue or count a concurrent admin decision in state %s", async (state) => {
  await saveSettings({ enabled: true, judge: { maxStars: 0 } }, "test");
  const repo = "admin/concurrent";
  await db.insert(crawlDocuments).values({ repo, productUrl: "https://concurrent.example", pageStatus: 200,
    repoMeta: { stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: "User" } },
    pageMeta: { title: "제품" } });
  const [candidate] = await db.insert(crawlCandidates).values({ repo, state: "needs_review", reason: "ambiguous", decidedBy: "auto" }).returning();
  let requeue: ReturnType<typeof requeueResolvedCandidates> | undefined;
  await db.transaction(async tx => {
    await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id)).for("update");
    requeue = requeueResolvedCandidates("requeue-admin");
    let waiting = false;
    const deadline = Date.now() + 5_000;
    while (!waiting && Date.now() < deadline) {
      const rows = await db.execute(sql`select 1 from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock' and query like '%crawl_candidates%'`);
      waiting = rows.length > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await tx.update(crawlCandidates).set({ state, decidedBy: "admin" }).where(eq(crawlCandidates.id, candidate.id));
  });
  expect(await requeue!).toMatchObject({ scanned: 1, requeued: 0, byReason: [] });
  expect(await db.query.crawlCandidates.findFirst({ where: eq(crawlCandidates.id, candidate.id) }))
    .toMatchObject({ state, decidedBy: "admin" });
  expect(await auditRowsAfter(floor, 'requeue-resolved')).toHaveLength(0);
  expect(await db.select().from(jobs)).toHaveLength(0);
});

it("preserves a collection switch changed while a defaults reset waits for its row lock", async () => {
  await saveSettings({ enabled: true, judge: { maxStars: 123 } }, "first-admin");
  let reset: ReturnType<typeof resetSettings> | undefined;
  await db.transaction(async (tx) => {
    const [current] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1)).for("update");
    reset = resetSettings("reset-admin");
    // Wait for the real reset transaction to reach the locked settings row.
    // Both the old read-then-write implementation and an atomic reset reach this boundary.
    let waiting = false;
    const deadline = Date.now() + 5_000;
    while (!waiting && Date.now() < deadline) {
      const rows = await db.execute(sql`
        select 1 from pg_stat_activity
        where datname = current_database() and pid <> pg_backend_pid()
          and wait_event_type = 'Lock' and query like '%crawl_settings%'
      `);
      waiting = rows.length > 0;
      if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
    await tx.update(crawlSettings).set({
      values: { ...(current.values as Record<string, unknown>), enabled: false },
    }).where(eq(crawlSettings.id, 1));
  });
  expect((await reset!)?.ok).toBe(true);
  expect((await getSettings()).enabled).toBe(false);
});

async function product(slug: string, status: "unverified" | "verified" | "seeded", source: "skill" | "crawler") {
  await db.insert(products).values({
    slug, url: `https://${slug}.example`, name: slug, tagline: "소개", description: "설명",
    category: "Dev", status, source, verifyToken: `nmv_verify_${slug}`, editTokenHash: "x".repeat(64),
    verifiedAt: status === "verified" ? new Date() : null,
  });
}

it("does not count manual or unverified registrations as crawler publication throughput", async () => {
  await db.insert(crawlCandidates).values({ repo: "admin/pending", state: "approved", reason: "passed" });
  await product("manual-pending", "unverified", "skill");
  await product("manual-verified", "verified", "skill");

  const flow = await pipelineFlow();
  expect(flow.stages.find(stage => stage.key === "publish")).toMatchObject({ waiting: 1, left: 0 });
  expect(flow.stages.find(stage => stage.key === "public")).toMatchObject({ waiting: 1, entered: 1 });
  expect(flow.bottleneck).toBe("publish");

  await product("crawler-published", "seeded", "crawler");
  const after = await pipelineFlow();
  expect(after.stages.find(stage => stage.key === "publish")?.left).toBe(1);
  expect(after.stages.find(stage => stage.key === "public")?.entered).toBe(2);
  expect(after.bottleneck).toBeNull();
});
