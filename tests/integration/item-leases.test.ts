import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { db } from "@/lib/db";
import { crawlFrontier, jobs, roleLeases } from "@/lib/db/schema";
import { requestJob } from "@/lib/jobs/control";
import { tryAcquireRole } from "@/lib/jobs/role-leader";
import { assertItemLease, beginStageDrain, claimItemLease, completeStageTransition,
  lockItemStage, releaseItemLease, renewItemLease } from "@/lib/jobs/items/repository";
import type { FetchItemBinding, ItemLease, ItemOwner } from "@/lib/jobs/items/types";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// These fixtures exercise the inactive ownership repository. Actual frontier/input/
// human-decision validation remains the PR03/04 domain adapters' responsibility.
const clientOptions = { max: 1, connect_timeout: 3, onnotice: () => {},
  connection: { statement_timeout: 8_000, lock_timeout: 6_000 } };
const a = postgres(TEST_DATABASE_URL, { ...clientOptions, connection: {
  ...clientOptions.connection, application_name: "pr02-items-independent-a" } });
const b = postgres(TEST_DATABASE_URL, { ...clientOptions, connection: {
  ...clientOptions.connection, application_name: "pr02-items-independent-b" } });
const observer = postgres(TEST_DATABASE_URL, { ...clientOptions, connection: {
  ...clientOptions.connection, application_name: "pr02-items-independent-observer" } });
const first = drizzle(a, { schema });
const second = drizzle(b, { schema });
type Tx = Parameters<Parameters<typeof first.transaction>[0]>[0];
const owner: ItemOwner = { instanceId: "independent-a", bootId: "00000000-0000-4000-8000-000000000001" };
const foreign: ItemOwner = { instanceId: "independent-b", bootId: "00000000-0000-4000-8000-000000000002" };
const unrelatedJob = { name: "pr02-items-independent-unrelated", requestedVersion: 13, processedVersion: 5,
  cursor: { marker: "pr02-items-independent-unrelated", page: 71 }, notBefore: new Date("2101-01-01T00:00:00.000Z") };

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 3_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`bounded wait: ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function until(predicate: () => Promise<boolean>, label: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`database predicate not reached: ${label}`);
}

async function waitForLock(pid: number) {
  await until(async () => {
    const [row] = await observer`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${pid}`;
    return row?.wait_event_type === "Lock";
  }, `backend ${pid} actual lock wait`);
}

async function integrated() {
  // Only the isolated test database owner grants the future integrated contract.
  await observer`UPDATE pipeline_stage_modes SET writer_contract_version = 1,
    mode = 'items', draining_from = NULL WHERE stage = 'fetch'`;
}

let sequence = 0;
async function frontier(): Promise<FetchItemBinding> {
  const [row] = await first.insert(crawlFrontier).values({
    repo: `independent/item-${++sequence}`, signal: "pr02-integration", state: "fetching", attempts: 1,
  }).returning();
  return { stage: "fetch", frontierId: row.id, repo: row.repo,
    claim: { attempts: row.attempts, nextAttemptAt: row.nextAttemptAt.toISOString() } };
}

async function claim(binding: FetchItemBinding, claimedBy = owner, ttlMs = 60_000) {
  return first.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "fetch"), binding, claimedBy, ttlMs));
}

async function requireClaim(binding: FetchItemBinding, ttlMs = 60_000): Promise<ItemLease> {
  const lease = await claim(binding, owner, ttlMs);
  expect(lease).not.toBeNull();
  return lease!;
}

async function lockDomain(tx: Tx, binding: FetchItemBinding) {
  const rows = await tx.select().from(crawlFrontier).where(eq(crawlFrontier.id, binding.frontierId)).for("update");
  expect(rows).toHaveLength(1);
}

let migrated = false;
async function cleanup() {
  await observer`DROP TRIGGER IF EXISTS pr02_item_handoff_failure ON jobs`;
  await observer`DROP FUNCTION IF EXISTS pr02_item_handoff_failure()`;
  await observer`DELETE FROM pipeline_item_leases WHERE stage = 'fetch' AND binding->>'repo' LIKE 'independent/item-%'`;
  await observer`DELETE FROM crawl_frontier WHERE signal = 'pr02-integration'`;
  await observer`DELETE FROM jobs WHERE name IN ('crawl-fetch', 'crawl-agent-review')`;
  await observer`DELETE FROM role_leases WHERE role = 'crawler'`;
  await observer`UPDATE pipeline_stage_modes SET mode = 'legacy', draining_from = NULL,
    epoch = 1, writer_contract_version = 0, updated_at = clock_timestamp()`;
}
beforeAll(async () => {
  ensureSchema(); migrated = true;
  // Keep an unrelated row across every cleanup so assertions cannot rely on
  // this file being first in the integration suite or on jobs being empty.
  await first.insert(jobs).values(unrelatedJob);
});
beforeEach(cleanup);
afterEach(async () => {
  expect(await first.select().from(jobs).where(eq(jobs.name, unrelatedJob.name)))
    .toMatchObject([unrelatedJob]);
});
afterAll(async () => {
  try { if (migrated) await cleanup(); }
  finally {
    try { if (migrated) await first.delete(jobs).where(eq(jobs.name, unrelatedJob.name)); }
    finally { await Promise.all([a.end({ timeout: 3 }), b.end({ timeout: 3 }), observer.end({ timeout: 3 })]); }
  }
});

describe("inactive item ownership on independent database connections", () => {
  it("preserves legacy schema defaults and refuses claim and activation with contract zero", async () => {
    // Inspect DDL independently of cleanup's fixture values. Root also checks
    // the initial seeded rows on a fresh database before any fixture reset.
    const defaults = await observer`SELECT column_name, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pipeline_stage_modes'
        AND column_name IN ('mode', 'epoch', 'writer_contract_version')`;
    expect(Object.fromEntries(defaults.map(row => [row.column_name, row.column_default]))).toEqual({
      mode: "'legacy'::character varying", epoch: "1", writer_contract_version: "0",
    });
    const stages = await observer`SELECT stage, mode, draining_from, epoch, writer_contract_version
      FROM pipeline_stage_modes ORDER BY stage`;
    expect(stages.map(row => ({ ...row, epoch: Number(row.epoch) }))).toEqual([
      { stage: "ai1", mode: "legacy", draining_from: null, epoch: 1, writer_contract_version: 0 },
      { stage: "ai2", mode: "legacy", draining_from: null, epoch: 1, writer_contract_version: 0 },
      { stage: "fetch", mode: "legacy", draining_from: null, epoch: 1, writer_contract_version: 0 },
    ]);
    const input = await frontier();
    expect(await claim(input)).toBeNull();
    await expect(first.transaction(tx => beginStageDrain(tx, "fetch"))).rejects.toThrow();
    await expect(first.transaction(tx => completeStageTransition(tx, "fetch", "items"))).rejects.toThrow();
    expect(await observer`SELECT * FROM pipeline_item_leases`).toHaveLength(0);
    expect((await observer`SELECT mode, writer_contract_version FROM pipeline_stage_modes WHERE stage = 'fetch'`)[0])
      .toEqual({ mode: "legacy", writer_contract_version: 0 });
  });

  it("gives two connections one winner without waiting for an uncommitted first INSERT", async () => {
    await integrated();
    const input = await frontier();
    const admitted = barrier(); const finish = barrier();
    let original: ItemLease | null = null;
    const running = first.transaction(async tx => {
      original = await claimItemLease(tx, await lockItemStage(tx, "fetch"), input, owner, 60_000);
      admitted.resolve(); await finish.promise;
    });
    try {
      await bounded(admitted.promise, "first claim");
      expect(original).not.toBeNull();
      const rival = second.transaction(async tx => claimItemLease(tx,
        await lockItemStage(tx, "fetch"), input, foreign, 60_000));
      expect(await bounded(rival, "uncommitted unique INSERT must skip")).toBeNull();
    } finally { finish.resolve(); await running; }
    const rows = await observer`SELECT token, owner_instance_id, owner_boot_id, item_epoch FROM pipeline_item_leases`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ token: original!.token, owner_instance_id: owner.instanceId, owner_boot_id: owner.bootId });
    expect(Number(rows[0].item_epoch)).toBe(1);
  });

  it("rejects a stage guard when its original transaction has already committed", async () => {
    await integrated();
    const input = await frontier();
    let expiredTx!: Tx;
    let expiredGuard!: Awaited<ReturnType<typeof lockItemStage>>;
    await first.transaction(async tx => {
      expiredTx = tx;
      expiredGuard = await lockItemStage(tx, "fetch");
    });
    await expect(claimItemLease(expiredTx, expiredGuard, input, owner, 60_000)).rejects.toThrow("invalid_item_stage_guard");
    expect(await observer`SELECT * FROM pipeline_item_leases`).toHaveLength(0);
    await expect(lockItemStage(expiredTx, "fetch")).rejects.toThrow("item_stage_transaction_required");
    expect(await observer`SELECT * FROM pipeline_item_leases`).toHaveLength(0);
  });

  it("skips a locked existing item and can acquire the next stable work identity", async () => {
    await integrated();
    const head = await frontier(); const next = await frontier();
    await requireClaim(head);
    await observer`UPDATE pipeline_item_leases SET lease_until = clock_timestamp() - interval '1 second'`;
    const locked = barrier(); const finish = barrier();
    const holding = first.transaction(async tx => {
      await lockItemStage(tx, "fetch");
      await tx.execute(sql`SELECT 1 FROM pipeline_item_leases WHERE stage = 'fetch'
        AND work_key = ${`fetch:${head.frontierId}`} FOR UPDATE`);
      locked.resolve(); await finish.promise;
    });
    try {
      await bounded(locked.promise, "head row lock");
      const skipped = second.transaction(async tx => claimItemLease(tx,
        await lockItemStage(tx, "fetch"), head, foreign, 60_000));
      expect(await bounded(skipped, "locked head must skip")).toBeNull();
      const acquired = await second.transaction(async tx => claimItemLease(tx,
        await lockItemStage(tx, "fetch"), next, foreign, 60_000));
      expect(acquired).toMatchObject({ workKey: `fetch:${next.frontierId}`, owner: foreign, itemEpoch: 1 });
    } finally { finish.resolve(); await holding; }
  });

  it("preserves a healthy foreign boot across changed binding and actual role/job takeover", async () => {
    await integrated();
    const input = await frontier(); const lease = await requireClaim(input);
    const primary = { role: "crawler" as const, instanceId: "role-a", bootId: "role-boot-a", release: "pr02", kind: "primary" as const };
    expect(await tryAcquireRole(primary)).not.toBeNull();
    await db.insert(jobs).values({ name: "crawl-fetch", leaseToken: "legacy-job-token", lockedAt: sql`clock_timestamp()`,
      requestedVersion: 7, processedVersion: 3, cursor: { page: 19 }, notBefore: new Date("2100-01-01T00:00:00.000Z") });
    await db.update(roleLeases).set({ leaseUntil: sql`clock_timestamp() - interval '1 second'` }).where(eq(roleLeases.role, "crawler"));
    expect(await tryAcquireRole({ ...primary, bootId: "role-boot-b" })).toMatchObject({ epoch: 2 });
    expect((await db.select().from(jobs).where(eq(jobs.name, "crawl-fetch")))[0]).toMatchObject({ leaseToken: null, lockedAt: null,
      requestedVersion: 7, processedVersion: 3, cursor: { page: 19 }, notBefore: new Date("2100-01-01T00:00:00.000Z") });
    const changed = { ...input, claim: { ...input.claim, attempts: input.claim.attempts + 1 } };
    expect(await claim(changed, foreign)).toBeNull();
    expect(await claim(input, { ...owner, bootId: foreign.bootId })).toBeNull();
    await first.transaction(async tx => assertItemLease(tx, await lockItemStage(tx, "fetch"), lease));
    expect((await observer`SELECT token, owner_boot_id FROM pipeline_item_leases`)[0])
      .toEqual({ token: lease.token, owner_boot_id: owner.bootId });
  });

  it("renews the actual lease while accepting the original in-flight lease object", async () => {
    await integrated();
    const input = await frontier(); const original = await requireClaim(input, 5_000);
    const renewed = await first.transaction(async tx => renewItemLease(tx, await lockItemStage(tx, "fetch"), original, 60_000));
    expect(renewed).not.toBeNull();
    expect(renewed!.leaseUntil.getTime()).toBeGreaterThan(original.leaseUntil.getTime());
    expect(renewed).toMatchObject({ token: original.token, itemEpoch: original.itemEpoch, stageEpoch: original.stageEpoch });
    await first.transaction(async tx => {
      const guard = await lockItemStage(tx, "fetch");
      await assertItemLease(tx, guard, original);
      await releaseItemLease(tx, guard, original);
    });
    expect((await observer`SELECT token, owner_instance_id, lease_until FROM pipeline_item_leases`)[0])
      .toEqual({ token: null, owner_instance_id: null, lease_until: null });
  });

  it.each(["result", "failure", "handoff"] as const)("rejects an expired old owner's %s with domain and outbox rollback", async kind => {
    await integrated();
    const input = await frontier(); const old = await requireClaim(input);
    await observer`UPDATE pipeline_item_leases SET lease_until = clock_timestamp() - interval '1 second'`;
    const current = await claim(input, foreign);
    expect(current).not.toBeNull();
    expect(current!.token).not.toBe(old.token);
    expect(current!.itemEpoch).toBe(old.itemEpoch + 1);
    expect(await first.transaction(async tx => renewItemLease(tx, await lockItemStage(tx, "fetch"), old, 60_000))).toBeNull();
    await expect(first.transaction(async tx => {
      const guard = await lockItemStage(tx, "fetch");
      await lockDomain(tx, input);
      // Preserve stage -> domain -> item -> jobs even when a caller checks the
      // stale result at the transaction's end to obtain atomic rollback.
      await tx.execute(sql`SELECT 1 FROM pipeline_item_leases WHERE stage = 'fetch'
        AND work_key = ${old.workKey} FOR UPDATE`);
      await tx.update(crawlFrontier).set({ state: kind === "failure" ? "failed" : "done", lastError: `stale-${kind}` })
        .where(eq(crawlFrontier.id, input.frontierId));
      await requestJob("crawl-agent-review", tx);
      if (kind === "handoff") await releaseItemLease(tx, guard, old);
      else await assertItemLease(tx, guard, old);
    })).rejects.toThrow("item_lease_lost");
    expect((await first.select().from(crawlFrontier).where(eq(crawlFrontier.id, input.frontierId)))[0])
      .toMatchObject({ state: "fetching", lastError: null });
    expect(await first.select().from(jobs).where(eq(jobs.name, "crawl-agent-review"))).toHaveLength(0);
    expect((await observer`SELECT token, owner_boot_id FROM pipeline_item_leases`)[0])
      .toEqual({ token: current!.token, owner_boot_id: foreign.bootId });
  });

  it("orders an admitted claim before drain and preserves its epoch and running owner", async () => {
    await integrated();
    const input = await frontier(); const admitted = barrier(); const finish = barrier();
    let lease: ItemLease | null = null;
    const running = first.transaction(async tx => {
      lease = await claimItemLease(tx, await lockItemStage(tx, "fetch"), input, owner, 60_000);
      admitted.resolve(); await finish.promise;
    });
    void running.catch(() => {});
    let drainPid = 0; const started = barrier();
    let draining: Promise<Awaited<ReturnType<typeof beginStageDrain>>> | undefined;
    try {
      await bounded(admitted.promise, "claim before drain");
      draining = second.transaction(async tx => {
        [ { pid: drainPid } ] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        started.resolve(); return beginStageDrain(tx, "fetch");
      });
      void draining.catch(() => {});
      await bounded(started.promise, "drain transaction started");
      await waitForLock(drainPid);
    } finally { finish.resolve(); await Promise.allSettled([running, ...(draining ? [draining] : [])]); }
    await running;
    expect(await draining!).toMatchObject({ mode: "draining", drainingFrom: "items", epoch: lease!.stageEpoch });
    expect(await claim(input, foreign)).toBeNull();
    await first.transaction(async tx => assertItemLease(tx, await lockItemStage(tx, "fetch"), lease!));
    await expect(first.transaction(tx => completeStageTransition(tx, "fetch", "legacy"))).rejects.toThrow();
    expect(Number((await observer`SELECT epoch FROM pipeline_stage_modes WHERE stage = 'fetch'`)[0].epoch)).toBe(lease!.stageEpoch);
  });

  it("orders drain before a waiting claim and rechecks the committed mode after the stage lock", async () => {
    await integrated();
    const input = await frontier(); const drained = barrier(); const finish = barrier();
    const draining = first.transaction(async tx => {
      await beginStageDrain(tx, "fetch"); drained.resolve(); await finish.promise;
    });
    void draining.catch(() => {});
    let claimPid = 0; const started = barrier();
    let claiming: Promise<ItemLease | null> | undefined;
    try {
      await bounded(drained.promise, "drain stage update lock");
      claiming = second.transaction(async tx => {
        [ { pid: claimPid } ] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        started.resolve();
        return claimItemLease(tx, await lockItemStage(tx, "fetch"), input, foreign, 60_000);
      });
      void claiming.catch(() => {});
      await bounded(started.promise, "claim transaction started");
      await waitForLock(claimPid);
    } finally { finish.resolve(); await Promise.allSettled([draining, ...(claiming ? [claiming] : [])]); }
    await draining;
    expect(await claiming!).toBeNull();
    expect(await observer`SELECT * FROM pipeline_item_leases`).toHaveLength(0);
  });

  it("allows existing drain renew/release and advances the stage epoch only after live work ends", async () => {
    await integrated();
    const input = await frontier(); const old = await requireClaim(input);
    await first.transaction(tx => beginStageDrain(tx, "fetch"));
    expect(await first.transaction(async tx => renewItemLease(tx, await lockItemStage(tx, "fetch"), old, 60_000))).not.toBeNull();
    await expect(first.transaction(tx => completeStageTransition(tx, "fetch", "legacy"))).rejects.toThrow();
    await first.transaction(async tx => releaseItemLease(tx, await lockItemStage(tx, "fetch"), old));
    expect(await first.transaction(tx => completeStageTransition(tx, "fetch", "legacy")))
      .toMatchObject({ mode: "legacy", drainingFrom: null, epoch: old.stageEpoch + 1 });
    expect(await claim(input)).toBeNull();
    await first.transaction(tx => beginStageDrain(tx, "fetch"));
    expect(await first.transaction(tx => completeStageTransition(tx, "fetch", "items")))
      .toMatchObject({ mode: "items", epoch: old.stageEpoch + 2 });
    const current = await requireClaim(input);
    expect(current).toMatchObject({ stageEpoch: old.stageEpoch + 2, itemEpoch: old.itemEpoch + 1 });
    await expect(first.transaction(async tx => assertItemLease(tx, await lockItemStage(tx, "fetch"), old))).rejects.toThrow("item_lease_lost");
  });

  it("rejects a lease that expires during an actual item-row lock wait using DB wall time", async () => {
    await integrated();
    const input = await frontier(); const lease = await requireClaim(input);
    await observer`UPDATE pipeline_item_leases SET lease_until = clock_timestamp() + interval '1 second'`;
    const locked = barrier(); const finish = barrier();
    const holding = first.transaction(async tx => {
      await lockItemStage(tx, "fetch");
      await tx.execute(sql`SELECT 1 FROM pipeline_item_leases WHERE stage = 'fetch' AND work_key = ${lease.workKey} FOR UPDATE`);
      locked.resolve(); await finish.promise;
    });
    void holding.catch(() => {});
    let writerPid = 0; const started = barrier();
    let writing: Promise<void> | undefined;
    let rejected: Promise<unknown> | undefined;
    try {
      await bounded(locked.promise, "expiry item row locked");
      writing = second.transaction(async tx => {
        [ { pid: writerPid } ] = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        const [before] = await tx.execute<{ before_expiry: boolean }>(sql`SELECT now() < lease_until AS before_expiry
          FROM pipeline_item_leases WHERE stage = 'fetch' AND work_key = ${lease.workKey}`);
        expect(before.before_expiry).toBe(true);
        const guard = await lockItemStage(tx, "fetch");
        await lockDomain(tx, input);
        await tx.update(crawlFrontier).set({ state: "done" }).where(eq(crawlFrontier.id, input.frontierId));
        started.resolve();
        await assertItemLease(tx, guard, lease);
        await requestJob("crawl-agent-review", tx);
      });
      rejected = expect(writing).rejects.toThrow("item_lease_lost");
      void rejected.catch(() => {});
      await bounded(started.promise, "expiry writer transaction started");
      await waitForLock(writerPid);
      await until(async () => (await observer`SELECT clock_timestamp() >= lease_until AS expired
        FROM pipeline_item_leases WHERE stage = 'fetch' AND work_key = ${lease.workKey}`)[0].expired,
      "lease expires while writer waits");
    } finally { finish.resolve(); await Promise.allSettled([holding, ...(writing ? [writing] : [])]); }
    await holding;
    await rejected!;
    expect((await first.select().from(crawlFrontier).where(eq(crawlFrontier.id, input.frontierId)))[0].state).toBe("fetching");
    expect(await first.select().from(jobs).where(eq(jobs.name, "crawl-agent-review"))).toHaveLength(0);
  });

  it("rolls back domain, release and handoff together while preserving job cursor/pause/requests", async () => {
    await integrated();
    const input = await frontier(); const lease = await requireClaim(input);
    const paused = new Date("2100-01-01T00:00:00.000Z");
    await first.insert(jobs).values({ name: "crawl-agent-review", requestedVersion: 7, processedVersion: 3,
      cursor: { page: 19 }, notBefore: paused });
    await observer`CREATE FUNCTION pr02_item_handoff_failure() RETURNS trigger LANGUAGE plpgsql AS
      'BEGIN IF NEW.name = ''crawl-agent-review'' THEN RAISE EXCEPTION ''pr02_handoff_failure''; END IF; RETURN NEW; END'`;
    await observer`CREATE TRIGGER pr02_item_handoff_failure BEFORE INSERT OR UPDATE ON jobs
      FOR EACH ROW EXECUTE FUNCTION pr02_item_handoff_failure()`;
    const handoff = () => first.transaction(async tx => {
      const guard = await lockItemStage(tx, "fetch");
      await lockDomain(tx, input);
      await assertItemLease(tx, guard, lease);
      await tx.update(crawlFrontier).set({ state: "done" }).where(eq(crawlFrontier.id, input.frontierId));
      await releaseItemLease(tx, guard, lease);
      await requestJob("crawl-agent-review", tx);
    });
    try { await expect(handoff()).rejects.toMatchObject({ cause: { message: "pr02_handoff_failure" } }); }
    finally {
      await observer`DROP TRIGGER pr02_item_handoff_failure ON jobs`;
      await observer`DROP FUNCTION pr02_item_handoff_failure()`;
    }
    expect((await first.select().from(crawlFrontier).where(eq(crawlFrontier.id, input.frontierId)))[0].state).toBe("fetching");
    expect((await observer`SELECT token FROM pipeline_item_leases`)[0].token).toBe(lease.token);
    expect((await first.select().from(jobs).where(eq(jobs.name, "crawl-agent-review")))[0]).toMatchObject({ requestedVersion: 7, processedVersion: 3,
      cursor: { page: 19 }, notBefore: paused });
    await handoff();
    expect((await first.select().from(crawlFrontier).where(eq(crawlFrontier.id, input.frontierId)))[0].state).toBe("done");
    expect((await observer`SELECT token FROM pipeline_item_leases`)[0].token).toBeNull();
    expect((await first.select().from(jobs).where(eq(jobs.name, "crawl-agent-review")))[0]).toMatchObject({ requestedVersion: 8, processedVersion: 3,
      cursor: { page: 19 }, notBefore: paused });
    await expect(handoff()).rejects.toThrow("item_lease_lost");
    expect((await first.select().from(jobs).where(eq(jobs.name, "crawl-agent-review")))[0].requestedVersion).toBe(8);
  });
});
