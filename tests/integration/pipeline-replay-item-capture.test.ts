import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { getTableColumns } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { db } from "@/lib/db";
import { pipelineItemLeases, pipelineStageModes } from "@/lib/db/schema";
import { claimItemLease, lockItemStage, renewItemLease, releaseItemLease,
  beginStageDrain, completeStageTransition } from "@/lib/jobs/items/repository";
import { itemWorkKey, type ItemBinding, type ItemLease, type ItemOwner } from "@/lib/jobs/items/types";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { captureReplayItemState } from "@/lib/operations/pipeline-replay-item-capture";
import { openVerifiedReplayHandlerDatabase, verifyReplayDatabaseSession,
  type VerifiedReplayDatabase } from "@/lib/operations/pipeline-replay-database";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { claimItemSecondReview } from "@/lib/crawl/second-review-ownership";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";

// Capture-only row evidence. Real generic leases are issued by the repository;
// this file establishes no domain, ready/live, commit or certified authority.
const prefix = "pr04c2-capture", sentinelName = `${prefix}-unrelated-${randomUUID().slice(0, 8)}`;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: "pr04c2-capture-admin" } });
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
let profile: { database: VerifiedReplayDatabase; release(): Promise<void> } | undefined;

async function allSteps(steps: readonly (() => Promise<unknown>)[]) {
  const errors: unknown[] = [];
  for (const step of steps) try { await step(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, "item_capture_fixture_cleanup_failed");
}
async function wholeSnapshot() {
  const [row] = await admin`SELECT jsonb_build_object(
    'stages',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY stage),'[]'::jsonb) FROM pipeline_stage_modes s),
    'items',(SELECT coalesce(jsonb_agg(to_jsonb(i) ORDER BY stage,work_key),'[]'::jsonb) FROM pipeline_item_leases i),
    'jobs',(SELECT coalesce(jsonb_agg(to_jsonb(j) ORDER BY name),'[]'::jsonb) FROM jobs j),
    'settings',(SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM crawl_settings s),
    'database_acl',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.grantor,a.grantee,a.privilege_type)
      FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) a WHERE d.datname=current_database()),
    'public_schema_acl',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.grantor,a.grantee,a.privilege_type)
      FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a WHERE n.nspname='public'),
    'relation_acl',(SELECT jsonb_agg(jsonb_build_object('name',c.relname,'acl',
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.grantor,a.grantee,a.privilege_type) FROM aclexplode(coalesce(c.relacl,
        acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) a)) ORDER BY c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f','S')),
    'column_acl',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',c.relname,'column',a.attname,'acl',a.attacl) ORDER BY c.relname,a.attname),'[]'::jsonb)
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND a.attacl IS NOT NULL)) AS value`;
  return row.value;
}
async function restoreStages() {
  await admin`UPDATE pipeline_stage_modes s SET mode=r.mode,draining_from=r.draining_from,
    epoch=r.epoch,writer_contract_version=r.writer_contract_version,updated_at=r.updated_at
    FROM jsonb_populate_recordset(NULL::pipeline_stage_modes,${JSON.stringify(originalStages)}::text::jsonb) r WHERE s.stage=r.stage`;
}
async function deleteKeys(values: readonly ItemKey[]) {
  if (values.length) await admin`DELETE FROM pipeline_item_leases i USING
    jsonb_to_recordset(${JSON.stringify(values)}::text::jsonb) AS k(stage text,work_key text)
    WHERE i.stage=k.stage AND i.work_key=k.work_key`;
}
async function closeProfile() {
  if (profile) { await profile.database.close(); await profile.release(); profile = undefined; }
}
async function cleanup() {
  // Never restore source while a verified profile or its actual work is active.
  await closeProfile();
  await allSteps([async () => { await deleteKeys(keys); keys = []; }, restoreStages]);
}
async function activateStages() {
  await admin`UPDATE pipeline_stage_modes SET mode='items',draining_from=NULL,writer_contract_version=1`;
}
async function sqlState(canonical = false): Promise<RawState> {
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
  if (stage === "fetch") return { stage, frontierId: id, repo: `pr04c2-capture/repo-${id}`,
    claim: { attempts: 1, nextAttemptAt: "2026-10-16T00:00:00.000Z" } };
  const common = { candidateId: id, inputHash: "1".repeat(64), sourceRevisionHash: "2".repeat(64),
    policyHash: "3".repeat(64), promptVersion: "capture-v1", rulesVersion: "capture-v1",
    reviewer: { provider: "capture-fixture", model: "capture-fixture" } };
  return stage === "ai1" ? { stage, ...common } : { stage, ...common, secondReviewId: id,
    source: { kind: "published", slug: `capture-${id}`, productId: id }, generationKey: "4".repeat(64),
    vote: id, fallbackForId: null };
}
async function claim(value: ItemBinding, by: ItemOwner = owner, sentinel = false): Promise<ItemLease> {
  const key = { stage: value.stage, work_key: itemWorkKey(value) };
  const [existing] = await admin`SELECT count(*)::int AS count FROM pipeline_item_leases
    WHERE stage=${key.stage} AND work_key=${key.work_key}`;
  expect(existing.count).toBe(0); (sentinel ? sentinelKeys : keys).push(key);
  const lease = await db.transaction(async tx => claimItemLease(tx, await lockItemStage(tx, value.stage), value, by, 90_000));
  expect(lease).not.toBeNull(); return lease!;
}
const capture = () => admin.begin(tx => captureReplayItemState(tx));
const exercises = new Set<Promise<void>>();
function exercise(load: () => Promise<void>) {
  return (): Promise<void> => {
    const work = Promise.resolve().then(load);
    exercises.add(work);
    // A Vitest timeout does not cancel its callback. Hooks retain and drain the
    // actual work before verified teardown or raw restoration, including errors.
    void work.catch(() => {});
    return work;
  };
}
async function settleExercises() {
  const pending = [...exercises];
  const results = await Promise.allSettled(pending);
  for (const work of pending) exercises.delete(work);
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "item_capture_exercise_failed");
}
beforeAll(exercise(async () => {
  ensureSchema(); original = await wholeSnapshot(); originalStages = (await sqlState()).tables.pipeline_stage_modes;
  initialized = true;
  await admin`INSERT INTO jobs(name,requested_version,processed_version,cursor,not_before,updated_at)
    VALUES(${sentinelName},17,6,'{"unrelated":true}'::jsonb,'2101-01-01T00:00:00.654321Z','2001-01-01T00:00:00.123456Z')`;
  try { await activateStages(); await claim(binding("fetch"), foreign, true); }
  finally { await restoreStages(); }
  withSentinel = await wholeSnapshot();
}));
beforeEach(exercise(async () => { await cleanup(); expect(await wholeSnapshot()).toEqual(withSentinel); await activateStages(); }));
afterEach(async () => {
  await allSteps([
    settleExercises,
    async () => { if (initialized) { await cleanup(); expect(await wholeSnapshot()).toEqual(withSentinel); } },
  ]);
});
afterAll(async () => {
  await allSteps([
    settleExercises,
    async () => {
      await closeProfile();
      await allSteps([
        async () => { if (initialized) await cleanup(); },
        async () => { await deleteKeys(sentinelKeys); },
        async () => { await admin`DELETE FROM jobs WHERE name=${sentinelName}`; },
        async () => { if (initialized) expect(await wholeSnapshot()).toEqual(original); },
      ]);
    },
    async () => { await admin.end({ timeout: 3 }); },
  ]);
});

it("reads all six/twelve SQL columns and real generic-issued row identities", exercise(async () => {
  const lease = await claim(binding("ai2")), result = await capture();
  for (const [name, table, count] of [["pipeline_stage_modes", pipelineStageModes, 6],
    ["pipeline_item_leases", pipelineItemLeases, 12]] as const) {
    const columns = Object.values(getTableColumns(table)).map(column => column.name).sort();
    const actual = await admin`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
      AND table_name=${name} ORDER BY column_name`;
    expect(columns).toHaveLength(count); expect(actual.map(row => row.column_name)).toEqual(columns);
    for (const row of result.state.tables[name]) expect(Object.keys(row).sort()).toEqual(columns);
  }
  expect(result.state.tables.pipeline_stage_modes).toHaveLength(3);
  expect(result.state.tables.pipeline_item_leases).toContainEqual(expect.objectContaining({ stage: lease.stage,
    work_key: lease.workKey, binding: lease.binding, binding_hash: lease.bindingHash, token: lease.token,
    owner_instance_id: owner.instanceId, owner_boot_id: owner.bootId, item_epoch: lease.itemEpoch, stage_epoch: lease.stageEpoch }));
  const [duration] = await admin`SELECT lease_until>clock_timestamp() AS live,
    lease_until-created_at>=interval '89 seconds' AS full_ttl FROM pipeline_item_leases
    WHERE stage=${lease.stage} AND work_key=${lease.workKey}`;
  expect(duration).toEqual({ live: true, full_ttl: true });
}));

it("returns the independent SQL canonical state and its full payload hash", exercise(async () => {
  await claim(binding("ai2")); await claim(binding("ai1"));
  const before = await sqlState(), expected = await sqlState(true), result = await capture();
  expect(result).toEqual({ state: expected, stateHash: reviewHash(expected) });
  expect(await sqlState()).toEqual(before);
}));

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function capturedItem(value: Awaited<ReturnType<typeof capture>>, lease: ItemLease) {
  const row = value.state.tables.pipeline_item_leases.find(row => row.stage === lease.stage && row.work_key === lease.workKey);
  expect(row).toBeDefined(); return row!;
}
async function expectFullCapture() {
  const expected = await sqlState(true), result = await capture();
  expect(result).toEqual({ state: expected, stateHash: reviewHash(expected) });
  expect(Object.keys(result).sort()).toEqual(["state", "stateHash"]);
  return result;
}

it("captures an uncapped 101-plus generic-issued universe including every foreign row", exercise(async () => {
  const before = await sqlState(), leases: ItemLease[] = [];
  for (let i = 0; i < 101; i++) leases.push(await claim(binding(i % 3 === 0 ? "fetch" : i % 3 === 1 ? "ai1" : "ai2")));
  const result = await expectFullCapture();
  expect(result.state.tables.pipeline_item_leases).toHaveLength(before.tables.pipeline_item_leases.length + 101);
  for (const lease of leases) expect(capturedItem(result, lease).token).toBe(lease.token);
  for (const row of before.tables.pipeline_item_leases)
    expect(result.state.tables.pipeline_item_leases).toContainEqual(expect.objectContaining({
      stage: row.stage, work_key: row.work_key, binding: row.binding, binding_hash: row.binding_hash,
      token: row.token, owner_instance_id: row.owner_instance_id, owner_boot_id: row.owner_boot_id,
    }));
}));

it("captures actual renewal, original-receipt release and historical epochs without filtering", exercise(async () => {
  const lease = await claim(binding("ai2")), claimed = await expectFullCapture();
  await expect.poll(async () => {
    const [row] = await admin`SELECT clock_timestamp()>updated_at+interval '2 milliseconds' AS passed
      FROM pipeline_item_leases WHERE stage=${lease.stage} AND work_key=${lease.workKey}`;
    return row.passed;
  }, { interval: 5 }).toBe(true);
  const renewed = await db.transaction(async tx => renewItemLease(tx, await lockItemStage(tx, lease.stage), lease, 90_000));
  expect(renewed).toMatchObject({ token: lease.token, owner: lease.owner, itemEpoch: lease.itemEpoch, stageEpoch: lease.stageEpoch });
  const renewedState = await expectFullCapture();
  expect(renewedState.stateHash).not.toBe(claimed.stateHash);
  expect(capturedItem(renewedState, lease).lease_until).not.toBe(capturedItem(claimed, lease).lease_until);
  await db.transaction(async tx => releaseItemLease(tx, await lockItemStage(tx, lease.stage), lease));
  await db.transaction(async tx => beginStageDrain(tx, "ai2"));
  await db.transaction(async tx => completeStageTransition(tx, "ai2", "items"));
  const other = await claim(binding("ai2"), foreign), result = await expectFullCapture();
  expect(capturedItem(result, lease)).toMatchObject({ token: null, owner_instance_id: null, owner_boot_id: null,
    lease_until: null, stage_epoch: lease.stageEpoch, item_epoch: lease.itemEpoch, binding: lease.binding });
  expect(result.state.tables.pipeline_stage_modes.find(row => row.stage === "ai2")!.epoch).toBe(lease.stageEpoch + 1);
  expect(capturedItem(result, other)).toMatchObject({ token: other.token, owner_instance_id: foreign.instanceId,
    owner_boot_id: foreign.bootId, stage_epoch: lease.stageEpoch + 1 });
}));

it("sees only the old or committed new pair around an actual atomic bootstrap transaction", exercise(async () => {
  const lease = await claim(binding("ai2"));
  await db.transaction(async tx => releaseItemLease(tx, await lockItemStage(tx, lease.stage), lease));
  const before = await expectFullCapture(), changed = latch(), finish = latch();
  const writer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "pr04c2-capture-paired-writer" } });
  let writing: Promise<unknown> | undefined, writerError: unknown;
  try {
    writing = writer.begin(async tx => {
      const [stage] = await tx`UPDATE pipeline_stage_modes SET epoch=epoch+1,updated_at=clock_timestamp()
        WHERE stage=${lease.stage} RETURNING epoch`;
      // This released historical row is state evidence, never a new authority.
      await tx`UPDATE pipeline_item_leases SET stage_epoch=${stage.epoch},updated_at=clock_timestamp()
        WHERE stage=${lease.stage} AND work_key=${lease.workKey}`;
      changed.resolve(); await finish.promise;
    });
    void writing.catch(error => { writerError = error; changed.resolve(); });
    await changed.promise;
    if (writerError) throw writerError;
    const uncommitted = await capture();
    expect(uncommitted).toEqual(before);
    expect(capturedItem(uncommitted, lease).stage_epoch).toBe(lease.stageEpoch);
    finish.resolve(); await writing;
    const committed = await expectFullCapture();
    expect(committed.stateHash).not.toBe(before.stateHash);
    expect(committed.state.tables.pipeline_stage_modes.find(row => row.stage === lease.stage)!.epoch).toBe(lease.stageEpoch + 1);
    expect(capturedItem(committed, lease).stage_epoch).toBe(lease.stageEpoch + 1);
  } finally {
    finish.resolve();
    try { if (writing) await writing; } finally { await writer.end({ timeout: 3 }); }
  }
}));

it("propagates the actual table-lock cancellation SQLSTATE after its exact backend is cancelled", exercise(async () => {
  await claim(binding("ai2"));
  const before = await sqlState(), locked = latch(), finish = latch(), entered = latch();
  const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "pr04c2-capture-table-holder" } });
  const reader = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
    connection: { application_name: "pr04c2-capture-cancel-reader" } });
  let holding: Promise<unknown> | undefined, holderPid: number | undefined, readerPid: number | undefined, holderError: unknown;
  let reading: Promise<unknown> | undefined;
  try {
    holding = holder.begin(async tx => {
      const [row] = await tx`SELECT pg_backend_pid() AS pid`; holderPid = row.pid;
      await tx`LOCK TABLE public.pipeline_item_leases IN ACCESS EXCLUSIVE MODE`;
      locked.resolve(); await finish.promise;
    });
    void holding.catch(error => { holderError = error; locked.resolve(); });
    await locked.promise;
    if (holderError) throw holderError;
    reading = reader.begin(async tx => {
      try {
        const [row] = await tx`SELECT pg_backend_pid() AS pid`; readerPid = row.pid;
        entered.resolve(); return await captureReplayItemState(tx);
      } finally { entered.resolve(); }
    }).then(value => ({ value }), error => ({ error }));
    await entered.promise; expect(readerPid).toBeDefined();
    await expect.poll(async () => {
      const [row] = await admin`SELECT ${holderPid!}::int=ANY(pg_blocking_pids(${readerPid!}::int)) AS blocked`;
      return row.blocked;
    }).toBe(true);
    const [cancelled] = await admin`SELECT pg_cancel_backend(${readerPid!}::int) AS cancelled`;
    expect(cancelled.cancelled).toBe(true);
    expect(await reading).toMatchObject({ error: { code: "57014" } });
  } finally {
    finish.resolve();
    await allSteps([
      async () => { if (holding) await holding; },
      async () => { if (reading) await reading; },
      async () => { await reader.end({ timeout: 3 }); },
      async () => { await holder.end({ timeout: 3 }); },
    ]);
  }
  expect(await sqlState()).toEqual(before);
}));

it.each(["extra", "missing"] as const)("fails closed on an actual %s SQL column and rolls its DDL back", kind => exercise(async () => {
  await claim(binding("ai2"));
  const before = await sqlState(), rollback = new Error("own_capture_schema_rollback");
  const beforeColumns = await admin`SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='pipeline_item_leases' ORDER BY column_name`;
  let strictError: unknown;
  const transaction = admin.begin(async tx => {
    if (kind === "extra") await tx`ALTER TABLE public.pipeline_item_leases ADD COLUMN pr04c2_capture_extra boolean`;
    else await tx`ALTER TABLE public.pipeline_item_leases DROP COLUMN updated_at`;
    try { await captureReplayItemState(tx); } catch (error) { strictError = error; }
    throw rollback;
  });
  await expect(transaction).rejects.toBe(rollback);
  expect(strictError).toMatchObject({ name: "ZodError" });
  expect(await admin`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
    AND table_name='pipeline_item_leases' ORDER BY column_name`).toEqual(beforeColumns);
  expect(await sqlState()).toEqual(before);
})());

it("captures through the genuine handlers-v5 role while preserving immutable DML and unsupported item entry", exercise(async () => {
  const lease = await claim(binding("ai2")), expected = await expectFullCapture(), before = await sqlState();
  const owned = await getReplayHandlerIdentityPath();
  let opened: VerifiedReplayDatabase | undefined;
  try {
    opened = await openVerifiedReplayHandlerDatabase(owned.identityPath, {});
    profile = { database: opened, release: owned.release };
    const database = opened;
    const result = await database.client.begin(async tx => {
      await verifyReplayDatabaseSession(tx, database);
      const [role] = await tx`SELECT current_user AS role,session_user AS session,
        has_table_privilege(current_user,'public.pipeline_item_leases','SELECT') AS item_select,
        has_table_privilege(current_user,'public.pipeline_item_leases','INSERT,DELETE') AS item_dml`;
      expect(role).toEqual({ role: database.identity.roleName, session: database.identity.roleName, item_select: true, item_dml: false });
      return captureReplayItemState(tx);
    });
    expect(result).toEqual(expected);
    await expect(database.client`UPDATE public.pipeline_item_leases SET work_key=work_key
      WHERE stage=${lease.stage} AND work_key=${lease.workKey}`).rejects.toMatchObject({ code: "42501", message: "replay_handler_source_immutable" });
    await expect(database.client`UPDATE public.pipeline_stage_modes SET stage=stage WHERE stage='ai2'`)
      .rejects.toMatchObject({ code: "42501", message: "replay_handler_source_immutable" });
    await expect(database.client`DELETE FROM public.pipeline_item_leases WHERE stage=${lease.stage} AND work_key=${lease.workKey}`)
      .rejects.toMatchObject({ code: "42501" });
    // ALWAYS guards also forbid the bootstrap owner from changing source while installed.
    await expect(admin`UPDATE public.pipeline_item_leases SET work_key=work_key WHERE stage=${lease.stage} AND work_key=${lease.workKey}`)
      .rejects.toMatchObject({ code: "42501", message: "replay_handler_source_immutable" });
    await expect(withReplayDatabaseScope(owned.identityPath, () => claimItemSecondReview(
      Number(lease.workKey.slice(4)), owner, 90_000))).rejects.toThrow("replay_item_execution_unsupported");
    expect(await sqlState()).toEqual(before);
    expect(await database.client.begin(tx => captureReplayItemState(tx))).toEqual(expected);
  } finally {
    // Every actual query above is awaited before closing verified clients and
    // releasing the authentic profile. Raw source restoration occurs afterward.
    if (profile) await closeProfile();
    else { if (opened) await opened.close(); await owned.release(); }
  }
  expect(await sqlState()).toEqual(before);
}));
