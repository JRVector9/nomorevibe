import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import postgres from "postgres";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { pipelineStageModes } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { itemBindingHash, itemWorkKey, type FetchItemBinding, type ItemLease, type ItemOwner } from "@/lib/jobs/items/types";
import { assertItemLease, beginStageDrain, claimItemLease, completeStageTransition, lockItemStage,
  releaseItemLease, renewItemLease, type ItemStageGuard } from "@/lib/jobs/items/repository";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

let admin: postgres.Sql;
const owner: ItemOwner = { instanceId: "repository-test", bootId: randomUUID() };
const binding: FetchItemBinding = { stage: "fetch", frontierId: 1, repo: "repository/app",
  claim: { attempts: 1, nextAttemptAt: "2001-11-01T00:00:00.000Z" } };
beforeAll(() => { ensureSchema(); admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} }); });
async function resetLeases() {
  await admin`TRUNCATE pipeline_item_leases`;
  await admin`UPDATE pipeline_stage_modes SET mode='legacy', draining_from=NULL, epoch=1, writer_contract_version=0`;
}
beforeEach(resetLeases);
afterAll(async () => {
  if (!admin) return;
  try { await resetLeases(); }
  finally { await admin.end({ timeout: 3 }); }
});
async function integrated() {
  await admin`UPDATE pipeline_stage_modes SET mode='items', writer_contract_version=1 WHERE stage='fetch'`;
}
async function claim(ttlMs = 60_000): Promise<ItemLease> {
  return db.transaction(async tx => {
    const lease = await claimItemLease(tx, await lockItemStage(tx, "fetch"), binding, owner, ttlMs);
    expect(lease).not.toBeNull(); return lease!;
  });
}

it("claims an integrated item with exact binding, a fresh token and independent epochs", async () => {
  await integrated();
  const lease = await claim();
  expect(lease).toMatchObject({ stage: "fetch", workKey: itemWorkKey(binding), binding,
    bindingHash: itemBindingHash(binding), owner, stageEpoch: 1, itemEpoch: 1 });
  expect(lease.token).toMatch(/^[a-f0-9-]{36}$/);
  expect(lease.leaseUntil).toBeInstanceOf(Date);
  await expect(db.transaction(async tx => assertItemLease(tx, await lockItemStage(tx, "fetch"), lease))).resolves.toBeUndefined();
});

it("keeps the default contract-zero stage inactive and refuses every transition", async () => {
  expect(await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "fetch"), binding, owner, 60_000))).toBeNull();
  await expect(db.transaction(tx => beginStageDrain(tx, "fetch"))).rejects.toThrow("item_stage_contract_required");
  await admin`UPDATE pipeline_stage_modes SET mode='draining',draining_from='items' WHERE stage='fetch'`;
  for (const target of ["legacy", "items"] as const)
    await expect(db.transaction(tx => completeStageTransition(tx, "fetch", target))).rejects.toThrow("item_stage_contract_required");
  expect((await db.select().from(pipelineStageModes).where(eq(pipelineStageModes.stage, "fetch")))[0].writerContractVersion).toBe(0);
});

it("keeps a healthy owner when the caller changes the binding or boot", async () => {
  await integrated(); const lease = await claim();
  const changed = { ...binding, claim: { ...binding.claim, attempts: 2 } };
  const replacement = { ...owner, bootId: randomUUID() };
  expect(await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "fetch"), changed, replacement, 60_000))).toBeNull();
  expect(await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "fetch"), binding, owner, 60_000))).toBeNull();
  await expect(db.transaction(async tx => assertItemLease(tx, await lockItemStage(tx, "fetch"), lease))).resolves.toBeUndefined();
});

it("allows the original execution object after renewal and increments the next acquisition epoch", async () => {
  await integrated(); const lease = await claim();
  const renewed = await db.transaction(async tx => renewItemLease(tx, await lockItemStage(tx, "fetch"), lease, 120_000));
  expect(renewed).toMatchObject({ token: lease.token, itemEpoch: lease.itemEpoch, owner });
  expect(+renewed!.leaseUntil).toBeGreaterThan(+lease.leaseUntil);
  await db.transaction(async tx => {
    const guard = await lockItemStage(tx, "fetch");
    await assertItemLease(tx, guard, lease); await releaseItemLease(tx, guard, lease);
  });
  const next = await claim();
  expect(next.itemEpoch).toBe(lease.itemEpoch + 1); expect(next.token).not.toBe(lease.token);
  await expect(db.transaction(async tx => assertItemLease(tx, await lockItemStage(tx, "fetch"), lease))).rejects.toThrow("item_lease_lost");
});

it("rejects a stage guard reused in another transaction or for another stage", async () => {
  await integrated(); let guard!: ItemStageGuard;
  await db.transaction(async tx => { guard = await lockItemStage(tx, "fetch"); });
  await expect(db.transaction(tx => claimItemLease(tx, guard, binding, owner, 60_000))).rejects.toThrow("invalid_item_stage_guard");
  await expect(db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "ai1"), binding, owner, 60_000)))
    .rejects.toThrow("invalid_item_stage_guard");
});

it("cannot reuse the same escaped transaction and guard after the native commit", async () => {
  await integrated(); let escapedTx!: ProductTransaction, guard!: ItemStageGuard;
  await db.transaction(async tx => { escapedTx = tx; guard = await lockItemStage(tx, "fetch"); });
  await expect(claimItemLease(escapedTx, guard, binding, owner, 60_000)).rejects.toThrow("invalid_item_stage_guard");
  await expect(lockItemStage(escapedTx, "fetch")).rejects.toThrow("item_stage_transaction_required");
  expect(await admin`SELECT 1 FROM pipeline_item_leases`).toHaveLength(0);
});

it.each(["begin", "complete"] as const)("refuses an autocommit %s transition through an escaped transaction", async action => {
  await integrated();
  if (action === "complete") await admin`UPDATE pipeline_stage_modes SET mode='draining',draining_from='items' WHERE stage='fetch'`;
  const before = await admin`SELECT mode,draining_from,epoch FROM pipeline_stage_modes WHERE stage='fetch'`;
  let escapedTx!: ProductTransaction;
  await db.transaction(async tx => { escapedTx = tx; });
  await expect(action === "begin" ? beginStageDrain(escapedTx, "fetch") : completeStageTransition(escapedTx, "fetch", "legacy"))
    .rejects.toThrow("item_stage_transaction_required");
  expect(await admin`SELECT mode,draining_from,epoch FROM pipeline_stage_modes WHERE stage='fetch'`).toEqual(before);
});

it("refuses a control lock upgrade after this transaction has acquired an item guard", async () => {
  await integrated();
  await expect(db.transaction(async tx => {
    await lockItemStage(tx, "fetch"); await beginStageDrain(tx, "fetch");
  })).rejects.toThrow("item_stage_lock_order");
  expect((await admin`SELECT mode FROM pipeline_stage_modes WHERE stage='fetch'`)[0].mode).toBe("items");
});

it("rejects child control before its stage UPDATE can wait on another parent's SHARE", async () => {
  await integrated();
  const peer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  let enter!: () => void, release!: () => void, peerPid = 0, settled = false;
  const entered = new Promise<void>(resolve => { enter = resolve; }), finish = new Promise<void>(resolve => { release = resolve; });
  const holding = peer.begin(async tx => {
    [{ pid: peerPid }] = await tx`SELECT pg_backend_pid() AS pid`;
    await tx`SELECT stage FROM pipeline_stage_modes WHERE stage='fetch' FOR SHARE`;
    enter(); await finish;
  });
  let misuse: Promise<unknown> | undefined;
  try {
    await entered;
    misuse = db.transaction(async tx => {
      await lockItemStage(tx, "fetch");
      await tx.transaction(nested => beginStageDrain(nested, "fetch"));
    });
    void misuse.then(() => { settled = true; }, () => { settled = true; });
    let blocked = false;
    await expect.poll(async () => {
      const [row] = await admin`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE ${peerPid} = ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'
          AND query ILIKE '%pipeline_stage_modes%') AS yes`;
      blocked = row.yes; return settled || blocked;
    }, { timeout: 2_000, interval: 10 }).toBe(true);
    expect(blocked).toBe(false);
    await expect(misuse).rejects.toThrow("item_stage_lock_order");
  } finally {
    release(); await Promise.allSettled([holding, ...(misuse ? [misuse] : [])]);
    await peer.end({ timeout: 3 });
  }
});

it("cannot reuse a child guard after its savepoint released the stage lock on rollback", async () => {
  await integrated();
  await db.transaction(async tx => {
    let child!: ProductTransaction, guard: ItemStageGuard | undefined;
    await expect(tx.transaction(async nested => {
      child = nested; guard = await lockItemStage(nested, "fetch"); throw new Error("rollback_child_guard");
    })).rejects.toThrow(/rollback_child_guard|item_stage_nested_transaction_unsupported/);
    if (guard) await expect(claimItemLease(child, guard, binding, owner, 60_000)).rejects.toThrow();
  });
  expect(await admin`SELECT 1 FROM pipeline_item_leases`).toHaveLength(0);
});

it.each(["item", "control"] as const)("rejects the first nested stage lock for %s entry on PostgreSQL17", async entry => {
  await integrated();
  await expect(db.transaction(tx => tx.transaction(async nested => {
    if (entry === "item") await lockItemStage(nested, "fetch");
    else await beginStageDrain(nested, "fetch");
  })))
    .rejects.toThrow("item_stage_nested_transaction_unsupported");
  expect((await admin`SELECT mode FROM pipeline_stage_modes WHERE stage='fetch'`)[0].mode).toBe("items");
});

it("preserves an existing parent guard across rollback of a child that reused its stage lock", async () => {
  await integrated(); const lease = await claim();
  await db.transaction(async tx => {
    const guard = await lockItemStage(tx, "fetch");
    await expect(tx.transaction(async nested => {
      await lockItemStage(nested, "fetch"); throw new Error("rollback_parent_keeps_stage");
    })).rejects.toThrow("rollback_parent_keeps_stage");
    await assertItemLease(tx, guard, lease); await releaseItemLease(tx, guard, lease);
  });
  expect((await admin`SELECT token FROM pipeline_item_leases`)[0].token).toBeNull();
});

it("accepts an earlier explicitly released savepoint whose stage lock belongs to its parent", async () => {
  await integrated();
  const lease = await db.transaction(async tx => {
    await tx.execute(sql`SAVEPOINT item_before_entry`);
    await tx.execute(sql`SELECT stage FROM pipeline_stage_modes WHERE stage='fetch' FOR SHARE`);
    await tx.execute(sql`RELEASE SAVEPOINT item_before_entry`);
    return claimItemLease(tx, await lockItemStage(tx, "fetch"), binding, owner, 60_000);
  });
  expect(lease).not.toBeNull();
});

it("conservatively refuses a parent entry while the native adapter keeps its earlier child savepoint open", async () => {
  await integrated();
  await expect(db.transaction(async tx => {
    await tx.transaction(async nested => { await nested.execute(sql`SELECT stage FROM pipeline_stage_modes WHERE stage='fetch' FOR SHARE`); });
    await lockItemStage(tx, "fetch");
  })).rejects.toThrow("item_stage_nested_transaction_unsupported");
  expect(await admin`SELECT 1 FROM pipeline_item_leases`).toHaveLength(0);
});

it("rejects binding tampering before an ownership assertion can succeed", async () => {
  await integrated(); const lease = await claim();
  const changed = { ...lease, binding: { ...binding, claim: { ...binding.claim, attempts: 5 } } };
  await expect(db.transaction(async tx => assertItemLease(tx, await lockItemStage(tx, "fetch"), changed)))
    .rejects.toThrow("invalid_item_lease");
});

it("rejects unsafe, nonpositive, fractional and unbounded lease durations", async () => {
  await integrated();
  for (const ttl of [0, -1, NaN, Infinity, 1.5, 3_600_001, Number.MAX_SAFE_INTEGER])
    await expect(db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "fetch"), binding, owner, ttl)))
      .rejects.toThrow("invalid_item_lease_ttl");
});

it("drains without fencing healthy owners and completes only after their release", async () => {
  await integrated(); const lease = await claim();
  expect(await db.transaction(tx => beginStageDrain(tx, "fetch"))).toMatchObject({ mode: "draining", drainingFrom: "items", epoch: 1 });
  expect(await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, "fetch"), binding, owner, 60_000))).toBeNull();
  expect(await db.transaction(async tx => renewItemLease(tx, await lockItemStage(tx, "fetch"), lease, 60_000))).not.toBeNull();
  await expect(db.transaction(tx => completeStageTransition(tx, "fetch", "legacy"))).rejects.toThrow("item_stage_not_drained");
  await db.transaction(async tx => releaseItemLease(tx, await lockItemStage(tx, "fetch"), lease));
  expect(await db.transaction(tx => completeStageTransition(tx, "fetch", "legacy"))).toMatchObject({ mode: "legacy", drainingFrom: null, epoch: 2 });
  await expect(db.transaction(async tx => assertItemLease(tx, await lockItemStage(tx, "fetch"), lease))).rejects.toThrow("item_lease_lost");
});
