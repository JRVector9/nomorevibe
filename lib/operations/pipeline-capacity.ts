import { createHash } from "node:crypto";
import { z } from "zod";
import type { CrawlSettings } from "@/lib/crawl/settings-schema";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";

const text = z.string().min(1).max(160).refine(value => value === value.trim(), "trimmed_text_required");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime().refine(value => new Date(value).toISOString() === value, "canonical_utc_required");
const integer = z.number().int().nonnegative().safe();
const positive = integer.positive();
const identity = z.object({ provider: z.enum(["abcllm", "claude-cli", "grok-cli"]), model: text, canonicalModel: text }).strict();
const input = z.object({ candidateId: positive, inputHash: hash, sourceRevisionHash: hash,
  readyAt: date, stratum: text, reReview: z.boolean() }).strict();
export const capacityManifestSchema = z.object({
  version: z.literal(1), runId: text, revision: z.string().regex(/^[a-f0-9]{7,40}$/),
  mode: z.enum(["fixtures", "model-replay"]), cacheMode: z.enum(["cold", "warm"]),
  referenceTime: date, startedAt: date, endedAt: date,
  inputPolicyHash: hash, fullReviewPolicyHash: hash, comparisonPolicyHash: hash, initialStateHash: hash,
  models: z.object({ first: identity, second: z.array(identity).max(3), fallbacks: z.array(identity).max(2) }).strict(),
  inputs: z.array(input).min(1).max(100_000),
  limits: z.object({ maxCalls: positive.max(1_000_000), maxTokens: positive,
    maxDurationMs: positive.max(86_400_000), concurrency: positive.max(4), perCallTokenUpperBound: positive }).strict(),
}).strict();
export const generationRecordSchema = z.object({
  candidateId: positive, firstAttemptId: positive, inputHash: hash, sourceRevisionHash: hash, policyHash: hash,
  provider: text.nullable(), model: text.nullable(), kind: z.enum(["automatic", "admin_override", "evidence_refresh"]),
  state: z.enum(["running", "succeeded", "failed", "superseded"]), reusedFromAttemptId: positive.nullable(),
  decision: z.enum(["approve", "reject", "needs_review"]).nullable(), startedAt: date,
  completedAt: date.nullable(), validUntil: date, candidateState: z.enum(["new", "approved", "rejected", "needs_review", "published"]),
  decidedBy: z.enum(["auto", "admin"]).nullable(), appliedAttemptId: positive.nullable(), currentInputMatched: z.boolean(),
  secondGateRequired: z.boolean(), secondGateSatisfied: z.boolean(), secondGateCompletedAt: date.nullable(),
}).strict();
const call = z.object({ callId: text, stage: z.enum(["first", "second"]), candidateId: positive,
  firstAttemptId: positive, inputHash: hash, sourceRevisionHash: hash,
  provider: text, model: text, startedAt: date, endedAt: date.nullable(), ok: z.boolean().nullable(),
  error: text.nullable(), inputTokens: integer.nullable(), outputTokens: integer.nullable() }).strict();
const label = z.object({ candidateId: positive, inputHash: hash, expected: z.enum(["approve", "reject"]) }).strict();
export const capacityArtifactSchema = z.object({
  manifest: capacityManifestSchema,
  source: z.object({ kind: z.enum(["fixture", "local-postgres"]), scope: z.literal("as_of_snapshot_only"),
    runId: text, exportedAt: date, fullReviewPolicyHash: hash }).strict(),
  generations: z.array(generationRecordSchema).max(1_000_000),
  readiness: z.array(z.object({ from: date, until: date, ready: integer }).strict()).max(100_000),
  calls: z.array(call).max(1_000_000),
  quality: z.object({ datasetHash: hash, labels: z.array(label).min(1).max(100_000) }).strict().nullable(),
}).strict();
export type CapacityManifest = z.infer<typeof capacityManifestSchema>;
export type GenerationRecord = z.infer<typeof generationRecordSchema>;
export type CapacityArtifact = z.infer<typeof capacityArtifactSchema>;

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  throw new Error("invalid_hash_input");
}
export function fullReviewPolicyHash(settings: CrawlSettings): string {
  return createHash("sha256").update(canonical(settings)).digest("hex");
}
/** The approved experiment may vary concurrency; all decision settings remain fixed. */
export function comparisonReviewPolicyHash(settings: CrawlSettings): string {
  const { reviewConcurrency, ...policy } = settings; void reviewConcurrency;
  return createHash("sha256").update(canonical(policy)).digest("hex");
}
function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
const time = (value: string) => Date.parse(value);
const inputKey = (value: { candidateId: number; inputHash: string; sourceRevisionHash: string }) =>
  `${value.candidateId}:${value.inputHash}:${value.sourceRevisionHash}`;
const labelKey = (value: { candidateId: number; inputHash: string }) => `${value.candidateId}:${value.inputHash}`;
const modelKey = (value: { provider: string | null; model: string | null }) => `${value.provider}:${canonicalReviewModel(value.model ?? "")}`;
function distinct<T>(rows: T[], key: (row: T) => string | number, code: string): T[] {
  const map = new Map<string | number, T>();
  for (const row of rows) {
    const prior = map.get(key(row));
    ensure(!prior || canonical(prior) === canonical(row), code);
    map.set(key(row), row);
  }
  return [...map.values()];
}
function validateManifest(manifest: CapacityManifest): void {
  const start = time(manifest.startedAt), end = time(manifest.endedAt);
  ensure(start < end && end - start <= manifest.limits.maxDurationMs, "invalid_window");
  const inputs = new Set<string>(), reviewKinds = new Map<number, boolean>();
  for (const row of manifest.inputs) {
    ensure(!inputs.has(inputKey(row)), "duplicate_input");
    ensure(time(row.readyAt) <= end, "invalid_window");
    ensure(!reviewKinds.has(row.candidateId) || reviewKinds.get(row.candidateId) === row.reReview, "generation_mismatch");
    inputs.add(inputKey(row)); reviewKinds.set(row.candidateId, row.reReview);
  }
  const { first, second, fallbacks } = manifest.models;
  for (const row of [first, ...second, ...fallbacks])
    ensure(canonicalReviewModel(row.model) === row.canonicalModel, "model_identity_mismatch");
  for (const pool of [second, fallbacks])
    ensure(new Set(pool.map(row => row.canonicalModel)).size === pool.length, "duplicate_model");
}
/** A strict offline record validates consistency, never the authenticity of its JSON provenance. */
export function parseCapacityArtifact(value: unknown): CapacityArtifact {
  const artifact = capacityArtifactSchema.parse(value), { manifest, source } = artifact;
  validateManifest(manifest);
  ensure(source.runId === manifest.runId && source.fullReviewPolicyHash === manifest.fullReviewPolicyHash
    && time(source.exportedAt) >= time(manifest.endedAt), "source_mismatch");
  const inputs = new Set(manifest.inputs.map(inputKey));
  const generations = distinct(artifact.generations, row => row.firstAttemptId, "conflicting_attempt");
  const attempts = new Map(generations.map(row => [row.firstAttemptId, row]));
  for (const row of generations) {
    ensure(inputs.has(inputKey(row)), "generation_mismatch");
    ensure((!row.completedAt || time(row.completedAt) >= time(row.startedAt))
      && time(row.validUntil) > time(row.startedAt), "invalid_generation_time");
    ensure(!row.secondGateCompletedAt || row.completedAt && time(row.secondGateCompletedAt) >= time(row.completedAt), "invalid_generation_time");
    ensure(!row.secondGateRequired || !row.secondGateSatisfied || row.secondGateCompletedAt, "invalid_generation_time");
  }
  for (const row of distinct(artifact.calls, row => row.callId, "conflicting_call")) {
    const attempt = attempts.get(row.firstAttemptId);
    const models = row.stage === "first" ? [manifest.models.first] : [...manifest.models.second, ...manifest.models.fallbacks];
    ensure(inputs.has(inputKey(row)) && attempt && inputKey(attempt) === inputKey(row)
      && models.some(model => modelKey(model) === modelKey(row))
      && time(row.startedAt) >= time(manifest.startedAt) && time(row.startedAt) <= time(manifest.endedAt)
      && (row.endedAt === null ? row.ok === null && row.error === null
        : row.ok !== null && time(row.endedAt) >= time(row.startedAt) && time(row.endedAt) <= time(manifest.endedAt)
          && (row.ok ? row.error === null : row.error !== null)), "call_mismatch");
  }
  if (artifact.quality) {
    const labels = [...artifact.quality.labels].sort((a, b) => labelKey(a).localeCompare(labelKey(b)));
    const keys = new Set(labels.map(labelKey)), allowed = new Set(manifest.inputs.map(labelKey));
    ensure(keys.size === labels.length && labels.every(row => allowed.has(labelKey(row)))
      && createHash("sha256").update(canonical(labels)).digest("hex") === artifact.quality.datasetHash, "quality_mismatch");
  }
  return artifact;
}
function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  return { samples: values.length, p50: values[Math.ceil(.5 * values.length) - 1] ?? null,
    p95: values[Math.ceil(.95 * values.length) - 1] ?? null };
}
function readiness(artifact: CapacityArtifact): "covered" | "missing" | "starved" {
  let cursor = time(artifact.manifest.startedAt), starved = false;
  for (const row of artifact.readiness) {
    if (time(row.from) !== cursor || time(row.until) <= cursor || time(row.until) > time(artifact.manifest.endedAt)) return "missing";
    cursor = time(row.until); starved ||= row.ready === 0;
  }
  return cursor !== time(artifact.manifest.endedAt) ? "missing" : starved ? "starved" : "covered";
}
/** Current durable finals as of export; later decisions can erase historical transitions. */
export function reportCapacityRun(value: unknown) {
  const artifact = parseCapacityArtifact(value), { manifest } = artifact;
  const inputs = new Map(manifest.inputs.map(row => [inputKey(row), row]));
  const exclusions = { rules: 0, reuse: 0, human: 0, partial: 0, stale: 0, reReview: 0, outsideWindow: 0 };
  const finals = new Map<string, { row: GenerationRecord; at: number; ready: number; reReview: boolean }>();
  for (const row of distinct(artifact.generations, row => row.firstAttemptId, "conflicting_attempt")) {
    const input = inputs.get(inputKey(row))!;
    const finalAt = row.completedAt ? Math.max(time(row.completedAt), row.secondGateRequired && row.secondGateCompletedAt ? time(row.secondGateCompletedAt) : 0) : null;
    let exclusion: keyof typeof exclusions | null = null;
    if (row.provider === "rules") exclusion = "rules";
    else if (row.reusedFromAttemptId !== null) exclusion = "reuse";
    else if (row.kind !== "automatic" || row.decidedBy !== "auto" || row.appliedAttemptId !== row.firstAttemptId
      || !["approved", "published", "rejected"].includes(row.candidateState)) exclusion = "human";
    else if (row.state !== "succeeded" || !["approve", "reject"].includes(row.decision ?? "") || finalAt === null
      || row.decision === "approve" && row.secondGateRequired && !row.secondGateSatisfied) exclusion = "partial";
    else if (!row.currentInputMatched || row.policyHash !== manifest.inputPolicyHash || modelKey(row) !== modelKey(manifest.models.first)
      || time(row.validUntil) <= finalAt || row.decision === "approve" && row.candidateState === "rejected"
      || row.decision === "reject" && row.candidateState !== "rejected") exclusion = "stale";
    else if (finalAt <= time(manifest.startedAt) || finalAt > time(manifest.endedAt)) exclusion = "outsideWindow";
    if (exclusion) { exclusions[exclusion]++; continue; }
    ensure(finalAt !== null && finalAt >= time(input.readyAt), "invalid_generation_time");
    const key = inputKey(row), prior = finals.get(key);
    if (!prior || finalAt < prior.at) finals.set(key, { row, at: finalAt, ready: time(input.readyAt), reReview: input.reReview });
    if (input.reReview) exclusions.reReview++;
  }
  const candidates = new Map<number, typeof finals extends Map<string, infer V> ? V : never>();
  for (const item of finals.values()) {
    if (item.reReview) continue;
    const prior = candidates.get(item.row.candidateId);
    if (!prior || item.at < prior.at) candidates.set(item.row.candidateId, item);
  }
  const calls = distinct(artifact.calls, row => row.callId, "conflicting_call");
  const completed = calls.filter(row => row.endedAt !== null);
  const cancelled = completed.filter(row => row.error === "cancelled" || row.error === "deferred").length;
  const tokenSum = (key: "inputTokens" | "outputTokens") => {
    if (!calls.length || calls.some(row => row[key] === null)) return null;
    const total = calls.reduce((sum, row) => sum + row[key]!, 0);
    ensure(Number.isSafeInteger(total), "usage_total_overflow"); return total;
  };
  const inputTokens = tokenSum("inputTokens"), outputTokens = tokenSum("outputTokens");
  const totalTokens = inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
  ensure(totalTokens === null || Number.isSafeInteger(totalTokens), "usage_total_overflow");
  const knownCalls = calls.filter(row => row.inputTokens !== null && row.outputTokens !== null);
  const perCallWithin = knownCalls.every(row => row.inputTokens! + row.outputTokens! <= manifest.limits.perCallTokenUpperBound);
  const knownFinals = new Map([...candidates.values()].map(item => [labelKey(item.row), item.row.decision]));
  let wrongApprovals = 0, wrongRejections = 0, evaluated = 0;
  for (const label of artifact.quality?.labels ?? []) {
    const decision = knownFinals.get(labelKey(label));
    if (!decision) continue;
    evaluated++; wrongApprovals += Number(decision === "approve" && label.expected === "reject");
    wrongRejections += Number(decision === "reject" && label.expected === "approve");
  }
  const qualityComplete = Boolean(artifact.quality && evaluated === artifact.quality.labels.length);
  const durationMs = time(manifest.endedAt) - time(manifest.startedAt);
  const reReviewGenerations = [...finals.values()].filter(item => item.reReview).length;
  return { runId: manifest.runId, evidence: "as_of_snapshot_only" as const, authenticity: "unverified" as const,
    budgetEvidence: "unverified" as const, durationMs, finalCandidates: candidates.size, finalGenerations: finals.size,
    reReviewGenerations, repeatGenerations: finals.size - reReviewGenerations - candidates.size,
    finalPerHour: candidates.size / durationMs * 3_600_000,
    endToEndMs: distribution([...candidates.values()].map(item => item.at - item.ready)), exclusions,
    calls: { completed: completed.length, failed: completed.filter(row => row.ok === false).length - cancelled,
      cancelled, unmatched: calls.length - completed.length, inputTokens, outputTokens },
    recordedBudget: { callsWithinLimit: calls.length <= manifest.limits.maxCalls,
      tokensWithinLimit: totalTokens === null ? null : totalTokens <= manifest.limits.maxTokens,
      perCallTokensWithinLimit: !perCallWithin ? false : knownCalls.length === calls.length && calls.length > 0 ? true : null },
    readiness: readiness(artifact), quality: { status: wrongApprovals + wrongRejections ? "failed" as const
      : qualityComplete ? "passed" as const : "incomplete" as const, wrongApprovals, wrongRejections,
      complete: qualityComplete, evaluated, expected: artifact.quality?.labels.length ?? 0, datasetHash: artifact.quality?.datasetHash ?? null } };
}
function conditions(manifest: CapacityManifest) {
  const { runId, revision, startedAt, endedAt, fullReviewPolicyHash: exactPolicyHash, models, inputs, limits, ...fixed } = manifest;
  void runId; void revision; void exactPolicyHash;
  const { concurrency, ...budget } = limits; void concurrency;
  const model = (row: z.infer<typeof identity>) => ({ provider: row.provider, canonicalModel: row.canonicalModel });
  const pool = (rows: z.infer<typeof identity>[]) => rows.map(model).sort((a, b) => canonical(a).localeCompare(canonical(b)));
  return { ...fixed, durationMs: time(endedAt) - time(startedAt), limits: budget,
    models: { first: model(models.first), second: pool(models.second), fallbacks: pool(models.fallbacks) },
    inputs: inputs.map(({ readyAt, ...row }) => ({ ...row, readyOffsetMs: time(readyAt) - time(startedAt) }))
      .sort((a, b) => inputKey(a).localeCompare(inputKey(b))) };
}
export function compareCapacityRuns(baselineValue: unknown, candidateValue: unknown) {
  const before = parseCapacityArtifact(baselineValue), after = parseCapacityArtifact(candidateValue);
  const baseline = reportCapacityRun(before), candidate = reportCapacityRun(after);
  const reasons = new Set<string>(["model_replay_unverified", "as_of_snapshot_only", "budget_evidence_unverified"]);
  if (canonical(conditions(before.manifest)) !== canonical(conditions(after.manifest))) reasons.add("conditions_mismatch");
  for (const report of [baseline, candidate]) {
    if (report.durationMs < 1_800_000) reasons.add("window_under_30_minutes");
    if (report.readiness !== "covered") reasons.add(report.readiness === "starved" ? "queue_starved" : "readiness_missing");
    if (!report.calls.completed) reasons.add("call_evidence_missing");
    if (report.calls.unmatched) reasons.add("call_evidence_unmatched");
    if (report.calls.inputTokens === null || report.calls.outputTokens === null) reasons.add("token_usage_unknown");
    if (Object.values(report.recordedBudget).some(within => within === false)) reasons.add("recorded_budget_exceeded");
  }
  const ratio = baseline.finalPerHour ? candidate.finalPerHour / baseline.finalPerHour : null;
  const failureRate = (report: typeof baseline) => report.calls.completed > report.calls.cancelled
    ? report.calls.failed / (report.calls.completed - report.calls.cancelled) : null;
  const firstRate = failureRate(baseline), secondRate = failureRate(candidate);
  const numericThresholds = { doubled: ratio === null ? null : ratio >= 2,
    latencyNotWorse: baseline.endToEndMs.p95 === null || candidate.endToEndMs.p95 === null ? null : candidate.endToEndMs.p95 <= baseline.endToEndMs.p95,
    technicalFailureWithinOnePoint: firstRate === null || secondRate === null ? null : secondRate <= firstRate + .01 };
  const quality = !baseline.quality.complete || !candidate.quality.complete || baseline.quality.datasetHash !== candidate.quality.datasetHash
    ? "incomplete" : candidate.quality.wrongApprovals <= baseline.quality.wrongApprovals && candidate.quality.wrongRejections <= baseline.quality.wrongRejections ? "passed" : "failed";
  return { baseline, candidate, ratio, numericThresholds, concurrency: { baseline: before.manifest.limits.concurrency, candidate: after.manifest.limits.concurrency },
    performance: "incomplete" as const, quality, overall: quality === "failed" ? "failed" as const : "incomplete" as const,
    budgetEvidence: "unverified" as const, reasons: [...reasons] };
}
/** Checks requested arithmetic and DB admission only. It never authorizes or executes model replay. */
export function validateReplayPlan(value: unknown, databaseUrl: string,
  env: Readonly<Record<string, string | undefined>> = process.env) {
  const manifest = capacityManifestSchema.parse(value); validateManifest(manifest);
  let local = false;
  try {
    const url = new URL(databaseUrl);
    // postgres.js3.4.9 splits at the first @ and decodes comma-separated hosts.
    // Require its raw host segment to equal the single canonical loopback host.
    const authority = databaseUrl.slice(databaseUrl.indexOf("://") + 3).split(/[?/]/)[0];
    const driverHost = authority.slice(authority.indexOf("@") + 1);
    local = driverHost === url.host && ["postgres:", "postgresql:"].includes(url.protocol)
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && url.pathname === "/nomorevibe_test" && !url.search && !url.hash;
  } catch { /* Fixed error below; never print credentials. */ }
  ensure(local, "local_test_database_required");
  ensure(!["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"].some(key => Boolean(env[key])), "database_override_rejected");
  ensure(!env.DATABASE_URL || env.DATABASE_URL === databaseUrl, "database_url_mismatch");
  ensure(!env.READ_DATABASE_URL, "replica_database_rejected");
  const bound = manifest.limits.maxCalls * manifest.limits.perCallTokenUpperBound;
  ensure(Number.isSafeInteger(bound) && bound <= manifest.limits.maxTokens, "planned_token_budget_exceeded");
  return { configurationValid: true, executionSupported: false, budgetEvidence: "unverified",
    reason: "real_model_replay_unimplemented", limits: manifest.limits } as const;
}
