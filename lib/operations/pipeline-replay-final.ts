import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type postgres from "postgres";
import { assertReplayDatabaseScopeIdentity, currentReplayDb } from "@/lib/db/replay-scope";
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs, secondReviews,
  type CrawlCandidate, type CrawlReviewAttempt, type SecondReview } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION, reviewHash, reviewPolicyHash, validateReviewOutcome,
  type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { STALE_LOCK_MS } from "@/lib/jobs/lease";
import { comparisonReviewPolicyHash, fullReviewPolicyHash } from "./pipeline-capacity";
import { replayFinalRunBinding, type ReplayRun } from "./pipeline-replay-ledger";
import { deferReplayFinalWrite } from "./pipeline-replay-execution";

type Binding = { stage: "first" | "second"; candidateId: number; firstAttemptId: number;
  secondReviewId?: number; input: ReviewInput; settings: CrawlSettings };
type Requests = readonly { job: string; requestedVersion: number }[];
type Scope = { run: ReplayRun; binding: ReturnType<typeof replayFinalRunBinding>;
  executor: NonNullable<ReturnType<typeof currentReplayDb>>; active: boolean };
type Observation = { candidate: CrawlCandidate; first: CrawlReviewAttempt; seconds: SecondReview[];
  gate: boolean; jobToken: string | null; leaseAlive: boolean };
type Call = Record<string, unknown> & { call_id: string; first_attempt_id: string | number | null;
  second_review_id: string | number | null; candidate_id: string | number; input_hash: string;
  source_revision_hash: string; provider: string; model: string; stage: string; generation_key: string | null;
  vote: string | number | null; state: string; result_ok: boolean | null; result_hash: string | null;
  result_decision_hash: string | null; dispatched_at: Date | string | null; settled_at: Date | string | null };
const tokenBrand: unique symbol = Symbol("ReplayFinalWrite");
export type ReplayFinalWrite = Readonly<{ [tokenBrand]: true }>;
type Write = { scope: Scope; tx: ProductTransaction; binding: Binding; before: Observation; consumed: boolean };
const writes = new WeakMap<object, Write>();
const scopes = new AsyncLocalStorage<Scope>();
function ensure(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const serializedHash = (value: unknown) => reviewHash(JSON.parse(JSON.stringify(value)));
const same = (left: unknown, right: unknown) => serializedHash(left) === serializedHash(right);

function activeScope(): Scope | undefined {
  const scope = scopes.getStore();
  if (!scope) return undefined;
  ensure(scope.active && currentReplayDb() === scope.executor, "replay_final_scope_closed");
  scope.binding.assertActive();
  assertReplayDatabaseScopeIdentity(scope.binding.database);
  return scope;
}

/** Only an authentic run owned by the current verified handler database may install this scope. */
export async function withReplayFinalScope<T>(run: ReplayRun, load: () => Promise<T>): Promise<T> {
  ensure(!scopes.getStore(), "replay_final_scope_conflict");
  const binding = replayFinalRunBinding(run), executor = currentReplayDb();
  ensure(executor, "replay_database_scope_required");
  assertReplayDatabaseScopeIdentity(binding.database); binding.assertActive();
  const scope: Scope = { run, binding, executor, active: true };
  return scopes.run(scope, async () => {
    try { return await load(); }
    finally { scope.active = false; }
  });
}

async function assertTransaction(scope: Scope, tx: ProductTransaction) {
  ensure(activeScope() === scope, "replay_final_scope_closed");
  const identity = scope.binding.database.identity;
  const [row] = await tx.execute<{ safe: boolean }>(sql`SELECT current_database() = ${identity.databaseName}
    AND current_user = ${identity.roleName} AND session_user = ${identity.roleName}
    AND (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) = ${identity.databaseOid}::oid
    AND (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = 'pipeline_replay') = ${identity.schemaOid}::oid AS safe`);
  ensure(row?.safe, "replay_final_transaction_mismatch");
}

async function observe(scope: Scope, tx: ProductTransaction, binding: Binding): Promise<Observation> {
  await assertTransaction(scope, tx);
  const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id, binding.candidateId));
  const [first] = await tx.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.id, binding.firstAttemptId));
  ensure(candidate && first?.candidateId === candidate.id, "replay_final_binding_mismatch");
  const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.repo, candidate.repo));
  const [saved] = await tx.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
  const { mergeWithDefaults } = await import("@/lib/crawl/settings");
  const settings = mergeWithDefaults(saved?.values), manifest = scope.binding.manifest;
  ensure(same(settings, binding.settings) && reviewPolicyHash(settings) === manifest.inputPolicyHash
    && fullReviewPolicyHash(settings) === manifest.fullReviewPolicyHash
    && comparisonReviewPolicyHash(settings) === manifest.comparisonPolicyHash, "replay_final_settings_mismatch");
  const member = manifest.inputs.find(item => item.candidateId === candidate.id && item.inputHash === binding.input.inputHash
    && item.sourceRevisionHash === binding.input.sourceRevisionHash);
  ensure(member && document && candidate.productUrl === document.productUrl, "replay_final_input_mismatch");
  const [frozen] = await tx.execute<{ frozen_input: unknown; frozen_hash: string }>(sql`SELECT frozen_input, frozen_hash
    FROM pipeline_replay.capacity_inputs WHERE run_id = ${scope.run.runId} AND candidate_id = ${candidate.id}
      AND input_hash = ${binding.input.inputHash} AND source_revision_hash = ${binding.input.sourceRevisionHash}`);
  ensure(frozen && frozen.frozen_hash === serializedHash(frozen.frozen_input)
    && frozen.frozen_hash === serializedHash(binding.input), "replay_final_input_mismatch");
  const { loadReviewInput, secondReviewApprovalPredicate } = await import("@/lib/crawl/agent-review-repository");
  const current = await loadReviewInput(candidate, document, settings, tx);
  ensure(same(current, binding.input) && +current.validUntil > Date.parse(manifest.referenceTime), "replay_final_input_mismatch");
  const seconds = await tx.select().from(secondReviews).where(or(eq(secondReviews.firstAttemptId, first.id),
    sql`${secondReviews.id} IN (SELECT g.fallback_for_id FROM second_reviews g
      WHERE g.first_attempt_id = ${first.id} AND g.fallback_for_id IS NOT NULL)`));
  const [gate] = await tx.select({ ok: secondReviewApprovalPredicate(settings) }).from(crawlReviewAttempts)
    .where(eq(crawlReviewAttempts.id, first.id));
  const [job] = await tx.select({ token: jobs.leaseToken,
    alive: sql<boolean>`${jobs.lockedAt} >= clock_timestamp() - ${STALE_LOCK_MS} * interval '1 millisecond'` })
    .from(jobs).where(eq(jobs.name, binding.stage === "first" ? "crawl-agent-review" : "second-review"));
  return { candidate, first, seconds, gate: gate?.ok === true, jobToken: job?.token ?? null,
    leaseAlive: Boolean(job?.token && job.alive) };
}

/** Capture real before rows after the writer's existing locks, without taking domain locks. */
export async function prepareReplayFinalWrite(tx: ProductTransaction, value: Binding): Promise<ReplayFinalWrite | undefined> {
  const scope = activeScope(); if (!scope) return undefined;
  ensure(positive(value.candidateId) && positive(value.firstAttemptId)
    && (value.stage === "first" || value.stage === "second" && positive(value.secondReviewId)), "replay_final_binding_mismatch");
  const binding = structuredClone(value), before = await observe(scope, tx, binding);
  ensure(before.leaseAlive && (binding.stage !== "first" || before.first.state !== "running"
    || before.first.leaseToken === before.jobToken), "replay_final_lease_mismatch");
  if (binding.stage === "second") ensure(before.seconds.some(row => row.id === binding.secondReviewId
    && row.candidateId === binding.candidateId), "replay_final_binding_mismatch");
  const token = Object.freeze({ [tokenBrand]: true as const });
  writes.set(token, { scope, tx, binding, before, consumed: false }); return token;
}

const firstIdentity = (row: CrawlReviewAttempt) => ({ id: row.id, candidateId: row.candidateId, kind: row.kind,
  inputHash: row.inputHash, sourceRevisionHash: row.sourceRevisionHash, policyHash: row.policyHash,
  snapshot: row.snapshot, source: row.source, promptVersion: row.promptVersion, rulesVersion: row.rulesVersion,
  provider: row.provider, model: row.model, reusedFromAttemptId: row.reusedFromAttemptId,
  leaseToken: row.leaseToken, startedAt: row.startedAt, validUntil: row.validUntil, actor: row.actor });
const decisionHash = (row: { decision: unknown; confidence?: unknown; reason: unknown }) =>
  reviewHash({ decision: row.decision, confidence: row.confidence ?? null, reason: row.reason });

function matchesCall(call: Call, binding: Binding) {
  return Number(call.candidate_id) === binding.candidateId && Number(call.first_attempt_id) === binding.firstAttemptId
    && call.input_hash === binding.input.inputHash && call.source_revision_hash === binding.input.sourceRevisionHash
    && call.state === "settled" && call.result_ok === true && call.dispatched_at && call.settled_at;
}
async function assertWrittenResult(scope: Scope, tx: ProductTransaction, write: Write, after: Observation) {
  const { binding, before } = write;
  if (binding.stage === "first" && before.first.state === "running" && after.first.state === "succeeded"
    && before.first.reusedFromAttemptId === null && before.first.provider !== "rules") {
    const outcome = validateReviewOutcome(binding.input, after.first.outcome);
    const calls = [...await tx.execute<Call>(sql`SELECT * FROM pipeline_replay.capacity_calls WHERE run_id = ${scope.run.runId}
      AND candidate_id = ${binding.candidateId} AND first_attempt_id = ${binding.firstAttemptId} AND stage = 'first'`)];
    ensure(calls.filter(call => matchesCall(call, binding) && call.provider === after.first.provider && call.model === after.first.model
      && call.result_hash === reviewHash(outcome) && call.result_decision_hash === decisionHash(outcome)).length === 1,
    "replay_final_result_mismatch");
  }
  if (binding.stage === "second") {
    const previous = before.seconds.find(row => row.id === binding.secondReviewId);
    const row = after.seconds.find(row => row.id === binding.secondReviewId);
    ensure(previous && row && same({ ...previous, status: null, resolution: null, resolvedAt: null, reviewedAt: null,
      secondDecision: null, secondConfidence: null, secondReason: null, failureCount: null, errorCode: null, errorDetail: null },
    { ...row, status: null, resolution: null, resolvedAt: null, reviewedAt: null, secondDecision: null,
      secondConfidence: null, secondReason: null, failureCount: null, errorCode: null, errorDetail: null }), "replay_final_binding_mismatch");
    if (previous.status === "pending" && row.secondDecision !== null) {
      const calls = [...await tx.execute<Call>(sql`SELECT * FROM pipeline_replay.capacity_calls WHERE run_id = ${scope.run.runId}
        AND candidate_id = ${binding.candidateId} AND first_attempt_id = ${binding.firstAttemptId} AND stage = 'second'
        AND second_review_id = ${row.id}`)];
      ensure(calls.filter(call => matchesCall(call, binding) && call.provider === row.provider && call.model === row.model
        && Number(call.vote) === (row.fallbackForId ?? row.id) && call.generation_key === row.generationKey
        && call.result_hash !== null && call.result_decision_hash === decisionHash({ decision: row.secondDecision,
          confidence: row.secondConfidence, reason: row.secondReason })).length === 1, "replay_final_result_mismatch");
    }
  }
}
async function finalEvidence(scope: Scope, tx: ProductTransaction, write: Write, after: Observation) {
  const { binding, before } = write, { first, candidate } = after, manifest = scope.binding.manifest;
  const expected = manifest.models.first, input = binding.input;
  if (binding.settings.reviewMode !== "enforce" || !binding.settings.enabled || candidate.decidedBy !== "auto" || before.candidate.decidedBy !== "auto"
    || candidate.signals?.agentReviewAttemptId !== first.id || first.kind !== "automatic" || first.state !== "succeeded"
    || first.reusedFromAttemptId !== null || first.actor !== null || first.provider !== expected.provider || first.model !== expected.model
    || first.promptVersion !== REVIEW_PROMPT_VERSION || first.rulesVersion !== REVIEW_RULES_VERSION
    || first.inputHash !== input.inputHash || first.sourceRevisionHash !== input.sourceRevisionHash || first.policyHash !== input.policyHash
    || !same(first.snapshot, input.snapshot) || !same(first.source, input.source) || +first.validUntil !== +input.validUntil
    || !first.completedAt || !first.leaseToken) return null;
  if (binding.stage === "first" && (before.first.state !== "running" || before.first.completedAt !== null
    || before.first.reusedFromAttemptId !== null || before.candidate.signals?.agentReviewAttemptId === first.id)) return null;
  const outcome = validateReviewOutcome(input, first.outcome);
  if (outcome.decision === "needs_review" || candidate.state !== (outcome.decision === "approve" ? "approved" : "rejected")) return null;
  const calls = [...await tx.execute<Call>(sql`SELECT * FROM pipeline_replay.capacity_calls WHERE run_id = ${scope.run.runId}
    AND candidate_id = ${candidate.id} AND first_attempt_id = ${first.id}`)];
  const firstCalls = calls.filter(call => matchesCall(call, binding) && call.stage === "first"
    && call.provider === first.provider && call.model === first.model && call.result_hash === reviewHash(outcome)
    && call.result_decision_hash === decisionHash(outcome));
  if (firstCalls.length !== 1) return null;
  const firstCall = firstCalls[0], witnesses: Record<string, unknown>[] = [];
  const { secondGateRequired } = await import("@/lib/crawl/agent-review-repository");
  if (outcome.decision === "approve" && secondGateRequired(binding.settings)) {
    const targetBefore = before.seconds.find(row => row.id === binding.secondReviewId);
    const targetAfter = after.seconds.find(row => row.id === binding.secondReviewId);
    if (binding.stage !== "second" || before.gate || !after.gate || targetBefore?.status !== "pending"
      || targetAfter?.status !== "agreed" || targetAfter.secondDecision !== "approve") return null;
    const { secondReviewGeneration } = await import("@/lib/crawl/second-review-input");
    for (const slot of manifest.models.second.filter(row => row.canonicalModel !== canonicalReviewModel(first.model ?? ""))) {
      const row = after.seconds.find(row => {
        const root = row.fallbackForId ? after.seconds.find(item => item.id === row.fallbackForId) : row;
        return root && root.provider === slot.provider && root.model === slot.model
          && row.status === "agreed" && row.secondDecision === "approve";
      });
      if (!row) return null;
      const root = row.fallbackForId ? after.seconds.find(item => item.id === row.fallbackForId)! : row;
      const pool = row.fallbackForId ? manifest.models.fallbacks : manifest.models.second;
      if (row.candidateId !== candidate.id || row.firstAttemptId !== first.id || row.trigger !== "ai_approved"
        || row.inputHash !== input.inputHash || row.generationKey !== secondReviewGeneration(first.id, input, "ai_approved")
        || row.firstModel !== first.model || row.firstDecision !== "approve" || row.firstConfidence !== (outcome.confidence ?? null)
        || row.publishedSlug !== null || row.resolvedBy !== null || row.errorCode !== null || !row.reviewedAt
        || !pool.some(item => item.provider === row.provider && item.model === row.model)
        || root.candidateId !== candidate.id || root.firstAttemptId !== first.id || root.inputHash !== row.inputHash
        || root.generationKey !== row.generationKey || root.fallbackForId !== null
        || root.trigger !== "ai_approved" || root.firstModel !== first.model || root.firstDecision !== "approve"
        || root.firstConfidence !== (outcome.confidence ?? null) || root.publishedSlug !== null || root.resolvedBy !== null
        || row.fallbackForId && (root.status !== "resolved" || root.resolution !== "fallback")) return null;
      const matching = calls.filter(call => matchesCall(call, binding) && call.stage === "second"
        && Number(call.second_review_id) === row.id && Number(call.vote) === root.id && call.generation_key === row.generationKey
        && call.provider === row.provider && call.model === row.model && call.result_hash !== null
        && call.result_decision_hash === decisionHash({ decision: row.secondDecision, confidence: row.secondConfidence, reason: row.secondReason }));
      if (matching.length !== 1) return null;
      let rootCallId: string | null = null;
      if (row.fallbackForId) {
        const rootCalls = calls.filter(call => Number(call.candidate_id) === candidate.id && Number(call.first_attempt_id) === first.id
          && call.input_hash === input.inputHash && call.source_revision_hash === input.sourceRevisionHash && call.stage === "second"
          && Number(call.second_review_id) === root.id && Number(call.vote) === root.id && call.generation_key === root.generationKey
          && call.provider === root.provider && call.model === root.model && call.state === "settled" && call.result_ok === false
          && call.result_hash === null && call.result_decision_hash === null && call.dispatched_at && call.settled_at);
        ensure(rootCalls.length === 1, "replay_final_root_call_mismatch"); rootCallId = rootCalls[0].call_id;
      }
      witnesses.push({ secondReviewId: row.id, callId: matching[0].call_id, rootId: root.id, generationKey: row.generationKey,
        rootCallId, vote: root.id, provider: row.provider, model: row.model, slotProvider: slot.provider, slotModel: slot.model });
    }
    if (!witnesses.length || !witnesses.some(item => item.secondReviewId === binding.secondReviewId)) return null;
  } else if (binding.stage !== "first") return null;
  return { firstCall, decision: outcome.decision, witnesses };
}

/** Run/event locks are always last, after all domain reads, writes, gate checks and outbox work. */
async function lockedRun(scope: Scope, tx: ProductTransaction) {
  ensure(activeScope() === scope, "replay_final_scope_closed");
  const [row] = await tx.execute<{ manifest_hash: string; state: string; started_at: Date; deadline_at: Date; writers_fenced_at: Date | null }>(sql`SELECT
    manifest_hash, state, started_at, deadline_at, writers_fenced_at FROM pipeline_replay.capacity_runs
    WHERE run_id = ${scope.run.runId} AND owner_id = ${scope.binding.ownerId}::uuid FOR UPDATE`);
  ensure(row && row.manifest_hash === reviewHash(scope.binding.manifest), "replay_run_identity_mismatch");
  const [clock] = await tx.execute<{ wall_now: Date }>(sql`SELECT clock_timestamp() AS wall_now`);
  ensure(['running','draining'].includes(row.state) && !row.writers_fenced_at && row.started_at && row.deadline_at
    && (scope.binding.certified || +new Date(clock.wall_now) < +new Date(row.deadline_at)),
    "replay_final_run_not_running");
  return row;
}
function ledgerExecutor(raw: postgres.TransactionSql): ProductTransaction {
  const dialect = new PgDialect();
  return { execute(query: Parameters<ProductTransaction["execute"]>[0]) {
    const rendered = dialect.sqlToQuery(query as ReturnType<typeof sql>);
    return raw.unsafe(rendered.sql, rendered.params as postgres.ParameterOrJSON<never>[]);
  } } as unknown as ProductTransaction;
}
async function append(scope: Scope, tx: ProductTransaction, kind: string, payload: object): Promise<number> {
  const [row] = await tx.execute<{ event_seq: string | number }>(sql`UPDATE pipeline_replay.capacity_runs SET event_seq = event_seq + 1
    WHERE run_id = ${scope.run.runId} RETURNING event_seq`);
  const seq = Number(row.event_seq); ensure(positive(seq), "replay_counter_overflow");
  await tx.execute(sql`INSERT INTO pipeline_replay.capacity_transitions (run_id, seq, kind, payload)
    VALUES (${scope.run.runId}, ${seq}, ${kind}, ${JSON.stringify(payload)}::text::jsonb)`);
  return seq;
}
function validateRequests(requests: Requests) {
  ensure(Array.isArray(requests) && requests.every(row => typeof row.job === "string" && row.job.length > 0
    && Number.isSafeInteger(row.requestedVersion) && row.requestedVersion >= 0), "replay_final_request_mismatch");
  return requests.map(({ job, requestedVersion }) => ({ job, requestedVersion }));
}

export async function recordReplayFinalWrite(tx: ProductTransaction, token: ReplayFinalWrite | undefined, requests: Requests): Promise<void> {
  const scope = activeScope();
  if (!scope && token === undefined) return;
  const write = token && writes.get(token);
  ensure(scope && write && write.scope === scope && write.tx === tx && !write.consumed, "replay_final_token_mismatch");
  write.consumed = true; const outboxRequests = validateRequests(requests);
  const after = await observe(scope, tx, write.binding), { before, binding } = write;
  ensure(same(firstIdentity(before.first), firstIdentity(after.first)) && before.candidate.repo === after.candidate.repo
    && before.candidate.productUrl === after.candidate.productUrl && +before.candidate.judgedAt! === +after.candidate.judgedAt!,
    "replay_final_binding_mismatch");
  ensure(after.leaseAlive && after.jobToken === before.jobToken, "replay_final_lease_mismatch");
  await assertWrittenResult(scope, tx, write, after);
  const evidence = await finalEvidence(scope, tx, write, after);
  const flush = async (run: Record<string, unknown>, target: ProductTransaction) => {
  await append(scope, target, "review_write", { stage: binding.stage, candidateId: binding.candidateId,
    firstAttemptId: binding.firstAttemptId, ...(binding.secondReviewId ? { secondReviewId: binding.secondReviewId } : {}),
    inputHash: binding.input.inputHash, sourceRevisionHash: binding.input.sourceRevisionHash,
    beforeState: binding.stage === "first" ? before.first.state : before.seconds.find(row => row.id === binding.secondReviewId)?.status,
    afterState: binding.stage === "first" ? after.first.state : after.seconds.find(row => row.id === binding.secondReviewId)?.status,
    requests: outboxRequests });
  if (!evidence) return;
  const dbTimestamp = z.union([z.date(), z.string().regex(/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00(?::?00)?)$/)
    .refine(value => Number.isFinite(Date.parse(value)))]);
  const timing = z.object({ started_at: dbTimestamp, deadline_at: dbTimestamp }).parse(run);
  ensure(+new Date(evidence.firstCall.dispatched_at!) >= +new Date(timing.started_at)
    && +new Date(evidence.firstCall.settled_at!) >= +new Date(evidence.firstCall.dispatched_at!)
    && (scope.binding.certified || +new Date(evidence.firstCall.settled_at!) <= +new Date(timing.deadline_at)), "replay_final_call_time_mismatch");
  const [existing] = await target.execute(sql`SELECT 1 FROM pipeline_replay.capacity_finals WHERE run_id = ${scope.run.runId}
    AND candidate_id = ${binding.candidateId} AND input_hash = ${binding.input.inputHash}
    AND source_revision_hash = ${binding.input.sourceRevisionHash} AND policy_hash = ${binding.input.policyHash}`);
  if (existing) return;
  const seq = await append(scope, target, "final", { candidateId: binding.candidateId, firstAttemptId: binding.firstAttemptId,
    inputHash: binding.input.inputHash, sourceRevisionHash: binding.input.sourceRevisionHash, policyHash: binding.input.policyHash,
    firstCallId: evidence.firstCall.call_id, decision: evidence.decision, secondWitnesses: evidence.witnesses });
  await target.execute(sql`INSERT INTO pipeline_replay.capacity_finals (run_id, candidate_id, input_hash, source_revision_hash,
    policy_hash, seq, first_attempt_id, first_call_id, decision, second_witnesses)
    VALUES (${scope.run.runId}, ${binding.candidateId}, ${binding.input.inputHash}, ${binding.input.sourceRevisionHash},
      ${binding.input.policyHash}, ${seq}, ${binding.firstAttemptId}, ${evidence.firstCall.call_id}, ${evidence.decision},
      ${JSON.stringify(evidence.witnesses)}::text::jsonb)`);
  };
  if (await deferReplayFinalWrite(tx, (run, raw) => flush(run, ledgerExecutor(raw)))) return;
  await flush(await lockedRun(scope, tx), tx);
}

export async function recordReplaySecondReviewTransition(tx: ProductTransaction, binding: {
  kind: "cleanup" | "retry" | "hold" | "reopen" | "superseded" | "enqueue" | "review_write";
  secondReviewIds?: readonly number[]; candidateIds?: readonly number[];
}, requests: Requests = []): Promise<void> {
  const scope = activeScope(); if (!scope) return;
  await assertTransaction(scope, tx); const outboxRequests = validateRequests(requests);
  const ids = [...new Set(binding.secondReviewIds ?? [])], candidates = [...new Set(binding.candidateIds ?? [])];
  ensure(["cleanup", "retry", "hold", "reopen", "superseded", "enqueue", "review_write"].includes(binding.kind)
    && [...ids, ...candidates].every(positive), "replay_final_binding_mismatch");
  if (!ids.length && !candidates.length) return;
  if (ids.length) {
    const rows = await tx.select({ id: secondReviews.id, candidateId: secondReviews.candidateId }).from(secondReviews).where(inArray(secondReviews.id, ids));
    ensure(rows.length === ids.length, "replay_final_binding_mismatch");
    candidates.push(...rows.map(row => row.candidateId));
  }
  const actual = await tx.select({ id: crawlCandidates.id }).from(crawlCandidates).where(inArray(crawlCandidates.id, [...new Set(candidates)]));
  ensure(actual.length === new Set(candidates).size, "replay_final_binding_mismatch");
  const flush = (target: ProductTransaction) => append(scope, target, `second_review_${binding.kind}`,
    { secondReviewIds: ids, candidateIds: [...new Set(candidates)], requests: outboxRequests }).then(() => undefined);
  if (await deferReplayFinalWrite(tx, (_run, raw) => flush(ledgerExecutor(raw)))) return;
  await lockedRun(scope, tx); await flush(tx);
}

export async function recordReplayFirstReviewTransition(tx: ProductTransaction, binding: {
  kind: "superseded" | "failed"; candidateId: number; firstAttemptId: number;
}, requests: Requests = []): Promise<void> {
  const scope = activeScope(); if (!scope) return;
  await assertTransaction(scope, tx); const outboxRequests = validateRequests(requests);
  ensure(["superseded", "failed"].includes(binding.kind) && positive(binding.candidateId) && positive(binding.firstAttemptId),
    "replay_final_binding_mismatch");
  const [row] = await tx.select({ state: crawlReviewAttempts.state, candidateId: crawlReviewAttempts.candidateId }).from(crawlReviewAttempts)
    .innerJoin(crawlCandidates, eq(crawlCandidates.id, crawlReviewAttempts.candidateId))
    .where(and(eq(crawlReviewAttempts.id, binding.firstAttemptId), eq(crawlCandidates.id, binding.candidateId)));
  ensure(row?.candidateId === binding.candidateId && row.state === binding.kind, "replay_final_binding_mismatch");
  const flush = (target: ProductTransaction) => append(scope, target, `first_review_${binding.kind}`,
    { candidateId: binding.candidateId, firstAttemptId: binding.firstAttemptId, requests: outboxRequests }).then(() => undefined);
  if (await deferReplayFinalWrite(tx, (_run, raw) => flush(ledgerExecutor(raw)))) return;
  await lockedRun(scope, tx); await flush(tx);
}
