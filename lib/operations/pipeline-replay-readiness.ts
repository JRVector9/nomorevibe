import { z } from "zod";
import { getTableColumns, type Table } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import type postgres from "postgres";
import type { CapacityManifest } from "./pipeline-capacity";
import { createReviewInput, isReviewCandidate, reviewHash, REVIEW_FRESH_MS, REVIEW_PROMPT_VERSION,
  REVIEW_RULES_VERSION, MAX_REVIEW_ATTEMPTS } from "@/lib/crawl/agent-review-contract";
import { mergeWithDefaults } from "@/lib/crawl/settings";
import { firstReviewer } from "@/lib/crawl/agent-review";
import { candidateStarAutoApproval } from "@/lib/crawl/star-auto-approval";
import { accessFromDocument, judgeStoredDocument } from "@/lib/crawl/rules";
import { secondReviewInputMatches } from "@/lib/crawl/second-review-input";
import { agentCoverageRevision } from "@/lib/domain/evidence/agents/coverage";
import { repositoryUrl } from "@/lib/domain/products/access";
import { reviewSemanticNow } from "@/lib/crawl/review-replay-context";

// PostgreSQL timestamps may have microseconds. Preserve those in evidence and digests.
const date = z.string().datetime().refine(value => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z$/.test(value));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const publicTables = { crawl_settings: schema.crawlSettings, crawl_candidates: schema.crawlCandidates,
  crawl_documents: schema.crawlDocuments, crawl_review_attempts: schema.crawlReviewAttempts,
  second_reviews: schema.secondReviews, agent_repository_scans: schema.agentRepositoryScans,
  agent_repository_observations: schema.agentRepositoryObservations, products: schema.products,
  crawl_frontier: schema.crawlFrontier, jobs: schema.jobs, operations_observations: schema.operationsObservations } as const;
type Json = z.infer<ReturnType<typeof z.json>>;
type Row = Record<string, Json>;
function rowSchema(table: Table) { return z.object(Object.fromEntries(Object.values(getTableColumns(table))
  .map(column => [column.name, z.json()]))).strict(); }
const callColumns = "run_id call_id candidate_id first_attempt_id input_hash source_revision_hash stage provider model second_review_id generation_key vote request_hash token_upper_bound state dispatched_at settled_at input_tokens output_tokens result_ok result_hash result_decision_hash failure_class".split(" ");
const callRow = z.object(Object.fromEntries(callColumns.map(name => [name, z.json()]))).strict();
const publicTableRows = Object.fromEntries(Object.entries(publicTables).map(([key, table]) => [key, z.array(rowSchema(table))])) as { [K in keyof typeof publicTables]: z.ZodArray<ReturnType<typeof rowSchema>> };
const tableRows = { ...publicTableRows, capacity_calls: z.array(callRow) };
export const ReplayReadinessProjectionSchema = z.object({ version: z.literal(1), referenceTime: date,
  universe: z.array(z.object({ candidateId: z.number().int().positive().safe(), inputHash: hash, sourceRevisionHash: hash,
    policyHash: hash, frozenInput: z.json(), frozenHash: hash }).strict()), tables: z.object(tableRows).strict() }).strict();
export type ReplayReadinessProjection = { version: 1; referenceTime: string; universe: Array<{
  candidateId: number; inputHash: string; sourceRevisionHash: string; policyHash: string; frozenInput: Json; frozenHash: string }>;
  tables: Record<keyof typeof publicTables | "capacity_calls", Row[]> };
export const ReplayReadinessChangeSchema = z.object({ table_name: z.enum(["crawl_settings", "crawl_candidates", "crawl_documents", "crawl_review_attempts", "second_reviews", "agent_repository_scans", "agent_repository_observations", "products", "crawl_frontier", "jobs", "operations_observations", "capacity_calls"]),
  operation: z.enum(["INSERT", "UPDATE", "DELETE"]), old_row: z.record(z.string(), z.json()).nullable(),
  new_row: z.record(z.string(), z.json()).nullable(), ordinal: z.number().int().positive().safe() }).strict();
export const ReplayReadinessJournalSchema = z.object({ transactions: z.array(z.object({ seq: z.number().int().positive().safe(), txKey: z.string().min(1),
  txStartedAt: date, recordedAt: date, confirmedAt: date.nullable(), changes: z.array(ReplayReadinessChangeSchema) }).strict()),
  gaps: z.array(z.object({ from: date, until: date, reason: z.string().min(1) }).strict()) }).strict();
export type ReplayReadinessChange = z.infer<typeof ReplayReadinessChangeSchema>;
export type ReplayReadinessJournal = z.infer<typeof ReplayReadinessJournalSchema>;
export type ReplayInitialReadinessSnapshot = { projection: ReplayReadinessProjection; capturedAt: string;
  initialStateHash: string; comparisonStateHash: string };
const fail = (code: string): never => { throw new Error(code); };
const ensure = (value: unknown, code: string): void => { if (!value) fail(code); };
const equal = (a: unknown, b: unknown) => reviewHash(a) === reviewHash(b);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const time = (value: unknown): number => {
  if (typeof value !== "string") return NaN;
  const rest = /\.(\d{3})(\d{3})Z$/.exec(value);
  const result = Date.parse(value) * 1000 + (rest ? Number(rest[2]) : 0);
  ensure(Number.isSafeInteger(result), "replay_readiness_timestamp_range");
  return result;
};
function iso(microseconds: number): string {
  const whole = Math.floor(microseconds / 1000), extra = microseconds - whole * 1000;
  const base = new Date(whole).toISOString();
  return extra ? base.replace(/Z$/, `${String(extra).padStart(3, "0")}Z`) : base;
}
function utc(value: unknown): string {
  ensure(typeof value === "string", "replay_readiness_timestamp_invalid");
  const raw = String(value).replace(" ", "T"), zoned = /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? raw : `${raw}Z`;
  const parsed = new Date(zoned); ensure(Number.isFinite(+parsed), "replay_readiness_timestamp_invalid");
  const extra = /\.(\d{3})(\d{1,3})(?:Z|[+-]\d\d:\d\d)$/.exec(zoned)?.[2]?.padEnd(3, "0");
  return extra && extra !== "000" ? parsed.toISOString().replace(/Z$/, `${extra}Z`) : parsed.toISOString();
}
function exactJsonNumbers(value: unknown): void {
  if (typeof value === "number") ensure(!Number.isInteger(value) || Number.isSafeInteger(value), "replay_readiness_unsafe_integer");
  else if (Array.isArray(value)) for (const item of value) exactJsonNumbers(item);
  else if (value && typeof value === "object") for (const item of Object.values(value)) exactJsonNumbers(item);
}
function normalizeRow(name: string, value: Row): Row {
  exactJsonNumbers(value);
  const row = structuredClone(value);
  const table = publicTables[name as keyof typeof publicTables];
  const dateColumns = table ? Object.values(getTableColumns(table)).filter(column => column.dataType === "date").map(column => column.name)
    : ["dispatched_at", "settled_at"];
  for (const column of dateColumns) if (row[column] !== null && row[column] !== undefined) row[column] = utc(row[column]);
  (table ? rowSchema(table) : callRow).parse(row);
  return row;
}
function rowKey(name: string, row: Row): string {
  const keys = name === "operations_observations" ? ["key"] : name === "jobs" ? ["name"] : name === "capacity_calls" ? ["run_id", "call_id"] : ["id"];
  ensure(keys.every(key => ["string", "number"].includes(typeof row[key])), "replay_readiness_key_invalid");
  return JSON.stringify(keys.map(key => row[key]));
}
function canonicalProjection(value: ReplayReadinessProjection): ReplayReadinessProjection {
  ReplayReadinessProjectionSchema.parse(value);
  const projection = structuredClone(value);
  projection.universe.sort((a, b) => a.candidateId - b.candidateId || a.inputHash.localeCompare(b.inputHash)
    || a.sourceRevisionHash.localeCompare(b.sourceRevisionHash));
  const identities = new Set<string>();
  for (const item of projection.universe) {
    const key = `${item.candidateId}:${item.inputHash}:${item.sourceRevisionHash}`;
    ensure(!identities.has(key), "replay_readiness_duplicate_input"); identities.add(key);
    const frozen = object(item.frozenInput), snapshot = object(frozen.snapshot), source = object(frozen.source);
    const evidence = snapshot.evidence;
    ensure(Array.isArray(evidence) && equal(item.frozenHash, reviewHash(frozen))
      && frozen.inputHash === item.inputHash && frozen.sourceRevisionHash === item.sourceRevisionHash
      && frozen.policyHash === item.policyHash && reviewHash(source) === item.sourceRevisionHash,
    "replay_readiness_frozen_mismatch");
    ensure(reviewHash({ snapshot: { ...snapshot, evidence: (evidence as unknown[]).map(item => object(item).observation) },
      policyHash: item.policyHash }) === item.inputHash, "replay_readiness_frozen_mismatch");
    const fetched = time(source.documentFetchedAt), scan = source.scanCompletedAt === null ? Infinity : time(source.scanCompletedAt);
    const valid = Math.min(fetched + REVIEW_FRESH_MS * 1000, scan + REVIEW_FRESH_MS * 1000), reference = time(projection.referenceTime);
    ensure(fetched <= reference && (scan === Infinity || scan <= reference) && valid > reference
      && time(frozen.validUntil) === valid, "replay_readiness_frozen_mismatch");
  }
  for (const name of Object.keys(projection.tables) as Array<keyof typeof projection.tables>) {
    const rows = projection.tables[name].map(row => normalizeRow(name, row));
    rows.sort((a, b) => rowKey(name, a).localeCompare(rowKey(name, b)));
    ensure(new Set(rows.map(row => rowKey(name, row))).size === rows.length, "replay_readiness_duplicate_row");
    projection.tables[name] = rows;
  }
  return projection;
}
export function readinessProjectionHashes(value: ReplayReadinessProjection, capturedAt: string) {
  date.parse(capturedAt);
  const projection = canonicalProjection(value), comparison = structuredClone(projection), base = time(capturedAt);
  for (const row of comparison.tables.crawl_settings) {
    const settings = object(row.values); if ("reviewConcurrency" in settings) settings.reviewConcurrency = 0;
  }
  // This allowlist deliberately retains all other timestamps, versions, cursor and ordering fields.
  for (const row of comparison.tables.crawl_review_attempts) {
    if (row.retry_after !== null) row.retry_after = time(row.retry_after) - base;
    if (row.state === "superseded" && row.error_code === "owner_changed" && row.completed_at !== null)
      row.completed_at = time(row.completed_at) - base;
  }
  for (const row of comparison.tables.jobs) for (const key of ["locked_at", "not_before"])
    if (row[key] !== null) row[key] = time(row[key]) - base;
  return { initialStateHash: reviewHash(projection), comparisonStateHash: reviewHash(comparison) };
}
function hydrate<T>(raw: Row, table: Table): T {
  return Object.fromEntries(Object.entries(getTableColumns(table)).map(([name, column]) => [name,
    raw[column.name] === null ? null : column.dataType === "date" ? new Date(String(raw[column.name]))
      : column.mapFromDriverValue(raw[column.name])])) as T;
}
function currentInput(projection: ReplayReadinessProjection, candidate: schema.CrawlCandidate, settings: ReturnType<typeof mergeWithDefaults>) {
  const rawDocument = projection.tables.crawl_documents.find(row => row.repo === candidate.repo);
  if (!rawDocument) return null;
  const document = hydrate<schema.CrawlDocument>(rawDocument, schema.crawlDocuments);
  if (candidate.productUrl !== document.productUrl) return null;
  const rawScan = projection.tables.agent_repository_scans.filter(row => row.repository_key === candidate.repo.toLowerCase() && row.scope === "")
    .sort((a, b) => time(b.started_at) - time(a.started_at) || Number(b.id) - Number(a.id))[0];
  const scan = rawScan ? hydrate<schema.AgentRepositoryScan>(rawScan, schema.agentRepositoryScans) : null;
  const observations = projection.tables.agent_repository_observations.filter(row => row.scan_id === scan?.id)
    .map(row => ({ id: `observation:${row.id}`, observation: hydrate<typeof schema.agentRepositoryObservations.$inferSelect>(row, schema.agentRepositoryObservations).facts }));
  const input = createReviewInput(candidate, document, settings, { scan, observations }, new Date(projection.referenceTime));
  const reference = time(projection.referenceTime), fetched = time(rawDocument.fetched_at), completed = rawScan?.completed_at;
  const fresh = fetched <= reference && fetched > reference - REVIEW_FRESH_MS * 1000
    && (completed === null || completed === undefined || (time(completed) <= reference && time(completed) > reference - REVIEW_FRESH_MS * 1000))
    && +input.validUntil * 1000 > reference;
  return { input, document, scan, fresh };
}
export type ReplayReadinessWork = { candidateId: number; inputHash: string; sourceRevisionHash: string; stage: "first" | "second";
  firstAttemptId: number | null; secondReviewId: number | null; generationKey: string | null;
  eligible: boolean; modelReady: boolean; inFlight: boolean; blockedReasons: string[] };
export type ReplayReadinessState = { first: { eligible: number; modelReady: number; inFlight: number; blockedReasons: Record<string, number> };
  second: { eligible: number; modelReady: number; inFlight: number; blockedReasons: Record<string, number> }; work: ReplayReadinessWork[] };
/** Uses the worker's input, rule and AI2 identity validators; never accepts caller counts or eligibility flags. */
export function deriveReplayReadiness(value: ReplayReadinessProjection, wallNow: string): ReplayReadinessState {
  return deriveWithFailureHistory(value, wallNow);
}
function deriveWithFailureHistory(value: ReplayReadinessProjection, wallNow: string,
  failureBaseline?: ReadonlyMap<number, number>, currentOwners?: ReadonlyMap<string, string>): ReplayReadinessState {
  const projection = canonicalProjection(value), wall = time(date.parse(wallNow)), reference = time(projection.referenceTime);
  ensure(+reviewSemanticNow(new Date(reference / 1000)) * 1000 === reference, "replay_readiness_reference_scope_mismatch");
  const settings = mergeWithDefaults(projection.tables.crawl_settings.find(row => row.id === 1)?.values);
  ensure(settings.firstReview, "replay_readiness_explicit_first_reviewer_required");
  const reviewer = firstReviewer(settings), work: ReplayReadinessWork[] = [];
  const attempts = projection.tables.crawl_review_attempts.map(row => hydrate<schema.CrawlReviewAttempt>(row, schema.crawlReviewAttempts));
  const seconds = projection.tables.second_reviews.map(row => hydrate<schema.SecondReview>(row, schema.secondReviews));
  const activeCalls = new Set(["reserved", "dispatching", "in_flight", "indeterminate"]);
  const jobs = projection.tables.jobs;
  const jobBlocks = (stage: "first" | "second"): string[] => {
    const job = jobs.find(row => row.name === (stage === "first" ? "crawl-agent-review" : "second-review"));
    // An already admitted owner can continue its current tick. A fresh requested-only
    // run must pass the same request, backoff, counter and stale-lock predicates.
    if (job && typeof job.lease_token === "string" && time(job.locked_at) >= wall - 90_000_000)
      return currentOwners?.get(String(job.name)) === job.lease_token ? [] : ["job_locked"];
    if (!job || Number(job.requested_version) <= Number(job.processed_version)) return ["job_not_requested"];
    if (Number(job.requested_version) >= Number.MAX_SAFE_INTEGER) return ["job_counter_exhausted"];
    if (time(job.not_before) > wall) return ["job_backoff"];
    if (time(job.locked_at) >= wall - 90_000_000) return ["job_locked"];
    return [];
  };
  for (const identity of projection.universe) {
    const rawCandidate = projection.tables.crawl_candidates.find(row => row.id === identity.candidateId);
    const candidate = rawCandidate ? hydrate<schema.CrawlCandidate>(rawCandidate, schema.crawlCandidates) : null;
    const current = candidate ? currentInput(projection, candidate, settings) : null;
    const input = current?.input;
    const matched = !!input && input.inputHash === identity.inputHash && input.sourceRevisionHash === identity.sourceRevisionHash
      && input.policyHash === identity.policyHash;
    const fresh = current?.fresh === true;
    const first: ReplayReadinessWork = { candidateId: identity.candidateId, inputHash: identity.inputHash,
      sourceRevisionHash: identity.sourceRevisionHash, stage: "first", firstAttemptId: null, secondReviewId: null,
      generationKey: null, eligible: false, modelReady: false, inFlight: false, blockedReasons: [] };
    const blocked = first.blockedReasons;
    const rows = attempts.filter(row => row.candidateId === identity.candidateId && row.kind === "automatic");
    const calls = projection.tables.capacity_calls.filter(row => row.candidate_id === identity.candidateId
      && row.input_hash === identity.inputHash && row.source_revision_hash === identity.sourceRevisionHash);
    const currentSourceMatches = (attempt: schema.CrawlReviewAttempt) => !!current && attempt.policyHash === input!.policyHash
      && attempt.promptVersion === REVIEW_PROMPT_VERSION && attempt.rulesVersion === REVIEW_RULES_VERSION
      && ((attempt.provider === "rules" && attempt.model === REVIEW_RULES_VERSION)
        || (attempt.provider === reviewer?.provider && attempt.model === reviewer?.model))
      && ["candidateJudgedAt", "documentId", "documentFetchedAt", "productUrl", "scanId", "scanSha", "scanStartedAt", "scanCompletedAt", "scanState", "scanError"]
        .every(key => equal(object(attempt.source)[key], object(input!.source)[key]))
      && equal(attempt.source.scanCoverage ?? {}, agentCoverageRevision(current.scan) ?? {})
      && (attempt.snapshot.product.readme ?? "") === input!.snapshot.product.readme;
    const sameSource = rows.filter(currentSourceMatches);
    const running = sameSource.some(row => row.state === "running" && jobs.some(job => job.name === "crawl-agent-review"
      && job.lease_token === row.leaseToken && time(job.locked_at) >= wall - 90_000_000));
    const ownedRunning = rows.some(row => row.state === "running" && row.leaseToken !== null && jobs.some(job => job.name === "crawl-agent-review"
      && job.lease_token === row.leaseToken && time(job.locked_at) >= wall - 90_000_000));
    first.inFlight = running || ownedRunning || calls.some(row => row.stage === "first" && activeCalls.has(String(row.state)));
    if (!settings.enabled || settings.reviewMode === "off" || !reviewer) blocked.push("disabled");
    if (!candidate) blocked.push("candidate_missing");
    else if (!isReviewCandidate(candidate)) blocked.push(candidate.decidedBy !== "auto" ? "human" : "candidate_state");
    if (!matched) blocked.push("input_changed");
    if (!fresh) blocked.push("stale");
    if (candidate && current && candidateStarAutoApproval(candidate, current.document, settings, new Date(reference / 1000))) blocked.push("star_auto_approved");
    if (sameSource.some(row => row.state === "succeeded" && +row.validUntil * 1000 > reference
      && (settings.reviewMode === "observe" || (candidate?.state === "approved" && row.outcome?.decision === "approve")
        || (candidate?.state === "needs_review" && row.outcome?.decision === "needs_review")))) blocked.push("already_succeeded");
    if (sameSource.some(row => row.state === "failed" && row.retryAfter && time(projection.tables.crawl_review_attempts.find(raw => raw.id === row.id)!.retry_after) > wall)) blocked.push("retry_wait");
    if (sameSource.filter(row => ["failed", "superseded"].includes(row.state) && row.errorCode !== "owner_changed").length >= MAX_REVIEW_ATTEMPTS)
      blocked.push("attempts_exhausted");
    if (sameSource.filter(row => row.state === "superseded" && row.errorCode === "owner_changed" && row.completedAt
      && time(projection.tables.crawl_review_attempts.find(raw => raw.id === row.id)!.completed_at) > wall - REVIEW_FRESH_MS * 1000).length >= 3) blocked.push("owner_changes_exhausted");
    if (first.inFlight) blocked.push("running");
    first.eligible = blocked.length === 0;
    if (first.eligible && current && candidate) {
      const verdict = judgeStoredDocument(current.document, settings, new Date(reference / 1000), settings.agentEvidence.enforceEligibility ? {
        relationship: input!.snapshot.relationship, scanState: input!.snapshot.scanState,
        observations: input!.snapshot.evidence.map(item => item.observation) } : undefined);
      const canonicalRepo = repositoryUrl(candidate.repo)?.toLowerCase();
      const existing = accessFromDocument(current.document, settings, new Date(reference / 1000)) && verdict.state !== "rejected"
        && projection.tables.products.some(product => product.url === current.document.productUrl || product.url === canonicalRepo
          || (typeof product.repo_url === "string" && product.repo_url.toLowerCase().replace(/\/+$/, "").replace(/^https?:\/\/(www\.)?/, "https://").replace(/\.git$/, "") === canonicalRepo));
      if (verdict.reason === "suspected_spam") blocked.push("suspected_spam");
      else if (verdict.state === "rejected" || existing) blocked.push("rules");
      else if (settings.agentEvidence.enforceEligibility && !input!.snapshot.evidenceSummary.eligible) blocked.push("evidence_hold");
      const claimRows = rows.filter(row => (row.inputHash === input!.inputHash && row.provider === reviewer!.provider && row.model === reviewer!.model)
        || row.state === "running").sort((a, b) => b.id - a.id).slice(0, 16);
      const same = claimRows.filter(row => row.inputHash === input!.inputHash && row.sourceRevisionHash === input!.sourceRevisionHash
        && row.provider === reviewer!.provider && row.model === reviewer!.model);
      if (same.some(row => row.state === "succeeded" && +row.validUntil * 1000 > reference && row.outcome)
        || claimRows.some(row => row.inputHash === input!.inputHash && row.state === "succeeded" && row.outcome
          && row.provider === reviewer!.provider && row.model === reviewer!.model
          && row.promptVersion === REVIEW_PROMPT_VERSION && row.rulesVersion === REVIEW_RULES_VERSION)) blocked.push("reuse");
      if (same.filter(row => ["failed", "superseded"].includes(row.state) && row.errorCode !== "owner_changed").length >= MAX_REVIEW_ATTEMPTS)
        blocked.push("attempts_exhausted");
      const replaced = claimRows.find(row => row.state === "running");
      const interruptions = same.filter(row => row.state === "superseded" && row.errorCode === "owner_changed" && row.completedAt
        && time(projection.tables.crawl_review_attempts.find(raw => raw.id === row.id)!.completed_at) > wall - REVIEW_FRESH_MS * 1000).length
        + (replaced && same.includes(replaced) ? 1 : 0);
      if (interruptions >= 3) blocked.push("owner_changes_exhausted");
      if (same.some(row => row.state === "failed" && row.retryAfter && time(projection.tables.crawl_review_attempts.find(raw => raw.id === row.id)!.retry_after) > wall)) blocked.push("retry_wait");
    }
    blocked.push(...jobBlocks("first"));
    first.modelReady = first.eligible && blocked.length === 0; work.push(first);
    for (const row of seconds.filter(row => row.candidateId === identity.candidateId && row.inputHash === identity.inputHash)) {
      const item: ReplayReadinessWork = { candidateId: identity.candidateId, inputHash: identity.inputHash,
        sourceRevisionHash: identity.sourceRevisionHash, stage: "second", firstAttemptId: row.firstAttemptId,
        secondReviewId: row.id, generationKey: row.generationKey, eligible: false, modelReady: false, inFlight: false, blockedReasons: [] };
      const reasons = item.blockedReasons;
      if (!settings.enabled || !settings.secondReview.enabled) reasons.push("disabled");
      const gate = row.trigger === "ai_approved" ? attempts.find(attempt => attempt.id === row.firstAttemptId && attempt.candidateId === row.candidateId) : null;
      const firstAttempt = rows.filter(attempt => attempt.state === "succeeded" && (["claude-cli", "abcllm"].includes(attempt.provider ?? "")
        || (attempt.provider === "grok-cli" && reviewer?.provider === "grok-cli" && reviewer.model === attempt.model))
        && (!gate || (attempt.provider === gate.provider && attempt.model === gate.model))).sort((a, b) => b.id - a.id)[0];
      if (!matched || !current || !candidate || !secondReviewInputMatches(row, { candidate, document: current.document, settings,
        input: input!, first: firstAttempt, root: seconds.find(root => root.id === row.fallbackForId) }, new Date(reference / 1000))) reasons.push("input_changed");
      if (row.status !== "pending") reasons.push(row.status === "failed" ? "retry_wait" : row.status === "needs_human" ? "human" : "settled");
      const rowCalls = calls.filter(call => call.stage === "second" && call.second_review_id === row.id && call.generation_key === row.generationKey);
      item.inFlight = rowCalls.some(call => activeCalls.has(String(call.state)));
      if (item.inFlight) reasons.push("running");
      if (row.status === "pending") {
        const settled = rowCalls.filter(call => call.state === "settled" && call.failure_class !== "cancelled");
        const failed = settled.filter(call => call.result_ok === false).length;
        // Only actual OLD/NEW history establishes how many current-run failures were
        // written. Host reviewed_at and DB settled_at cannot establish that ordering.
        const recorded = failureBaseline?.has(row.id) ? row.failureCount - failureBaseline.get(row.id)! : null;
        if (settled.some(call => call.result_ok === true) || (failed > 0 && (recorded === null || failed > recorded))) reasons.push("awaiting_writer");
      }
      item.eligible = reasons.length === 0;
      reasons.push(...jobBlocks("second"));
      item.modelReady = item.eligible && reasons.length === 0; work.push(item);
    }
  }
  const count = (stage: "first" | "second") => {
    const rows = work.filter(row => row.stage === stage), blockedReasons: Record<string, number> = {};
    for (const row of rows) for (const reason of new Set(row.blockedReasons)) blockedReasons[reason] = (blockedReasons[reason] ?? 0) + 1;
    return { eligible: rows.filter(row => row.eligible).length, modelReady: rows.filter(row => row.modelReady).length,
      inFlight: rows.filter(row => row.inFlight).length, blockedReasons };
  };
  return { first: count("first"), second: count("second"), work };
}
const mutable = new Set(["crawl_candidates", "crawl_review_attempts", "second_reviews", "crawl_frontier", "jobs", "operations_observations", "capacity_calls"]);
export function applyReplayChanges(value: ReplayReadinessProjection, changes: ReplayReadinessChange[]): ReplayReadinessProjection {
  const projection = canonicalProjection(value);
  for (const [index, raw] of changes.entries()) {
    const change = ReplayReadinessChangeSchema.parse(raw), name = change.table_name as keyof typeof projection.tables;
    ensure(mutable.has(name), "replay_readiness_immutable_change");
    ensure(change.ordinal === index + 1, "replay_readiness_ordinal_mismatch");
    const old = change.old_row ? normalizeRow(name, change.old_row) : null, next = change.new_row ? normalizeRow(name, change.new_row) : null;
    ensure((change.operation === "INSERT" && !old && next) || (change.operation === "UPDATE" && old && next)
      || (change.operation === "DELETE" && old && !next), "replay_readiness_operation_mismatch");
    const key = rowKey(name, (old ?? next)!), at = projection.tables[name].findIndex(row => rowKey(name, row) === key);
    if (old) ensure(at >= 0 && equal(projection.tables[name][at], old), "replay_readiness_old_mismatch");
    else ensure(at < 0, "replay_readiness_insert_exists");
    if (next) {
      ensure(rowKey(name, next) === key, "replay_readiness_key_changed");
      if (at < 0) projection.tables[name].push(next); else projection.tables[name][at] = next;
    } else projection.tables[name].splice(at, 1);
  }
  return canonicalProjection(projection);
}
function expiries(projection: ReplayReadinessProjection): number[] {
  const values: number[] = [];
  for (const row of projection.tables.crawl_review_attempts) {
    values.push(time(row.retry_after));
    if (row.state === "superseded" && row.error_code === "owner_changed") values.push(time(row.completed_at) + REVIEW_FRESH_MS * 1000);
  }
  // The worker's >= lease predicate still owns the exact 90-second instant.
  for (const row of projection.tables.jobs) values.push(time(row.not_before), time(row.locked_at) + 90_000_001);
  return values.filter(Number.isFinite);
}
export function reduceReplayReadinessCoverage(initial: ReplayInitialReadinessSnapshot, value: ReplayReadinessJournal, window: { from: string; until: string }) {
  const journal = ReplayReadinessJournalSchema.parse(value), from = time(date.parse(window.from)), until = time(date.parse(window.until));
  ensure(from < until && time(initial.capturedAt) <= from, "replay_readiness_window_invalid");
  const hashes = readinessProjectionHashes(initial.projection, initial.capturedAt);
  ensure(equal(hashes.initialStateHash, initial.initialStateHash) && equal(hashes.comparisonStateHash, initial.comparisonStateHash), "replay_readiness_initial_hash_mismatch");
  const states = [canonicalProjection(initial.projection)], points = new Set([from, until]);
  const baselines = [new Map(states[0].tables.second_reviews.map(row => [Number(row.id), Number(row.failure_count)]))];
  const owners = [new Map<string, string>()];
  const txKeys = new Set<string>(); let previousSeq = 0;
  for (const tx of journal.transactions) {
    ensure(tx.seq > previousSeq && !txKeys.has(tx.txKey), "replay_readiness_sequence_mismatch"); previousSeq = tx.seq; txKeys.add(tx.txKey);
    ensure(time(tx.txStartedAt) <= time(tx.recordedAt) && (!tx.confirmedAt || time(tx.recordedAt) <= time(tx.confirmedAt)), "replay_readiness_commit_bounds_invalid");
    states.push(applyReplayChanges(states.at(-1)!, tx.changes));
    const baseline = new Map(baselines.at(-1)!);
    const owner = new Map(owners.at(-1)!);
    for (const change of tx.changes) if (change.table_name === "second_reviews") {
      if (change.operation === "INSERT") baseline.set(Number(change.new_row!.id), Number(change.new_row!.failure_count));
      if (change.operation === "DELETE") baseline.delete(Number(change.old_row!.id));
    }
    for (const change of tx.changes) if (change.table_name === "jobs") {
      const old = change.old_row, next = change.new_row, name = String((next ?? old)!.name);
      const currentClaim = old && next && typeof next.lease_token === "string" && next.lease_token !== old.lease_token
        && next.locked_at !== null && Number(next.runs) === Number(old.runs) + 1
        && next.requested_version === old.requested_version && Number(next.requested_version) > Number(next.processed_version)
        && Number(next.requested_version) < Number.MAX_SAFE_INTEGER;
      if (currentClaim) owner.set(name, String(next.lease_token));
      else if (!next || next.lease_token !== owner.get(name) || next.locked_at === null) owner.delete(name);
    }
    baselines.push(baseline);
    owners.push(owner);
    points.add(time(tx.txStartedAt)); if (tx.confirmedAt) points.add(time(tx.confirmedAt));
  }
  for (const gap of journal.gaps) { ensure(time(gap.from) < time(gap.until), "replay_readiness_gap_invalid"); points.add(time(gap.from)); points.add(time(gap.until)); }
  for (const state of states) for (const expiry of expiries(state)) points.add(expiry);
  const ordered = [...points].filter(point => point >= from && point <= until).sort((a, b) => a - b);
  const intervals: Array<{ from: string; until: string; firstReadyLower: number; secondReadyLower: number; status: "known" | "unknown"; reasons: string[] }> = [];
  const readyAt = new Map<string, { candidateId: number; inputHash: string; sourceRevisionHash: string; at: string }>();
  for (let i = 0; i + 1 < ordered.length; i++) {
    const left = ordered[i], right = ordered[i + 1], at = (left + right) / 2;
    let lower = 0, upper = 0;
    for (const [index, tx] of journal.transactions.entries()) {
      if (tx.confirmedAt && time(tx.confirmedAt) <= left) lower = index + 1;
      if (time(tx.txStartedAt) < right) upper = index + 1;
    }
    // Every earlier sequence must have started before a later committed prefix is possible.
    while (upper > lower && journal.transactions.slice(0, upper).some(tx => time(tx.txStartedAt) >= right)) upper--;
    const possible = states.slice(lower, Math.max(lower, upper) + 1)
      .map((state, index) => deriveWithFailureHistory(state, iso(Math.floor(at)), baselines[lower + index], owners[lower + index]));
    const firstReadyLower = Math.min(...possible.map(state => state.first.modelReady));
    const secondReadyLower = Math.min(...possible.map(state => state.second.modelReady));
    const totals = possible.map(state => state.first.modelReady + state.second.modelReady), reasons: string[] = [];
    const gap = journal.gaps.some(gap => time(gap.from) < right && time(gap.until) > left);
    if (gap) reasons.push("execution_gap");
    if (lower !== upper && firstReadyLower + secondReadyLower === 0 && Math.max(...totals) > 0) reasons.push("commit_unconfirmed");
    const status = reasons.length ? "unknown" as const : "known" as const;
    const leftIso = iso(left), rightIso = iso(right);
    intervals.push({ from: leftIso, until: rightIso, firstReadyLower, secondReadyLower, status, reasons });
    if (!gap) for (const item of possible[0].work.filter(item => item.modelReady)) {
      const key = `${item.candidateId}:${item.inputHash}:${item.sourceRevisionHash}`;
      if (!readyAt.has(key) && possible.every(state => state.work.some(work => work.candidateId === item.candidateId
        && work.inputHash === item.inputHash && work.sourceRevisionHash === item.sourceRevisionHash && work.modelReady)))
        readyAt.set(key, { candidateId: item.candidateId, inputHash: item.inputHash, sourceRevisionHash: item.sourceRevisionHash, at: leftIso });
    }
  }
  const coverage = intervals.some(row => row.status === "unknown") ? "missing" as const
    : intervals.some(row => row.firstReadyLower + row.secondReadyLower === 0) ? "starved" as const : "covered" as const;
  return { coverage, intervals, readyAtByInput: [...readyAt.values()], initial: deriveWithFailureHistory(states[0], window.from, baselines[0], owners[0]),
    final: deriveWithFailureHistory(states.at(-1)!, window.until, baselines.at(-1), owners.at(-1)) };
}
export type ReplayFrozenReadinessInput = { candidateId: number; inputHash: string; sourceRevisionHash: string; frozen: unknown; frozenHash: string };
/** Called inside the lifecycle's exclusive fence/snapshot; no row locks or caller-supplied readiness. */
export async function captureReplayReadinessProjection(tx: postgres.TransactionSql, manifest: CapacityManifest,
  frozenInputs?: readonly ReplayFrozenReadinessInput[]): Promise<ReplayInitialReadinessSnapshot> {
  const inputs = frozenInputs ?? (await tx`SELECT candidate_id, input_hash, source_revision_hash, frozen_input, frozen_hash
    FROM pipeline_replay.capacity_inputs WHERE run_id=${manifest.runId}`).map(row => ({ candidateId: Number(row.candidate_id),
      inputHash: String(row.input_hash), sourceRevisionHash: String(row.source_revision_hash), frozen: row.frozen_input, frozenHash: String(row.frozen_hash) }));
  ensure(inputs.length === manifest.inputs.length, "replay_readiness_universe_mismatch");
  const tables = {} as ReplayReadinessProjection["tables"];
  for (const name of Object.keys(publicTables) as Array<keyof typeof publicTables>) {
    const rows = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public.${name} t`); tables[name] = rows.map(row => row.row as Row);
  }
  const calls = await tx`SELECT to_jsonb(t) AS row FROM pipeline_replay.capacity_calls t WHERE run_id=${manifest.runId}`;
  tables.capacity_calls = calls.map(row => row.row as Row);
  const projection = canonicalProjection({ version: 1, referenceTime: manifest.referenceTime, tables, universe: inputs.map(item => {
    ensure(manifest.inputs.some(expected => expected.candidateId === item.candidateId && expected.inputHash === item.inputHash
      && expected.sourceRevisionHash === item.sourceRevisionHash), "replay_readiness_universe_mismatch");
    ensure(object(item.frozen).policyHash === manifest.inputPolicyHash, "replay_readiness_universe_mismatch");
    return { candidateId: item.candidateId, inputHash: item.inputHash, sourceRevisionHash: item.sourceRevisionHash,
      policyHash: manifest.inputPolicyHash, frozenInput: item.frozen as Row, frozenHash: item.frozenHash };
  }) });
  const settings = mergeWithDefaults(projection.tables.crawl_settings.find(row => row.id === 1)?.values);
  ensure(settings.firstReview, "replay_readiness_explicit_first_reviewer_required");
  for (const item of projection.universe) {
    const raw = projection.tables.crawl_candidates.find(row => row.id === item.candidateId);
    const actual = raw ? currentInput(projection, hydrate<schema.CrawlCandidate>(raw, schema.crawlCandidates), settings) : null;
    ensure(actual?.fresh && reviewHash(JSON.parse(JSON.stringify(actual.input))) === item.frozenHash, "replay_readiness_current_input_mismatch");
  }
  const [clock] = await tx`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`;
  const capturedAt = utc(clock.now);
  return { projection, capturedAt, ...readinessProjectionHashes(projection, capturedAt) };
}
