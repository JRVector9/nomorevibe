import { z } from "zod";
import { reviewHash } from "@/lib/crawl/agent-review-contract";
import { capacityManifestSchema, parseCapacityManifest } from "./pipeline-capacity";
import { assertVerifiedReplayHandlerDatabase, type VerifiedReplayDatabase } from "./pipeline-replay-database";
import { ReplayReadinessProjectionSchema, ReplayReadinessJournalSchema, readinessProjectionHashes,
  reduceReplayReadinessCoverage, type ReplayReadinessProjection } from "./pipeline-replay-readiness";
import { classifyReplayInitialCandidates } from "./pipeline-replay-classification";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().min(1).max(160).refine(value => value === value.trim());
const integer = z.number().int().nonnegative().safe(), positive = integer.positive();
const timestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/;
const date = z.string().datetime().refine(value => timestamp.test(value)
  && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19));
const inputKeySchema = z.object({ candidateId: positive, inputHash: hash, sourceRevisionHash: hash }).strict();
export const replayQualitySchema = z.object({ datasetHash: hash, cohort: z.array(inputKeySchema).min(1).max(100_000),
  labels: z.array(inputKeySchema.extend({ expected: z.enum(["approve", "reject"]) }).strict()).max(100_000) }).strict();
export const replayArtifactCallSchema = z.object({ callId: text, candidateId: positive, firstAttemptId: positive.nullable(),
  inputHash: hash, sourceRevisionHash: hash, stage: z.enum(["first", "second"]), provider: text, model: text,
  secondReviewId: positive.nullable(), generationKey: text.nullable(), vote: positive.nullable(), requestHash: hash,
  tokenUpperBound: positive, state: z.enum(["settled", "cancelled_before_dispatch"]),
  dispatchedAt: date.nullable(), settledAt: date.nullable(), inputTokens: integer.nullable(), outputTokens: integer.nullable(),
  resultOk: z.boolean().nullable(), resultHash: hash.nullable(), resultDecisionHash: hash.nullable(),
  failureClass: z.enum(["technical", "cancelled", "deferred", "unknown"]).nullable() }).strict();
const witnessSchema = z.object({ secondReviewId: positive, callId: text, rootId: positive, generationKey: text,
  rootCallId: text.nullable(), vote: positive, provider: text, model: text, slotProvider: text, slotModel: text }).strict();
export const replayArtifactFinalSchema = inputKeySchema.extend({ policyHash: hash, seq: positive, at: date,
  firstAttemptId: positive, firstCallId: text, decision: z.enum(["approve", "reject"]),
  secondWitnesses: z.array(witnessSchema).max(3) }).strict();
export const replayArtifactSchema = z.object({ kind: z.literal("pipeline-replay-ledger"), version: z.literal(1),
  manifest: capacityManifestSchema,
  run: z.object({ runId: text, epoch: positive, profile: z.literal("handlers-v5"), state: z.literal("sealed"),
    startedAt: date, deadlineAt: date, admissionClosedAt: date, writersFencedAt: date, sealedAt: date,
    chargedCalls: integer, chargedTokens: integer }).strict(),
  initial: z.object({ capturedAt: date, initialStateHash: hash, comparisonStateHash: hash,
    projection: ReplayReadinessProjectionSchema,
    runner: z.object({ jobs: z.array(z.enum(["crawl-agent-review", "second-review"])).min(1).max(100),
      budgetMs: positive.max(110_000) }).strict(), quality: replayQualitySchema.nullable() }).strict(),
  journal: z.array(z.object({ seq: positive, at: date, kind: text, txKey: text.nullable(), payloadHash: hash }).strict()).min(1).max(2_000_000),
  readiness: ReplayReadinessJournalSchema,
  calls: z.array(replayArtifactCallSchema).max(1_000_000), finals: z.array(replayArtifactFinalSchema).max(1_000_000),
  seal: z.object({ headSeq: positive, manifestHash: hash, initialStateHash: hash,
    comparisonStateHash: hash, contentHash: hash }).strict(),
}).strict();
export type ReplayArtifact = z.infer<typeof replayArtifactSchema>;
export type ReplayArtifactCall = z.infer<typeof replayArtifactCallSchema>;
export type ReplayArtifactFinal = z.infer<typeof replayArtifactFinalSchema>;
const verifiedBrand: unique symbol = Symbol("VerifiedReplayArtifact");
export type VerifiedReplayArtifact = Readonly<{ [verifiedBrand]: true }>;
const verified = new WeakMap<object, ReplayArtifact>();
/** PostgreSQL commit upper bounds must not be rounded down to JavaScript milliseconds. */
export function replayTimestampMicros(value: string): bigint {
  const match = timestamp.exec(value);
  if (!match) throw new Error("invalid_replay_artifact");
  return BigInt(Date.parse(`${match[1]}.000Z`)) * BigInt(1000) + BigInt(match[2].padEnd(6, "0"));
}
const time = replayTimestampMicros;
const key = (value: { candidateId: number; inputHash: string; sourceRevisionHash: string }) =>
  `${value.candidateId}:${value.inputHash}:${value.sourceRevisionHash}`;
const ensure = (value: unknown): void => { if (!value) throw new Error("invalid_replay_artifact"); };
function unique<T>(rows: readonly T[], identity: (row: T) => string | number) {
  ensure(new Set(rows.map(identity)).size === rows.length);
}
export function replayArtifactContentHash(value: Omit<ReplayArtifact, "seal">): string { return reviewHash(value); }
export function replayQualityDatasetHash(value: Pick<NonNullable<ReplayArtifact["initial"]["quality"]>, "cohort" | "labels">): string {
  return reviewHash({ cohort: [...value.cohort].sort((a, b) => key(a).localeCompare(key(b))),
    labels: [...value.labels].sort((a, b) => key(a).localeCompare(key(b))) });
}

/** Structural consistency is deliberately independent from provenance authentication. */
export function parseReplayArtifact(value: unknown): ReplayArtifact {
  try {
    const artifact = replayArtifactSchema.parse(value), { manifest, run, initial, seal } = artifact;
    parseCapacityManifest(manifest);
    const projection = initial.projection as ReplayReadinessProjection;
    const hashes = readinessProjectionHashes(projection, initial.capturedAt);
    ensure(run.runId === manifest.runId && initial.initialStateHash === manifest.initialStateHash
      && hashes.initialStateHash === initial.initialStateHash && hashes.comparisonStateHash === initial.comparisonStateHash
      && seal.initialStateHash === initial.initialStateHash && seal.comparisonStateHash === initial.comparisonStateHash
      && seal.manifestHash === reviewHash(manifest));
    ensure(time(initial.capturedAt) <= time(run.startedAt) && time(run.startedAt) < time(run.admissionClosedAt)
      && time(run.admissionClosedAt) <= time(run.writersFencedAt) && time(run.writersFencedAt) <= time(run.sealedAt)
      && time(run.startedAt) < time(run.deadlineAt)
      && time(run.deadlineAt) - time(run.startedAt) <= BigInt(manifest.limits.maxDurationMs) * BigInt(1000));
    const inputs = new Map(manifest.inputs.map(row => [key(row), row]));
    unique(projection.universe, key);
    ensure(projection.referenceTime === manifest.referenceTime && projection.universe.length === inputs.size
      && projection.universe.every(row => inputs.has(key(row)) && row.policyHash === manifest.inputPolicyHash
        && row.frozenHash === reviewHash(row.frozenInput)));
    unique(artifact.journal, row => row.seq);
    ensure(artifact.journal.length === seal.headSeq && artifact.journal.every((row, index) => row.seq === index + 1
      && time(row.at) <= time(run.sealedAt) && (!index || time(row.at) >= time(artifact.journal[index - 1].at))));
    const journal = new Map(artifact.journal.map(row => [row.seq, row]));
    unique(artifact.readiness.transactions, row => row.seq);
    unique(artifact.readiness.transactions, row => row.txKey);
    ensure(artifact.readiness.transactions.every(row => journal.get(row.seq)?.txKey === row.txKey
      && time(row.txStartedAt) <= time(row.recordedAt) && time(row.recordedAt) <= time(journal.get(row.seq)!.at)
      && (row.confirmedAt === null || time(journal.get(row.seq)!.at) <= time(row.confirmedAt) && time(row.confirmedAt) <= time(run.sealedAt))));
    const confirmations = new Map(artifact.readiness.transactions.map(row => [row.txKey, row.confirmedAt]));
    unique(artifact.calls, row => row.callId);
    const chargedTokens = artifact.calls.reduce((sum, row) => sum + row.tokenUpperBound, 0);
    ensure(Number.isSafeInteger(chargedTokens) && run.chargedCalls === artifact.calls.length && run.chargedTokens === chargedTokens);
    const calls = new Map(artifact.calls.map(row => [row.callId, row]));
    for (const call of artifact.calls) {
      ensure(inputs.has(key(call)) && call.tokenUpperBound <= manifest.limits.perCallTokenUpperBound);
      ensure(call.stage === "first" ? call.firstAttemptId !== null && call.secondReviewId === null && call.generationKey === null && call.vote === null
        : call.secondReviewId !== null && call.generationKey !== null && call.vote !== null);
      const models = call.stage === "first" ? [manifest.models.first] : [...manifest.models.second, ...manifest.models.fallbacks];
      ensure(models.some(row => row.provider === call.provider && row.model === call.model));
      if (call.state === "cancelled_before_dispatch") {
        ensure(call.dispatchedAt === null && call.settledAt === null && call.inputTokens === null && call.outputTokens === null
          && call.resultOk === null && call.resultHash === null && call.resultDecisionHash === null && call.failureClass === null);
      } else {
        ensure(call.dispatchedAt !== null && call.settledAt !== null
          && time(call.dispatchedAt!) >= time(run.startedAt) && time(call.dispatchedAt!) <= time(run.admissionClosedAt)
          && time(call.settledAt!) >= time(call.dispatchedAt!) && time(call.settledAt!) <= time(run.writersFencedAt));
        ensure(call.resultOk === true ? call.resultHash !== null && call.resultDecisionHash !== null && call.failureClass === null
          : call.resultHash === null && call.resultDecisionHash === null && (call.resultOk === false || call.failureClass === null));
        ensure(call.inputTokens === null || call.outputTokens === null || Number.isSafeInteger(call.inputTokens + call.outputTokens)
          && call.inputTokens + call.outputTokens <= call.tokenUpperBound);
      }
    }
    unique(artifact.finals, row => `${key(row)}:${row.policyHash}`);
    unique(artifact.finals, row => row.seq);
    for (const final of artifact.finals) {
      const call = calls.get(final.firstCallId);
      ensure(inputs.has(key(final)) && final.policyHash === manifest.inputPolicyHash && journal.get(final.seq)?.kind === "final"
        && time(final.at) >= time(run.startedAt) && time(final.at) <= time(run.writersFencedAt)
        && call && key(call) === key(final) && call.firstAttemptId === final.firstAttemptId && call.stage === "first" && call.resultOk === true
        && call.provider === manifest.models.first.provider && call.model === manifest.models.first.model);
      const txKey = journal.get(final.seq)?.txKey;
      const confirmation = txKey ? confirmations.get(txKey) : null;
      ensure(!confirmation || time(confirmation) >= time(final.at));
      unique(final.secondWitnesses, row => `${row.slotProvider}:${row.slotModel}`);
      for (const witness of final.secondWitnesses) {
        const vote = calls.get(witness.callId), root = witness.rootCallId ? calls.get(witness.rootCallId) : null;
        ensure(witness.vote === witness.rootId && vote && key(vote) === key(final) && vote.firstAttemptId === final.firstAttemptId
          && vote.stage === "second" && vote.resultOk === true && vote.secondReviewId === witness.secondReviewId
          && vote.vote === witness.rootId && vote.generationKey === witness.generationKey
          && vote.provider === witness.provider && vote.model === witness.model
          && manifest.models.second.some(slot => slot.provider === witness.slotProvider && slot.model === witness.slotModel));
        ensure(witness.secondReviewId === witness.rootId ? witness.rootCallId === null
            && witness.provider === witness.slotProvider && witness.model === witness.slotModel
          : root && key(root) === key(final) && root.firstAttemptId === final.firstAttemptId && root.stage === "second"
            && root.resultOk === false && root.secondReviewId === witness.rootId && root.vote === witness.rootId
            && root.generationKey === witness.generationKey && root.provider === witness.slotProvider && root.model === witness.slotModel
            && manifest.models.fallbacks.some(model => model.provider === witness.provider && model.model === witness.model));
      }
    }
    if (initial.quality) {
      const quality = initial.quality;
      unique(quality.cohort, key); unique(quality.labels, key);
      const cohort = new Set(quality.cohort.map(key));
      ensure(quality.cohort.every(row => inputs.has(key(row))) && quality.labels.every(row => cohort.has(key(row)))
        && replayQualityDatasetHash(quality) === quality.datasetHash);
    }
    const { seal: omitted, ...content } = artifact; void omitted;
    ensure(replayArtifactContentHash(content) === seal.contentHash);
    return artifact;
  } catch { throw new Error("invalid_replay_artifact"); }
}

/** No callback, artifact flag or caller-supplied digest can create this capability. */
export async function loadVerifiedReplayArtifact(database: VerifiedReplayDatabase, runId: string,
  expectedArtifact?: unknown): Promise<VerifiedReplayArtifact> {
  assertVerifiedReplayHandlerDatabase(database);
  const expected = expectedArtifact === undefined ? undefined : parseReplayArtifact(expectedArtifact);
  const { readSealedReplayArtifact } = await import("./pipeline-replay-execution");
  const artifact = parseReplayArtifact(await readSealedReplayArtifact(database, runId));
  if (artifact.run.runId !== runId || expected && reviewHash(expected) !== reviewHash(artifact))
    throw new Error("replay_artifact_database_mismatch");
  const handle = Object.freeze({ [verifiedBrand]: true as const });
  verified.set(handle, structuredClone(artifact)); return handle;
}
export function replayArtifactFromVerified(value: unknown): ReplayArtifact {
  const artifact = value && typeof value === "object" ? verified.get(value) : undefined;
  if (!artifact) throw new Error("verified_replay_artifact_required");
  return structuredClone(artifact);
}
function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  return { samples: values.length, p50: values[Math.ceil(values.length * .5) - 1] ?? null,
    p95: values[Math.ceil(values.length * .95) - 1] ?? null };
}

function report(artifact: ReplayArtifact, authenticity: "unverified" | "verified") {
  const { run, manifest, initial } = artifact, start = time(run.startedAt), end = time(run.admissionClosedAt);
  const initialClassification = classifyReplayInitialCandidates(initial.projection as ReplayReadinessProjection, manifest);
  const reviewKinds = new Map(initialClassification.map(row => [row.candidateId, row.kind]));
  const journal = new Map(artifact.journal.map(row => [row.seq, row]));
  const commits = new Map(artifact.readiness.transactions.map(row => [row.txKey, row.confirmedAt]));
  const committedAt = (row: ReplayArtifactFinal) => {
    const txKey = journal.get(row.seq)?.txKey;
    return txKey ? commits.get(txKey) ?? null : null;
  };
  const unconfirmedFinals = artifact.finals.filter(row => !committedAt(row)).length;
  const finals = artifact.finals.filter(row => committedAt(row) && time(committedAt(row)!) > start && time(committedAt(row)!) <= end)
    .sort((a, b) => Number(time(committedAt(a)!) - time(committedAt(b)!)) || a.seq - b.seq);
  const candidates = new Map<number, ReplayArtifactFinal>();
  let reReviewGenerations = 0, unclassifiedGenerations = 0;
  for (const row of finals) {
    if (reviewKinds.get(row.candidateId) === "reReview") { reReviewGenerations++; continue; }
    if (reviewKinds.get(row.candidateId) !== "new") { unclassifiedGenerations++; continue; }
    if (!candidates.has(row.candidateId)) candidates.set(row.candidateId, row);
  }
  const completed = artifact.calls.filter(row => row.state === "settled");
  const usageKnown = completed.every(row => row.inputTokens !== null && row.outputTokens !== null);
  const sum = (values: number[]) => { const total = values.reduce((a, b) => a + b, 0);
    if (!Number.isSafeInteger(total)) throw new Error("replay_artifact_usage_overflow"); return total; };
  const chargedTokens = sum(artifact.calls.map(row => row.tokenUpperBound));
  const inputTokens = usageKnown ? sum(completed.map(row => row.inputTokens!)) : null;
  const outputTokens = usageKnown ? sum(completed.map(row => row.outputTokens!)) : null;
  const totalTokens = inputTokens === null || outputTokens === null ? null : sum([inputTokens, outputTokens]);
  const classificationKnown = completed.every(row => row.resultOk === true || row.resultOk === false
    && row.failureClass !== null && row.failureClass !== "unknown");
  const technical = completed.filter(row => row.resultOk === false && row.failureClass === "technical").length;
  const cancelled = completed.filter(row => row.resultOk === false && ["cancelled", "deferred"].includes(row.failureClass ?? "")).length;
  const judged = new Map(finals.map(row => [key(row), row.decision]));
  let evaluated = 0, wrongApprovals = 0, wrongRejections = 0;
  for (const label of initial.quality?.labels ?? []) {
    const decision = judged.get(key(label)); if (!decision) continue;
    evaluated++; wrongApprovals += Number(decision === "approve" && label.expected === "reject");
    wrongRejections += Number(decision === "reject" && label.expected === "approve");
  }
  const qualityComplete = Boolean(initial.quality && initial.quality.labels.length === initial.quality.cohort.length
    && evaluated === initial.quality.cohort.length);
  const readiness = reduceReplayReadinessCoverage({ ...initial, projection: initial.projection as ReplayReadinessProjection },
    artifact.readiness, { from: run.startedAt, until: run.admissionClosedAt });
  const certifiedReady = new Map((readiness.readyAtByInput ?? []).map(row => [key(row), row.at]));
  // A later readiness confirmation is an upper bound, so subtracting it would
  // understate latency. Only readiness certified at the window start is exact.
  const latencyEvidenceComplete = [...candidates.values()].every(row => certifiedReady.has(key(row))
    && time(certifiedReady.get(key(row))!) <= start);
  const latencies = latencyEvidenceComplete ? [...candidates.values()].map(row =>
    Number(time(committedAt(row)!) - time(certifiedReady.get(key(row))!)) / 1000) : [];
  return { runId: run.runId, evidence: "sealed_replay_ledger" as const, authenticity,
    mode: manifest.mode, budgetEvidence: "unverified" as const, durationMs: Number(end - start) / 1000,
    finalCandidates: candidates.size, finalGenerations: finals.length, reReviewGenerations,
    repeatGenerations: finals.length - reReviewGenerations - unclassifiedGenerations - candidates.size,
    unclassifiedGenerations, classificationComplete: initialClassification.every(row => row.kind !== "unknown"), initialClassification,
    unconfirmedFinals, outsideWindowFinals: artifact.finals.length - finals.length - unconfirmedFinals,
    finalPerHour: candidates.size / (Number(end - start) / 1000) * 3_600_000,
    endToEndMs: distribution(latencies), latencyEvidenceComplete,
    readiness: readiness.coverage, readinessIntervals: readiness.intervals,
    calls: { charged: artifact.calls.length, completed: completed.length, cancelledBeforeDispatch: artifact.calls.length - completed.length,
      failed: classificationKnown ? technical : null, cancelled: classificationKnown ? cancelled : null,
      technicalFailureRate: classificationKnown && completed.length > cancelled ? technical / (completed.length - cancelled) : null,
      classificationKnown, inputTokens, outputTokens },
    recordedBudget: { chargedTokens, callsWithinLimit: artifact.calls.length <= manifest.limits.maxCalls,
      reservedTokensWithinLimit: chargedTokens <= manifest.limits.maxTokens,
      actualTokensWithinLimit: totalTokens === null ? null : totalTokens <= manifest.limits.maxTokens },
    quality: { complete: qualityComplete, status: !qualityComplete ? "incomplete" as const
      : wrongApprovals || wrongRejections ? "failed" as const : "passed" as const,
      evaluated, expected: initial.quality?.cohort.length ?? 0, wrongApprovals, wrongRejections,
      datasetHash: initial.quality?.datasetHash ?? null } };
}
export function reportReplayArtifact(value: unknown) { return report(parseReplayArtifact(value), "unverified"); }
export function reportVerifiedReplayArtifact(value: VerifiedReplayArtifact) { return report(replayArtifactFromVerified(value), "verified"); }
