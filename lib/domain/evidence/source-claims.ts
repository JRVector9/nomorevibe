import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { evidenceSourceClaims, evidenceSourceControl } from "@/lib/db/evidence-source-claims-schema";
import { productEvidenceSources, productRefreshRequests } from "@/lib/db/schema";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { assertJobLeaseAtWallTime, type JobLease } from "@/lib/jobs/control";
import { assertJobBatchAdmission, JobBatchBlockedError, lockJobBatch } from "@/lib/jobs/batch-repository";
import { assertRoleLease, type RoleLease } from "@/lib/jobs/role-leader";
import { lockCanonicalContext } from "./source-context";
import { CanonicalSourceBindingSchema, CanonicalSourceLeaseSchema, SourceJobSchema, SourceOwnerSchema, SOURCE_LANES,
  sourceRefreshKey, canonicalSourcePolicyHash, type CanonicalSourceLease, type SourceOwner } from "./source-contract";
import { evidenceSettingsSchema } from "./settings";
import { evidenceSettings } from "@/lib/db/schema";
import { collectCanonicalSite, CanonicalCollectionSchema, type CanonicalCollection } from "./canonical-collection";
import { recomputeRepositoryRelationships } from "./providers/github";
import { upsertObservedSource } from "./repository";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { fetchCapped } from "@/lib/net/fetch";
import { requestEvidenceRefreshJobs } from "./refresh-requests";

function supported() { if (currentReplayDb()) throw new Error("evidence_source_replay_unsupported"); }
const TTL = 90_000;
const lost = () => new Error("evidence_source_lease_lost");
function receipt(row: typeof evidenceSourceClaims.$inferSelect): CanonicalSourceLease {
  return CanonicalSourceLeaseSchema.parse({ binding: row.binding, bindingHash: row.bindingHash,
    owner: { instanceId: row.instanceId, bootId: row.bootId }, token: row.token, epoch: row.epoch,
    controlEpoch: row.controlEpoch, leaseUntil: row.leaseUntil, job: row.job });
}
async function assertOwner(tx: ProductTransaction, lease: CanonicalSourceLease, allowExpired = false) {
  await tx.select({ id: evidenceSourceClaims.productId })
    .from(evidenceSourceClaims).where(eq(evidenceSourceClaims.productId, lease.binding.productId)).for("update");
  const [row] = await tx.select({ row: evidenceSourceClaims, live: sql<boolean>`${evidenceSourceClaims.leaseUntil}>clock_timestamp()`,
    leaseUntilText: sql<string>`${evidenceSourceClaims.leaseUntil}::text` })
    .from(evidenceSourceClaims).where(eq(evidenceSourceClaims.productId, lease.binding.productId));
  if (!row || row.row.token !== lease.token || row.row.instanceId !== lease.owner.instanceId || row.row.bootId !== lease.owner.bootId
    || row.row.epoch !== lease.epoch || row.row.controlEpoch !== lease.controlEpoch || row.row.bindingHash !== lease.bindingHash
    || reviewHash(row.row.binding) !== lease.bindingHash || reviewHash(lease.binding) !== lease.bindingHash
    || reviewHash(row.row.job) !== reviewHash(lease.job) || (!allowExpired && !row.live)) throw lost();
  return row;
}
async function finalAuthority(tx: ProductTransaction, lease: CanonicalSourceLease, lockedExpiry?: string) {
  if (lease.job) await assertJobLeaseAtWallTime(tx, lease.job, "update");
  // The private text is read from the authenticated row after FOR UPDATE, never from a caller Date.
  const [row] = await tx.execute<{ live: boolean }>(lockedExpiry === undefined
    ? sql`select lease_until>clock_timestamp() as live from evidence_source_claims where product_id=${lease.binding.productId}`
    : sql`select ${lockedExpiry}::text::timestamptz>clock_timestamp() as live`);
  if (!row?.live) throw lost();
}
async function clear(tx: ProductTransaction, lease: CanonicalSourceLease, outcome: string, nextAttemptAt: Date) {
  await tx.update(evidenceSourceClaims).set({ token: null, instanceId: null, bootId: null, job: null, leaseUntil: null,
    lastOutcome: outcome, nextAttemptAt, updatedAt: sql`clock_timestamp()` }).where(eq(evidenceSourceClaims.productId, lease.binding.productId));
}

/** SQL hints only; actual source, public state and policy are locked/rechecked at claim. */
async function selectTarget(tx: ProductTransaction, lane: string, policyHash: string, productId?: number) {
  const [row] = await tx.execute<{ id: number }>(sql`with candidates as (
    select p.id,p.created_at,s.next_attempt_at,
      (r.requested_version>r.completed_version and (r.force or r.active_force) and s.last_error_code is null
        and not coalesce(c.last_outcome='ok' and (c.binding->>'requestVersion')::int=r.active_version
          and c.binding->>'sourceUrl'=p.url,false)) as forced,
      s.id as source_id,s.source_url,p.url
    from products p left join product_evidence_sources s on s.slug=p.slug and s.kind='documentation' and s.source_key='canonical_site'
    left join product_refresh_requests r on r.product_id=p.id left join evidence_source_claims c on c.product_id=p.id
    where p.status in ('seeded','verified') and p.access_mode='website'
      and not coalesce(s.source_url=p.url and s.last_error_code is not null and s.next_attempt_at>clock_timestamp(),false)
      and (${productId ?? null}::int is null or p.id=${productId ?? null})
      and (c.token is null or c.lease_until<=clock_timestamp())
      and (c.product_id is null or c.next_attempt_at<=clock_timestamp()
        or (c.last_outcome in ('ok','failed') and s.next_attempt_at<=clock_timestamp()) or c.binding->>'sourceUrl' is distinct from p.url
        or (c.product_id is not null and c.binding->>'policyHash' is distinct from ${policyHash})
        or (r.requested_version>r.completed_version and (r.force or r.active_force) and s.last_error_code is null
          and not coalesce(c.last_outcome='ok' and (c.binding->>'requestVersion')::int=r.active_version
            and c.binding->>'sourceUrl'=p.url,false)))
      and (s.id is null or s.source_url is distinct from p.url or s.next_attempt_at<=clock_timestamp()
        or (c.product_id is not null and c.binding->>'policyHash' is distinct from ${policyHash})
        or (r.requested_version>r.completed_version and (r.force or r.active_force) and s.last_error_code is null
          and not coalesce(c.last_outcome='ok' and (c.binding->>'requestVersion')::int=r.active_version
            and c.binding->>'sourceUrl'=p.url,false)))
  ) select id from candidates where (case when forced then 'admin' when source_id is null or source_url is distinct from url
    or next_attempt_at<clock_timestamp()-interval '24 hours' then 'catchup' else 'normal' end)=${lane}
    order by next_attempt_at asc nulls first,created_at,id limit 1`);
  return row?.id;
}
/** Recheck the hint after all input/claim row locks, using the actual DB wall. */
async function isDue(tx: ProductTransaction, context: NonNullable<Awaited<ReturnType<typeof lockCanonicalContext>>>, old: typeof evidenceSourceClaims.$inferSelect | undefined) {
  const [clock] = await tx.execute<{ retryBlocked: boolean; sourceDue: boolean; claimDue: boolean }>(sql`select
    exists(select 1 from product_evidence_sources s where s.slug=${context.product.slug} and s.kind='documentation' and s.source_key='canonical_site'
      and s.source_url=${context.product.url} and s.last_error_code is not null and s.next_attempt_at>clock_timestamp()) as "retryBlocked",
    exists(select 1 from product_evidence_sources s where s.slug=${context.product.slug} and s.kind='documentation' and s.source_key='canonical_site'
      and s.next_attempt_at<=clock_timestamp()) as "sourceDue",
    exists(select 1 from evidence_source_claims where product_id=${context.product.id} and next_attempt_at<=clock_timestamp()) as "claimDue"`);
  if (clock.retryBlocked) return false;
  const key = sourceRefreshKey(context.binding);
  const force = context.request && context.request.requestedVersion>context.request.completedVersion
    && (context.request.force || context.request.activeForce) && !context.stored?.lastErrorCode
    && !context.request.progress.completedKeys.includes(key);
  const changed = old && (old.binding.sourceUrl!==context.binding.sourceUrl || old.binding.policyHash!==context.binding.policyHash);
  const producerDue = old && ["ok","failed"].includes(old.lastOutcome ?? "") && context.stored && clock.sourceDue;
  if (!force && !changed && !producerDue && old && !clock.claimDue) return false;
  return Boolean(force || changed || !context.stored || context.stored.sourceUrl!==context.product.url || clock.sourceDue);
}
export async function claimCanonicalEvidenceSource(input: { owner: SourceOwner; productId?: number; job?: JobLease; roleLease?: RoleLease }): Promise<CanonicalSourceLease | null> {
  supported(); const owner = SourceOwnerSchema.parse(structuredClone(input.owner));
  const productId = input.productId;
  const job = input.job ? SourceJobSchema.parse({ ...input.job }) : null;
  const roleLease = input.roleLease ? structuredClone(input.roleLease) : undefined;
  if (productId !== undefined && (!Number.isSafeInteger(productId) || productId <= 0)) throw new Error("invalid evidence source target");
  return onPrimary(() => db.transaction(async tx => {
    const batch = await lockJobBatch(tx);
    const site = job?.name === "product-site-evidence-refresh";
    if ((site && (batch.mode !== "versioned" || roleLease?.role !== "site-evidence" || roleLease.batchVersion !== 1))
      || (!site && batch.mode !== "legacy")
      || (roleLease && (owner.instanceId !== roleLease.instanceId || owner.bootId !== roleLease.bootId))) throw new JobBatchBlockedError();
    await assertJobBatchAdmission(tx, job?.name ?? "product-evidence-refresh", roleLease);
    if (roleLease) await assertRoleLease(tx, roleLease);
    const [control] = await tx.select().from(evidenceSourceControl).where(eq(evidenceSourceControl.id, 1)).for("update");
    if (!control?.enabled) return null;
    const [settingsRow] = await tx.select().from(evidenceSettings).where(eq(evidenceSettings.id, 1));
    const policyHash = canonicalSourcePolicyHash(evidenceSettingsSchema.parse(settingsRow?.values ?? {}));
    let id: number | undefined, lane: typeof SOURCE_LANES[number] = "admin";
    for (let offset = 0; offset < SOURCE_LANES.length; offset++) {
      lane = SOURCE_LANES[(control.cursor + offset) % SOURCE_LANES.length];
      id = await selectTarget(tx, lane, policyHash, productId); if (id !== undefined) break;
    }
    if (id === undefined) { if (job) await assertJobLeaseAtWallTime(tx, job); return null; }
    const context = await lockCanonicalContext(tx, id);
    if (!context || context.product.accessMode !== "website" || !["seeded", "verified"].includes(context.product.status)) return null;
    const [old] = await tx.select({ row: evidenceSourceClaims, live: sql<boolean>`${evidenceSourceClaims.leaseUntil}>clock_timestamp()` })
      .from(evidenceSourceClaims).where(eq(evidenceSourceClaims.productId, id)).for("update");
    if (old?.live || (old?.row.epoch ?? 0) >= Number.MAX_SAFE_INTEGER || !(await isDue(tx, context, old?.row))) {
      if (job) await assertJobLeaseAtWallTime(tx, job); return null;
    }
    let { request } = context;
    if (request && request.requestedVersion > request.completedVersion && request.activeVersion === null) {
      [request] = await tx.update(productRefreshRequests).set({ activeVersion: request.requestedVersion, activeForce: request.force,
        progress: { completedKeys: [], retryAfterByKey: {} }, result: {}, startedAt: sql`clock_timestamp()`, lastError: null })
        .where(eq(productRefreshRequests.productId, id)).returning();
    }
    const binding = CanonicalSourceBindingSchema.parse({ ...context.binding, requestVersion: request?.activeVersion ?? null });
    const values = { productId: id, binding, bindingHash: reviewHash(binding), controlEpoch: control.epoch, epoch: (old?.row.epoch ?? 0) + 1,
      instanceId: owner.instanceId, bootId: owner.bootId, token: randomUUID(), job, lane,
      leaseUntil: sql`date_trunc('milliseconds',clock_timestamp())+${TTL}*interval '1 millisecond'`, updatedAt: sql`clock_timestamp()` };
    const [written] = await tx.insert(evidenceSourceClaims).values(values).onConflictDoUpdate({ target: evidenceSourceClaims.productId, set: values }).returning();
    await finalAuthority(tx, receipt(written));
    // Admission already holds this role row; recheck the site role wall after every source/job wait.
    if (roleLease) await assertRoleLease(tx, roleLease);
    return receipt(written);
  }));
}
export async function renewCanonicalEvidenceSource(value: CanonicalSourceLease): Promise<CanonicalSourceLease | null> {
  supported(); const lease = CanonicalSourceLeaseSchema.parse(structuredClone(value));
  return onPrimary(() => db.transaction(async tx => {
    await tx.select().from(evidenceSourceControl).where(eq(evidenceSourceControl.id, 1)).for("share");
    try { await assertOwner(tx, lease); } catch (error) { if (error instanceof Error && error.message === "evidence_source_lease_lost") return null; throw error; }
    const [row] = await tx.update(evidenceSourceClaims).set({ leaseUntil: sql`date_trunc('milliseconds',clock_timestamp())+${TTL}*interval '1 millisecond'`,
      updatedAt: sql`clock_timestamp()` }).where(and(eq(evidenceSourceClaims.productId, lease.binding.productId),
        sql`${evidenceSourceClaims.leaseUntil}>clock_timestamp()`)).returning();
    if (!row) return null;
    await finalAuthority(tx, lease);
    return receipt(row);
  }));
}
export async function abandonCanonicalEvidenceSource(value: CanonicalSourceLease): Promise<void> {
  supported(); const lease = CanonicalSourceLeaseSchema.parse(structuredClone(value));
  await onPrimary(() => db.transaction(async tx => {
    await tx.select().from(evidenceSourceControl).where(eq(evidenceSourceControl.id, 1)).for("share");
    await assertOwner(tx, lease, true);
    await clear(tx, lease, "deferred", new Date(0));
    if (lease.job) await assertJobLeaseAtWallTime(tx, lease.job, "update");
  }));
}
export type CanonicalSourceResult = { state: "recorded" | "failed" | "input_changed" | "incomplete"; factsChanged: number };
export async function recordCanonicalEvidenceSource(value: CanonicalSourceLease, result: CanonicalCollection,
  options: { signal?: AbortSignal } = {}): Promise<CanonicalSourceResult> {
  supported(); const lease = CanonicalSourceLeaseSchema.parse(structuredClone(value));
  result = CanonicalCollectionSchema.parse(structuredClone(result));
  const signal = options.signal;
  const assertNotAborted = () => { if (signal?.aborted) throw signal.reason ?? new DOMException("canonical source cancelled", "AbortError"); };
  assertNotAborted();
  return onPrimary(() => db.transaction(async tx => {
    const [control] = await tx.select().from(evidenceSourceControl).where(eq(evidenceSourceControl.id, 1)).for("update");
    const context = await lockCanonicalContext(tx, lease.binding.productId);
    const owned = await assertOwner(tx, lease);
    const current = context && CanonicalSourceBindingSchema.parse(context.binding);
    if (!control?.enabled || control.epoch !== lease.controlEpoch || !context || context.product.accessMode !== "website" || !["seeded", "verified"].includes(context.product.status)
      || reviewHash(current) !== lease.bindingHash) {
      await clear(tx, lease, "input_changed", new Date(0));
      await finalAuthority(tx, lease, owned.leaseUntilText); assertNotAborted();
      return { state: "input_changed", factsChanged: 0 };
    }
    const [clock] = await tx.execute<{ at: string }>(sql`select clock_timestamp()::text as at`);
    const now = new Date(clock.at), key = sourceRefreshKey(lease.binding);
    let next = new Date(now.getTime() + context.settings.linkCheckHours * 3600000);
    if (result.state === "incomplete") {
      await clear(tx, lease, "incomplete", new Date(now.getTime() + 60000));
      await finalAuthority(tx, lease, owned.leaseUntilText); assertNotAborted();
      return { state: "incomplete", factsChanged: 0 };
    }
    const attempts = result.state === "failed" ? (context.stored?.sourceUrl === lease.binding.sourceUrl ? context.stored.attempts : 0) + 1 : 0;
    if (result.state === "failed") next = new Date(now.getTime() + Math.min(7 * 24, 6 * 2 ** Math.min(attempts - 1, context.settings.maxRetries - 1)) * 3600000);
    await upsertObservedSource({ slug: lease.binding.slug, kind: "documentation", provider: "product_site", sourceKey: "canonical_site",
      sourceUrl: lease.binding.sourceUrl, state: result.state === "ok" ? "ok" : "failed", attempts,
      nextAttemptAt: next, lastErrorCode: result.state === "failed" ? result.reason : null,
      ...(result.state === "ok" ? { normalizedFacts: result.facts, observedAt: now, lastSuccessAt: now,
        etag: result.etag, lastModified: result.lastModified } : { lastFailureAt: now }) }, tx, lease.binding.productId);
    if (result.state === "ok") await recomputeRepositoryRelationships(lease.binding.slug, lease.binding.productId, undefined, { transaction: tx });
    if (context.request && context.request.activeVersion === lease.binding.requestVersion) {
      const progress = structuredClone(context.request.progress);
      if (result.state === "ok") { if (!progress.completedKeys.includes(key)) progress.completedKeys.push(key); delete progress.retryAfterByKey[key]; }
      else progress.retryAfterByKey[key] = next.toISOString();
      await tx.update(productRefreshRequests).set({ progress, updatedAt: now }).where(eq(productRefreshRequests.productId, lease.binding.productId));
    }
    await requestEvidenceRefreshJobs(tx);
    await clear(tx, lease, result.state, next);
    await tx.update(evidenceSourceControl).set({ cursor: (control.cursor + 1) % SOURCE_LANES.length }).where(eq(evidenceSourceControl.id, 1));
    await finalAuthority(tx, lease, owned.leaseUntilText); assertNotAborted();
    return { state: result.state === "ok" ? "recorded" : "failed", factsChanged: result.state === "ok" && reviewHash(context.stored?.normalizedFacts ?? null) !== reviewHash(result.facts) ? 1 : 0 };
  }));
}
export async function executeCanonicalEvidenceSource(input: { owner: SourceOwner; productId?: number; job?: JobLease; roleLease?: RoleLease; signal?: AbortSignal;
  deadlineAt?: number; fetch?: typeof fetchCapped }): Promise<CanonicalSourceResult | { state: "idle"; factsChanged: 0 }> {
  const lease = await claimCanonicalEvidenceSource(input);
  if (!lease) return { state: "idle", factsChanged: 0 };
  try {
    const stored = await db.query.productEvidenceSources.findFirst({ where: and(eq(productEvidenceSources.slug, lease.binding.slug),
      eq(productEvidenceSources.kind, "documentation"), eq(productEvidenceSources.sourceKey, "canonical_site")) });
    const result = await collectCanonicalSite(lease.binding.sourceUrl, stored, input);
    return await recordCanonicalEvidenceSource(lease, result, { signal: input.signal });
  } catch (error) {
    try { await abandonCanonicalEvidenceSource(lease); } catch (cleanup) { throw new AggregateError([error, cleanup], "canonical source failed and cleanup rejected"); }
    throw error;
  }
}
