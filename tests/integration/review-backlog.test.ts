import { randomUUID } from "node:crypto";
import { beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ensureSchema } from "./setup";
import { db } from "@/lib/db";
import { crawlCandidates, crawlDocuments, crawlFrontier } from "@/lib/db/schema";
import { readReviewBacklogInTransaction } from "@/lib/crawl/review-backlog";

beforeAll(ensureSchema);
it("counts each unfinished repository once across stages, keeps retries, and releases terminal work", async () => {
  const rollback = new Error("fixture_rollback");
  const prefix = `queue-cap-${randomUUID()}`;
  await expect(db.transaction(async tx => {
    // Read against the same transaction; leave every fixture rolled back.
    const read = () => readReviewBacklogInTransaction(tx, new Date(), Date.now() + 3000);
    const before = await read();
    await tx.insert(crawlCandidates).values([
      { repo: `${prefix}/overlap`, state: "needs_review", decidedBy: "admin" },
      { repo: `${prefix}/completed`, state: "published" },
      { repo: `${prefix}/rejected`, state: "rejected" },
    ]);
    await tx.insert(crawlDocuments).values([
      { repo: `${prefix}/overlap`, repoMeta: {} },
      { repo: `${prefix}/document-only`, repoMeta: {} },
      { repo: `${prefix}/completed`, repoMeta: {} },
      { repo: `${prefix}/rejected`, repoMeta: {} },
    ]);
    await tx.insert(crawlFrontier).values([
      { repo: `${prefix.toUpperCase()}/OVERLAP`, signal: "fixture", state: "fetching" },
      { repo: `${prefix}/delayed-retry`, signal: "fixture", nextAttemptAt: new Date(Date.now() + 86400000) },
      { repo: `${prefix}/alias`, signal: "fixture", aliasOf: `${prefix}/overlap` },
      { repo: `${prefix}/done`, signal: "fixture", state: "done" },
      { repo: `${prefix}/failed`, signal: "fixture", state: "failed" },
    ]);
    const after = await read();
    expect(after.queuedRepositories - before.queuedRepositories).toBe(3);
    expect(after.downstreamRepositories - before.downstreamRepositories).toBe(2);
    await tx.execute(sql`update ${crawlCandidates} set state='published' where repo=${prefix + '/overlap'}`);
    // In-flight collection still holds this repository's place after review ends.
    const collecting = await read();
    expect(collecting.queuedRepositories).toBe(after.queuedRepositories);
    expect(collecting.downstreamRepositories).toBe(after.downstreamRepositories - 1);
    await tx.execute(sql`update ${crawlFrontier} set state='done' where repo=${prefix.toUpperCase() + '/OVERLAP'}`);
    expect((await read()).queuedRepositories).toBe(after.queuedRepositories - 1);
    throw rollback;
  })).rejects.toBe(rollback);
});

it("preserves case-insensitive admission when exact matches and historical case variants coexist", async () => {
  const rollback = new Error("fixture_rollback");
  const prefix = `queue-case-${randomUUID()}`;
  await expect(db.transaction(async tx => {
    const now = new Date();
    const read = () => readReviewBacklogInTransaction(tx, now, Date.now() + 3000);
    const before = await read();
    await tx.insert(crawlCandidates).values([
      { repo: `${prefix}/exact-terminal`, state: "published" },
      { repo: `${prefix}/CASE-terminal`, state: "rejected" },
      { repo: `${prefix}/active`, state: "approved" },
      { repo: `${prefix}/ACTIVE`, state: "rejected" },
    ]);
    await tx.insert(crawlDocuments).values([
      { repo: `${prefix}/exact-terminal`, repoMeta: {} },
      { repo: `${prefix}/case-terminal`, repoMeta: {} },
      { repo: `${prefix}/active`, repoMeta: {} },
      { repo: `${prefix}/orphan`, repoMeta: {} },
      { repo: `${prefix}/ORPHAN`, repoMeta: {} },
    ]);
    await tx.insert(crawlFrontier).values([
      { repo: `${prefix}/ORPHAN`, signal: "fixture", discoveredAt: new Date(now.getTime() - 1000) },
      { repo: `${prefix}/refresh`, signal: "admin-evidence-refresh", discoveredAt: new Date(now.getTime() - 1000) },
      { repo: `${prefix}/alias`, signal: "fixture", aliasOf: `${prefix}/orphan`, discoveredAt: new Date(now.getTime() - 1000) },
      { repo: `${prefix}/future`, signal: "fixture", state: "done", discoveredAt: new Date(now.getTime() + 1000) },
    ]);
    const after = await read();
    expect(after.downstreamRepositories - before.downstreamRepositories).toBe(2);
    expect(after.queuedRepositories - before.queuedRepositories).toBe(3);
    expect(after.recentNew - before.recentNew).toBe(1);
    throw rollback;
  })).rejects.toBe(rollback);
});
