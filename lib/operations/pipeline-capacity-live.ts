import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";
import { dbIdentitySchema } from "./dr/epoch";
import { budgetEvidenceConsistent, budgetEvidenceSchema, judgeBudget } from "./pipeline-capacity-budget";

/** PR17 고정 기준: 30분 이상 구간, 최종 고유 완료 2.0배, p95 악화 없음, 기술 실패 +1%p 이하. */
export const LIVE_MIN_WINDOW_MS = 1_800_000;
export const LIVE_MAX_WINDOW_MS = 86_400_000;
export const LIVE_ROW_LIMIT = 100_000;
/** 0076 운영 스키마에는 없는 테이블. 없으면 stage=legacy, 모델 슬롯=disabled, item lease 없음으로 고정한다. */
export const LIVE_OPTIONAL_TABLES = ["pipeline_stage_modes", "pipeline_item_leases", "model_capacity_control"] as const;
/**
 * 기준선 건전성 하한(F1). 하나라도 못 미치면 비교 불가(incomplete)다 — 판정을 느슨하게 하는 값이 아니다.
 * - 고유 최종 30건: Poisson 근사에서 기준선이 그 수로 관측됐을 때 실제 1.5배인 후보가 2.0배로 보일 확률이 10건 12%, 30건 2%다
 *   (기준선도 우연이면 28%·13%). 하한은 충분조건이 아니라 이보다 작은 표본을 아예 판정하지 않는 바닥이다.
 * - 라벨 30건: 잘못 승인 비율 10%인 후보가 표본에서 0건으로 보일 확률이 10건이면 35%, 30건이면 4%다. 라벨은 두 실행이 같은 표본이다.
 * - 워커 공백 5분: legacy 심사 잡 주기 60초 + 게이트웨이 시간 제한 60초 + 같은 줄 AI2 틱 예산 110초보다 길다. 준비 증인이 있는데
 *   AI1 호출이 이보다 오래 없으면 워커가 멈춘 구간이다.
 * - 기술 실패율 5%: 기준선이 망가진 구간이면 '기준+1%p' 비교가 무의미해진다.
 */
export const LIVE_MIN_BASELINE_FINALS = 30;
export const LIVE_MIN_QUALITY_LABELS = 30;
export const LIVE_MAX_BASELINE_IDLE_MS = 300_000;
export const LIVE_MAX_BASELINE_FAILURE_PERCENT = 5;

const text = z.string().min(1).max(160).refine(value => value === value.trim(), "trimmed_text_required");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime().refine(value => new Date(value).toISOString() === value, "canonical_utc_required");
const integer = z.number().int().nonnegative().safe();
const positive = integer.positive();
/** 구간 시작 기준 ms. DB가 시간대 없는 UTC 벽시계 차이를 직접 계산한 값이다. */
const offset = z.number().int().safe();
const identity = z.object({ provider: z.enum(["abcllm", "claude-cli", "grok-cli"]), model: text, canonicalModel: text }).strict();
const decision = z.enum(["approve", "reject", "needs_review"]);
const attempt = z.object({ id: positive, candidateId: positive, inputHash: hash,
  state: z.enum(["running", "succeeded", "failed", "superseded"]), failure: z.enum(["technical", "cancelled"]).nullable(),
  provider: text.nullable(), model: text.nullable(), policyHash: hash, promptVersion: text, rulesVersion: text,
  reusedFromAttemptId: positive.nullable(), decision: decision.nullable(), reReview: z.boolean(),
  readyMs: offset, startedMs: offset, completedMs: offset.nullable(),
  inputTokens: integer.nullable(), outputTokens: integer.nullable() }).strict();
const vote = z.object({ id: positive, firstAttemptId: positive,
  status: z.enum(["pending", "agreed", "needs_human", "failed", "resolved"]), settledElsewhere: z.boolean(), fallback: z.boolean(),
  provider: text.nullable(), model: text.nullable(), slotProvider: text.nullable(), slotModel: text.nullable(),
  secondDecision: decision.nullable(), reviewedMs: offset.nullable() }).strict();
const candidate = z.object({ id: positive, state: z.enum(["new", "approved", "rejected", "needs_review", "published"]),
  decidedBy: z.enum(["auto", "admin"]).nullable(), appliedAttemptId: positive.nullable() }).strict();
const label = z.object({ candidateId: positive, inputHash: hash, expected: z.enum(["approve", "reject"]) }).strict();
/** 0097 증거 장부. 기록 시작 marker가 구간 시작 이전일 때만 싣는다. 거부 건수는 가드가 작동한 참고값이다(위반 아님). */
const ledger = z.object({ startedAt: date, humanDecisionRefusals: integer, lateWritesRefused: integer }).strict();
const ledgerCount = z.union([z.literal("unverified"), integer]);
/**
 * F1 출처: 수집기가 남긴 출처 종류와 비밀 아닌 DB 식별자(DR과 같은 system_identifier·database oid·이름, 함수 권한이 없으면 null).
 * 없으면(이전 artifact) 비교는 incomplete다.
 */
const source = z.object({ kind: z.enum(["live", "replay"]), database: dbIdentitySchema.nullable() }).strict();
export const liveCapacityLabelsSchema = z.array(label).min(1).max(100_000);
export const liveCapacityArtifactSchema = z.object({
  version: z.literal(1), scope: z.literal("live_window"), runId: text, revision: z.string().regex(/^[a-f0-9]{7,40}$/),
  schema: z.object({ appliedMigrations: integer.nullable(), absentTables: z.array(z.enum(LIVE_OPTIONAL_TABLES)).max(3) }).strict(),
  window: z.object({ startedAt: date, endedAt: date, durationMs: positive.max(LIVE_MAX_WINDOW_MS),
    collectedAt: date, collectedAfterEndMs: integer }).strict(),
  database: z.object({ target: z.enum(["primary", "replica"]), inRecovery: z.boolean(), readOnly: z.literal(true),
    isolation: z.literal("repeatable read"), replicaCaughtUp: z.boolean().nullable(), writeXidAssigned: z.literal(false) }).strict(),
  source: source.optional(),
  identity: z.object({ promptVersion: text, rulesVersion: text, inputPolicyHash: hash, comparisonPolicyHash: hash,
    fullReviewPolicyHash: hash, reviewMode: z.enum(["off", "observe", "enforce"]), secondGateRequired: z.boolean(),
    concurrency: positive, settingsUpdatedMs: offset.nullable(),
    models: z.object({ first: identity, second: z.array(identity).max(16), fallbacks: z.array(identity).max(16) }).strict() }).strict(),
  stageModes: z.array(z.object({ stage: z.enum(["fetch", "ai1", "ai2"]), mode: z.enum(["legacy", "draining", "items"]),
    epoch: positive, changedSinceStart: z.boolean() }).strict()).max(3),
  modelCapacity: z.object({ mode: z.enum(["disabled", "open", "draining"]), changedSinceStart: z.boolean() }).strict().nullable(),
  attempts: z.array(attempt).max(LIVE_ROW_LIMIT), votes: z.array(vote).max(LIVE_ROW_LIMIT),
  candidates: z.array(candidate).max(LIVE_ROW_LIMIT),
  ai2Calls: z.object({ chains: integer, calls: integer, failed: integer, unattributedChains: integer }).strict(),
  readiness: z.object({ witnesses: integer, sampleCandidateIds: z.array(positive).max(20) }).strict(),
  ledger: ledger.nullable().optional(),
  // 증명할 수 없는 항목은 JSON에서 검증됨으로 올릴 수 없다. 사람 판단 덮음·lease 위반은 ledger가 구간을 덮을 때만 수치다.
  safety: z.object({ duplicatePublications: integer, humanDecisionOverrides: ledgerCount, leaseViolations: ledgerCount }).strict(),
  // PR01b-9: 모델 슬롯 장부가 세 조건을 모두 증명할 때만 verified다(pipeline-capacity-budget). 이전 artifact의 {status:"unverified"}도 받는다.
  budget: budgetEvidenceSchema,
  quality: z.object({ datasetHash: hash, labels: liveCapacityLabelsSchema }).strict().nullable(),
}).strict();
export type LiveCapacityArtifact = z.infer<typeof liveCapacityArtifactSchema>;
type Attempt = LiveCapacityArtifact["attempts"][number];
type Vote = LiveCapacityArtifact["votes"][number];
type Identity = z.infer<typeof identity>;
export type LiveCapacitySource = z.infer<typeof source>;

function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
function unique<T>(rows: T[], key: (row: T) => number | string): boolean { return new Set(rows.map(key)).size === rows.length; }
const labelKey = (row: { candidateId: number; inputHash: string }) => `${row.candidateId}:${row.inputHash}`;
const modelKey = (provider: string | null, model: string | null) => `${provider}:${canonicalReviewModel(model ?? "")}`;
/** 기존 pipeline-capacity의 canonical label hash와 같은 값이다(키 알파벳 순서 고정). */
export function liveLabelDatasetHash(labels: z.infer<typeof label>[]): string {
  const sorted = [...labels].sort((a, b) => labelKey(a).localeCompare(labelKey(b)))
    .map(row => ({ candidateId: row.candidateId, expected: row.expected, inputHash: row.inputHash }));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

/** Strict 일관성 검사다. JSON 출처의 진위는 증명하지 않는다. */
export function parseLiveCapacityArtifact(value: unknown): LiveCapacityArtifact {
  const artifact = liveCapacityArtifactSchema.parse(value), { window, database, identity: fixed } = artifact;
  ensure(Date.parse(window.endedAt) - Date.parse(window.startedAt) === window.durationMs
    && Date.parse(window.collectedAt) >= Date.parse(window.endedAt), "live_artifact_mismatch");
  ensure(database.target === "primary" ? !database.inRecovery && database.replicaCaughtUp === null
    : database.inRecovery && database.replicaCaughtUp !== null, "live_artifact_mismatch");
  const { first, second, fallbacks } = fixed.models;
  ensure([first, ...second, ...fallbacks].every(row => canonicalReviewModel(row.model) === row.canonicalModel)
    && unique(second, row => row.canonicalModel) && unique(fallbacks, row => row.canonicalModel)
    && unique(artifact.stageModes, row => row.stage), "live_artifact_mismatch");
  // 없는 테이블은 구간 중 바뀔 수 없다: 고정값 외의 모드·변경 표시는 위조로 본다.
  const absent = new Set(artifact.schema.absentTables);
  ensure(absent.size === artifact.schema.absentTables.length
    && (!absent.has("pipeline_stage_modes") || artifact.stageModes.length === 3
      && artifact.stageModes.every(row => row.mode === "legacy" && row.epoch === 1 && !row.changedSinceStart))
    && (!absent.has("model_capacity_control") || artifact.modelCapacity?.mode === "disabled"
      && !artifact.modelCapacity.changedSinceStart), "live_artifact_mismatch");
  ensure(unique(artifact.attempts, row => row.id) && unique(artifact.votes, row => row.id)
    && unique(artifact.candidates, row => row.id), "live_artifact_mismatch");
  const attempts = new Set(artifact.attempts.map(row => row.id)), candidates = new Set(artifact.candidates.map(row => row.id));
  ensure(artifact.attempts.every(row => candidates.has(row.candidateId)
    && (row.state === "failed") === (row.failure !== null)
    && (row.state === "running") === (row.completedMs === null)
    && (row.state !== "succeeded" || row.decision !== null)), "live_artifact_mismatch");
  ensure(artifact.votes.every(row => attempts.has(row.firstAttemptId)), "live_artifact_mismatch");
  ensure(artifact.ai2Calls.failed <= artifact.ai2Calls.calls
    && artifact.readiness.sampleCandidateIds.length <= artifact.readiness.witnesses
    && unique(artifact.readiness.sampleCandidateIds, id => id), "live_artifact_mismatch");
  // 장부가 덮은 구간만 수치를 싣고, 그때 AI2 호출은 호출 시각으로 귀속되므로 귀속 불가 사슬이 없다.
  const covered = Boolean(artifact.ledger);
  ensure(covered === (typeof artifact.safety.humanDecisionOverrides === "number")
    && covered === (typeof artifact.safety.leaseViolations === "number")
    && (!artifact.ledger || Date.parse(artifact.ledger.startedAt) <= Date.parse(window.startedAt)
      && artifact.ai2Calls.unattributedChains === 0), "live_artifact_mismatch");
  // 장부 budget은 열린 모드가 구간 내내 그대로이고 0097 장부가 구간을 덮을 때만 수집기가 verified로 낸다. 계량기 증거는 replay 보고에만 있다.
  const { budget } = artifact;
  ensure(budgetEvidenceConsistent(budget) && (budget.status === "unverified" || budget.source === "model_capacity_ledger"
    && artifact.modelCapacity?.mode === "open" && !artifact.modelCapacity.changedSinceStart && covered), "live_artifact_mismatch");
  if (artifact.quality) ensure(unique(artifact.quality.labels, labelKey)
    && liveLabelDatasetHash(artifact.quality.labels) === artifact.quality.datasetHash, "live_quality_mismatch");
  return artifact;
}

/** 사후 사람 표본 판정을 고정 hash와 함께 붙인다. 이미 붙은 표본은 바꾸지 않는다. */
export function attachLiveCapacityLabels(artifactValue: unknown, labelsValue: unknown): LiveCapacityArtifact {
  const artifact = parseLiveCapacityArtifact(artifactValue), labels = liveCapacityLabelsSchema.parse(labelsValue);
  ensure(artifact.quality === null, "live_quality_already_attached");
  return parseLiveCapacityArtifact({ ...artifact, quality: { datasetHash: liveLabelDatasetHash(labels), labels } });
}

function distribution(values: number[]) {
  values.sort((a, b) => a - b);
  return { samples: values.length, p50: values[Math.ceil(.5 * values.length) - 1] ?? null,
    p95: values[Math.ceil(.95 * values.length) - 1] ?? null };
}
/** 발행 SQL 관문과 같은 칸 규칙: 1차와 다른 현재 2차 모델 칸마다 승인 표, 열린 표 없음. */
function gateTime(row: Attempt, votes: Vote[], published: boolean, fixed: LiveCapacityArtifact["identity"]): number | null {
  const slots = fixed.models.second.filter(slot => slot.canonicalModel !== canonicalReviewModel(row.model ?? ""));
  if (!slots.length || votes.some(vote => ["pending", "failed", "needs_human"].includes(vote.status))) return null;
  const fallbacks = new Set(fixed.models.fallbacks.map(model => modelKey(model.provider, model.model)));
  // 발행 뒤 정리는 일치 표를 decided_elsewhere로 닫는다. 현재 적용된 자동 발행분에서만 그 표를 인정한다.
  const accepted = votes.filter(vote => vote.secondDecision === "approve" && vote.reviewedMs !== null
    && (vote.status === "agreed" || vote.status === "resolved" && vote.settledElsewhere && published)
    && (!vote.fallback || fallbacks.has(modelKey(vote.provider, vote.model))));
  let gate = -Infinity;
  for (const slot of slots) {
    const times = accepted.filter(vote => vote.slotProvider === slot.provider
      && modelKey(vote.slotProvider, vote.slotModel) === modelKey(slot.provider, slot.model)).map(vote => vote.reviewedMs!);
    if (!times.length) return null;
    gate = Math.max(gate, Math.min(...times));
  }
  return gate;
}
const comparableModel = (row: Identity) => ({ provider: row.provider, canonicalModel: row.canonicalModel });
const pool = (rows: Identity[]) => rows.map(comparableModel).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
/** not_applicable: 그 실행에 관측 대상이 없다(replay의 사람 결정·발행). 통과 증거로 세지 않고, 0이 아닌 관측은 그대로 verified로 둔다. */
type SafetyEvidence = { status: "unverified" } | { status: "verified"; count: number } | { status: "not_applicable" };
const evidence = (value: number | "unverified"): SafetyEvidence => value === "unverified" ? { status: value } : { status: "verified", count: value };

/** 구간 안에서 후보별 첫 최종만 센다. 재시도·중복 표·여러 세대는 완료량을 늘리지 않는다. */
export function reportLiveCapacityWindow(value: unknown) {
  const artifact = parseLiveCapacityArtifact(value), { window, identity: fixed } = artifact;
  const duration = window.durationMs, inWindow = (ms: number | null) => ms !== null && ms > 0 && ms <= duration;
  const candidates = new Map(artifact.candidates.map(row => [row.id, row]));
  const votes = new Map<number, Vote[]>();
  for (const row of artifact.votes) votes.set(row.firstAttemptId, [...votes.get(row.firstAttemptId) ?? [], row]);
  const first = modelKey(fixed.models.first.provider, fixed.models.first.model);
  const exclusions = { rules: 0, reuse: 0, stale: 0, humanHandoff: 0, pendingAtEnd: 0, superseded: 0 };
  const ai1 = { calls: 0, failed: 0, cancelled: 0 };
  let clockAnomalies = 0, inputTokens: number | null = 0, outputTokens: number | null = 0;
  const finals: { candidateId: number; inputHash: string; decision: "approve" | "reject"; reReview: boolean;
    readyMs: number; startedMs: number; completedMs: number; gateMs: number | null; finalMs: number }[] = [];
  for (const row of [...artifact.attempts].sort((a, b) => a.id - b.id)) {
    if (row.readyMs > row.startedMs || row.completedMs !== null && row.completedMs < row.startedMs) { clockAnomalies++; continue; }
    const ended = inWindow(row.completedMs);
    if (row.provider === "rules") { exclusions.rules += Number(ended); continue; }
    if (row.reusedFromAttemptId !== null) { exclusions.reuse += Number(ended); continue; }
    if (row.state === "superseded") { exclusions.superseded += Number(ended); continue; }
    if (row.state === "running" || row.completedMs === null) continue;
    if (ended && row.failure === "cancelled") { ai1.cancelled++; continue; }
    if (ended) {
      ai1.calls++; ai1.failed += Number(row.state === "failed");
      inputTokens = inputTokens === null || row.inputTokens === null ? null : inputTokens + row.inputTokens;
      outputTokens = outputTokens === null || row.outputTokens === null ? null : outputTokens + row.outputTokens;
    }
    if (row.state !== "succeeded") continue;
    if (row.policyHash !== fixed.inputPolicyHash || row.promptVersion !== fixed.promptVersion
      || row.rulesVersion !== fixed.rulesVersion || modelKey(row.provider, row.model) !== first) { exclusions.stale += Number(ended); continue; }
    if (row.decision !== "approve" && row.decision !== "reject") { exclusions.humanHandoff += Number(ended); continue; }
    const owner = candidates.get(row.candidateId)!;
    const applied = owner.appliedAttemptId === row.id && owner.decidedBy === "auto";
    const gateMs = row.decision === "approve" && fixed.secondGateRequired
      ? gateTime(row, votes.get(row.id) ?? [], applied && owner.state === "published", fixed) : null;
    if (gateMs !== null && gateMs < row.completedMs) { clockAnomalies++; continue; }
    if (row.decision === "approve" && fixed.secondGateRequired && (gateMs === null || gateMs > duration)) {
      const handoff = gateMs === null && ((votes.get(row.id) ?? []).some(vote => vote.status === "needs_human")
        || applied && owner.state === "needs_review");
      if (ended) exclusions[handoff ? "humanHandoff" : "pendingAtEnd"]++;
      continue;
    }
    const finalMs = Math.max(row.completedMs, gateMs ?? row.completedMs);
    if (inWindow(finalMs)) finals.push({ candidateId: row.candidateId, inputHash: row.inputHash, decision: row.decision,
      reReview: row.reReview, readyMs: row.readyMs, startedMs: row.startedMs, completedMs: row.completedMs, gateMs, finalMs });
  }
  finals.sort((a, b) => a.finalMs - b.finalMs);
  const seen = new Set<number>(), uniqueFinals: typeof finals = [];
  for (const row of finals) if (!seen.has(row.candidateId)) { seen.add(row.candidateId); uniqueFinals.push(row); }
  const fresh = uniqueFinals.filter(row => !row.reReview);
  const decisions = new Map(uniqueFinals.map(row => [labelKey(row), row.decision]));
  let wrongApprovals = 0, wrongRejections = 0, evaluated = 0;
  for (const row of artifact.quality?.labels ?? []) {
    const actual = decisions.get(labelKey(row));
    if (!actual) continue;
    evaluated++; wrongApprovals += Number(actual === "approve" && row.expected === "reject");
    wrongRejections += Number(actual === "reject" && row.expected === "approve");
  }
  // 워커 가동 연속성: 모델을 부른 AI1 세대(규칙·재사용 제외)의 [시작, 끝]이 덮지 못한 가장 긴 구간 안 공백.
  let idle = 0, covered = 0;
  for (const [from, to] of artifact.attempts.filter(row => row.provider !== "rules" && row.reusedFromAttemptId === null
    && row.completedMs !== null && row.startedMs <= row.completedMs).map(row => [Math.max(0, row.startedMs), Math.min(duration, row.completedMs!)])
    .filter(([from, to]) => from <= to).sort((a, b) => a[0] - b[0])) {
    idle = Math.max(idle, from - covered); covered = Math.max(covered, to);
  }
  idle = Math.max(idle, duration - covered);
  const evidenceIssues: string[] = [];
  if (duration < LIVE_MIN_WINDOW_MS) evidenceIssues.push("window_under_30_minutes");
  if (fixed.reviewMode !== "enforce") evidenceIssues.push("review_mode_not_enforce");
  if (fixed.settingsUpdatedMs !== null && fixed.settingsUpdatedMs > 0) evidenceIssues.push("settings_changed_since_window_start");
  if (artifact.stageModes.some(row => row.changedSinceStart)) evidenceIssues.push("stage_mode_changed_since_window_start");
  if (artifact.modelCapacity?.changedSinceStart) evidenceIssues.push("model_capacity_changed_since_window_start");
  if (artifact.database.target === "replica" && !artifact.database.replicaCaughtUp) evidenceIssues.push("replica_not_caught_up");
  if (!artifact.readiness.witnesses) evidenceIssues.push("readiness_unproven");
  if (clockAnomalies) evidenceIssues.push("clock_anomaly");
  const ai2 = artifact.ai2Calls;
  return { runId: artifact.runId, scope: "live_window" as const, durationMs: duration, database: artifact.database, schema: artifact.schema,
    source: artifact.source ?? null, activity: { maxIdleMs: idle },
    identityKey: JSON.stringify({ promptVersion: fixed.promptVersion, rulesVersion: fixed.rulesVersion,
      inputPolicyHash: fixed.inputPolicyHash, comparisonPolicyHash: fixed.comparisonPolicyHash, reviewMode: fixed.reviewMode,
      secondGateRequired: fixed.secondGateRequired, models: { first: comparableModel(fixed.models.first),
        second: pool(fixed.models.second), fallbacks: pool(fixed.models.fallbacks) } }),
    concurrency: fixed.concurrency, stageModes: artifact.stageModes, modelCapacity: artifact.modelCapacity,
    readiness: { status: artifact.readiness.witnesses ? "covered" as const : "unproven" as const, witnesses: artifact.readiness.witnesses },
    finals: { newCandidates: fresh.length, reReviewCandidates: uniqueFinals.length - fresh.length,
      repeatGenerations: finals.length - uniqueFinals.length,
      approvals: fresh.filter(row => row.decision === "approve").length, rejections: fresh.filter(row => row.decision === "reject").length },
    finalPerHour: fresh.length / duration * 3_600_000, exclusions,
    latencyMs: { endToEnd: distribution(fresh.map(row => row.finalMs - row.readyMs)),
      ai1Queue: distribution(fresh.map(row => row.startedMs - row.readyMs)),
      ai1Model: distribution(fresh.map(row => row.completedMs - row.startedMs)),
      ai2Gate: distribution(fresh.flatMap(row => row.gateMs === null ? [] : [row.gateMs - row.completedMs])) },
    calls: { ai1, ai2, total: ai1.calls + ai2.calls, failed: ai1.failed + ai2.failed,
      technicalFailureRate: ai1.calls + ai2.calls ? (ai1.failed + ai2.failed) / (ai1.calls + ai2.calls) : null,
      ai1InputTokens: inputTokens, ai1OutputTokens: outputTokens },
    quality: { complete: Boolean(artifact.quality && evaluated === artifact.quality.labels.length), evaluated,
      expected: artifact.quality?.labels.length ?? 0, wrongApprovals, wrongRejections, datasetHash: artifact.quality?.datasetHash ?? null },
    safety: { duplicatePublications: { status: "verified", count: artifact.safety.duplicatePublications } as SafetyEvidence,
      humanDecisionOverrides: evidence(artifact.safety.humanDecisionOverrides), leaseViolations: evidence(artifact.safety.leaseViolations) },
    ledger: artifact.ledger ?? null,
    budgetEvidence: artifact.budget.status, budget: artifact.budget, clockAnomalies, evidenceIssues };
}
export type LiveCapacityReport = ReturnType<typeof reportLiveCapacityWindow>;
type Check = "passed" | "failed" | "incomplete";

/** 기준선 구간 건전성(F1). 표본 하한·워커 가동 연속성·절대 기술 실패율 상한 중 하나라도 못 미치면 그 기준선으로는 판정하지 않는다. */
function baselineHealthIssues(report: LiveCapacityReport): string[] {
  const issues: string[] = [];
  if (report.finals.newCandidates < LIVE_MIN_BASELINE_FINALS) issues.push("baseline_finals_below_minimum");
  if (report.activity.maxIdleMs > LIVE_MAX_BASELINE_IDLE_MS) issues.push("baseline_worker_idle");
  if (report.calls.total && 100 * report.calls.failed > LIVE_MAX_BASELINE_FAILURE_PERCENT * report.calls.total) issues.push("baseline_failure_rate_above_cap");
  return issues;
}
/**
 * 출처 검사(F1). 두 artifact 모두 출처가 있고 기대한 종류여야 한다. 운영 구간은 같은 DB(system_identifier·oid·이름)에서 수집했어야 한다
 * (물리 복제본은 primary와 같다).
 * replay는 실행마다 격리 DB가 다르므로 종류만 본다(격리는 실행 관문이 확인한다).
 */
export function artifactSourceIssues(baseline: LiveCapacitySource | null, candidate: LiveCapacitySource | null, kind: "live" | "replay"): string[] {
  if (!baseline || !candidate) return ["artifact_source_unrecorded"];
  if (baseline.kind !== kind || candidate.kind !== kind) return [`artifact_source_not_${kind}`];
  if (kind === "replay") return [];
  if (!baseline.database || !candidate.database) return ["live_database_identity_unknown"];
  const [a, b] = [baseline.database, candidate.database];
  return a.systemIdentifier === b.systemIdentifier && a.databaseOid === b.databaseOid && a.databaseName === b.databaseName ? [] : ["live_database_mismatch"];
}

/**
 * 모든 조건이 실제로 충족될 때만 passed. 비교 불가(구간·고갈·조건 불일치)는 수치와 무관하게 incomplete,
 * 품질 퇴행·안전 위반은 증거가 불완전해도 failed다. 경계는 정수 교차곱으로 정확히 비교한다.
 */
export function judgeLiveCapacity(baseline: LiveCapacityReport, candidate: LiveCapacityReport, qualityIssues: readonly string[] = []) {
  const reasons = new Set<string>([...baseline.evidenceIssues, ...candidate.evidenceIssues]);
  if (baseline.identityKey !== candidate.identityKey) reasons.add("conditions_mismatch");
  for (const issue of baselineHealthIssues(baseline)) reasons.add(issue);
  const comparable = reasons.size === 0;
  const before = baseline.finals.newCandidates, after = candidate.finals.newCandidates;
  const doubled = before ? after * baseline.durationMs >= 2 * before * candidate.durationMs : null;
  const p95Before = baseline.latencyMs.endToEnd.p95, p95After = candidate.latencyMs.endToEnd.p95;
  const latencyNotWorse = p95Before === null || p95After === null ? null : p95After <= p95Before;
  const { total: callsBefore, failed: failedBefore } = baseline.calls, { total: callsAfter, failed: failedAfter } = candidate.calls;
  const technicalFailureWithinOnePoint = !callsBefore || !callsAfter ? null
    : 100 * failedAfter * callsBefore <= 100 * failedBefore * callsAfter + callsBefore * callsAfter;
  if (doubled === null) reasons.add("baseline_without_finals");
  else if (!doubled) reasons.add("throughput_below_2x");
  if (latencyNotWorse === null) reasons.add("latency_samples_missing");
  else if (!latencyNotWorse) reasons.add("latency_p95_worse");
  if (technicalFailureWithinOnePoint === null) reasons.add("call_evidence_missing");
  else if (!technicalFailureWithinOnePoint) reasons.add("technical_failure_rate_exceeded");
  const numeric = [doubled, latencyNotWorse, technicalFailureWithinOnePoint];
  const performance: Check = !comparable || numeric.includes(null) ? "incomplete" : numeric.includes(false) ? "failed" : "passed";
  // 품질은 두 실행이 같은 라벨 표본(같은 dataset hash)일 때만 비교한다. 같은 표본의 퇴행은 표본이 작아도 failed,
  // 퇴행이 없으면 호출자가 준 표본 문제(replay labelTemplate 불일치)와 표본 하한을 모두 넘어야 passed다.
  let quality: Check = "incomplete";
  const a = baseline.quality, b = candidate.quality;
  if (!a.complete || !b.complete) reasons.add("quality_unverified");
  else if (a.datasetHash !== b.datasetHash) reasons.add("quality_label_set_mismatch");
  else if (!(b.wrongApprovals * a.evaluated <= a.wrongApprovals * b.evaluated && b.wrongRejections * a.evaluated <= a.wrongRejections * b.evaluated)) {
    quality = "failed"; reasons.add("wrong_decisions_increased");
  } else if (qualityIssues.length) for (const issue of qualityIssues) reasons.add(issue);
  else if (a.evaluated < LIVE_MIN_QUALITY_LABELS) reasons.add("quality_labels_below_minimum");
  else quality = "passed";
  // not_applicable은 그 실행에 관측 대상이 없다는 표시라 막지도 통과 증거로 세지도 않는다(replay 전용, reportFixedInputRun이 정한다).
  let safety: Check = "passed";
  for (const [name, evidence] of [["duplicate_publication", candidate.safety.duplicatePublications],
    ["human_decision_override", candidate.safety.humanDecisionOverrides], ["lease_violation", candidate.safety.leaseViolations]] as const) {
    if (evidence.status === "not_applicable") continue;
    if (evidence.status === "unverified") { reasons.add(`${name}_unverified`); if (safety === "passed") safety = "incomplete"; }
    else if (evidence.count) { reasons.add(`${name}_detected`); safety = "failed"; }
  }
  // 보고서의 두 칸이 모두 verified여야 한다. 고유 최종당 호출·과금 토큰과 선언 한도를 기준선과 비교한다(허용 오차 0).
  const verified = (report: LiveCapacityReport) => report.budgetEvidence === "verified" ? report.budget : { status: "unverified" as const };
  const budget = judgeBudget({ budget: verified(baseline), finals: before }, { budget: verified(candidate), finals: after }, comparable);
  for (const reason of budget.reasons) reasons.add(reason);
  const budgetVerified = budget.baseline !== null && budget.candidate !== null;
  const status: Check = quality === "failed" || safety === "failed" || performance === "failed" || budget.status === "failed" ? "failed"
    : performance === "passed" && quality === "passed" && safety === "passed" && budget.status === "passed" ? "passed" : "incomplete";
  return { status, reasons: [...reasons], ratio: before ? after * baseline.durationMs / (before * candidate.durationMs) : null,
    numericThresholds: { doubled, latencyNotWorse, technicalFailureWithinOnePoint }, performance, quality, safety,
    budgetEvidence: budgetVerified ? "verified" as const : "unverified" as const, budget,
    concurrency: { baseline: baseline.concurrency, candidate: candidate.concurrency } };
}

/** 운영 구간 비교. 두 artifact 모두 운영 수집기가 같은 DB에서 남긴 live 출처여야 한다(replay 결과의 live 부분을 넣으면 비교 불가). */
export function compareLiveCapacityRuns(baselineValue: unknown, candidateValue: unknown) {
  const baseline = reportLiveCapacityWindow(baselineValue), candidate = reportLiveCapacityWindow(candidateValue);
  const issues = artifactSourceIssues(baseline.source, candidate.source, "live");
  return { ...judgeLiveCapacity({ ...baseline, evidenceIssues: [...baseline.evidenceIssues, ...issues] }, candidate), baseline, candidate };
}
