import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z, ZodError } from "zod";
import { modelCapacityPolicySchema } from "@/lib/llm/capacity";
import { formatCapacityCliError } from "./pipeline-capacity-cli";
import { meterBudgetEvidence, replayLedgerBudget, type BudgetEvidence } from "./pipeline-capacity-budget";
import { artifactSourceIssues, attachLiveCapacityLabels, judgeLiveCapacity, liveCapacityArtifactSchema, liveCapacityLabelsSchema, LIVE_MIN_WINDOW_MS,
  reportLiveCapacityWindow, type LiveCapacityArtifact, type LiveCapacityReport } from "./pipeline-capacity-live";

/**
 * 고정 입력 replay(PR01b-7). 운영에서 실제로 심사된 후보 묶음을 읽기 전용으로 꺼내(artifact), 격리 DB에 같은 순서·같은
 * 근거 나이로 다시 세운 뒤 legacy 또는 item consumer 모드로 실모델 심사를 돌린다. 판정은 운영 구간과 같은
 * judgeLiveCapacity를 쓴다. 이 모듈은 순수 검증·보고만 한다(DB·네트워크 없음).
 */
export const FIXED_INPUT_MAX_INPUTS = 5_000;
export const FIXED_INPUT_FILE_LIMIT = 256 * 1024 * 1024;
/** 적재 기준 시각(anchor)에서 측정 구간 시작까지. 두 실행이 같은 값을 써야 구간 시작의 근거 나이가 같다. */
export const FIXED_INPUT_LEAD_MS = 300_000;
/** 구간 끝 신호 뒤 진행 중 호출이 끝나기를 기다리는 상한(legacy 틱 예산 110초 + 여유). */
export const FIXED_INPUT_DRAIN_MS = 180_000;
export const FIXED_INPUT_COLLECT_MS = 120_000;
/** export 자격: anchor 뒤로 원본·스캔이 이만큼 더 신선해야 적재·구간·수집 동안 24시간 기준을 넘지 않는다. */
export const FIXED_INPUT_MIN_HEADROOM_MS = 3 * 3_600_000;
export const FIXED_INPUT_UPSTREAM_PATH = "/v1/chat/completions";

const text = z.string().min(1).max(160).refine(value => value === value.trim(), "trimmed_text_required");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime().refine(value => new Date(value).toISOString() === value, "canonical_utc_required");
const integer = z.number().int().nonnegative().safe();
const positive = integer.positive();
const json = z.record(z.string(), z.unknown());
const repo = z.string().min(3).max(200).regex(/^[^\s/]+\/[^\s/]+$/);
const reviewer = z.object({ provider: z.enum(["abcllm", "claude-cli", "grok-cli"]), model: text }).strict();

/** 근거 시각은 절대값이 아니라 원래 심사 시작(anchor) 기준 나이(µs)로 둔다. 적재가 같은 나이로 다시 세운다. */
const fixedInputSchema = z.object({
  ordinal: positive, repo,
  production: z.object({ candidateId: positive, attemptId: positive, inputHash: hash,
    decision: z.enum(["approve", "reject", "needs_review"]), provider: text, model: text }).strict(),
  anchorAt: date, inputHash: hash,
  document: z.object({ repoMeta: json, productUrl: z.string().min(1).max(2_000).nullable(), pageStatus: z.number().int().safe().nullable(),
    pageMeta: json.nullable(), fetchedAgeUs: integer }).strict(),
  scan: z.object({ githubRepositoryId: z.string().regex(/^[1-9]\d{0,18}$/), commitSha: z.string().min(1).max(64),
    detectorVersion: z.string().min(1).max(40), scope: z.literal(""), scopeHash: z.string().min(1).max(64),
    state: z.enum(["pending", "complete", "partial", "failed"]), cursor: z.unknown().nullable(), requestCount: integer, fileCount: integer,
    coverage: json, startedAgeUs: integer, completedAgeUs: integer.nullable(), lastErrorCode: z.string().min(1).max(60).nullable() }).strict().nullable(),
  observations: z.array(z.object({ observationKey: z.string().min(1).max(64), facts: json, observedAgeUs: integer }).strict()).max(10_000),
}).strict();
export const fixedInputArtifactSchema = z.object({
  version: z.literal(1), scope: z.literal("fixed_input_replay"),
  export: z.object({ revision: z.string().regex(/^[a-f0-9]{7,40}$/), exportedAt: date, from: date, to: date, seed: text,
    requested: positive.max(FIXED_INPUT_MAX_INPUTS), population: integer, examined: integer, selected: integer,
    exclusions: z.object({ modelChanged: integer, documentChanged: integer, scanChanged: integer, readmeMissing: integer,
      headroom: integer, inputDrift: integer, oversize: integer }).strict(),
    firstReviewer: reviewer, inputPolicyHash: hash }).strict(),
  settings: json,
  inputs: z.array(fixedInputSchema).min(1).max(FIXED_INPUT_MAX_INPUTS),
}).strict();
export type FixedInputArtifact = z.infer<typeof fixedInputArtifactSchema>;
export type FixedInput = FixedInputArtifact["inputs"][number];

function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
export const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
/** 같은 seed와 후보 번호면 언제 뽑아도 같은 순서다. */
export const fixedInputSampleKey = (seed: string, candidateId: number) => sha256(`${seed}:${candidateId}`);

/** JSON 출처의 진위는 증명하지 않는다. 일관성(순번·저장소 유일·anchor 범위)만 본다. */
export function parseFixedInputArtifact(value: unknown): FixedInputArtifact {
  const artifact = fixedInputArtifactSchema.parse(value), { from, to, selected } = artifact.export;
  ensure(Date.parse(from) < Date.parse(to) && selected === artifact.inputs.length
    && artifact.inputs.length <= artifact.export.requested, "fixed_input_artifact_mismatch");
  const repos = new Set<string>(), production = new Set<number>();
  for (const [index, input] of artifact.inputs.entries()) {
    const at = Date.parse(input.anchorAt);
    ensure(input.ordinal === index + 1 && !repos.has(input.repo.toLowerCase()) && !production.has(input.production.candidateId)
      && at >= Date.parse(from) && at < Date.parse(to) && input.production.inputHash === input.inputHash
      && (!input.scan || input.scan.completedAgeUs === null || input.scan.completedAgeUs <= input.scan.startedAgeUs),
    "fixed_input_artifact_mismatch");
    repos.add(input.repo.toLowerCase()); production.add(input.production.candidateId);
  }
  return artifact;
}

/** 실행에 포함한 입력 집합. 두 실행의 이 값이 다르면 같은 입력 비교가 아니다. */
export function fixedInputSetHash(items: readonly { ordinal: number; inputHash: string }[]): string {
  return sha256(JSON.stringify([...items].sort((a, b) => a.ordinal - b.ordinal).map(item => [item.ordinal, item.inputHash])));
}

const OVERRIDES = ["PGHOST", "PGHOSTADDR", "PGPORT", "PGSERVICE", "PGSERVICEFILE", "PGOPTIONS"] as const;
/**
 * 격리 replay DB 관문. postgres.js의 첫 @ 분리까지 맞춘 loopback·nomorevibe_test 하나만 받는다. 운영 URL·복제본·
 * 마이그레이션 URL·공유 캐시·libpq 우회가 하나라도 있으면 드라이버를 열기 전에 거부한다.
 */
export function assertIsolatedReplayDatabase(databaseUrl: string | undefined, env: Readonly<Record<string, string | undefined>>): string {
  ensure(databaseUrl, "explicit_TEST_DATABASE_URL_required");
  let local = false;
  try {
    const url = new URL(databaseUrl);
    const authority = databaseUrl.slice(databaseUrl.indexOf("://") + 3).split(/[?/]/)[0];
    local = authority.slice(authority.indexOf("@") + 1) === url.host && ["postgres:", "postgresql:"].includes(url.protocol)
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && url.pathname === "/nomorevibe_test" && !url.search && !url.hash;
  } catch { /* 고정 오류만 낸다 — 자격 증명을 출력하지 않는다. */ }
  ensure(local, "local_test_database_required");
  ensure(!OVERRIDES.some(key => Boolean(env[key])), "database_override_rejected");
  // DATABASE_FALLBACK_HOST 는 lib/db 의 새 연결을 다른 주소로 보낼 수 있다(lib/db/network-route.ts)
  ensure(!env.DATABASE_FALLBACK_HOST && !env.READ_DATABASE_FALLBACK_HOST, "database_override_rejected");
  ensure(!env.DATABASE_URL || env.DATABASE_URL === databaseUrl, "database_url_mismatch");
  ensure(!env.READ_DATABASE_URL, "replica_database_rejected");
  ensure(!env.MIGRATION_DATABASE_URL && !env.VALKEY_URL, "external_service_url_rejected");
  return databaseUrl;
}
/** export는 명시한 원본 URL 하나만 읽기 전용으로 연다. libpq 우회는 거부한다. */
export function assertExportSourceEnv(env: Readonly<Record<string, string | undefined>>): string {
  const url = env.FIXED_INPUT_SOURCE_DATABASE_URL;
  ensure(url, "explicit_FIXED_INPUT_SOURCE_DATABASE_URL_required");
  ensure(!OVERRIDES.some(key => Boolean(env[key])), "database_override_rejected");
  return url;
}

function upstreamOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("invalid_replay_upstream"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  ensure((url.protocol === "https:" || url.protocol === "http:" && loopback) && !url.username && !url.password
    && url.pathname === "/" && !url.search && !url.hash && `${url.origin}` === value.replace(/\/$/, ""), "invalid_replay_upstream");
  return url.origin;
}
export const fixedInputRunManifestSchema = z.object({
  version: z.literal(1), runId: text, mode: z.enum(["legacy", "items"]), artifactSha256: hash, upstream: z.string().min(1).max(200),
  durationMs: positive.max(3 * 3_600_000),
  limits: z.object({ maxCalls: positive.max(100_000), maxTokens: positive, perCallTokenUpperBound: positive.max(1_000_000),
    maxWallMs: positive.max(6 * 3_600_000) }).strict(),
  /** 두 실행에 똑같이 적용하는 2차 대체 모델 고정. 없으면 artifact 설정 그대로다. */
  secondReviewFallbacks: z.array(reviewer).max(2).optional(),
  items: z.object({ ai1Consumers: positive.max(16), ai2Consumers: positive.max(16), capacityPolicy: modelCapacityPolicySchema }).strict().optional(),
  /**
   * PR01b-9: 두 실행에 같은 값으로 선언하는 공통 동시 호출 예산. 계량기 최대 동시 호출이 이 값을 넘으면 budget 미검증이다(강제하지 않는다).
   * items 실행은 이 값이 모델 슬롯 정책의 심사 한도 min(전체, reviewer)와 같아야 budget이 검증된다(F1).
   */
  budget: z.object({ maxConcurrentCalls: positive.max(256) }).strict().optional(),
}).strict();
/** F1: 결과에 남기는 manifest의 비교 대상. 두 실행이 같아야 비교한다(runId·mode·items·budget은 실험 변수거나 budget 판정이 따로 본다). */
const runConditionsSchema = z.object({ upstream: z.string().min(1).max(200), durationMs: positive.max(3 * 3_600_000),
  limits: z.object({ maxCalls: positive.max(100_000), maxTokens: positive, perCallTokenUpperBound: positive.max(1_000_000),
    maxWallMs: positive.max(6 * 3_600_000) }).strict(),
  secondReviewFallbacks: z.array(reviewer).max(2).nullable() }).strict();
export type FixedInputRunConditions = z.infer<typeof runConditionsSchema>;
/** 정규화된 manifest(upstream은 이미 자격 증명·경로 없는 origin)에서 비교 대상만 뽑는다. */
export function fixedInputRunConditions(manifest: FixedInputRunManifest): FixedInputRunConditions {
  return { upstream: manifest.upstream, durationMs: manifest.durationMs, limits: manifest.limits,
    secondReviewFallbacks: manifest.secondReviewFallbacks ?? null };
}
export type FixedInputRunManifest = z.infer<typeof fixedInputRunManifestSchema>;
export type FixedInputTiming = { minimumWindowMs: number; leadMs: number; drainMs: number; collectMs: number };
export const FIXED_INPUT_TIMING: FixedInputTiming = Object.freeze({ minimumWindowMs: LIVE_MIN_WINDOW_MS, leadMs: FIXED_INPUT_LEAD_MS,
  drainMs: FIXED_INPUT_DRAIN_MS, collectMs: FIXED_INPUT_COLLECT_MS });

/** 사전 상한 산술만 본다. 호출 수 × 호출당 상한이 토큰 상한 안이어야 하고, 벽시간이 적재·구간·배수·수집을 덮어야 한다. */
export function parseFixedInputRunManifest(value: unknown, timing: FixedInputTiming = FIXED_INPUT_TIMING): FixedInputRunManifest {
  const manifest = fixedInputRunManifestSchema.parse(value), { limits } = manifest;
  ensure((manifest.mode === "items") === Boolean(manifest.items), "invalid_replay_mode");
  ensure(manifest.durationMs >= timing.minimumWindowMs, "replay_window_under_30_minutes");
  const planned = limits.maxCalls * limits.perCallTokenUpperBound;
  ensure(Number.isSafeInteger(planned) && planned <= limits.maxTokens, "planned_token_budget_exceeded");
  ensure(limits.maxWallMs >= manifest.durationMs + timing.leadMs + timing.drainMs + timing.collectMs, "wall_limit_below_window");
  return { ...manifest, upstream: upstreamOrigin(manifest.upstream) };
}

const offset = z.number().int().safe();
export const fixedInputRunResultSchema = z.object({
  version: z.literal(1), scope: z.literal("fixed_input_replay_run"), runId: text, mode: z.enum(["legacy", "items"]),
  revision: z.string().regex(/^[a-f0-9]{7,40}$/), artifactSha256: hash, manifestSha256: hash, inputSetHash: hash,
  inputs: z.object({ loaded: integer, items: z.array(z.object({ ordinal: positive, inputHash: hash }).strict()).max(FIXED_INPUT_MAX_INPUTS),
    excluded: z.object({ notReviewable: integer, inputDrift: integer }).strict() }).strict(),
  window: z.object({ anchorAt: date, startedAt: date, endedAt: date, durationMs: positive, collectionStartedAt: date }).strict(),
  stop: z.object({ reason: z.enum(["window_end", "call_cap", "token_cap", "per_call_bound_exceeded", "wall_cap", "egress_rejected", "worker_failed"]),
    atOffsetMs: offset, drainMs: integer, drainExceeded: z.boolean() }).strict(),
  meter: z.object({ calls: integer, refused: integer, upstreamFailed: integer, indeterminate: integer, maxInFlight: integer,
    usageKnownCalls: integer, reportedInputTokens: integer, reportedOutputTokens: integer, chargedTokens: integer, egressRejected: integer,
    // PR01b-9 이전 결과에는 없다(그 결과의 budget은 미검증으로 남는다).
    upstreamReportedCalls: integer.optional(), upstreamReportedTokens: integer.optional(),
    models: z.array(z.object({ model: text, calls: integer }).strict()).max(32), usageProvenance: z.literal("reported_unverified") }).strict(),
  /** PR01b-9: manifest가 선언한 공통 동시 예산과, 구간 정지 순간까지 계량기가 보낸 호출 수. */
  budget: z.object({ declaredConcurrentCalls: positive.max(256).nullable(), callsAtStop: integer }).strict().optional(),
  /**
   * 구간 끝 drain(정상 종료만). 정지 순간 계량기에 진행 중이던 호출은 drain 상한까지 upstream이 끝나 budget(호출·토큰)에 들어가지만
   * 최종·처리량·p95는 구간 안 결과만 센다 — 최종당 호출·토큰이 그 실행에 불리하게(크게) 잡힌다(accounting). 상한에서 끊은 호출이 있으면
   * budget은 두 모드 모두 미검증, drain 중 계량기 상한에 닿았으면(meterStop) 비교 불가다. 이전 결과에는 없다.
   */
  windowEndDrain: z.object({ limitMs: integer, inFlightAtStop: integer, cutAtLimit: integer, waitedMs: integer,
    meterStop: z.enum(["call_cap", "token_cap", "per_call_bound_exceeded"]).nullable(),
    accounting: z.literal("drain_calls_in_budget_not_in_finals") }).strict().optional(),
  writes: z.object({ products: integer, publishRuns: integer }).strict(),
  failures: z.array(z.string().min(1).max(120)).max(32),
  /** F1: 이전 결과에는 없다(그 결과끼리는 비교 불가로 남는다). */
  conditions: runConditionsSchema.optional(),
  live: liveCapacityArtifactSchema,
}).strict();
export type FixedInputRunResult = z.infer<typeof fixedInputRunResultSchema>;

export function parseFixedInputRunResult(value: unknown): FixedInputRunResult {
  const result = fixedInputRunResultSchema.parse(value), { live } = result;
  const ordinals = new Set(result.inputs.items.map(item => item.ordinal));
  ensure(ordinals.size === result.inputs.items.length && result.inputSetHash === fixedInputSetHash(result.inputs.items)
    && live.runId === result.runId && live.window.endedAt === result.window.endedAt
    && live.window.startedAt === result.window.collectionStartedAt
    && live.candidates.every(row => ordinals.has(row.id)), "fixed_input_result_mismatch");
  const { meter, budget, windowEndDrain: drain } = result;
  ensure((meter.upstreamReportedCalls === undefined) === (meter.upstreamReportedTokens === undefined)
    && (meter.upstreamReportedCalls ?? 0) <= meter.calls && (!budget || budget.callsAtStop <= meter.calls), "fixed_input_result_mismatch");
  ensure(!drain || result.stop.reason === "window_end" && drain.cutAtLimit <= drain.inFlightAtStop && drain.cutAtLimit <= meter.indeterminate
    && drain.inFlightAtStop <= (budget?.callsAtStop ?? meter.calls), "fixed_input_result_mismatch");
  // upstream은 manifest 관문과 같은 정규화 origin이어야 한다(자격 증명·경로·질의가 섞인 값은 위조로 본다).
  let upstream: string | null = null;
  try { upstream = result.conditions ? upstreamOrigin(result.conditions.upstream) : null; } catch { /* 아래에서 거부한다. */ }
  ensure(!result.conditions || upstream === result.conditions.upstream, "fixed_input_result_mismatch");
  return result;
}

/**
 * 같은 판정 규칙에 대한 명시적 대응. 고정 입력은 모두 구간 시작 전에 적재돼 준비 대기가 묶음 크기의 산물이므로
 * replay의 종단 지연은 AI1 시작→최종(서비스 지연)으로 잰다(readyMs := startedMs). 나머지 규칙은 운영 구간과 같다.
 */
export function reportFixedInputRun(value: unknown): LiveCapacityReport & { replay: ReturnType<typeof replaySummary> } {
  const result = parseFixedInputRunResult(value);
  const live: LiveCapacityArtifact = { ...result.live, attempts: result.live.attempts.map(row => ({ ...row, readyMs: row.startedMs })) };
  const report = reportLiveCapacityWindow(live), issues = [...report.evidenceIssues];
  if (result.window.durationMs < LIVE_MIN_WINDOW_MS) issues.push("replay_window_under_30_minutes");
  if (result.stop.reason !== "window_end") issues.push("replay_stopped_early");
  if (result.stop.drainExceeded) issues.push("replay_drain_exceeded");
  if (result.windowEndDrain?.meterStop) issues.push("replay_drain_meter_stop");
  if (result.meter.refused) issues.push("replay_calls_refused");
  if (result.meter.egressRejected) issues.push("replay_egress_rejected");
  if (result.writes.products || result.writes.publishRuns) issues.push("replay_public_write_detected");
  if (result.failures.length) issues.push("replay_worker_failed");
  if (!result.inputs.items.length) issues.push("replay_inputs_empty");
  const budget = replayBudget(result, report);
  return { ...report, budgetEvidence: budget.status, budget, safety: replaySafety(report.safety), evidenceIssues: [...new Set(issues)],
    replay: replaySummary(result) };
}
/**
 * F1: 격리 replay에는 사람 결정도 발행도 없다(공개 쓰기는 replay_public_write_detected가 따로 막는다). 관측 대상이 없는 두 칸의 0·미검증은
 * 'verified 0'이 아니라 not_applicable이다 — 통과 증거로 세지 않는다. 0이 아닌 수가 관측되면 그대로 verified(→ failed)로 둔다.
 * lease 위반은 replay 워커에도 관측 대상이라 0097 장부가 구간을 덮을 때만 verified다(그대로 둔다).
 */
function replaySafety(safety: LiveCapacityReport["safety"]): LiveCapacityReport["safety"] {
  const absent = (evidence: LiveCapacityReport["safety"]["duplicatePublications"]) =>
    evidence.status === "verified" && evidence.count > 0 ? evidence : { status: "not_applicable" as const };
  return { duplicatePublications: absent(safety.duplicatePublications), humanDecisionOverrides: absent(safety.humanDecisionOverrides),
    leaseViolations: safety.leaseViolations };
}
/**
 * PR01b-9 budget. legacy 격리 DB에는 모델 슬롯 장부가 없으므로 계량기를 호출 장부로 쓰고(모든 호출 upstream usage·선언 한도 필요),
 * DB 기록이 센 구간 호출이 계량기 호출보다 많으면 계량기 밖 호출로 본다. items는 수집기가 낸 장부 증거에 계량기를 맞춘다.
 * 구간 끝 drain 상한에서 끊은 호출이 있으면 두 모드 모두 미검증이다.
 */
function replayBudget(result: FixedInputRunResult, report: LiveCapacityReport): BudgetEvidence {
  const { meter } = result, callsAtStop = result.budget?.callsAtStop ?? null, drainCut = result.windowEndDrain?.cutAtLimit ?? 0;
  const declared = result.budget?.declaredConcurrentCalls ?? null;
  if (result.mode === "items") return replayLedgerBudget(result.live.budget, meter, callsAtStop, drainCut, declared);
  return meterBudgetEvidence({ calls: meter.calls, maxInFlight: meter.maxInFlight, reportedCalls: meter.upstreamReportedCalls,
    reportedTokens: meter.upstreamReportedTokens, declared, callsAtStop, recordedCalls: report.calls.total, drainCut });
}
function replaySummary(result: FixedInputRunResult) {
  return { mode: result.mode, artifactSha256: result.artifactSha256, inputSetHash: result.inputSetHash, included: result.inputs.items.length,
    excluded: result.inputs.excluded, window: result.window, stop: result.stop, meter: result.meter, budget: result.budget ?? null,
    windowEndDrain: result.windowEndDrain ?? null, writes: result.writes, failures: result.failures, conditions: result.conditions ?? null };
}
/** F1: 두 실행의 manifest 비교 대상(upstream·구간·상한·대체 모델)이 같아야 한다. 기록이 없으면(이전 결과) 비교하지 않는다. */
function conditionIssues(baseline: FixedInputRunResult, candidate: FixedInputRunResult): string[] {
  const a = baseline.conditions, b = candidate.conditions;
  if (!a || !b) return ["replay_conditions_unrecorded"];
  const { upstream: left, ...restA } = a, { upstream: right, ...restB } = b, issues: string[] = [];
  if (left !== right) issues.push("replay_upstream_mismatch");
  if (!isDeepStrictEqual(restA, restB)) issues.push("replay_conditions_mismatch");
  return issues;
}

/** 후보 하나만 남긴 부분 artifact로 같은 최종 규칙을 다시 적용해 최종 후보 목록을 얻는다(표본 라벨 대상). */
export function fixedInputFinals(value: unknown): { candidateId: number; inputHash: string; decision: "approve" | "reject" }[] {
  const result = parseFixedInputRunResult(value), live = result.live;
  const finals: { candidateId: number; inputHash: string; decision: "approve" | "reject" }[] = [];
  for (const candidate of live.candidates) {
    const attempts = live.attempts.filter(row => row.candidateId === candidate.id).map(row => ({ ...row, readyMs: row.startedMs }));
    const ids = new Set(attempts.map(row => row.id));
    const report = reportLiveCapacityWindow({ ...live, attempts, votes: live.votes.filter(row => ids.has(row.firstAttemptId)),
      candidates: [candidate], readiness: { witnesses: live.readiness.witnesses, sampleCandidateIds: [] }, quality: null });
    if (!report.finals.newCandidates) continue;
    // 판정은 attempt의 입력 해시로 라벨을 맞춘다. 실행 중 입력이 바뀐 후보는 고정 입력이 아니므로 표본에서 뺀다.
    const input = result.inputs.items.find(item => item.ordinal === candidate.id);
    if (input && attempts.every(row => row.inputHash === input.inputHash)) finals.push({ candidateId: candidate.id, inputHash: input.inputHash, decision: report.finals.approvals ? "approve" : "reject" });
  }
  return finals;
}

/** 사람 라벨을 실행 결과의 live artifact에 붙인다. 포함 입력(순번·입력 해시)에 없는 라벨은 거부한다. */
export function attachFixedInputLabels(resultValue: unknown, labelsValue: unknown): FixedInputRunResult {
  const result = parseFixedInputRunResult(resultValue), labels = liveCapacityLabelsSchema.parse(labelsValue);
  const included = new Set(result.inputs.items.map(item => `${item.ordinal}:${item.inputHash}`));
  ensure(labels.every(label => included.has(`${label.candidateId}:${label.inputHash}`)), "replay_label_unknown_input");
  return parseFixedInputRunResult({ ...result, live: attachLiveCapacityLabels(result.live, labels) });
}

/**
 * PR17 기준을 그대로 적용한다. 같은 artifact·같은 포함 입력 집합·같은 manifest 비교 대상(upstream 포함)·replay 출처가 아니면
 * 수치와 무관하게 비교 불가다. 품질은 두 실행의 라벨이 모두 labelTemplate(두 실행 공통 최종) 그대로일 때만 판정한다.
 */
export function compareFixedInputRuns(baselineValue: unknown, candidateValue: unknown) {
  const baselineResult = parseFixedInputRunResult(baselineValue), candidateResult = parseFixedInputRunResult(candidateValue);
  const baseline = reportFixedInputRun(baselineResult), candidate = reportFixedInputRun(candidateResult);
  const shared: string[] = [];
  if (baselineResult.artifactSha256 !== candidateResult.artifactSha256) shared.push("replay_artifact_mismatch");
  if (baselineResult.inputSetHash !== candidateResult.inputSetHash) shared.push("replay_input_set_mismatch");
  if (baselineResult.mode !== "legacy") shared.push("replay_baseline_not_legacy");
  shared.push(...conditionIssues(baselineResult, candidateResult), ...artifactSourceIssues(baseline.source, candidate.source, "replay"));
  const key = (row: { candidateId: number; inputHash: string }) => `${row.candidateId}:${row.inputHash}`;
  const after = new Map(fixedInputFinals(candidateResult).map(row => [key(row), row]));
  const labelTemplate = fixedInputFinals(baselineResult).filter(row => after.has(key(row)))
    .map(row => ({ candidateId: row.candidateId, inputHash: row.inputHash }));
  const template = new Set(labelTemplate.map(key));
  const sampled = (result: FixedInputRunResult) => !result.live.quality
    || result.live.quality.labels.length === template.size && result.live.quality.labels.every(row => template.has(key(row)));
  const judged = judgeLiveCapacity({ ...baseline, evidenceIssues: [...baseline.evidenceIssues, ...shared] }, candidate,
    sampled(baselineResult) && sampled(candidateResult) ? [] : ["quality_label_template_mismatch"]);
  return { ...judged, modes: { baseline: baselineResult.mode, candidate: candidateResult.mode }, baseline, candidate, labelTemplate };
}

const fixedErrors = new Set([
  "invalid_fixed_input_command", "fixed_input_artifact_mismatch", "fixed_input_result_mismatch", "explicit_FIXED_INPUT_SOURCE_DATABASE_URL_required",
  "external_service_url_rejected", "invalid_replay_upstream", "invalid_replay_mode", "replay_window_under_30_minutes", "wall_limit_below_window",
  "replay_artifact_sha_mismatch", "replay_database_not_empty", "replay_settings_invalid", "replay_settings_not_enforced",
  "replay_cli_provider_unsupported", "replay_upstream_mismatch", "replay_api_key_missing", "consumer_mode_blocked", "replay_load_exceeded_lead",
  "replay_inputs_empty", "replay_candidate_unmapped", "replay_label_unknown_input", "replay_runner_scope_conflict",
  "fixed_input_export_window_invalid", "fixed_input_first_reviewer_unpinned", "fixed_input_population_limit", "fixed_input_export_write_detected",
  "replay_live_collection_failed", "replay_readme_sample_version_mismatch",
]);
/** 값·경로·DB 메시지·원인을 내보내지 않는다. 공용 capacity 오류 코드는 그 형식기로 넘긴다. */
export function formatFixedInputCliError(error: unknown): string {
  if (error instanceof ZodError) return "invalid_fixed_input_artifact";
  if (error instanceof Error && fixedErrors.has(error.message)) return error.message;
  return formatCapacityCliError(error);
}
