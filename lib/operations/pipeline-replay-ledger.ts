import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { z } from "zod";
import { MAX_REVIEW_INPUT_BYTES, REVIEW_FRESH_MS, reviewHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { parseCapacityManifest, type CapacityManifest } from "./pipeline-capacity";
import { assertVerifiedReplayDatabase, verifyReplayDatabaseSession, type VerifiedReplayDatabase } from "./pipeline-replay-database";
import { assertReplayQuiescence, currentReplayTransactionHooks, type ReplayQuiescenceProof } from "./pipeline-replay-execution";

const hash = z.string().regex(/^[a-f0-9]{64}$/), positive = z.number().int().positive().safe();
const callBase = { callId: z.string().min(1).max(160), candidateId: positive,
  inputHash: hash, sourceRevisionHash: hash, provider: z.string().min(1).max(160),
  model: z.string().min(1).max(160), requestHash: hash, tokenUpperBound: positive };
const callSchema = z.discriminatedUnion("stage", [
  z.object({ ...callBase, stage: z.literal("first"), firstAttemptId: positive }).strict(),
  z.object({ ...callBase, stage: z.literal("second"), firstAttemptId: positive.nullable(), secondReviewId: positive,
    generationKey: z.string().min(1).max(160), vote: positive }).strict(),
]);
export type ReplayCallRequest = z.infer<typeof callSchema>;
export type ReplayReceipt = { inputTokens: number; outputTokens: number } | null;
const resultProofSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), outcomeHash: hash, decisionHash: hash }).strict(),
  z.object({ ok: z.literal(false), outcomeHash: z.null(), decisionHash: z.null(),
    error: z.enum(["not_configured", "input_too_large", "timeout", "cancelled", "output_too_large", "missing_cli", "auth",
      "cli_error", "invalid_output", "max_turns", "budget", "rate_limited", "model_unavailable", "gateway_error"]).optional() }).strict(),
]);
export type ReplayResultProof = z.infer<typeof resultProofSchema>;
const runBrand: unique symbol = Symbol("ReplayRun");
export type ReplayRun = Readonly<{ [runBrand]: true; runId: string }>;
type RunIdentity = { ledger: ReplayLedger; database: VerifiedReplayDatabase; ownerId: string; manifest: CapacityManifest;
  admissionClosed: boolean; writersFenced: boolean; certified: boolean };
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

/** Internal bridge: only an authentic owner handle can construct the final recorder scope. */
export function replayFinalRunBinding(run: ReplayRun) {
  const identity = run && runs.get(run);
  ensure(identity, "replay_run_required");
  assertVerifiedReplayDatabase(identity.database);
  return Object.freeze({ database: identity.database, ownerId: identity.ownerId, certified: identity.certified,
    manifest: structuredClone(identity.manifest),
    assertActive() {
      ensure(runs.get(run) === identity && !identity.writersFenced, "replay_final_scope_closed");
      assertVerifiedReplayDatabase(identity.database);
    } });
}

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
  private async transaction<T>(load: (tx: Tx) => Promise<T>, journalRun?: ReplayRun): Promise<T> {
    assertVerifiedReplayDatabase(this.database);
    const hooks = journalRun && this.identity(journalRun).certified ? currentReplayTransactionHooks(this.database) : undefined;
    let ticket: Awaited<ReturnType<NonNullable<typeof hooks>["before"]>>;
    let committed = false;
    try {
      const result = await this.database.client.begin(async tx => {
        await verifyReplayDatabaseSession(tx, this.database);
        ticket = await hooks?.before(tx);
        const result = await load(tx);
        await hooks?.after(tx, ticket);
        return result;
      }) as T;
      committed = true;
      await hooks?.commitAck(ticket); return result;
    } catch (error) {
      if (!committed) hooks?.rollback(ticket);
      if (error instanceof ReplayLedgerError) throw error;
      if (error instanceof Error && ["replay_review_kind_mismatch", "replay_readiness_explicit_first_reviewer_required"].includes(error.message))
        throw new ReplayLedgerError(error.message);
      throw new ReplayLedgerError("replay_ledger_operation_failed");
    }
  }
  private async locked(tx: Tx, run: ReplayRun): Promise<Row> {
    const identity = this.identity(run);
    const [row] = await tx`SELECT * FROM pipeline_replay.capacity_runs
      WHERE run_id = ${run.runId} AND owner_id = ${identity.ownerId} FOR UPDATE`;
    ensure(row && row.manifest_hash === reviewHash(identity.manifest), "replay_run_identity_mismatch");
    // Clock projection in SELECT FOR UPDATE can be evaluated before waiting for a lock.
    const [clock] = await tx`SELECT clock_timestamp() AS wall_now,clock_timestamp()>=deadline_at AS deadline_elapsed
      FROM pipeline_replay.capacity_runs WHERE run_id=${run.runId}`;
    return { ...row, wall_now: clock.wall_now, deadline_elapsed: clock.deadline_elapsed };
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
    runs.set(run, { ledger: this, database: this.database, ownerId, manifest, admissionClosed: false,
      writersFenced: false, certified: false }); return run;
  }
  async prepareCertified(value: unknown, inputs: { candidateId: number; input: ReviewInput }[], options: {
    runner: { jobs: readonly ("crawl-agent-review" | "second-review")[]; budgetMs: number }; quality: unknown | null;
  }): Promise<ReplayRun> {
    const { replayQualitySchema, replayQualityDatasetHash } = await import("./pipeline-replay-artifact");
    const runner = { jobs: [...options.runner.jobs], budgetMs: options.runner.budgetMs };
    ensure(runner.jobs.length > 0 && runner.jobs.length <= 100 && runner.jobs.every(name => ['crawl-agent-review','second-review'].includes(name))
      && Number.isSafeInteger(runner.budgetMs) && runner.budgetMs > 0 && runner.budgetMs <= 110_000, "invalid_replay_runner_options");
    const quality = options.quality === null ? null : replayQualitySchema.parse(options.quality);
    ensure(!quality || quality.datasetHash === replayQualityDatasetHash(quality), "replay_quality_mismatch");
    const manifest = parseCapacityManifest(value), frozen = frozenInputs(manifest, inputs), ownerId = randomUUID();
    ensure(Number.isSafeInteger(manifest.limits.maxCalls * manifest.limits.perCallTokenUpperBound)
      && manifest.limits.maxCalls * manifest.limits.perCallTokenUpperBound <= manifest.limits.maxTokens, "invalid_replay_manifest");
    await this.transaction(async tx => {
      await tx`SELECT pg_advisory_xact_lock(1485803,2)`;
      await tx`SELECT pg_advisory_xact_lock(1485803,4)`;
      const [active] = await tx`SELECT 1 FROM pipeline_replay.capacity_runs WHERE state IN ('running','draining') LIMIT 1`;
      ensure(!active, "replay_active_run_exists");
      const { captureReplayReadinessProjection } = await import("./pipeline-replay-readiness");
      const initial = await captureReplayReadinessProjection(tx, manifest, frozen);
      ensure(initial.initialStateHash === manifest.initialStateHash, "replay_initial_state_mismatch");
      const { assertReplayInitialReviewKinds } = await import("./pipeline-replay-classification");
      assertReplayInitialReviewKinds(initial.projection, manifest);
      await tx`INSERT INTO pipeline_replay.capacity_runs (run_id,owner_id,manifest,manifest_hash,state,runner,quality,
        initial_projection,current_projection,initial_state_hash,comparison_state_hash,captured_at)
        VALUES (${manifest.runId},${ownerId},${tx.json(manifest)},${reviewHash(manifest)},'prepared',${tx.json(runner)},${quality === null ? null : tx.json(quality)},
          ${tx.json(initial.projection)},${tx.json(initial.projection)},${initial.initialStateHash},${initial.comparisonStateHash},${initial.capturedAt}::text::timestamptz)`;
      for (const item of frozen) await tx`INSERT INTO pipeline_replay.capacity_inputs
        (run_id,candidate_id,input_hash,source_revision_hash,frozen_input,frozen_hash)
        VALUES (${manifest.runId},${item.candidateId},${item.inputHash},${item.sourceRevisionHash},${tx.json(item.frozen)},${item.frozenHash})`;
      const actual = await captureReplayReadinessProjection(tx, manifest);
      ensure(actual.initialStateHash === initial.initialStateHash, "replay_initial_state_mismatch");
      await this.event(tx, manifest.runId, "prepared");
    });
    const run = Object.freeze({ [runBrand]: true as const, runId: manifest.runId });
    runs.set(run, { ledger: this, database: this.database, ownerId, manifest, admissionClosed: false, writersFenced: false, certified: true });
    return run;
  }
  async previewInitialState(value: unknown, inputs: { candidateId: number; input: ReviewInput }[]) {
    const manifest = parseCapacityManifest(value), frozen = frozenInputs(manifest, inputs);
    return this.transaction(async tx => {
      await tx`SELECT pg_advisory_xact_lock(1485803,2)`;
      await tx`SELECT pg_advisory_xact_lock(1485803,4)`;
      const { captureReplayReadinessProjection } = await import("./pipeline-replay-readiness");
      return captureReplayReadinessProjection(tx, manifest, frozen);
    });
  }
  async start(run: ReplayRun): Promise<void> {
    await this.transaction(async tx => {
      await tx`SELECT pg_advisory_xact_lock(1485803, 2)`;
      if (this.identity(run).certified) await tx`SELECT pg_advisory_xact_lock(1485803,4)`;
      const current = this.identity(run).certified
        ? await (await import("./pipeline-replay-readiness")).captureReplayReadinessProjection(tx, this.identity(run).manifest) : undefined;
      const row = await this.locked(tx, run);
      ensure(row.state === "prepared", "replay_run_state_mismatch");
      const [other] = await tx`SELECT 1 FROM pipeline_replay.capacity_runs WHERE state IN ('running','draining') LIMIT 1`;
      ensure(!other, "replay_active_run_exists");
      if (current) ensure(current.initialStateHash === row.initial_state_hash, "replay_initial_state_mismatch");
      await tx`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at)
        UPDATE pipeline_replay.capacity_runs SET state = 'running', started_at = clock.at,
        deadline_at = clock.at + ${this.identity(run).manifest.limits.maxDurationMs} * interval '1 millisecond'
        FROM clock WHERE run_id = ${run.runId}`;
      await this.event(tx, run.runId, "started");
    });
  }
  async fixtureMode(run: ReplayRun): Promise<void> {
    await this.transaction(async tx => {
      await this.locked(tx, run);
      ensure(this.identity(run).manifest.mode === "fixtures", "unsupported_provider_budget");
    });
  }
  private async closeRowAdmission(tx: Tx, run: ReplayRun): Promise<void> {
    if (this.identity(run).certified) await tx`UPDATE pipeline_replay.capacity_runs SET state='draining',
      admission_closed_at=coalesce(admission_closed_at,clock_timestamp()) WHERE run_id=${run.runId}`;
    else await tx`UPDATE pipeline_replay.capacity_runs SET state='draining' WHERE run_id=${run.runId}`;
  }
  private async admission(tx: Tx, run: ReplayRun, row: Row): Promise<string | null> {
    const identity = this.identity(run);
    if (identity.admissionClosed || row.state !== "running") {
      if (row.state === "running") {
        await this.closeRowAdmission(tx, run);
        await this.event(tx, run.runId, "admission_closed");
      }
      return "replay_run_not_running";
    }
    if (row.deadline_elapsed) {
      identity.admissionClosed = true;
      await this.closeRowAdmission(tx, run);
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
        source_revision_hash, stage, second_review_id, generation_key, vote, provider, model, request_hash, token_upper_bound, state)
        VALUES (${run.runId}, ${call.callId}, ${call.candidateId}, ${call.firstAttemptId}, ${call.inputHash}, ${call.sourceRevisionHash},
        ${call.stage}, ${call.stage === "second" ? call.secondReviewId : null}, ${call.stage === "second" ? call.generationKey : null},
        ${call.stage === "second" ? call.vote : null}, ${call.provider}, ${call.model}, ${call.requestHash}, ${call.tokenUpperBound}, 'reserved')`;
      await tx`UPDATE pipeline_replay.capacity_runs SET charged_calls = ${calls}, charged_tokens = ${tokens} WHERE run_id = ${run.runId}`;
      await this.event(tx, run.runId, "reserved", { callId: call.callId, tokenUpperBound: call.tokenUpperBound,
        ...(call.stage === "second" ? { secondReviewId: call.secondReviewId, generationKey: call.generationKey, vote: call.vote } : {}) });
      return null;
    }, run);
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
    }, run);
    if (denial) fail(denial);
  }
  markDispatching(run: ReplayRun, callId: string) { return this.move(run, callId, "reserved", "dispatching"); }
  markInFlight(run: ReplayRun, callId: string) { return this.move(run, callId, "dispatching", "in_flight"); }
  cancelBeforeDispatch(run: ReplayRun, callId: string) { return this.move(run, callId, "reserved", "cancelled_before_dispatch"); }
  async settle(run: ReplayRun, callId: string, receipt: ReplayReceipt, result?: ReplayResultProof): Promise<void> {
    let proof: ReplayResultProof | undefined;
    if (result !== undefined) {
      const parsed = resultProofSchema.safeParse(result);
      ensure(parsed.success, "replay_result_proof_invalid"); proof = parsed.data;
    }
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
        input_tokens = ${receipt.inputTokens}, output_tokens = ${receipt.outputTokens}, result_ok = ${proof?.ok ?? null},
        result_hash = ${proof?.outcomeHash ?? null}, result_decision_hash = ${proof?.decisionHash ?? null}
        WHERE run_id = ${run.runId} AND call_id = ${callId}`;
      if (this.identity(run).certified) {
        const classification = proof?.ok === false ? proof.error === "cancelled" ? "cancelled"
          : proof.error === "budget" ? "deferred" : proof.error ? "technical" : "unknown" : null;
        await tx`UPDATE pipeline_replay.capacity_calls SET failure_class = ${classification}
          WHERE run_id = ${run.runId} AND call_id = ${callId}`;
      }
      await this.event(tx, run.runId, "settled", { callId }); return false;
    }, run);
    if (uncertain) fail("replay_call_indeterminate");
  }
  private async uncertain(tx: Tx, run: ReplayRun, callId: string) {
    await tx`UPDATE pipeline_replay.capacity_calls SET state = 'indeterminate' WHERE run_id = ${run.runId} AND call_id = ${callId}`;
    await this.closeRowAdmission(tx, run);
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
    }, run);
  }
  async drain(run: ReplayRun): Promise<void> {
    return this.closeAdmission(run);
  }
  async closeAdmission(run: ReplayRun): Promise<void> {
    this.identity(run).admissionClosed = true;
    await this.transaction(async tx => {
      const row = await this.locked(tx, run);
      ensure(["running", "draining"].includes(row.state), "replay_run_state_mismatch");
      if (row.state === "running" || this.identity(run).certified && !row.admission_closed_at) {
        await this.closeRowAdmission(tx, run);
        await this.event(tx, run.runId, "draining");
      }
    });
  }
  async fenceWriters(run: ReplayRun): Promise<void> {
    ensure(this.identity(run).certified && this.identity(run).admissionClosed, "replay_admission_not_closed");
    await this.transaction(async tx => {
      await tx`SELECT pg_advisory_xact_lock(1485803,2)`;
      await tx`SELECT pg_advisory_xact_lock(1485803,4)`;
      const row = await this.locked(tx, run);
      ensure(row.state === 'draining' && row.admission_closed_at && !row.writers_fenced_at, "replay_run_state_mismatch");
      const [unresolved] = await tx`SELECT 1 FROM pipeline_replay.capacity_calls WHERE run_id = ${run.runId}
        AND state NOT IN ('settled','cancelled_before_dispatch') LIMIT 1`;
      ensure(!unresolved, "replay_calls_unresolved");
      await tx`UPDATE pipeline_replay.capacity_runs SET writers_fenced_at = clock_timestamp() WHERE run_id = ${run.runId}`;
      await this.event(tx, run.runId, "writers_fenced");
    });
    this.identity(run).writersFenced = true;
  }
  async seal(run: ReplayRun, proof: ReplayQuiescenceProof): Promise<void> {
    ensure(this.identity(run).certified && this.identity(run).writersFenced, "replay_writers_not_fenced");
    assertReplayQuiescence(run, proof);
    const { sealReplayLedger } = await import("./pipeline-replay-execution");
    await this.transaction(tx => sealReplayLedger(tx, run, this.identity(run).ownerId, proof));
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
