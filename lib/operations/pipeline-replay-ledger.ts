import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { MAX_REVIEW_INPUT_BYTES, REVIEW_FRESH_MS, reviewHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { parseCapacityManifest, type CapacityManifest } from "./pipeline-capacity";
import { assertVerifiedReplayDatabase, verifyReplayDatabaseSession, type VerifiedReplayDatabase } from "./pipeline-replay-database";

const hash = z.string().regex(/^[a-f0-9]{64}$/), positive = z.number().int().positive().safe();
const callSchema = z.object({ callId: z.string().min(1).max(160), candidateId: positive, firstAttemptId: positive,
  inputHash: hash, sourceRevisionHash: hash, stage: z.enum(["first", "second"]), provider: z.string().min(1).max(160),
  model: z.string().min(1).max(160), requestHash: hash, tokenUpperBound: positive }).strict();
export type ReplayCallRequest = z.infer<typeof callSchema>;
export type ReplayReceipt = { inputTokens: number; outputTokens: number } | null;
const runBrand: unique symbol = Symbol("ReplayRun");
export type ReplayRun = Readonly<{ [runBrand]: true; runId: string }>;
type RunIdentity = { ledger: ReplayLedger; ownerId: string; manifest: CapacityManifest; admissionClosed: boolean };
const runs = new WeakMap<object, RunIdentity>();
class ReplayLedgerError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new ReplayLedgerError(code); };
function ensure(value: unknown, code: string): asserts value { if (!value) fail(code); }
type Row = postgres.Row;
type Tx = postgres.TransactionSql;
const active = ["reserved", "dispatching", "in_flight", "indeterminate"];
const key = (value: { candidateId: number; inputHash: string; sourceRevisionHash: string }) =>
  `${value.candidateId}:${value.inputHash}:${value.sourceRevisionHash}`;
const number = (value: unknown) => { const result = Number(value); ensure(Number.isSafeInteger(result), "replay_counter_overflow"); return result; };

function frozenInputs(manifest: CapacityManifest, inputs: { candidateId: number; input: ReviewInput }[]) {
  const expected = new Map(manifest.inputs.map(item => [key(item), item]));
  ensure(inputs.length === expected.size, "replay_input_mismatch");
  const seen = new Set<string>();
  return inputs.map(({ candidateId, input }) => {
    try {
      const serialized = JSON.parse(JSON.stringify(input));
      const { snapshot, source } = input, reference = Date.parse(manifest.referenceTime);
      const fetched = Date.parse(source.documentFetchedAt), scan = source.scanCompletedAt === null ? Infinity : Date.parse(source.scanCompletedAt);
      const validUntil = Math.min(fetched + REVIEW_FRESH_MS, scan + REVIEW_FRESH_MS);
      const semantic = { ...snapshot, evidence: snapshot.evidence.map(item => item.observation) };
      const identity = { candidateId, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash }, identityKey = key(identity);
      ensure(expected.has(identityKey) && !seen.has(identityKey) && input.policyHash === manifest.inputPolicyHash
        && input.inputHash === reviewHash({ snapshot: semantic, policyHash: input.policyHash })
        && input.sourceRevisionHash === reviewHash(source) && input.validUntil instanceof Date
        && +input.validUntil === validUntil && fetched <= reference && (scan === Infinity || scan <= reference)
        && validUntil > reference && Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_REVIEW_INPUT_BYTES,
      "replay_input_mismatch");
      seen.add(identityKey);
      return { ...identity, frozen: serialized, frozenHash: reviewHash(serialized) };
    } catch { return fail("replay_input_mismatch"); }
  });
}

/** Unused by live workers. All writes are fenced to a verified, restricted local test session. */
export class ReplayLedger {
  constructor(private readonly database: VerifiedReplayDatabase) { assertVerifiedReplayDatabase(database); }
  private identity(run: ReplayRun): RunIdentity {
    const value = run && runs.get(run);
    ensure(value?.ledger === this, "replay_run_required"); return value;
  }
  private async transaction<T>(load: (tx: Tx) => Promise<T>): Promise<T> {
    assertVerifiedReplayDatabase(this.database);
    try {
      return await this.database.client.begin(async tx => {
        await verifyReplayDatabaseSession(tx, this.database);
        return load(tx);
      }) as T;
    } catch (error) {
      if (error instanceof ReplayLedgerError) throw error;
      throw new ReplayLedgerError("replay_ledger_operation_failed");
    }
  }
  private async locked(tx: Tx, run: ReplayRun): Promise<Row> {
    const identity = this.identity(run);
    const [row] = await tx`SELECT * FROM pipeline_replay.capacity_runs
      WHERE run_id = ${run.runId} AND owner_id = ${identity.ownerId} FOR UPDATE`;
    ensure(row && row.manifest_hash === reviewHash(identity.manifest), "replay_run_identity_mismatch");
    // Clock projection in SELECT FOR UPDATE can be evaluated before waiting for a lock.
    const [clock] = await tx`SELECT clock_timestamp() AS wall_now`;
    return { ...row, wall_now: clock.wall_now };
  }
  private async event(tx: Tx, runId: string, kind: string, payload: Record<string, unknown> = {}) {
    const [row] = await tx`UPDATE pipeline_replay.capacity_runs SET event_seq = event_seq + 1 WHERE run_id = ${runId} RETURNING event_seq`;
    await tx`INSERT INTO pipeline_replay.capacity_transitions (run_id, seq, kind, payload)
      VALUES (${runId}, ${row.event_seq}, ${kind}, ${tx.json(payload as postgres.JSONValue)})`;
  }
  async prepare(value: unknown, inputs: { candidateId: number; input: ReviewInput }[]): Promise<ReplayRun> {
    let manifest: CapacityManifest;
    try {
      manifest = parseCapacityManifest(value);
      const planned = manifest.limits.maxCalls * manifest.limits.perCallTokenUpperBound;
      ensure(Number.isSafeInteger(planned) && planned <= manifest.limits.maxTokens, "invalid_replay_manifest");
    } catch { return fail("invalid_replay_manifest"); }
    const frozen = frozenInputs(manifest, inputs), ownerId = randomUUID();
    await this.transaction(async tx => {
      await tx`INSERT INTO pipeline_replay.capacity_runs (run_id, owner_id, manifest, manifest_hash, state)
        VALUES (${manifest.runId}, ${ownerId}, ${tx.json(manifest)}, ${reviewHash(manifest)}, 'prepared')`;
      for (const item of frozen) await tx`INSERT INTO pipeline_replay.capacity_inputs
        (run_id, candidate_id, input_hash, source_revision_hash, frozen_input, frozen_hash)
        VALUES (${manifest.runId}, ${item.candidateId}, ${item.inputHash}, ${item.sourceRevisionHash}, ${tx.json(item.frozen)}, ${item.frozenHash})`;
      await this.event(tx, manifest.runId, "prepared");
    });
    const run = Object.freeze({ [runBrand]: true as const, runId: manifest.runId });
    runs.set(run, { ledger: this, ownerId, manifest, admissionClosed: false }); return run;
  }
  async start(run: ReplayRun): Promise<void> {
    await this.transaction(async tx => {
      await tx`SELECT pg_advisory_xact_lock(1485803, 2)`;
      const row = await this.locked(tx, run);
      ensure(row.state === "prepared", "replay_run_state_mismatch");
      const [other] = await tx`SELECT 1 FROM pipeline_replay.capacity_runs WHERE state IN ('running','draining') LIMIT 1`;
      ensure(!other, "replay_active_run_exists");
      await tx`UPDATE pipeline_replay.capacity_runs SET state = 'running', started_at = clock_timestamp(),
        deadline_at = clock_timestamp() + ${this.identity(run).manifest.limits.maxDurationMs} * interval '1 millisecond' WHERE run_id = ${run.runId}`;
      await this.event(tx, run.runId, "started");
    });
  }
  async fixtureMode(run: ReplayRun): Promise<void> {
    await this.transaction(async tx => {
      await this.locked(tx, run);
      ensure(this.identity(run).manifest.mode === "fixtures", "unsupported_provider_budget");
    });
  }
  private async admission(tx: Tx, run: ReplayRun, row: Row): Promise<string | null> {
    const identity = this.identity(run);
    if (identity.admissionClosed || row.state !== "running") {
      if (row.state === "running") {
        await tx`UPDATE pipeline_replay.capacity_runs SET state = 'draining' WHERE run_id = ${run.runId}`;
        await this.event(tx, run.runId, "admission_closed");
      }
      return "replay_run_not_running";
    }
    if (+row.wall_now >= +row.deadline_at) {
      identity.admissionClosed = true;
      await tx`UPDATE pipeline_replay.capacity_runs SET state = 'draining' WHERE run_id = ${run.runId}`;
      await this.event(tx, run.runId, "deadline"); return "replay_deadline_elapsed";
    }
    return null;
  }
  async reserve(run: ReplayRun, value: ReplayCallRequest): Promise<void> {
    let call: ReplayCallRequest;
    try { call = callSchema.parse(value); } catch { return fail("replay_call_binding_mismatch"); }
    const denial = await this.transaction(async tx => {
      const row = await this.locked(tx, run), manifest = this.identity(run).manifest;
      const denied = await this.admission(tx, run, row);
      if (denied) return denied;
      // Actual providers remain closed even if a caller bypasses the fixture transport wrapper.
      ensure(manifest.mode === "fixtures", "unsupported_provider_budget");
      const models = call.stage === "first" ? [manifest.models.first] : [...manifest.models.second, ...manifest.models.fallbacks];
      ensure(models.some(item => item.provider === call.provider && item.model === call.model && item.canonicalModel === canonicalReviewModel(call.model))
        && manifest.inputs.some(item => key(item) === key(call)) && call.tokenUpperBound <= manifest.limits.perCallTokenUpperBound,
      "replay_call_binding_mismatch");
      const [prior] = await tx`SELECT 1 FROM pipeline_replay.capacity_calls WHERE run_id = ${run.runId} AND call_id = ${call.callId}`;
      ensure(!prior, "replay_call_id_reused");
      const [count] = await tx`SELECT count(*) AS active FROM pipeline_replay.capacity_calls WHERE run_id = ${run.runId} AND state IN ${tx(active)}`;
      ensure(number(count.active) < manifest.limits.concurrency, "replay_concurrency_full");
      const calls = number(row.charged_calls) + 1, tokens = number(row.charged_tokens) + call.tokenUpperBound;
      ensure(Number.isSafeInteger(tokens) && calls <= manifest.limits.maxCalls && tokens <= manifest.limits.maxTokens, "replay_budget_exhausted");
      await tx`INSERT INTO pipeline_replay.capacity_calls (run_id, call_id, candidate_id, first_attempt_id, input_hash,
        source_revision_hash, stage, provider, model, request_hash, token_upper_bound, state)
        VALUES (${run.runId}, ${call.callId}, ${call.candidateId}, ${call.firstAttemptId}, ${call.inputHash}, ${call.sourceRevisionHash},
        ${call.stage}, ${call.provider}, ${call.model}, ${call.requestHash}, ${call.tokenUpperBound}, 'reserved')`;
      await tx`UPDATE pipeline_replay.capacity_runs SET charged_calls = ${calls}, charged_tokens = ${tokens} WHERE run_id = ${run.runId}`;
      await this.event(tx, run.runId, "reserved", { callId: call.callId, tokenUpperBound: call.tokenUpperBound });
      return null;
    });
    if (denial) fail(denial);
  }
  private async move(run: ReplayRun, callId: string, from: string, to: string): Promise<void> {
    const denial = await this.transaction(async tx => {
      const row = await this.locked(tx, run);
      if (to !== "cancelled_before_dispatch") {
        const denied = await this.admission(tx, run, row);
        if (denied) return denied;
      }
      ensure(["running", "draining"].includes(row.state), "replay_run_state_mismatch");
      const [changed] = await tx`UPDATE pipeline_replay.capacity_calls SET state = ${to},
        dispatched_at = CASE WHEN ${to} = 'in_flight' THEN clock_timestamp() ELSE dispatched_at END
        WHERE run_id = ${run.runId} AND call_id = ${callId} AND state = ${from} RETURNING call_id`;
      ensure(changed, "replay_call_state_mismatch");
      await this.event(tx, run.runId, to, { callId }); return null;
    });
    if (denial) fail(denial);
  }
  markDispatching(run: ReplayRun, callId: string) { return this.move(run, callId, "reserved", "dispatching"); }
  markInFlight(run: ReplayRun, callId: string) { return this.move(run, callId, "dispatching", "in_flight"); }
  cancelBeforeDispatch(run: ReplayRun, callId: string) { return this.move(run, callId, "reserved", "cancelled_before_dispatch"); }
  async settle(run: ReplayRun, callId: string, receipt: ReplayReceipt): Promise<void> {
    const uncertain = await this.transaction(async tx => {
      await this.locked(tx, run);
      const [call] = await tx`SELECT * FROM pipeline_replay.capacity_calls WHERE run_id = ${run.runId} AND call_id = ${callId} FOR UPDATE`;
      ensure(call?.state === "in_flight", "replay_call_state_mismatch");
      const valid = receipt && Number.isSafeInteger(receipt.inputTokens) && receipt.inputTokens >= 0
        && Number.isSafeInteger(receipt.outputTokens) && receipt.outputTokens >= 0
        && Number.isSafeInteger(receipt.inputTokens + receipt.outputTokens)
        && receipt.inputTokens + receipt.outputTokens <= number(call.token_upper_bound);
      if (!valid) { this.identity(run).admissionClosed = true; await this.uncertain(tx, run, callId); return true; }
      await tx`UPDATE pipeline_replay.capacity_calls SET state = 'settled', settled_at = clock_timestamp(),
        input_tokens = ${receipt.inputTokens}, output_tokens = ${receipt.outputTokens} WHERE run_id = ${run.runId} AND call_id = ${callId}`;
      await this.event(tx, run.runId, "settled", { callId }); return false;
    });
    if (uncertain) fail("replay_call_indeterminate");
  }
  private async uncertain(tx: Tx, run: ReplayRun, callId: string) {
    await tx`UPDATE pipeline_replay.capacity_calls SET state = 'indeterminate' WHERE run_id = ${run.runId} AND call_id = ${callId}`;
    await tx`UPDATE pipeline_replay.capacity_runs SET state = 'draining' WHERE run_id = ${run.runId}`;
    await this.event(tx, run.runId, "indeterminate", { callId });
  }
  async markIndeterminate(run: ReplayRun, callId: string): Promise<void> {
    // Poison this opaque owner immediately, even when the following DB transaction fails.
    this.identity(run).admissionClosed = true;
    await this.transaction(async tx => {
      await this.locked(tx, run);
      const [call] = await tx`SELECT state FROM pipeline_replay.capacity_calls WHERE run_id = ${run.runId} AND call_id = ${callId} FOR UPDATE`;
      ensure(call && ["dispatching", "in_flight", "indeterminate"].includes(call.state), "replay_call_state_mismatch");
      if (call.state !== "indeterminate") await this.uncertain(tx, run, callId);
    });
  }
  async drain(run: ReplayRun): Promise<void> {
    this.identity(run).admissionClosed = true;
    await this.transaction(async tx => {
      const row = await this.locked(tx, run);
      ensure(["running", "draining"].includes(row.state), "replay_run_state_mismatch");
      if (row.state === "running") {
        await tx`UPDATE pipeline_replay.capacity_runs SET state = 'draining' WHERE run_id = ${run.runId}`;
        await this.event(tx, run.runId, "draining");
      }
    });
  }
  async inspect(run: ReplayRun) {
    return this.transaction(async tx => {
      const row = await this.locked(tx, run);
      const [counts] = await tx`SELECT count(*) AS active FROM pipeline_replay.capacity_calls WHERE run_id = ${run.runId} AND state IN ${tx(active)}`;
      return { runId: run.runId, state: row.state as string, chargedCalls: number(row.charged_calls), chargedTokens: number(row.charged_tokens),
        activeCalls: number(counts.active), eventSeq: number(row.event_seq), evidence: "fixture_call_ledger_only" as const,
        authenticity: "unverified" as const, finalThroughput: null };
    });
  }
}
