import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { productHealth, products } from "@/lib/db/schema";
import { uptimeControl, uptimeGates, uptimeObservations } from "@/lib/db/product-uptime-schema";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { assertJobLeaseAtWallTime, requestJob, type JobLease } from "@/lib/jobs/control";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { serviceInstanceId } from "@/lib/operations/instance";
import { lockProductGeneration } from "./generation";
import { writeHealthResult } from "./health-record";
import { assessUptimeObservation, UptimeObservationSchema, UptimeSourcesSchema, UPTIME_EVIDENCE_MS,
  UPTIME_POLICY_VERSION, UPTIME_SLOT_MS, type UptimeSource } from "./uptime-policy";

export async function uptimeObservationMode() {
  const [row] = await db.select().from(uptimeControl).where(eq(uptimeControl.id, 1));
  return { observationsEnabled: row?.observationsEnabled ?? false, gateEnabled: row?.gateEnabled ?? false,
    revision: row?.revision ?? 1, sources: UptimeSourcesSchema.parse(row?.sources ?? []) };
}

export function uptimeObserverSource(sources: UptimeSource[]): UptimeSource {
  const instanceId = serviceInstanceId();
  const source = sources.find(value => value.instanceId === instanceId);
  if (!source) throw new Error("uptime_source_unconfigured");
  return structuredClone(source);
}

export async function nextUptimeObservationTargets(limit: number, source: UptimeSource) {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > 200) throw new Error("invalid uptime batch");
  return db.select({ id: products.id, slug: products.slug, url: products.url }).from(products)
    .where(and(inArray(products.status, ["verified", "seeded"]), eq(products.accessMode, "website"),
      sql`not exists (select 1 from uptime_observations o where o.product_id=${products.id}
        and o.url=${products.url} and o.host=${source.host}
        and (o.slot=to_timestamp(floor(extract(epoch from clock_timestamp())/21600)*21600)
          or o.observed_at > clock_timestamp()-interval '6 hours'))`))
    .orderBy(sql`(select max(o.observed_at) from uptime_observations o
      where o.product_id=${products.id} and o.url=${products.url} and o.host=${source.host}) asc nulls first`, asc(products.id)).limit(limit);
}

export type UptimeObservationResult = { state: "disabled" | "duplicate" | "raw_only" | "applied" | "observation_hold" | "stale"; reason?: string };

/** Raw facts and authoritative writes share one transaction. This is not remote host attestation. */
export async function recordUptimeObservation(value: unknown, controls: { lease: JobLease; signal?: AbortSignal }): Promise<UptimeObservationResult> {
  if (currentReplayDb()) throw new Error("uptime_replay_unsupported");
  const observation = UptimeObservationSchema.parse(structuredClone(value));
  if (!controls?.lease || controls.lease.name !== "uptime-ping" || typeof controls.lease.token !== "string" || !controls.lease.token) {
    throw new Error("uptime_job_required");
  }
  const lease = { ...controls.lease };
  const payloadHash = reviewHash({ ...observation, slot: observation.slot.toISOString(),
    startedAt: observation.startedAt.toISOString(), observedAt: observation.observedAt.toISOString() });
  const urlHash = reviewHash(observation.url);
  return onPrimary(() => db.transaction(async tx => {
    const [control] = await tx.select().from(uptimeControl).where(eq(uptimeControl.id, 1)).for("share");
    if (!control?.observationsEnabled) return { state: "disabled" };
    const sources = UptimeSourcesSchema.parse(control.sources);
    if (!sources.some(source => source.host === observation.source.host && source.instanceId === observation.source.instanceId
      && source.region === observation.source.region)) throw new Error("uptime_source_unconfigured");
    const present = await lockProductGeneration(tx, observation.productId, observation.slug);
    const [current] = present ? await tx.select({ url: products.url, status: products.status,
      accessMode: products.accessMode, updatedAt: sql<string>`${products.updatedAt}::text`,
      unchanged: sql<boolean>`${products.updatedAt} <= ${observation.startedAt.toISOString()}::timestamp`,
    }).from(products).where(eq(products.id, observation.productId)) : [];
    const [health] = await tx.select().from(productHealth).where(eq(productHealth.slug, observation.slug)).for("update");
    const [previous] = await tx.select().from(uptimeGates).where(eq(uptimeGates.productId, observation.productId)).for("update");
    const [byId] = await tx.select().from(uptimeObservations).where(eq(uptimeObservations.observationId, observation.observationId));
    if (byId) {
      if (byId.payloadHash !== payloadHash) throw new Error("uptime_observation_identity_mismatch");
      await assertJobLeaseAtWallTime(tx, lease);
      return { state: "duplicate" };
    }
    const [slot] = await tx.select().from(uptimeObservations).where(and(eq(uptimeObservations.productId, observation.productId),
      eq(uptimeObservations.urlHash, urlHash), eq(uptimeObservations.host, observation.source.host), eq(uptimeObservations.slot, observation.slot)));
    if (slot) { await assertJobLeaseAtWallTime(tx, lease); return { state: "duplicate" }; }
    const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
    const wall = new Date(clock.now);
    let reason: string | undefined;
    let state: UptimeObservationResult["state"] = "applied";
    if (!current || current.url !== observation.url || !current.unchanged || current.accessMode !== "website"
      || !["verified", "seeded"].includes(current.status)) { state = "stale"; reason = "product_changed"; }
    else if (observation.observedAt > wall) { state = "stale"; reason = "future_observation"; }
    else if ((previous && previous.lastObservedAt >= observation.observedAt)
      || (health && health.checkedAt >= observation.observedAt)) { state = "stale"; reason = "older_observation"; }
    else if (health && observation.observedAt.getTime() - health.checkedAt.getTime() < UPTIME_SLOT_MS) {
      state = "observation_hold"; reason = "minimum_interval";
    } else if (!control.gateEnabled && observation.source.host === "oracle-osaka-smoke") {
      state = "raw_only"; reason = "oracle_comparison";
    } else if (control.gateEnabled) {
      const rows = await tx.select().from(uptimeObservations).where(and(eq(uptimeObservations.revision, control.revision),
        gte(uptimeObservations.observedAt, new Date(observation.observedAt.getTime() - UPTIME_EVIDENCE_MS))));
      const facts = rows.filter(row => row.disposition !== "stale" && sources.some(source => source.host === row.host
        && source.instanceId === row.instanceId && source.region === row.region));
      reason = assessUptimeObservation(observation, facts) ?? undefined;
      if (reason) state = "observation_hold";
    }
    await tx.insert(uptimeObservations).values({ ...observation, host: observation.source.host,
      instanceId: observation.source.instanceId, region: observation.source.region, urlHash, payloadHash,
      disposition: state as "applied" | "raw_only" | "stale" | "observation_hold", reason, revision: control.revision });
    if (state !== "stale") {
      const certified = previous?.policyVersion === UPTIME_POLICY_VERSION && previous.revision === control.revision
        && previous.url === observation.url && previous.productUpdatedAt === current!.updatedAt
        && previous.healthCheckedAt?.getTime() === health?.checkedAt.getTime()
        && previous.failures === health?.failures && previous.status === health?.status;
      if (state === "applied") {
        await writeHealthResult(tx, { slug: observation.slug, status: observation.status, latencyMs: observation.latencyMs,
          observedAt: observation.observedAt, resetStreak: control.gateEnabled ? !certified : !health?.downSince });
      }
      const [written] = await tx.select().from(productHealth).where(eq(productHealth.slug, observation.slug));
      const gate = { productId: observation.productId, url: observation.url, productUpdatedAt: current!.updatedAt,
        revision: control.revision, policyVersion: state === "applied" ? (control.gateEnabled ? UPTIME_POLICY_VERSION : null) : previous?.policyVersion ?? null,
        state: state === "applied" ? "admitted" as const : "observation_hold" as const,
        reason: reason ?? null, lastObservationId: observation.observationId, lastObservedAt: observation.observedAt,
        appliedObservationId: state === "applied" ? observation.observationId : previous?.appliedObservationId ?? null,
        healthCheckedAt: written?.checkedAt ?? null, failures: written?.failures ?? 0, status: written?.status ?? null,
        nextCheckAt: new Date(observation.observedAt.getTime() + UPTIME_SLOT_MS),
        recheckRequestedAt: state === "observation_hold" ? wall : null };
      await tx.insert(uptimeGates).values(gate).onConflictDoUpdate({ target: uptimeGates.productId, set: gate });
    }
    if (controls.signal?.aborted) throw new DOMException("uptime cancelled", "AbortError");
    // Same-job UPDATE precedes requestJob, avoiding SHARE->UPDATE lock upgrades.
    await assertJobLeaseAtWallTime(tx, lease, "update");
    if (state === "observation_hold") await requestJob("uptime-ping", tx);
    await assertJobLeaseAtWallTime(tx, lease, "update");
    if (controls.signal?.aborted) throw new DOMException("uptime cancelled", "AbortError");
    return { state, ...(reason ? { reason } : {}) };
  }));
}

/** PR13 can read held facts/age separately from authoritative checkedAt and due backlog. */
export async function uptimeObservationSummary() {
  const [row] = await db.execute(sql`select count(*) filter (where state='observation_hold')::int as held,
    min(last_observed_at) filter (where state='observation_hold') as oldest,
    count(*) filter (where next_check_at<=clock_timestamp())::int as due from uptime_gates`);
  return row;
}
