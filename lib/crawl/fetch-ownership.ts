import { and, eq, sql } from "drizzle-orm";
import { crawlFrontier, pipelineItemLeases, type FrontierEntry } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertJobLeaseAtWallTime, JobLeaseLostError, type JobLease } from "@/lib/jobs/control";
import { assertItemLease, readItemStage, releaseItemLease, type ItemStageGuard } from "@/lib/jobs/items/repository";
import { itemBindingHash, itemWorkKey, parseItemBinding, type FetchItemBinding, type ItemLease } from "@/lib/jobs/items/types";

export type FetchItemLease = ItemLease & { stage: "fetch"; binding: FetchItemBinding };
export type FetchClaim = FrontierEntry & { ownership:
  | { kind: "legacy"; stageEpoch: number; job: JobLease }
  | { kind: "item"; lease: FetchItemLease } };

/** The claim identity is the actual frontier attempt, never a caller-selected work key. */
export function fetchClaimPredicate(claim: FetchClaim) {
  return and(eq(crawlFrontier.id, claim.id), eq(crawlFrontier.repo, claim.repo), eq(crawlFrontier.state, "fetching"),
    eq(crawlFrontier.attempts, claim.attempts),
    sql`date_trunc('milliseconds', ${crawlFrontier.nextAttemptAt}) = ${claim.nextAttemptAt.toISOString()}::timestamp`);
}

/** Lock the logical slot even when its binding changed. No domain lock may follow this. */
export async function hasLiveFetchItem(tx: ProductTransaction, frontierId: number): Promise<boolean> {
  const where = and(eq(pipelineItemLeases.stage, "fetch"), eq(pipelineItemLeases.workKey, `fetch:${frontierId}`));
  await tx.select({ workKey: pipelineItemLeases.workKey }).from(pipelineItemLeases).where(where).for("update");
  const [live] = await tx.select({ workKey: pipelineItemLeases.workKey }).from(pipelineItemLeases)
    .where(and(where, sql`${pipelineItemLeases.token} IS NOT NULL AND ${pipelineItemLeases.leaseUntil} > clock_timestamp()`));
  return Boolean(live);
}

/** Job expiry is checked after waiting for the job row, using wall time. */
export async function assertFetchJob(tx: ProductTransaction, job: JobLease): Promise<void> {
  if (job.name !== "crawl-fetch") throw new JobLeaseLostError();
  await assertJobLeaseAtWallTime(tx, job);
}

/** Stage SHARE precedes domain; item proof follows domain; job proof is last. */
export async function assertFetchOwnership(tx: ProductTransaction, guard: ItemStageGuard, claim: FetchClaim): Promise<void> {
  const state = await readItemStage(tx, guard);
  if (state.stage !== "fetch") throw new Error("invalid_fetch_stage_guard");
  if (claim.ownership.kind === "legacy") {
    if (state.epoch !== claim.ownership.stageEpoch || !(state.mode === "legacy"
      || state.mode === "draining" && state.drainingFrom === "legacy")) throw new Error("fetch_stage_ownership_lost");
    if (claim.ownership.job.name !== "crawl-fetch" || await hasLiveFetchItem(tx, claim.id)) throw new Error("fetch_ownership_lost");
    return;
  }
  const lease = claim.ownership.lease;
  const binding = parseItemBinding(lease.binding);
  if (binding.stage !== "fetch" || lease.stage !== "fetch" || binding.frontierId !== claim.id || binding.repo !== claim.repo
    || binding.claim.attempts !== claim.attempts || binding.claim.nextAttemptAt !== claim.nextAttemptAt.toISOString()
    || itemWorkKey(binding) !== lease.workKey || itemBindingHash(binding) !== lease.bindingHash) throw new Error("invalid_fetch_claim");
  await assertItemLease(tx, guard, lease);
}

/** Called only once external work has settled; expiry alone is never a drain proof. */
export async function finishFetchOwnership(tx: ProductTransaction, guard: ItemStageGuard, claim: FetchClaim): Promise<void> {
  if (claim.ownership.kind === "item") await releaseItemLease(tx, guard, claim.ownership.lease);
  else await assertFetchJob(tx, claim.ownership.job);
}
