import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ItemLease } from "@/lib/jobs/items/types";
import { itemBindingHash, itemBindingSchema, itemOwnerSchema } from "@/lib/jobs/items/types";
import { canonicalReplayItemState } from "./pipeline-replay-item-state";
import type { ReplayItemCallAuthoritySchema } from "./pipeline-replay-item-execution";
import type { ReplayCallRequest } from "./pipeline-replay-ledger";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { JobLease } from "@/lib/jobs/control";
import { JobLeaseLostError, STALE_LOCK_MS } from "@/lib/jobs/lease";
import { assertSameReplayHandlerDatabase, assertVerifiedReplayDatabase, assertVerifiedReplayHandlerDatabase,
  verifyReplayDatabaseSession, type VerifiedReplayDatabase } from "./pipeline-replay-database";
import { replayCallRequestSchema, replayFinalRunBinding, type ReplayRun } from "./pipeline-replay-ledger";

const brand: unique symbol = Symbol("ReplayTransactionTicket");
export type ReplayTransactionTicket = Readonly<{ [brand]: true }>;
const proofBrand: unique symbol = Symbol("ReplayQuiescenceProof");
export type ReplayQuiescenceProof = Readonly<{ [proofBrand]: true }>;
type Raw = postgres.TransactionSql;
type Binding = ReturnType<typeof replayFinalRunBinding>;
type Scope = { run: ReplayRun; binding: Binding; active: boolean; pending: Set<ReplayTransactionTicket> };
type Ticket = { scope: Scope; tx: Raw; txKey: string; txStartedAt: string; dbXid: string;
  state: "open" | "flushing" | "flushed" | "finalized" | "confirmed" | "rolled_back";
  authorities: Map<string, string>; registering: number;
  items: Map<string, { lease: import("zod").infer<typeof ReplayItemCallAuthoritySchema>["lease"]; released: boolean }>;
  reservations: Map<string, import("zod").infer<typeof ReplayItemCallAuthoritySchema>>; preFlush: Array<() => Promise<void>>;
  callbacks: Array<(run: Record<string, unknown>, raw: Raw) => Promise<void>> };
const executions = new AsyncLocalStorage<Scope>();
const tickets = new WeakMap<ReplayTransactionTicket, Ticket>();
const keys = new Map<string, ReplayTransactionTicket>();
const proofs = new WeakMap<ReplayQuiescenceProof, { run: ReplayRun; binding: Binding }>();
const latestProof = new WeakMap<ReplayRun, ReplayQuiescenceProof>();
const enteredRuns = new WeakSet<ReplayRun>();
function ensure(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }

type ExecutionDiagnosticPhase = "journal.prepare" | "journal.packets" | "journal.final_check"
  | "seal.journal" | "seal.event_write" | "seal.artifact_content" | "seal.strict_parse" | "seal.final_update";
type ExecutionMeasurement = { wall: number; cpu: NodeJS.CpuUsage };
type ExecutionDiagnostic = ExecutionMeasurement & { ordinal: number; phase: ExecutionDiagnosticPhase };
type PacketDiagnosticTotals = { count: number; wallMs: number; userMs: number; systemMs: number };
let executionDiagnosticOrdinal = 0;
let executionDiagnosticWrites = 0, executionDiagnosticAwaitingError = false,
  executionDiagnosticErrorGeneration = 0, executionDiagnosticListening = false;
function executionDiagnosticDetach(): void {
  try {
    if (executionDiagnosticListening && executionDiagnosticWrites === 0 && !executionDiagnosticAwaitingError) {
      process.stderr.removeListener("error", executionDiagnosticSinkError);
      executionDiagnosticListening = false;
    }
  } catch { /* Sink bookkeeping cannot affect replay validation. */ }
}
function executionDiagnosticSinkError(): void {
  try { executionDiagnosticErrorGeneration++; executionDiagnosticAwaitingError = false; executionDiagnosticDetach(); }
  catch { /* Preserve the original replay result or rejection. */ }
}
function writeExecutionDiagnostic(line: string): void {
  try {
    if (!executionDiagnosticListening) {
      const max = process.stderr.getMaxListeners();
      if (max > 0 && process.stderr.listenerCount("error") >= max) return;
      process.stderr.on("error", executionDiagnosticSinkError); executionDiagnosticListening = true;
    }
    executionDiagnosticWrites++;
    const generation = executionDiagnosticErrorGeneration;
    let completed = false;
    const complete = (error?: Error | null): void => {
      try {
        if (completed) return;
        completed = true; executionDiagnosticWrites--;
        // Writable callback errors precede its error event; retain one shared
        // guard until that event, or use the generation if it already arrived.
        if (error && generation === executionDiagnosticErrorGeneration) executionDiagnosticAwaitingError = true;
        executionDiagnosticDetach();
      } catch { /* The asynchronous callback must also be best effort. */ }
    };
    try { process.stderr.write(line, complete); } catch { complete(); }
  } catch { /* Neither synchronous nor asynchronous sink errors replace replay errors. */ }
}
// Fixed diagnostics only. Process CPU includes other concurrent work; it is not
// per-query CPU or authority. No projection serialization or row values here.
function captureExecutionMeasurement(): ExecutionMeasurement | undefined {
  try { return { wall: performance.now(), cpu: process.cpuUsage() }; } catch { return undefined; }
}
function beginExecutionDiagnostic(phase: ExecutionDiagnosticPhase): ExecutionDiagnostic | undefined {
  try {
    const measurement = captureExecutionMeasurement(); if (!measurement) return undefined;
    const sample = { ...measurement, ordinal: ++executionDiagnosticOrdinal, phase };
    writeExecutionDiagnostic(JSON.stringify({ event: "certified_replay_execution_subphase", ordinal: sample.ordinal, phase, state: "begin" }) + "\n");
    return sample;
  } catch { return undefined; }
}
function finishExecutionDiagnostic(sample: ExecutionDiagnostic | undefined, state: "end" | "reject",
  counts: Record<string, number | string> = {}): void {
  try {
    if (!sample) return;
    const cpu = process.cpuUsage(sample.cpu);
    writeExecutionDiagnostic(JSON.stringify({ event: "certified_replay_execution_subphase", ordinal: sample.ordinal,
      phase: sample.phase, state, wallMs: Math.round((performance.now() - sample.wall) * 1_000) / 1_000,
      userMs: cpu.user / 1_000, systemMs: cpu.system / 1_000, ...counts }) + "\n");
  } catch { /* Diagnostics cannot replace the original result or rejection. */ }
}
function addPacketMeasurement(total: PacketDiagnosticTotals, sample: ExecutionMeasurement | undefined): void {
  try {
    if (!sample) return;
    const cpu = process.cpuUsage(sample.cpu);
    total.count++; total.wallMs += performance.now() - sample.wall;
    total.userMs += cpu.user / 1_000; total.systemMs += cpu.system / 1_000;
  } catch { /* A failed sample cannot change journal validation. */ }
}

/** Only a DB-certified opaque run can install the transaction journal context. */
export async function withReplayExecutionScope<T>(run: ReplayRun, load: () => Promise<T>): Promise<T> {
  ensure(!executions.getStore(), "replay_execution_scope_conflict");
  const binding = replayFinalRunBinding(run);
  ensure(binding.certified, "replay_certified_run_required");
  binding.assertActive();
  ensure(!enteredRuns.has(run), "replay_execution_already_started");
  enteredRuns.add(run); latestProof.delete(run);
  const scope: Scope = { run, binding, active: true, pending: new Set() };
  return executions.run(scope, async () => {
    let complete = false;
    try {
      const result = await load();
      ensure(scope.pending.size === 0, "replay_execution_not_quiescent");
      complete = true; return result;
    } finally {
      scope.active = false;
      if (complete) {
        const proof = Object.freeze({ [proofBrand]: true as const });
        proofs.set(proof, { run, binding }); latestProof.set(run, proof);
      }
    }
  });
}
export function replayQuiescenceProof(run: ReplayRun): ReplayQuiescenceProof {
  const proof = latestProof.get(run);
  ensure(proof, "replay_execution_not_quiescent"); return proof;
}
export function assertReplayQuiescence(run: ReplayRun, proof: ReplayQuiescenceProof): void {
  const owned = proof && proofs.get(proof);
  ensure(owned?.run === run && latestProof.get(run) === proof, "replay_execution_not_quiescent");
  assertVerifiedReplayDatabase(owned.binding.database);
}

export type ReplayTransactionHooks = {
  before(tx: Raw, parentTicket?: ReplayTransactionTicket): Promise<ReplayTransactionTicket | undefined>;
  after(tx: Raw, ticket: ReplayTransactionTicket | undefined): Promise<void>;
  finalWall(tx: Raw, ticket: ReplayTransactionTicket | undefined): Promise<void>;
  commitAck(ticket: ReplayTransactionTicket | undefined): Promise<void>;
  rollback(ticket: ReplayTransactionTicket | undefined): void;
};

/** Every guarded handler transaction calls this, including legacy/outside-context callers. */
export function currentReplayTransactionHooks(database: VerifiedReplayDatabase): ReplayTransactionHooks {
  assertVerifiedReplayDatabase(database);
  return {
    async before(tx, parentTicket) {
      const scope = executions.getStore();
      if (!scope) {
        await tx`SELECT pg_advisory_xact_lock_shared(1485803, 4)`;
        const [exists] = await tx`SELECT pg_catalog.to_regclass('pipeline_replay.capacity_runs') IS NOT NULL AS present`;
        if (exists.present) {
          const [row] = await tx`SELECT EXISTS (SELECT 1 FROM pipeline_replay.capacity_runs
            WHERE initial_state_hash IS NOT NULL AND state IN ('running','draining','sealed')) AS certified`;
          ensure(!row.certified, "replay_execution_scope_required");
        }
        return undefined;
      }
      ensure(scope.active, "replay_execution_scope_closed");
      ensure(!parentTicket, "replay_certified_savepoint_rejected");
      assertSameReplayHandlerDatabase(database, scope.binding.database);
      scope.binding.assertActive();
      await tx`SELECT pg_advisory_xact_lock_shared(1485803, 4)`;
      const [row] = await tx`SELECT owner_id::text, state, writers_fenced_at FROM pipeline_replay.capacity_runs
        WHERE run_id = ${scope.run.runId}`;
      ensure(row?.owner_id === scope.binding.ownerId && ['running','draining'].includes(row.state)
        && row.writers_fenced_at === null, "replay_writers_fenced");
      const [clock] = await tx`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at,
        pg_current_xact_id()::text AS xid`;
      const txKey = randomUUID(), token = Object.freeze({ [brand]: true as const });
      await tx`SELECT set_config('pipeline_replay.run_id', ${scope.run.runId}, true),
        set_config('pipeline_replay.tx_key', ${txKey}, true), set_config('pipeline_replay.ordinal', '0', true)`;
      tickets.set(token, { scope, tx, txKey, txStartedAt: clock.at, dbXid: clock.xid, state: "open",
        authorities: new Map(), registering: 0, items: new Map(), reservations: new Map(), preFlush: [], callbacks: [] });
      keys.set(txKey, token); scope.pending.add(token); return token;
    },
    async after(tx, token) {
      if (!token) return;
      const value = tickets.get(token);
      ensure(value?.tx === tx && value.state === "open" && value.scope.active, "replay_transaction_ticket_mismatch");
      ensure(executions.getStore() === value.scope, "replay_transaction_ticket_mismatch");
      ensure(value.registering === 0, "replay_transaction_work_not_awaited");
      value.state = "flushing";
      await flushReplayTransaction(value);
      value.state = "flushed";
    },
    async finalWall(tx, token) {
      if (!token) return;
      const value = tickets.get(token);
      ensure(value?.tx === tx && value.state === "flushed" && value.scope.active
        && executions.getStore() === value.scope, "replay_transaction_ticket_mismatch");
      value.scope.binding.assertActive();
      // Registration already acquired every relevant job lock in this TX.
      // No new row lock or verifier may follow this final wall-clock query.
      const authorities = JSON.stringify([...value.authorities].map(([name, token]) => ({ name, token })));
      const items = JSON.stringify([...value.items.values()].map(item => ({ ...item.lease, released: item.released })));
      const [wall] = await tx`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at), proof AS MATERIALIZED (SELECT current_setting('pipeline_replay.tx_key',true) AS tx_key,
        pg_current_xact_id()::text AS xid, NOT EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${authorities}::text::jsonb) AS required(name text,token text)
          LEFT JOIN public.jobs j ON j.name=required.name
          WHERE j.lease_token IS DISTINCT FROM required.token
            OR NOT coalesce(j.locked_at >= (SELECT at FROM clock)-${STALE_LOCK_MS} * interval '1 millisecond',false)
        ) AND NOT EXISTS (
          SELECT 1 FROM jsonb_to_recordset(${items}::text::jsonb) AS required(work_key text,token text,owner_instance_id text,
            owner_boot_id text,stage_epoch bigint,item_epoch bigint,binding_hash text,binding jsonb,lease_until text,released boolean)
          LEFT JOIN public.pipeline_item_leases i ON i.stage='ai2' AND i.work_key=required.work_key
          LEFT JOIN public.pipeline_stage_modes s ON s.stage='ai2'
          WHERE i.work_key IS NULL OR s.epoch IS DISTINCT FROM required.stage_epoch OR s.writer_contract_version<1
            OR NOT(s.mode='items' OR s.mode='draining' AND s.draining_from='items')
            OR i.stage_epoch IS DISTINCT FROM required.stage_epoch OR i.item_epoch IS DISTINCT FROM required.item_epoch
            OR i.binding_hash IS DISTINCT FROM required.binding_hash OR i.binding IS DISTINCT FROM required.binding
            OR required.lease_until::timestamptz<=(SELECT at FROM clock)
            OR CASE WHEN required.released THEN i.token IS NOT NULL OR i.owner_instance_id IS NOT NULL
                OR i.owner_boot_id IS NOT NULL OR i.lease_until IS NOT NULL
              ELSE i.token::text IS DISTINCT FROM required.token OR i.owner_instance_id IS DISTINCT FROM required.owner_instance_id
                OR i.owner_boot_id::text IS DISTINCT FROM required.owner_boot_id OR i.lease_until<=(SELECT at FROM clock) END
        ) AS owned), head AS (
          UPDATE pipeline_replay.capacity_runs SET event_seq=event_seq+1 WHERE run_id=${value.scope.run.runId}
            AND (SELECT owned FROM proof) AND jsonb_array_length(${items}::text::jsonb)>0 RETURNING event_seq
        ), event AS (
          INSERT INTO pipeline_replay.capacity_transitions(run_id,seq,kind,payload)
          SELECT ${value.scope.run.runId},head.event_seq,'item_final_authority',jsonb_build_object(
            'txKey',${value.txKey}::text,'checkedAt',to_char(clock.at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'items',${items}::text::jsonb) FROM head,clock RETURNING seq
        ) SELECT proof.*,(SELECT seq FROM event) AS authority_seq FROM proof`;
      ensure(wall?.tx_key === value.txKey && wall.xid === value.dbXid, "replay_transaction_ticket_mismatch");
      if (!wall.owned) throw new JobLeaseLostError();
      ensure(value.state === "flushed" && value.scope.active && executions.getStore() === value.scope,
        "replay_transaction_ticket_mismatch");
      value.scope.binding.assertActive();
      value.state = "finalized";
    },
    async commitAck(token) {
      if (!token) return;
      const value = tickets.get(token);
      ensure(value?.state === "finalized" && value.scope.active && executions.getStore() === value.scope,
        "replay_transaction_ticket_mismatch");
      await value.scope.binding.database.client.begin(async tx => {
        await verifyReplayDatabaseSession(tx, value.scope.binding.database);
        await tx`INSERT INTO pipeline_replay.capacity_commit_confirmations (run_id, tx_key)
          VALUES (${value.scope.run.runId}, ${value.txKey}::uuid)`;
        await verifyReplayDatabaseSession(tx, value.scope.binding.database);
      });
      value.state = "confirmed"; value.scope.pending.delete(token); keys.delete(value.txKey);
    },
    rollback(token) {
      if (!token) return;
      const value = tickets.get(token);
      if (value && value.state !== "confirmed") {
        value.state = "rolled_back"; value.scope.pending.delete(token); keys.delete(value.txKey);
      }
    },
  };
}

/** Only an actual successful wall-time check registers a final job requirement.
 * The caller's executor is not proof: bind it to this ticket's raw transaction
 * using a fresh TX-local challenge, then check the real locked job ourselves. */
export async function registerReplayJobFinalAuthority(tx: ProductTransaction, lease: JobLease,
  mode: "share" | "update"): Promise<void> {
  const scope = executions.getStore(); if (!scope) return;
  ensure(scope.active, "replay_execution_scope_closed"); scope.binding.assertActive();
  const { name, token: jobToken } = lease;
  ensure(["crawl-agent-review", "second-review"].includes(name)
    && typeof jobToken === "string" && jobToken.length > 0 && jobToken.length <= 160
    && ["share", "update"].includes(mode), "replay_job_final_authority_unsupported");
  const challenge = randomUUID();
  const [identity] = await tx.execute<{ tx_key: string; xid: string }>(sql`SELECT
    set_config('pipeline_replay.final_authority_challenge',${challenge},true),
    current_setting('pipeline_replay.tx_key',true) AS tx_key, pg_current_xact_id()::text AS xid`);
  const token = identity && keys.get(identity.tx_key), value = token && tickets.get(token);
  ensure(value && value.scope === scope && value.state === "open" && scope.active
    && identity.xid === value.dbXid, "replay_transaction_ticket_mismatch");
  const previous = value.authorities.get(name);
  ensure(previous === undefined || previous === jobToken, "replay_job_final_authority_conflict");
  value.registering++;
  try {
    const [actual] = await value.tx`SELECT current_setting('pipeline_replay.tx_key',true) AS tx_key,
      pg_current_xact_id()::text AS xid,
      current_setting('pipeline_replay.final_authority_challenge',true) AS challenge`;
    ensure(actual?.tx_key === value.txKey && actual.xid === value.dbXid && actual.challenge === challenge,
      "replay_transaction_ticket_mismatch");
    // Consume only after verification, before any failure can abort the TX.
    // A cleanup query in finally could hide the original error with 25P02.
    await value.tx`SELECT set_config('pipeline_replay.final_authority_challenge','',true)`;
    if (mode === "update") await value.tx`SELECT name FROM public.jobs WHERE name=${name} FOR UPDATE`;
    else await value.tx`SELECT name FROM public.jobs WHERE name=${name} FOR SHARE`;
    const [owned] = await value.tx`SELECT name FROM public.jobs WHERE name=${name} AND lease_token=${jobToken}
      AND locked_at >= clock_timestamp()-${STALE_LOCK_MS} * interval '1 millisecond'`;
    if (!owned) throw new JobLeaseLostError();
    ensure(value.state === "open" && scope.active && executions.getStore() === scope,
      "replay_transaction_ticket_mismatch");
    scope.binding.assertActive();
    value.authorities.set(name, jobToken);
  } finally { value.registering--; }
}

/** A fresh job claim is admission; heartbeats and already admitted writers remain separate. */
export async function assertReplayJobAdmission(tx: ProductTransaction): Promise<void> {
  const scope = executions.getStore(); if (!scope) return;
  ensure(scope.active, "replay_execution_scope_closed"); scope.binding.assertActive();
  const [row] = await tx.execute<{ tx_key: string; admitted: boolean }>(sql`SELECT
    current_setting('pipeline_replay.tx_key',true) AS tx_key,
    EXISTS(SELECT 1 FROM pipeline_replay.capacity_runs WHERE run_id=${scope.run.runId}
      AND owner_id=${scope.binding.ownerId}::uuid AND state='running' AND admission_closed_at IS NULL
      AND clock_timestamp()<deadline_at) AS admitted`);
  const token = keys.get(row.tx_key), ticket = token && tickets.get(token);
  ensure(ticket?.scope === scope && ticket.state === "open" && row.admitted, "replay_job_admission_closed");
}

/** The ordinary item path remains unchanged. A replay requires this private,
 * certified run kind, not a caller flag or a lease-shaped JSON value. */
export function assertReplayItemExecutionAllowed(): void {
  const scope = executions.getStore();
  ensure(scope?.active && scope.binding.items, "replay_item_execution_unsupported");
  scope.binding.assertActive();
}

async function itemTicket(tx: ProductTransaction): Promise<Ticket | undefined> {
  const scope = executions.getStore(); if (!scope) return undefined;
  assertReplayItemExecutionAllowed();
  const challenge = randomUUID();
  const [identity] = await tx.execute<{ tx_key: string; xid: string }>(sql`SELECT
    set_config('pipeline_replay.item_authority_challenge',${challenge},true),
    current_setting('pipeline_replay.tx_key',true) AS tx_key,pg_current_xact_id()::text AS xid`);
  const token = identity && keys.get(identity.tx_key), value = token && tickets.get(token);
  ensure(value?.scope === scope && value.state === "open" && value.dbXid === identity.xid, "replay_transaction_ticket_mismatch");
  const [actual] = await value.tx`SELECT current_setting('pipeline_replay.item_authority_challenge',true) AS challenge,
    current_setting('pipeline_replay.tx_key',true) AS tx_key,pg_current_xact_id()::text AS xid`;
  ensure(actual.challenge === challenge && actual.tx_key === value.txKey && actual.xid === value.dbXid,
    "replay_transaction_ticket_mismatch");
  await value.tx`SELECT set_config('pipeline_replay.item_authority_challenge','',true)`;
  ensure(value.state === "open" && scope.active && executions.getStore() === scope, "replay_transaction_ticket_mismatch");
  return value;
}

async function actualItem(tx: Raw, workKey: string) {
  const [row] = await tx`SELECT to_jsonb(i) AS value FROM public.pipeline_item_leases i WHERE stage='ai2' AND work_key=${workKey}`;
  ensure(row, "item_lease_lost");
  const stages = await tx`SELECT to_jsonb(s) AS value FROM public.pipeline_stage_modes s ORDER BY stage`;
  return canonicalReplayItemState({ kind: "pipeline-replay-item-state", version: 1,
    tables: { pipeline_stage_modes: stages.map(stage => stage.value), pipeline_item_leases: [row.value] } })
    .tables.pipeline_item_leases[0];
}

function sameItemOwner(actual: Awaited<ReturnType<typeof actualItem>>, lease: ItemLease) {
  return actual.stage === "ai2" && actual.work_key === lease.workKey && actual.token === lease.token
    && actual.owner_instance_id === lease.owner.instanceId && actual.owner_boot_id === lease.owner.bootId
    && actual.stage_epoch === lease.stageEpoch && actual.item_epoch === lease.itemEpoch
    && actual.binding_hash === lease.bindingHash && actual.binding_hash === itemBindingHash(lease.binding)
    && reviewHash(actual.binding) === reviewHash(lease.binding);
}

// This validates and copies caller identity only. The locked DB row grants authority.
const itemLeaseSnapshotSchema = z.object({ stage: z.literal("ai2"), workKey: z.string().min(1),
  binding: itemBindingSchema, bindingHash: z.string().regex(/^[a-f0-9]{64}$/), owner: itemOwnerSchema,
  token: z.uuid(), stageEpoch: z.number().int().positive().safe(), itemEpoch: z.number().int().positive().safe(),
  leaseUntil: z.date() }).strict();

export async function registerReplayItemFinalAuthority(tx: ProductTransaction, lease: ItemLease): Promise<void> {
  if (!executions.getStore()) return;
  lease = itemLeaseSnapshotSchema.parse(structuredClone(lease));
  const value = await itemTicket(tx); if (!value) return;
  value.registering++;
  try {
    await value.tx`SELECT work_key FROM public.pipeline_item_leases WHERE stage='ai2' AND work_key=${lease.workKey} FOR UPDATE`;
    const actual = await actualItem(value.tx, lease.workKey);
    const [valid] = await value.tx`SELECT lease_until>clock_timestamp() AS alive FROM public.pipeline_item_leases
      WHERE stage='ai2' AND work_key=${lease.workKey}`;
    ensure(sameItemOwner(actual, lease) && valid?.alive, "item_lease_lost");
    ensure(value.state === "open" && value.scope.active, "replay_transaction_ticket_mismatch");
    value.items.set(lease.workKey, { lease: actual, released: false });
  } finally { value.registering--; }
}

export async function registerReplayItemRelease(tx: ProductTransaction, lease: ItemLease): Promise<void> {
  if (!executions.getStore()) return;
  lease = itemLeaseSnapshotSchema.parse(structuredClone(lease));
  const value = await itemTicket(tx); if (!value) return;
  value.registering++;
  try {
  const previous = value.items.get(lease.workKey);
  ensure(previous && sameItemOwner(previous.lease, lease), "replay_item_authority_required");
  const current = await actualItem(value.tx, lease.workKey);
  const [release] = await value.tx`SELECT old_row,new_row FROM pipeline_replay.capacity_changes
    WHERE run_id=${value.scope.run.runId} AND tx_key=${value.txKey}::uuid AND table_name='pipeline_item_leases'
      AND old_row->>'work_key'=${lease.workKey} AND old_row->>'token'=${lease.token}
      AND new_row->>'token' IS NULL ORDER BY ordinal DESC LIMIT 1`;
  ensure(release && current.token === null && current.owner_instance_id === null && current.owner_boot_id === null
    && current.lease_until === null && current.item_epoch === lease.itemEpoch && current.stage_epoch === lease.stageEpoch
    && current.binding_hash === lease.bindingHash, "replay_item_release_mismatch");
  ensure(value.state === "open" && value.scope.active, "replay_transaction_ticket_mismatch");
  previous.released = true;
  } finally { value.registering--; }
}

export async function reserveReplayItemCall(tx: ProductTransaction, lease: ItemLease, request: ReplayCallRequest): Promise<void> {
  lease = itemLeaseSnapshotSchema.parse(structuredClone(lease));
  request = replayCallRequestSchema.parse(structuredClone(request));
  await registerReplayItemFinalAuthority(tx, lease);
  const { ReplayItemCallAuthoritySchema } = await import("./pipeline-replay-item-execution");
  const value = await itemTicket(tx);
  ensure(value && request.stage === "second" && lease.binding.stage === "ai2"
    && request.firstAttemptId === (lease.binding.source.kind === "first_attempt" ? lease.binding.source.firstAttemptId : null)
    && request.secondReviewId === lease.binding.secondReviewId && request.candidateId === lease.binding.candidateId
    && request.generationKey === lease.binding.generationKey && request.vote === lease.binding.vote
    && request.inputHash === lease.binding.inputHash && request.sourceRevisionHash === lease.binding.sourceRevisionHash
    && request.provider === lease.binding.reviewer.provider && request.model === lease.binding.reviewer.model,
    "replay_item_call_binding_mismatch");
  const authority = ReplayItemCallAuthoritySchema.parse({ callId: request.callId, txKey: value.txKey,
    lease: value.items.get(lease.workKey)!.lease });
  ensure(!value.reservations.has(request.callId), "replay_call_id_reused");
  value.reservations.set(request.callId, authority);
  value.preFlush.push(() => value.scope.binding.reserveItemCall(value.tx, request));
}

export function consumeReplayItemReservation(tx: Raw, callId: string) {
  const scope = executions.getStore();
  assertReplayItemExecutionAllowed();
  const value = [...scope!.pending].map(token => tickets.get(token)).find(ticket => ticket?.tx === tx);
  ensure(value?.state === "flushing" && value.reservations.has(callId), "replay_item_call_authority_required");
  const authority = value.reservations.get(callId)!; value.reservations.delete(callId);
  return authority;
}

/** Native call transitions take their stage/item prefix before the run lock. */
export async function assertReplayItemCallDispatch(tx: Raw, runId: string, callId: string): Promise<void> {
  const [proof] = await tx`SELECT payload FROM pipeline_replay.capacity_transitions WHERE run_id=${runId}
    AND kind='item_call_authority' AND payload->>'callId'=${callId}`;
  if (!proof) {
    const [call] = await tx`SELECT stage FROM pipeline_replay.capacity_calls WHERE run_id=${runId} AND call_id=${callId}`;
    ensure(call?.stage === "first", "replay_item_call_authority_required"); return;
  }
  const { ReplayItemCallAuthoritySchema } = await import("./pipeline-replay-item-execution");
  const authority = ReplayItemCallAuthoritySchema.parse(proof.payload), lease = authority.lease;
  for (const stage of ["fetch", "ai1", "ai2"]) await tx`SELECT stage FROM public.pipeline_stage_modes WHERE stage=${stage} FOR SHARE`;
  await tx`SELECT work_key FROM public.pipeline_item_leases WHERE stage='ai2' AND work_key=${lease.work_key} FOR UPDATE`;
  const actual = await actualItem(tx, lease.work_key);
  const [valid] = await tx`SELECT token::text=${lease.token} AND owner_instance_id=${lease.owner_instance_id}
    AND owner_boot_id::text=${lease.owner_boot_id} AND stage_epoch=${lease.stage_epoch} AND item_epoch=${lease.item_epoch}
    AND binding_hash=${lease.binding_hash} AND lease_until>clock_timestamp() AS owned
    FROM public.pipeline_item_leases WHERE stage='ai2' AND work_key=${lease.work_key}`;
  ensure(valid?.owned && reviewHash(actual.binding) === reviewHash(lease.binding), "item_lease_lost");
  const scope = executions.getStore();
  const ticket = scope && [...scope.pending].map(token => tickets.get(token)).find(value => value?.tx === tx);
  ensure(ticket?.state === "open", "replay_transaction_ticket_mismatch");
  ticket.items.set(lease.work_key, { lease: actual, released: false });
}

/** Domain observations have completed; defer only ledger writes until the outer common flush. */
export async function deferReplayFinalWrite(tx: ProductTransaction,
  flush: (row: Record<string, unknown>, raw: Raw) => Promise<void>): Promise<boolean> {
  const scope = executions.getStore(); if (!scope) return false;
  ensure(scope.active, "replay_execution_scope_closed");
  const [row] = await tx.execute<{ tx_key: string }>(sql`SELECT current_setting('pipeline_replay.tx_key', true) AS tx_key`);
  const token = keys.get(row.tx_key), value = token && tickets.get(token);
  ensure(value && value.scope === scope && value.state === "open", "replay_transaction_ticket_mismatch");
  value.callbacks.push(flush); return true;
}

async function flushReplayTransaction(value: Ticket): Promise<void> {
  const { tx, scope } = value;
  const [run] = await tx`SELECT * FROM pipeline_replay.capacity_runs WHERE run_id = ${scope.run.runId}
    AND owner_id = ${scope.binding.ownerId}::uuid FOR UPDATE`;
  ensure(run && ['running','draining'].includes(run.state) && !run.writers_fenced_at, "replay_writers_fenced");
  for (const reserve of value.preFlush) await reserve();
  const rawChanges = [...await tx`SELECT ordinal, table_name, operation, old_row, new_row
    FROM pipeline_replay.capacity_changes WHERE run_id = ${scope.run.runId} AND tx_key = ${value.txKey}::uuid ORDER BY ordinal`];
  const { applyReplayChanges, ReplayReadinessProjectionSchema, ReplayReadinessChangeSchema } = await import("./pipeline-replay-readiness");
  const { applyReplayMixedChanges, ReplayMixedChangeSchema } = await import("./pipeline-replay-item-execution");
  const changes = rawChanges.map(row => (scope.binding.items ? ReplayMixedChangeSchema : ReplayReadinessChangeSchema)
    .parse({ ...row, ordinal: Number(row.ordinal) }));
  const projection = scope.binding.items ? applyReplayMixedChanges(run.current_projection, changes)
    : applyReplayChanges(ReplayReadinessProjectionSchema.parse(run.current_projection), changes as import("./pipeline-replay-readiness").ReplayReadinessChange[]);
  const [event] = await tx`UPDATE pipeline_replay.capacity_runs SET event_seq = event_seq + 1,
    current_projection = ${JSON.stringify(projection)}::text::jsonb WHERE run_id = ${scope.run.runId} RETURNING event_seq`;
  const [clock] = await tx`INSERT INTO pipeline_replay.capacity_transitions (run_id,seq,kind,payload)
    VALUES (${scope.run.runId},${event.event_seq},'transaction',${JSON.stringify({ txKey: value.txKey })}::text::jsonb)
    RETURNING to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;
  await tx`INSERT INTO pipeline_replay.capacity_transactions (run_id,tx_key,db_xid,seq,tx_started_at,recorded_at,changes)
    VALUES (${scope.run.runId},${value.txKey}::uuid,${value.dbXid},${event.event_seq},${value.txStartedAt}::text::timestamptz,${clock.at}::text::timestamptz,${JSON.stringify(changes)}::text::jsonb)`;
  for (const callback of value.callbacks) await callback(run, tx);
}

// JSON projections retain PostgreSQL's microseconds; Date conversion would round an upper bound down.
function utc(value: unknown): string {
  ensure(typeof value === "string", "replay_timestamp_invalid");
  const matched = /^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(?:Z|\+00(?::?00)?)$/.exec(value);
  ensure(matched, "replay_timestamp_invalid");
  return `${matched[1]}T${matched[2]}.${(matched[3] ?? "").padEnd(6, "0")}Z`;
}
const nullableUtc = (value: unknown) => value === null ? null : utc(value);
type JsonRow = Record<string, unknown>;

async function artifactContent(tx: Raw, runId: string) {
  const [result] = await tx`SELECT to_jsonb(r) AS value FROM pipeline_replay.capacity_runs r WHERE run_id=${runId}`;
  const row = result?.value as JsonRow;
  const { ReplayCombinedExecutionSchema } = await import("./pipeline-replay-item-execution");
  const items = ReplayCombinedExecutionSchema.safeParse(row?.initial_projection).success;
  ensure(row?.initial_projection && row.initial_state_hash && row.writers_fenced_at && row.sealed_at, "replay_run_not_sealed");
  const journalRows = await tx`SELECT to_jsonb(e) AS value FROM pipeline_replay.capacity_transitions e WHERE run_id=${runId} ORDER BY seq`;
  const transactionRows = await tx`SELECT to_jsonb(t) || jsonb_build_object('confirmed_at',c.confirmed_at) AS value
    FROM pipeline_replay.capacity_transactions t LEFT JOIN pipeline_replay.capacity_commit_confirmations c
      ON c.run_id=t.run_id AND c.tx_key=t.tx_key WHERE t.run_id=${runId} ORDER BY t.seq`;
  const callRows = await tx`SELECT to_jsonb(c) AS value FROM pipeline_replay.capacity_calls c WHERE run_id=${runId} ORDER BY call_id`;
  const finalRows = await tx`SELECT to_jsonb(f) AS value FROM pipeline_replay.capacity_finals f WHERE run_id=${runId} ORDER BY seq`;
  const journal = journalRows.map(({ value: item }) => ({ seq: Number(item.seq), at: utc(item.at), kind: item.kind,
    txKey: item.tx_key, payloadHash: reviewHash(item.payload),
    ...(items ? { payload: item.payload } : {}) }));
  const transactions = transactionRows.map(({ value: item }) => ({ seq: Number(item.seq), txKey: item.tx_key,
    txStartedAt: utc(item.tx_started_at), recordedAt: utc(item.recorded_at), confirmedAt: nullableUtc(item.confirmed_at), changes: item.changes }));
  const calls = callRows.map(({ value: item }) => ({ callId: item.call_id, candidateId: Number(item.candidate_id),
    firstAttemptId: item.first_attempt_id === null ? null : Number(item.first_attempt_id), inputHash: item.input_hash,
    sourceRevisionHash: item.source_revision_hash, stage: item.stage, provider: item.provider, model: item.model,
    secondReviewId: item.second_review_id === null ? null : Number(item.second_review_id), generationKey: item.generation_key,
    vote: item.vote === null ? null : Number(item.vote), requestHash: item.request_hash, tokenUpperBound: Number(item.token_upper_bound),
    state: item.state, dispatchedAt: nullableUtc(item.dispatched_at), settledAt: nullableUtc(item.settled_at),
    inputTokens: item.input_tokens === null ? null : Number(item.input_tokens), outputTokens: item.output_tokens === null ? null : Number(item.output_tokens),
    resultOk: item.result_ok, resultHash: item.result_hash, resultDecisionHash: item.result_decision_hash, failureClass: item.failure_class }));
  const finals = finalRows.map(({ value: item }) => ({ candidateId: Number(item.candidate_id), inputHash: item.input_hash,
    sourceRevisionHash: item.source_revision_hash, policyHash: item.policy_hash, seq: Number(item.seq), at: utc(item.at),
    firstAttemptId: Number(item.first_attempt_id), firstCallId: item.first_call_id, decision: item.decision, secondWitnesses: item.second_witnesses }));
  return { row, content: { kind: "pipeline-replay-ledger" as const, version: items ? 2 : 1, manifest: row.manifest,
    run: { runId, epoch: Number(row.epoch), profile: items ? "handlers-v6-item" : "handlers-v5", state: "sealed" as const,
      startedAt: utc(row.started_at), deadlineAt: utc(row.deadline_at), admissionClosedAt: utc(row.admission_closed_at),
      writersFencedAt: utc(row.writers_fenced_at), sealedAt: utc(row.sealed_at),
      chargedCalls: Number(row.charged_calls), chargedTokens: Number(row.charged_tokens) },
    initial: { capturedAt: utc(row.captured_at), initialStateHash: row.initial_state_hash,
      comparisonStateHash: row.comparison_state_hash, projection: row.initial_projection, runner: row.runner, quality: row.quality },
    journal, readiness: { transactions, gaps: [] }, calls, finals } };
}

async function validateJournal(tx: Raw, runId: string): Promise<void> {
  let diagnostic = beginExecutionDiagnostic("journal.prepare");
  const reads: PacketDiagnosticTotals = { count: 0, wallMs: 0, userMs: 0, systemMs: 0 };
  const reductions: PacketDiagnosticTotals = { count: 0, wallMs: 0, userMs: 0, systemMs: 0 };
  let packetCount = 0, changeCount = 0, maxChanges = 0;
  let packetStep: "none" | "read" | "reduce" = "none", packetSample: ExecutionMeasurement | undefined;
  const packetCounts = () => ({ packets: packetCount, changes: changeCount, maxChanges, packetStep,
    readCount: reads.count, readWallMs: reads.wallMs, readUserMs: reads.userMs, readSystemMs: reads.systemMs,
    reduceCount: reductions.count, reduceWallMs: reductions.wallMs, reduceUserMs: reductions.userMs, reduceSystemMs: reductions.systemMs });
  try {
    const [unresolved] = await tx`SELECT 1 FROM pipeline_replay.capacity_calls WHERE run_id=${runId}
    AND state NOT IN ('settled','cancelled_before_dispatch') LIMIT 1`;
    ensure(!unresolved, "replay_calls_unresolved");
    const [missing] = await tx`SELECT 1 FROM pipeline_replay.capacity_transactions t
    LEFT JOIN pipeline_replay.capacity_commit_confirmations c ON c.run_id=t.run_id AND c.tx_key=t.tx_key
    WHERE t.run_id=${runId} AND c.tx_key IS NULL LIMIT 1`;
    ensure(!missing, "replay_commit_unconfirmed");
    const [orphan] = await tx`SELECT 1 FROM pipeline_replay.capacity_changes c LEFT JOIN pipeline_replay.capacity_transactions t
    ON t.run_id=c.run_id AND t.tx_key=c.tx_key WHERE c.run_id=${runId} AND t.tx_key IS NULL LIMIT 1`;
    ensure(!orphan, "replay_journal_binding_mismatch");
    const [run] = await tx`SELECT initial_projection,current_projection,event_seq,manifest,manifest_hash
    FROM pipeline_replay.capacity_runs WHERE run_id=${runId}`;
    ensure(run && reviewHash(run.manifest) === run.manifest_hash, "replay_journal_binding_mismatch");
    const [invalidPacket] = await tx`SELECT 1 FROM pipeline_replay.capacity_transactions t
    LEFT JOIN pipeline_replay.capacity_transitions e ON e.run_id=t.run_id AND e.seq=t.seq
    WHERE t.run_id=${runId} AND (e.seq IS NULL OR e.kind<>'transaction' OR e.tx_key IS DISTINCT FROM t.tx_key::text
      OR e.at<>t.recorded_at OR t.tx_started_at>t.recorded_at) LIMIT 1`;
    const [orphanConfirmation] = await tx`SELECT 1 FROM pipeline_replay.capacity_commit_confirmations c
    LEFT JOIN pipeline_replay.capacity_transactions t ON t.run_id=c.run_id AND t.tx_key=c.tx_key
    WHERE c.run_id=${runId} AND (t.tx_key IS NULL OR c.confirmed_at<t.recorded_at) LIMIT 1`;
    const [invalidFinal] = await tx`SELECT 1 FROM pipeline_replay.capacity_transitions e
    LEFT JOIN pipeline_replay.capacity_finals f ON f.run_id=e.run_id AND f.seq=e.seq
    WHERE e.run_id=${runId} AND e.kind='final' AND f.seq IS NULL LIMIT 1`;
    ensure(!invalidPacket && !orphanConfirmation && !invalidFinal, "replay_journal_binding_mismatch");
    const { applyReplayChanges, ReplayReadinessProjectionSchema, ReplayReadinessChangeSchema } = await import("./pipeline-replay-readiness");
    const { applyReplayMixedChanges, ReplayCombinedExecutionSchema, ReplayMixedChangeSchema } = await import("./pipeline-replay-item-execution");
    const items = run.initial_projection.kind === "pipeline-replay-combined-state";
    let projection = items ? ReplayCombinedExecutionSchema.parse(run.initial_projection) : ReplayReadinessProjectionSchema.parse(run.initial_projection);
    const frozen = await tx`SELECT candidate_id,input_hash,source_revision_hash,frozen_input,frozen_hash
    FROM pipeline_replay.capacity_inputs WHERE run_id=${runId} ORDER BY candidate_id,input_hash,source_revision_hash`;
    const actualInputs = frozen.map(row => ({ candidateId: Number(row.candidate_id), inputHash: row.input_hash,
      sourceRevisionHash: row.source_revision_hash, frozenInput: row.frozen_input, frozenHash: row.frozen_hash }));
    const domain = "domain" in projection ? projection.domain : projection;
    const expectedInputs = domain.universe.map(({ candidateId, inputHash, sourceRevisionHash, frozenInput, frozenHash }) =>
      ({ candidateId, inputHash, sourceRevisionHash, frozenInput, frozenHash }));
    ensure(reviewHash(actualInputs) === reviewHash(expectedInputs), "replay_journal_binding_mismatch");
    const packets = await tx`SELECT tx_key,changes FROM pipeline_replay.capacity_transactions WHERE run_id=${runId} ORDER BY seq`;
    packetCount = packets.length;
    finishExecutionDiagnostic(diagnostic, "end", { packets: packetCount, frozenInputs: frozen.length });
    diagnostic = beginExecutionDiagnostic("journal.packets");
    for (const packet of packets) {
      packetStep = "read"; packetSample = captureExecutionMeasurement();
      const actual = await tx`SELECT ordinal,table_name,operation,old_row,new_row FROM pipeline_replay.capacity_changes
      WHERE run_id=${runId} AND tx_key=${packet.tx_key} ORDER BY ordinal`;
      addPacketMeasurement(reads, packetSample); packetSample = undefined;
      changeCount += actual.length; maxChanges = Math.max(maxChanges, actual.length);
      packetStep = "reduce"; packetSample = captureExecutionMeasurement();
      const changes = actual.map(item => (items ? ReplayMixedChangeSchema : ReplayReadinessChangeSchema).parse({ ...item, ordinal: Number(item.ordinal) }));
      ensure(reviewHash(changes) === reviewHash(packet.changes), "replay_journal_binding_mismatch");
      projection = items ? applyReplayMixedChanges(projection, changes) : applyReplayChanges(projection as import("./pipeline-replay-readiness").ReplayReadinessProjection, changes as import("./pipeline-replay-readiness").ReplayReadinessChange[]);
      addPacketMeasurement(reductions, packetSample); packetSample = undefined; packetStep = "none";
    }
    finishExecutionDiagnostic(diagnostic, "end", packetCounts());
    diagnostic = beginExecutionDiagnostic("journal.final_check");
    ensure(reviewHash(projection) === reviewHash(run.current_projection), "replay_journal_binding_mismatch");
    const [counts] = await tx`SELECT count(*) AS count,min(seq) AS min,max(seq) AS max FROM pipeline_replay.capacity_transitions WHERE run_id=${runId}`;
    ensure(Number(counts.count) === Number(run.event_seq) && Number(counts.min) === 1
      && Number(counts.max) === Number(run.event_seq), "replay_sequence_mismatch");

    finishExecutionDiagnostic(diagnostic, "end", { events: Number(counts.count) });
  } catch (error) {
    if (packetSample) addPacketMeasurement(packetStep === "read" ? reads : reductions, packetSample);
    finishExecutionDiagnostic(diagnostic, "reject", packetCounts());
    throw error;
  }
}
/** Called solely by the authentic ledger after its opaque quiescence proof is checked. */
export async function sealReplayLedger(tx: Raw, run: ReplayRun, ownerId: string, proof: ReplayQuiescenceProof): Promise<void> {
  assertReplayQuiescence(run, proof);
  await tx`SELECT pg_advisory_xact_lock(1485803,2)`;
  await tx`SELECT pg_advisory_xact_lock(1485803,4)`;
  const [row] = await tx`SELECT state,writers_fenced_at FROM pipeline_replay.capacity_runs
    WHERE run_id=${run.runId} AND owner_id=${ownerId}::uuid FOR UPDATE`;
  ensure(row?.state === "draining" && row.writers_fenced_at, "replay_writers_not_fenced");
  let diagnostic = beginExecutionDiagnostic("seal.journal");
  try {
    await validateJournal(tx, run.runId);
    finishExecutionDiagnostic(diagnostic, "end");
    diagnostic = beginExecutionDiagnostic("seal.event_write");
    const [head] = await tx`UPDATE pipeline_replay.capacity_runs SET event_seq=event_seq+1
    WHERE run_id=${run.runId} RETURNING event_seq`;
    await tx`INSERT INTO pipeline_replay.capacity_transitions(run_id,seq,kind,payload)
    VALUES (${run.runId},${head.event_seq},'sealed','{}'::jsonb)`;
    await tx`UPDATE pipeline_replay.capacity_runs SET sealed_at=(SELECT at FROM pipeline_replay.capacity_transitions
    WHERE run_id=${run.runId} AND seq=${head.event_seq}) WHERE run_id=${run.runId}`;
    finishExecutionDiagnostic(diagnostic, "end");
    diagnostic = beginExecutionDiagnostic("seal.artifact_content");
    const { row: state, content } = await artifactContent(tx, run.runId);
    finishExecutionDiagnostic(diagnostic, "end", { packets: content.readiness.transactions.length,
      events: content.journal.length, calls: content.calls.length, finals: content.finals.length });
    diagnostic = beginExecutionDiagnostic("seal.strict_parse");
    const { parseReplayArtifact, replayArtifactSchema, replayItemArtifactSchema, replayArtifactContentHash } = await import("./pipeline-replay-artifact");
    const parsedContent = (content.version === 2 ? replayItemArtifactSchema : replayArtifactSchema).omit({ seal: true }).parse(content);
    const seal = { headSeq: Number(state.event_seq), manifestHash: reviewHash(parsedContent.manifest),
      initialStateHash: parsedContent.initial.initialStateHash, comparisonStateHash: parsedContent.initial.comparisonStateHash,
      contentHash: replayArtifactContentHash(parsedContent) };
    parseReplayArtifact({ ...parsedContent, seal });
    finishExecutionDiagnostic(diagnostic, "end");
    diagnostic = beginExecutionDiagnostic("seal.final_update");
    await tx`UPDATE pipeline_replay.capacity_runs SET state='sealed',seal=${JSON.stringify(seal)}::text::jsonb WHERE run_id=${run.runId}`;

    finishExecutionDiagnostic(diagnostic, "end");
  } catch (error) {
    finishExecutionDiagnostic(diagnostic, "reject");
    throw error;
  }
}
/** A fixed DB readback verifies the protected seal; artifact JSON cannot authorize this read. */
export async function readSealedReplayArtifact(database: VerifiedReplayDatabase, runId: string): Promise<unknown> {
  assertVerifiedReplayHandlerDatabase(database);
  return database.client.begin(async tx => {
    await verifyReplayDatabaseSession(tx, database);
    const [state] = await tx`SELECT state FROM pipeline_replay.capacity_runs WHERE run_id=${runId} FOR UPDATE`;
    ensure(state?.state === 'sealed', "replay_run_not_sealed");
    await validateJournal(tx, runId);
    const { row, content } = await artifactContent(tx, runId);
    const { parseReplayArtifact, replayAnyArtifactSchema, replayArtifactContentHash } = await import("./pipeline-replay-artifact");
    const parsed = replayAnyArtifactSchema.parse({ ...content, seal: row.seal });
    const { seal, ...sealedContent } = parsed;
    ensure(replayArtifactContentHash(sealedContent) === seal.contentHash, "replay_seal_content_mismatch");
    const artifact = parseReplayArtifact(parsed);
    await verifyReplayDatabaseSession(tx, database); return artifact;
  });
}
