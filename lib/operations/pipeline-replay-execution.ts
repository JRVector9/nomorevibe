import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { sql } from "drizzle-orm";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { assertSameReplayHandlerDatabase, assertVerifiedReplayDatabase, assertVerifiedReplayHandlerDatabase,
  verifyReplayDatabaseSession, type VerifiedReplayDatabase } from "./pipeline-replay-database";
import { replayFinalRunBinding, type ReplayRun } from "./pipeline-replay-ledger";

const brand: unique symbol = Symbol("ReplayTransactionTicket");
export type ReplayTransactionTicket = Readonly<{ [brand]: true }>;
const proofBrand: unique symbol = Symbol("ReplayQuiescenceProof");
export type ReplayQuiescenceProof = Readonly<{ [proofBrand]: true }>;
type Raw = postgres.TransactionSql;
type Binding = ReturnType<typeof replayFinalRunBinding>;
type Scope = { run: ReplayRun; binding: Binding; active: boolean; pending: Set<ReplayTransactionTicket> };
type Ticket = { scope: Scope; tx: Raw; txKey: string; txStartedAt: string; dbXid: string;
  state: "open" | "flushed" | "confirmed" | "rolled_back"; callbacks: Array<(run: Record<string, unknown>, raw: Raw) => Promise<void>> };
const executions = new AsyncLocalStorage<Scope>();
const tickets = new WeakMap<ReplayTransactionTicket, Ticket>();
const keys = new Map<string, ReplayTransactionTicket>();
const proofs = new WeakMap<ReplayQuiescenceProof, { run: ReplayRun; binding: Binding }>();
const latestProof = new WeakMap<ReplayRun, ReplayQuiescenceProof>();
const enteredRuns = new WeakSet<ReplayRun>();
function ensure(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }

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
      tickets.set(token, { scope, tx, txKey, txStartedAt: clock.at, dbXid: clock.xid, state: "open", callbacks: [] });
      keys.set(txKey, token); scope.pending.add(token); return token;
    },
    async after(tx, token) {
      if (!token) return;
      const value = tickets.get(token);
      ensure(value?.tx === tx && value.state === "open" && value.scope.active, "replay_transaction_ticket_mismatch");
      await flushReplayTransaction(value);
      value.state = "flushed";
    },
    async commitAck(token) {
      if (!token) return;
      const value = tickets.get(token);
      ensure(value?.state === "flushed", "replay_transaction_ticket_mismatch");
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
  const rawChanges = [...await tx`SELECT ordinal, table_name, operation, old_row, new_row
    FROM pipeline_replay.capacity_changes WHERE run_id = ${scope.run.runId} AND tx_key = ${value.txKey}::uuid ORDER BY ordinal`];
  const { applyReplayChanges, ReplayReadinessProjectionSchema, ReplayReadinessChangeSchema } = await import("./pipeline-replay-readiness");
  const changes = rawChanges.map(row => ReplayReadinessChangeSchema.parse({ ...row, ordinal: Number(row.ordinal) }));
  const [run] = await tx`SELECT * FROM pipeline_replay.capacity_runs WHERE run_id = ${scope.run.runId}
    AND owner_id = ${scope.binding.ownerId}::uuid FOR UPDATE`;
  ensure(run && ['running','draining'].includes(run.state) && !run.writers_fenced_at, "replay_writers_fenced");
  const projection = applyReplayChanges(ReplayReadinessProjectionSchema.parse(run.current_projection), changes);
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
  ensure(row?.initial_projection && row.initial_state_hash && row.writers_fenced_at && row.sealed_at, "replay_run_not_sealed");
  const journalRows = await tx`SELECT to_jsonb(e) AS value FROM pipeline_replay.capacity_transitions e WHERE run_id=${runId} ORDER BY seq`;
  const transactionRows = await tx`SELECT to_jsonb(t) || jsonb_build_object('confirmed_at',c.confirmed_at) AS value
    FROM pipeline_replay.capacity_transactions t LEFT JOIN pipeline_replay.capacity_commit_confirmations c
      ON c.run_id=t.run_id AND c.tx_key=t.tx_key WHERE t.run_id=${runId} ORDER BY t.seq`;
  const callRows = await tx`SELECT to_jsonb(c) AS value FROM pipeline_replay.capacity_calls c WHERE run_id=${runId} ORDER BY call_id`;
  const finalRows = await tx`SELECT to_jsonb(f) AS value FROM pipeline_replay.capacity_finals f WHERE run_id=${runId} ORDER BY seq`;
  const journal = journalRows.map(({ value: item }) => ({ seq: Number(item.seq), at: utc(item.at), kind: item.kind,
    txKey: item.tx_key, payloadHash: reviewHash(item.payload) }));
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
  return { row, content: { kind: "pipeline-replay-ledger" as const, version: 1 as const, manifest: row.manifest,
    run: { runId, epoch: Number(row.epoch), profile: "handlers-v5" as const, state: "sealed" as const,
      startedAt: utc(row.started_at), deadlineAt: utc(row.deadline_at), admissionClosedAt: utc(row.admission_closed_at),
      writersFencedAt: utc(row.writers_fenced_at), sealedAt: utc(row.sealed_at),
      chargedCalls: Number(row.charged_calls), chargedTokens: Number(row.charged_tokens) },
    initial: { capturedAt: utc(row.captured_at), initialStateHash: row.initial_state_hash,
      comparisonStateHash: row.comparison_state_hash, projection: row.initial_projection, runner: row.runner, quality: row.quality },
    journal, readiness: { transactions, gaps: [] }, calls, finals } };
}

async function validateJournal(tx: Raw, runId: string): Promise<void> {
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
  let projection = ReplayReadinessProjectionSchema.parse(run.initial_projection);
  const frozen = await tx`SELECT candidate_id,input_hash,source_revision_hash,frozen_input,frozen_hash
    FROM pipeline_replay.capacity_inputs WHERE run_id=${runId} ORDER BY candidate_id,input_hash,source_revision_hash`;
  const actualInputs = frozen.map(row => ({ candidateId: Number(row.candidate_id), inputHash: row.input_hash,
    sourceRevisionHash: row.source_revision_hash, frozenInput: row.frozen_input, frozenHash: row.frozen_hash }));
  const expectedInputs = projection.universe.map(({ candidateId, inputHash, sourceRevisionHash, frozenInput, frozenHash }) =>
    ({ candidateId, inputHash, sourceRevisionHash, frozenInput, frozenHash }));
  ensure(reviewHash(actualInputs) === reviewHash(expectedInputs), "replay_journal_binding_mismatch");
  const packets = await tx`SELECT tx_key,changes FROM pipeline_replay.capacity_transactions WHERE run_id=${runId} ORDER BY seq`;
  for (const packet of packets) {
    const actual = await tx`SELECT ordinal,table_name,operation,old_row,new_row FROM pipeline_replay.capacity_changes
      WHERE run_id=${runId} AND tx_key=${packet.tx_key} ORDER BY ordinal`;
    const changes = actual.map(item => ReplayReadinessChangeSchema.parse({ ...item, ordinal: Number(item.ordinal) }));
    ensure(reviewHash(changes) === reviewHash(packet.changes), "replay_journal_binding_mismatch");
    projection = applyReplayChanges(projection, changes);
  }
  ensure(reviewHash(projection) === reviewHash(run.current_projection), "replay_journal_binding_mismatch");
  const [counts] = await tx`SELECT count(*) AS count,min(seq) AS min,max(seq) AS max FROM pipeline_replay.capacity_transitions WHERE run_id=${runId}`;
  ensure(Number(counts.count) === Number(run.event_seq) && Number(counts.min) === 1
    && Number(counts.max) === Number(run.event_seq), "replay_sequence_mismatch");
}

/** Called solely by the authentic ledger after its opaque quiescence proof is checked. */
export async function sealReplayLedger(tx: Raw, run: ReplayRun, ownerId: string, proof: ReplayQuiescenceProof): Promise<void> {
  assertReplayQuiescence(run, proof);
  await tx`SELECT pg_advisory_xact_lock(1485803,2)`;
  await tx`SELECT pg_advisory_xact_lock(1485803,4)`;
  const [row] = await tx`SELECT state,writers_fenced_at FROM pipeline_replay.capacity_runs
    WHERE run_id=${run.runId} AND owner_id=${ownerId}::uuid FOR UPDATE`;
  ensure(row?.state === "draining" && row.writers_fenced_at, "replay_writers_not_fenced");
  await validateJournal(tx, run.runId);
  const [head] = await tx`UPDATE pipeline_replay.capacity_runs SET event_seq=event_seq+1
    WHERE run_id=${run.runId} RETURNING event_seq`;
  await tx`INSERT INTO pipeline_replay.capacity_transitions(run_id,seq,kind,payload)
    VALUES (${run.runId},${head.event_seq},'sealed','{}'::jsonb)`;
  await tx`UPDATE pipeline_replay.capacity_runs SET sealed_at=(SELECT at FROM pipeline_replay.capacity_transitions
    WHERE run_id=${run.runId} AND seq=${head.event_seq}) WHERE run_id=${run.runId}`;
  const { row: state, content } = await artifactContent(tx, run.runId);
  const { parseReplayArtifact, replayArtifactSchema, replayArtifactContentHash } = await import("./pipeline-replay-artifact");
  const parsedContent = replayArtifactSchema.omit({ seal: true }).parse(content);
  const seal = { headSeq: Number(state.event_seq), manifestHash: reviewHash(parsedContent.manifest),
    initialStateHash: parsedContent.initial.initialStateHash, comparisonStateHash: parsedContent.initial.comparisonStateHash,
    contentHash: replayArtifactContentHash(parsedContent) };
  parseReplayArtifact({ ...parsedContent, seal });
  await tx`UPDATE pipeline_replay.capacity_runs SET state='sealed',seal=${JSON.stringify(seal)}::text::jsonb WHERE run_id=${run.runId}`;
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
    const { parseReplayArtifact, replayArtifactSchema, replayArtifactContentHash } = await import("./pipeline-replay-artifact");
    const parsed = replayArtifactSchema.parse({ ...content, seal: row.seal });
    const { seal, ...sealedContent } = parsed;
    ensure(replayArtifactContentHash(sealedContent) === seal.contentHash, "replay_seal_content_mismatch");
    const artifact = parseReplayArtifact(parsed);
    await verifyReplayDatabaseSession(tx, database); return artifact;
  });
}
