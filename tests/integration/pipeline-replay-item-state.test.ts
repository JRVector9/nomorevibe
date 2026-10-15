import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { getTableColumns } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import { pipelineItemLeases, pipelineStageModes } from "@/lib/db/schema";
import { claimItemLease, lockItemStage, releaseItemLease, renewItemLease,
  beginStageDrain, completeStageTransition } from "@/lib/jobs/items/repository";
import { itemWorkKey, type ItemBinding, type ItemLease, type ItemOwner } from "@/lib/jobs/items/types";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { ReplayItemStateSchema, canonicalReplayItemState, replayItemStateHash,
  applyReplayItemStateChanges, replayItemStateExpiries } from "@/lib/operations/pipeline-replay-item-state";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// Actual generic ownership and SQL rows only. No AI2 domain, admission, journal,
// readiness, certified artifact or external-call authority is inferred here.
const prefix = "pr04c2-state", sentinelName = `${prefix}-unrelated-${randomUUID().slice(0, 8)}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04c2-state-admin", statement_timeout: 8_000 } });
const owner: ItemOwner = { instanceId: `${prefix}-owner`, bootId: randomUUID() };
const foreign: ItemOwner = { instanceId: `${prefix}-foreign`, bootId: randomUUID() };
type RawRow = Record<string, unknown>;
type RawState = { kind: "pipeline-replay-item-state"; version: 1; tables: {
  pipeline_stage_modes: RawRow[]; pipeline_item_leases: RawRow[];
} };
type ItemKey = { stage: ItemBinding["stage"]; work_key: string };
let originalStages: RawRow[] = [], original: unknown, withSentinel: unknown, initialized = false;
let keys: ItemKey[] = [];
const sentinelKeys: ItemKey[] = [];
let sequence = 0;
const idBase = Number.parseInt(randomUUID().replaceAll("-", "").slice(0, 11), 16);

async function allSteps(steps: readonly (() => Promise<unknown>)[]) {
  const errors: unknown[] = [];
  for (const step of steps) try { await step(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "item_state_fixture_cleanup_failed");
}
async function wholeSnapshot() {
  const [row] = await admin`SELECT jsonb_build_object(
    'stages',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY stage),'[]'::jsonb) FROM pipeline_stage_modes s),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY stage,work_key),'[]'::jsonb) FROM pipeline_item_leases i),
    'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY name),'[]'::jsonb) FROM jobs j),
    'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM crawl_settings s)) AS value`;
  return row.value;
}
async function restoreStages() {
  await admin`UPDATE pipeline_stage_modes s SET mode=r.mode,draining_from=r.draining_from,
    epoch=r.epoch,writer_contract_version=r.writer_contract_version,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::pipeline_stage_modes,${JSON.stringify(originalStages)}::text::jsonb) r
    WHERE s.stage=r.stage`;
}
async function deleteKeys(values: readonly ItemKey[]) {
  if (values.length) await admin`DELETE FROM pipeline_item_leases i USING
    jsonb_to_recordset(${JSON.stringify(values)}::text::jsonb) AS k(stage text,work_key text)
    WHERE i.stage=k.stage AND i.work_key=k.work_key`;
}
async function cleanupRowsAndStages() {
  await allSteps([async () => { await deleteKeys(keys); keys = []; }, restoreStages]);
}
async function activateStages() {
  await admin`UPDATE pipeline_stage_modes SET mode='items',draining_from=NULL,writer_contract_version=1`;
}
async function state(canonical = false): Promise<RawState> {
  const stageRow = canonical ? `to_jsonb(s)||jsonb_build_object('updated_at',to_char(s.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))` : "to_jsonb(s)";
  const itemRow = canonical ? `to_jsonb(i)||jsonb_build_object(
    'lease_until',CASE WHEN i.lease_until IS NULL THEN NULL ELSE to_char(i.lease_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
    'created_at',to_char(i.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at',to_char(i.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))` : "to_jsonb(i)";
  const order = canonical ? "ASC" : "DESC";
  const [row] = await admin.unsafe(`SELECT jsonb_build_object('kind','pipeline-replay-item-state','version',1,
    'tables',jsonb_build_object(
      'pipeline_stage_modes',(SELECT coalesce(jsonb_agg(${stageRow} ORDER BY s.stage COLLATE "C" ${order}),'[]'::jsonb) FROM pipeline_stage_modes s),
      'pipeline_item_leases',(SELECT coalesce(jsonb_agg(${itemRow} ORDER BY i.stage COLLATE "C" ${order},i.work_key COLLATE "C" ${order}),'[]'::jsonb) FROM pipeline_item_leases i))) AS value`);
  return row.value as RawState;
}
function binding(stage: ItemBinding["stage"] = "ai2"): ItemBinding {
  const id = idBase + ++sequence;
  if (stage === "fetch") return { stage, frontierId: id, repo: `pr04c2-state/repo-${id}`,
    claim: { attempts: 1, nextAttemptAt: "2026-10-16T00:00:00.000Z" } };
  const common = { candidateId: id, inputHash: "1".repeat(64), sourceRevisionHash: "2".repeat(64),
    policyHash: "3".repeat(64), promptVersion: "state-v1", rulesVersion: "state-v1",
    reviewer: { provider: "state-fixture", model: "state-fixture" } };
  return stage === "ai1" ? { stage, ...common } : { stage, ...common, secondReviewId: id,
    source: { kind: "published", slug: `state-${id}`, productId: id }, generationKey: "4".repeat(64),
    vote: id, fallbackForId: null };
}
async function claim(value: ItemBinding, by: ItemOwner = owner, sentinel = false): Promise<ItemLease> {
  const key = { stage: value.stage, work_key: itemWorkKey(value) };
  const [existing] = await admin`SELECT count(*)::int AS count FROM pipeline_item_leases
    WHERE stage=${key.stage} AND work_key=${key.work_key}`;
  expect(existing.count).toBe(0);
  (sentinel ? sentinelKeys : keys).push(key);
  const lease = await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, value.stage), value, by, 90_000));
  expect(lease).not.toBeNull();
  return lease!;
}
async function renew(lease: ItemLease) {
  return db.transaction(async tx => renewItemLease(tx, await lockItemStage(tx, lease.stage), lease, 90_000));
}
async function release(lease: ItemLease) {
  await db.transaction(async tx => releaseItemLease(tx, await lockItemStage(tx, lease.stage), lease));
}

beforeAll(async () => {
  ensureSchema();
  original = await wholeSnapshot();
  originalStages = (await state()).tables.pipeline_stage_modes;
  initialized = true;
  await admin`INSERT INTO jobs(name,requested_version,processed_version,cursor,not_before,updated_at)
    VALUES(${sentinelName},17,6,'{"unrelated":true}'::jsonb,'2101-01-01T00:00:00.654321Z','2001-01-01T00:00:00.123456Z')`;
  try { await activateStages(); await claim(binding("fetch"), foreign, true); }
  finally { await restoreStages(); }
  withSentinel = await wholeSnapshot();
});
beforeEach(async () => {
  await cleanupRowsAndStages();
  expect(await wholeSnapshot()).toEqual(withSentinel);
  await activateStages();
});
afterEach(async () => {
  if (initialized) await allSteps([cleanupRowsAndStages, async () => { expect(await wholeSnapshot()).toEqual(withSentinel); }]);
});
afterAll(async () => {
  await allSteps([
    async () => { if (initialized) await cleanupRowsAndStages(); },
    async () => { await deleteKeys(sentinelKeys); },
    async () => { await admin`DELETE FROM jobs WHERE name=${sentinelName}`; },
    async () => { if (initialized) expect(await wholeSnapshot()).toEqual(original); },
    async () => { await admin.end({ timeout: 3 }); },
  ]);
});

it("matches every actual SQL and Drizzle column and parses full generic-issued rows", async () => {
  const leases = await Promise.all([claim(binding("fetch")), claim(binding("ai1")), claim(binding("ai2"))]);
  const raw = await state(), snapshot = structuredClone(raw);
  for (const [name, table, count] of [["pipeline_stage_modes", pipelineStageModes, 6],
    ["pipeline_item_leases", pipelineItemLeases, 12]] as const) {
    const drizzleColumns = Object.values(getTableColumns(table)).map(column => column.name).sort();
    const sqlColumns = await admin`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=${name} ORDER BY column_name`;
    expect(drizzleColumns).toHaveLength(count);
    expect(sqlColumns.map(column => column.column_name)).toEqual(drizzleColumns);
    for (const row of raw.tables[name]) expect(Object.keys(row).sort()).toEqual(drizzleColumns);
  }
  expect(ReplayItemStateSchema.parse(raw)).toEqual(raw);
  expect(raw).toEqual(snapshot);
  for (const lease of leases) {
    const row = raw.tables.pipeline_item_leases.find(row => row.stage === lease.stage && row.work_key === lease.workKey)!;
    expect(row.token).toBe(lease.token); expect(row.item_epoch).toBe(1);
    expect(row.binding).toEqual(lease.binding); expect(row.owner_instance_id).toBe(owner.instanceId);
    const [duration] = await admin`SELECT lease_until>clock_timestamp() AS live,
      lease_until-created_at>=interval '89 seconds' AS full_ttl FROM pipeline_item_leases
      WHERE stage=${lease.stage} AND work_key=${lease.workKey}`;
    expect(duration).toEqual({ live: true, full_ttl: true });
  }
});

it("canonicalizes actual to_jsonb timestamps and ordering against an independent SQL projection", async () => {
  await claim(binding("ai2")); await claim(binding("ai1"));
  const raw = await state(), snapshot = structuredClone(raw), expected = await state(true);
  expect(canonicalReplayItemState(raw)).toEqual(expected);
  expect(replayItemStateHash(raw)).toBe(reviewHash(expected));
  expect(raw).toEqual(snapshot);
  expect(await state()).toEqual(snapshot);
});

function itemRow(value: RawState, lease: ItemLease) {
  const row = value.tables.pipeline_item_leases.find(row => row.stage === lease.stage && row.work_key === lease.workKey);
  expect(row).toBeDefined(); return row!;
}
function stageRow(value: RawState, stage: ItemBinding["stage"]) {
  const row = value.tables.pipeline_stage_modes.find(row => row.stage === stage);
  expect(row).toBeDefined(); return row!;
}
function change(ordinal: number, oldRow: RawRow | null, newRow: RawRow | null,
  table = "pipeline_item_leases") {
  return { ordinal, table_name: table, operation: oldRow === null ? "INSERT" : newRow === null ? "DELETE" : "UPDATE",
    old_row: oldRow, new_row: newRow };
}
async function nextClockTick(lease: ItemLease) {
  // Preserve the original 90s lease. Wait only until actual DB time can produce
  // a distinct timestamp(3) renewal; never shorten or overwrite lease_until.
  await expect.poll(async () => {
    const [row] = await admin`SELECT clock_timestamp()>updated_at+interval '2 milliseconds' AS passed
      FROM pipeline_item_leases WHERE stage=${lease.stage} AND work_key=${lease.workKey}`;
    return row.passed;
  }, { interval: 5 }).toBe(true);
}

it("replays full actual claim, renewal, original-object release and deletion OLD/NEW rows", async () => {
  const before = await state(), immutableBefore = structuredClone(before), changes: unknown[] = [];
  const lease = await claim(binding("ai2")), claimed = await state();
  changes.push(change(1, null, itemRow(claimed, lease)));
  expect(applyReplayItemStateChanges(before, changes)).toEqual(await state(true));
  const claimHash = replayItemStateHash(claimed);
  await nextClockTick(lease);
  const renewedLease = await renew(lease);
  expect(renewedLease).toMatchObject({ token: lease.token, owner: lease.owner,
    stageEpoch: lease.stageEpoch, itemEpoch: lease.itemEpoch, binding: lease.binding });
  const renewed = await state();
  changes.push(change(2, itemRow(claimed, lease), itemRow(renewed, lease)));
  expect(itemRow(renewed, lease).lease_until).not.toBe(itemRow(claimed, lease).lease_until);
  expect(replayItemStateHash(renewed)).not.toBe(claimHash);
  expect(applyReplayItemStateChanges(before, changes)).toEqual(await state(true));
  // The actual generic API accepts the original object after heartbeat renewal.
  await release(lease);
  const released = await state(), releasedRow = itemRow(released, lease);
  expect(releasedRow).toMatchObject({ owner_instance_id: null, owner_boot_id: null, token: null, lease_until: null,
    binding: lease.binding, binding_hash: lease.bindingHash, item_epoch: lease.itemEpoch, stage_epoch: lease.stageEpoch });
  changes.push(change(3, itemRow(renewed, lease), releasedRow));
  expect(applyReplayItemStateChanges(before, changes)).toEqual(await state(true));
  await deleteKeys([{ stage: lease.stage, work_key: lease.workKey }]);
  changes.push(change(4, releasedRow, null));
  const immutableChanges = structuredClone(changes);
  const replayed = applyReplayItemStateChanges(before, changes);
  expect(replayed).toEqual(await state(true));
  expect(replayItemStateHash(replayed)).toBe(reviewHash(await state(true)));
  expect(before).toEqual(immutableBefore);
  expect(changes).toEqual(immutableChanges);
  expect(await state()).toEqual(before);
});

it("preserves foreign and released historical epochs through actual stage transitions", async () => {
  const staleLease = await claim(binding("ai2")); await release(staleLease);
  const before = await state(), stale = structuredClone(itemRow(before, staleLease));
  await db.transaction(async tx => beginStageDrain(tx, "ai2"));
  const drained = await state();
  const first = change(1, stageRow(before, "ai2"), stageRow(drained, "ai2"), "pipeline_stage_modes");
  expect(applyReplayItemStateChanges(before, [first])).toEqual(await state(true));
  await db.transaction(async tx => completeStageTransition(tx, "ai2", "items"));
  const transitioned = await state();
  expect(stageRow(transitioned, "ai2").epoch).toBe(staleLease.stageEpoch + 1);
  expect(itemRow(transitioned, staleLease)).toEqual(stale);
  expect(applyReplayItemStateChanges(before, [first,
    change(2, stageRow(drained, "ai2"), stageRow(transitioned, "ai2"), "pipeline_stage_modes")])).toEqual(await state(true));
  const other = await claim(binding("ai2"), foreign), raw = await state(), snapshot = structuredClone(raw);
  const canonical = canonicalReplayItemState(raw);
  expect(canonical).toEqual(await state(true));
  expect(canonical.tables.pipeline_item_leases).toHaveLength(raw.tables.pipeline_item_leases.length);
  expect(itemRow(raw, other)).toMatchObject({ owner_instance_id: foreign.instanceId, owner_boot_id: foreign.bootId,
    token: other.token, stage_epoch: staleLease.stageEpoch + 1 });
  expect(itemRow(raw, staleLease)).toEqual(stale);
  expect(raw).toEqual(snapshot); expect(await state()).toEqual(snapshot);
});

it("collects every actual owned expiry, including foreign rows, and omits released rows", async () => {
  const first = await claim(binding("ai1")), second = await claim(binding("ai2"));
  await release(first);
  const raw = await state(), snapshot = structuredClone(raw);
  const expected = await admin`SELECT DISTINCT to_char(lease_until AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expiry,lease_until FROM pipeline_item_leases
    WHERE owner_instance_id IS NOT NULL ORDER BY lease_until`;
  expect(replayItemStateExpiries(raw)).toEqual(expected.map(row => row.expiry));
  const sentinel = sentinelKeys[0];
  const required = await admin`SELECT to_char(lease_until AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expiry FROM pipeline_item_leases
    WHERE (stage=${second.stage} AND work_key=${second.workKey})
      OR (stage=${sentinel.stage} AND work_key=${sentinel.work_key})`;
  expect(required).toHaveLength(2);
  expect(expected.map(row => row.expiry)).toEqual(expect.arrayContaining(required.map(row => row.expiry)));
  expect(itemRow(raw, first).lease_until).toBeNull();
  expect(itemRow(raw, second).token).toBe(second.token);
  expect(raw).toEqual(snapshot); expect(await state()).toEqual(snapshot);
});

it("rejects stale actual OLD rows and incomplete SQL rows without changing caller or database state", async () => {
  const lease = await claim(binding("ai2")), claimed = await state();
  await nextClockTick(lease); await renew(lease);
  const current = await state(), snapshot = structuredClone(current);
  const stale = [change(1, itemRow(claimed, lease), itemRow(current, lease))], staleSnapshot = structuredClone(stale);
  expect(() => applyReplayItemStateChanges(current, stale)).toThrow();
  const incomplete = structuredClone(current);
  delete itemRow(incomplete, lease).created_at;
  expect(() => canonicalReplayItemState(incomplete)).toThrow();
  const extraColumn = structuredClone(current);
  itemRow(extraColumn, lease).unsupported_column = true;
  expect(() => canonicalReplayItemState(extraColumn)).toThrow();
  expect(stale).toEqual(staleSnapshot); expect(current).toEqual(snapshot);
  expect(await state()).toEqual(snapshot);
});

it("propagates actual cleanup failure while still restoring every borrowed stage row", async () => {
  const lease = await claim(binding("ai2")), issued = itemRow(await state(), lease);
  let failure: unknown;
  try {
    await admin.unsafe(`CREATE FUNCTION pr04c2_state_cleanup_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.stage='ai2' AND OLD.work_key='${lease.workKey}' THEN
        RAISE EXCEPTION 'own_item_state_cleanup_failed'; END IF; RETURN OLD; END $$`);
    await admin.unsafe(`CREATE TRIGGER pr04c2_state_cleanup_failure BEFORE DELETE ON pipeline_item_leases
      FOR EACH ROW EXECUTE FUNCTION pr04c2_state_cleanup_failure()`);
    try { await cleanupRowsAndStages(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect((failure as AggregateError).errors[0]).toMatchObject({ message: "own_item_state_cleanup_failed" });
    const failed = await state();
    expect(failed.tables.pipeline_stage_modes).toEqual(originalStages);
    expect(itemRow(failed, lease)).toEqual(issued);
  } finally {
    await allSteps([
      async () => { await admin`DROP TRIGGER IF EXISTS pr04c2_state_cleanup_failure ON pipeline_item_leases`; },
      async () => { await admin`DROP FUNCTION IF EXISTS pr04c2_state_cleanup_failure()`; },
      cleanupRowsAndStages,
    ]);
  }
});
