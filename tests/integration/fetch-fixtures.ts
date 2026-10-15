import { randomUUID } from "node:crypto";
import { ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlFrontier, jobs } from "@/lib/db/schema";
import type { JobLease } from "@/lib/jobs/control";
import { lockItemStage } from "@/lib/jobs/items/repository";
import { dequeue } from "@/lib/crawl/repository";

/** Repository fixtures install an actual healthy job row, then obtain domain
 * receipts through dequeue. Handler behavior tests use runJob instead. A fresh
 * fixture claim deliberately replaces this file's preceding test owner. */
export async function claimFetchFixtureJob(): Promise<JobLease> {
  const token = randomUUID();
  const [row] = await db.insert(jobs).values({ name: "crawl-fetch", leaseToken: token,
    requestedVersion: 1, lockedAt: sql`clock_timestamp()`, lastRunAt: sql`clock_timestamp()` })
    .onConflictDoUpdate({ target: jobs.name, set: { leaseToken: token,
      requestedVersion: sql`greatest(${jobs.requestedVersion}, ${jobs.processedVersion}) + 1`,
      lockedAt: sql`clock_timestamp()`, lastRunAt: sql`clock_timestamp()` } })
    .returning({ requestedVersion: jobs.requestedVersion });
  return { name: "crawl-fetch", token, requestedVersion: row.requestedVersion };
}

/** Keep unrelated fixture rows locked out of this repository's SKIP LOCKED
 * selection without deleting or changing them. The actual target is claimed by
 * dequeue, including its stage/job checks and normal frontier CAS. */
export async function dequeueFetchFixture(repo: string, lease: JobLease) {
  return db.transaction(async tx => {
    await lockItemStage(tx, "fetch");
    await tx.select({ id: crawlFrontier.id }).from(crawlFrontier)
      .where(ne(crawlFrontier.repo, repo)).for("update");
    const [claim] = await dequeue(1, undefined, lease);
    if (!claim || claim.repo !== repo) throw new Error("fetch_fixture_claim_missing");
    return claim;
  });
}
