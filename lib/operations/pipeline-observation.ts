import { z } from "zod";
import { modelCapacityPolicyHash, parseModelCapacityPolicy, type ModelCapacityPolicy, type ModelCapacityState } from "@/lib/llm/capacity";

/**
 * PR17a 운영 관측(설계 §7.5: 30분 canary 뒤 24시간). 수집은 읽기 전용이고 이 모듈은 수집물의 일관성 검사·요약만 한다.
 * 합격 판정은 하지 않는다 — 안전 위반 수와 증명하지 못한 칸(unverified)만 드러낸다. 합격 수치는 운영자가 정한다.
 * 모든 시각은 구간 시작 기준 ms다. 수집기가 DB에서 직접 잰 값이다(시간대 없는 UTC 벽시계를 JS Date로 해석하지 않는다).
 */
export const OBSERVATION_DEFAULT_HOURS = 24;
export const OBSERVATION_MIN_WINDOW_MS = 60_000;
export const OBSERVATION_MAX_WINDOW_MS = 48 * 3_600_000;
export const OBSERVATION_ROW_LIMIT = 200_000;
/** 0076 운영 스키마 뒤에 생긴 표. 없거나 읽을 권한이 없으면 그 칸은 미상이다(배포 전). */
export const OBSERVATION_OPTIONAL_TABLES = ["pipeline_stage_modes", "model_capacity_control", "model_capacity_requests", "model_capacity_events",
  "uptime_observations", "evidence_source_claims", "job_batch_control", "dr_writer_fence", "dr_fence_events", "pipeline_evidence_events"] as const;

const text = z.string().min(1).max(200).refine(value => value === value.trim(), "trimmed_text_required");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().datetime().refine(value => new Date(value).toISOString() === value, "canonical_utc_required");
const integer = z.number().int().nonnegative().safe();
const offset = z.number().int().safe();
const capacityClass = z.enum(["first", "second", "background"]);

const roleState = z.object({ role: text, epoch: integer, ownerInstanceId: text.nullable(), ownerBootId: text.nullable() }).strict();
const jobCounter = z.object({ name: text, runs: integer, processedVersion: integer }).strict();
const controls = z.object({
  stageModes: z.array(z.object({ stage: text, mode: text, epoch: integer }).strict()).max(3).nullable(),
  modelCapacity: z.object({ mode: text, epoch: integer, revision: integer }).strict().nullable(),
  jobBatch: z.object({ mode: text, epoch: integer }).strict().nullable(),
  writerFence: z.object({ state: text, writerEpoch: integer }).strict().nullable(),
}).strict();
const state = z.object({ roles: z.array(roleState).max(64), jobs: z.array(jobCounter).max(256), controls }).strict();
const database = z.object({ name: text, oid: z.string().regex(/^[1-9][0-9]{0,9}$/), target: z.enum(["primary", "replica"]),
  inRecovery: z.boolean(), readOnly: z.literal(true), isolation: z.literal("repeatable read"), writeXidAssigned: z.literal(false) }).strict();

/** 인계·epoch는 이력 표가 없어 두 시점의 카운터 차이로만 증명한다. 구간 시작 전에 이 스냅숏을 남겨야 한다. */
export const pipelineSnapshotSchema = z.object({ version: z.literal(1), scope: z.literal("pipeline_snapshot"), capturedAt: date, database })
  .extend(state.shape).strict();
export type PipelineSnapshot = z.infer<typeof pipelineSnapshotSchema>;

/** 장부 요청 하나의 대기·점유 구간. from이 null이면 그 상태가 없었고, to가 null이면 구간 끝까지 그 상태였다. */
export const slotRequestSchema = z.object({ routeId: text, class: capacityClass, pool: z.enum(["reviewer", "text"]), providerBudgetId: text,
  groupId: text, policyHash: hash, waitFromMs: offset.nullable(), waitToMs: offset.nullable(),
  activeFromMs: offset.nullable(), activeToMs: offset.nullable() }).strict();
export type SlotRequest = z.infer<typeof slotRequestSchema>;
const ledgerCounts = z.object({ humanDecisionOverrides: integer, leaseViolations: integer, humanDecisionRefusals: integer,
  lateWritesRefused: integer, ai2Calls: integer, ai2Failed: integer, ai2Chains: integer }).strict();

export const pipelineObservationSchema = z.object({
  version: z.literal(1), scope: z.literal("pipeline_observation"), runId: text, revision: z.string().regex(/^[a-f0-9]{7,40}$/),
  window: z.object({ startedAt: date, endedAt: date, durationMs: integer.min(OBSERVATION_MIN_WINDOW_MS).max(OBSERVATION_MAX_WINDOW_MS),
    collectedAt: date, collectedAfterEndMs: integer }).strict(),
  database: database.extend({ replicaCaughtUp: z.boolean().nullable() }).strict(),
  schema: z.object({ appliedMigrations: integer.nullable(), absentTables: z.array(z.enum(OBSERVATION_OPTIONAL_TABLES)).max(OBSERVATION_OPTIONAL_TABLES.length) }).strict(),
  baseline: pipelineSnapshotSchema.nullable(),
  /** 수집 시각(collectedAt)의 카운터. 구간 끝 시각이 아니다. */
  current: state,
  jobs: z.array(z.object({ name: text, role: text, lastRunMs: offset.nullable(), lastSuccessMs: offset.nullable(),
    failingAtCollection: z.boolean() }).strict()).max(256),
  /** batch-result ACK는 instance·job마다 마지막 하나만 남는다(덮어쓰기). 개수가 아니라 마지막 ACK 시각이다. */
  acks: z.object({ rows: z.array(z.object({ role: text, job: text, instanceId: text, host: text, recordedMs: offset }).strict()).max(4096),
    invalid: integer }).strict(),
  /** 구간 안에 마지막 쓰기가 있는 도메인 행 수(하한). 표가 없으면 null. */
  readback: z.array(z.object({ role: text, stage: text, rows: integer.nullable() }).strict()).max(32),
  ai1: z.object({ calls: integer, technicalFailures: integer, cancelled: integer }).strict(),
  ledger: z.object({ status: z.enum(["absent", "unreadable", "marker_missing", "marker_after_start", "covered"]),
    startedAt: date.nullable(), counts: ledgerCounts.nullable() }).strict(),
  duplicatePublications: integer,
  fenceEvents: z.array(z.object({ reason: text, fromEpoch: integer, toEpoch: integer, atMs: offset }).strict()).max(1000).nullable(),
  modelLedger: z.object({
    control: z.object({ mode: z.enum(["disabled", "open", "draining"]), changedSinceStart: z.boolean(), policyHash: hash.nullable(),
      policy: z.unknown() }).strict().nullable(),
    events: z.array(z.object({ routeId: text, class: capacityClass, kind: text, count: integer.positive() }).strict()).max(4096),
    openAtCollection: z.array(z.object({ routeId: text, class: capacityClass, state: z.enum(["dispatched", "indeterminate"]),
      count: integer.positive() }).strict()).max(4096),
    requests: z.array(slotRequestSchema).max(OBSERVATION_ROW_LIMIT),
  }).strict().nullable(),
}).strict();
export type PipelineObservation = z.infer<typeof pipelineObservationSchema>;

function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }

/** Strict 일관성 검사다. JSON 출처의 진위는 증명하지 않는다. */
export function parsePipelineObservation(value: unknown): PipelineObservation {
  const artifact = pipelineObservationSchema.parse(value), { window, database: db } = artifact;
  ensure(Date.parse(window.endedAt) - Date.parse(window.startedAt) === window.durationMs
    && Date.parse(window.collectedAt) - Date.parse(window.endedAt) === window.collectedAfterEndMs, "observation_artifact_mismatch");
  ensure(db.target === "primary" ? !db.inRecovery && db.replicaCaughtUp === null : db.inRecovery && db.replicaCaughtUp !== null,
    "observation_artifact_mismatch");
  const absent = new Set(artifact.schema.absentTables);
  ensure(absent.size === artifact.schema.absentTables.length
    && absent.has("pipeline_evidence_events") === ["absent", "unreadable"].includes(artifact.ledger.status)
    && (artifact.ledger.status === "covered") === (artifact.ledger.counts !== null)
    && (!absent.has("dr_fence_events") || artifact.fenceEvents === null)
    && (!absent.has("model_capacity_events") || artifact.modelLedger === null), "observation_artifact_mismatch");
  ensure(artifact.modelLedger === null || artifact.modelLedger.requests.every(row =>
    (row.waitFromMs !== null || row.waitToMs === null) && (row.activeFromMs !== null || row.activeToMs === null)
    && (row.waitFromMs === null || row.waitToMs === null || row.waitFromMs <= row.waitToMs)
    && (row.activeFromMs === null || row.activeToMs === null || row.activeFromMs <= row.activeToMs)), "observation_artifact_mismatch");
  return artifact;
}

const ACTIVE = new Set<string | null>(["reserved", "dispatched", "indeterminate"]);
export type ModelEvent = { toState: ModelCapacityState | null; atMs: number };
/**
 * 한 요청의 장부 이벤트(id 순)를 대기 구간 하나와 점유 구간 하나로 바꾼다. 상태기계상 대기로 되돌아가지 않는다.
 * 대기는 queue_until, 아직 보내지 않은 예약은 reserved_until에서 끝난 것으로 본다 — 다음 승인 TX가 그 전에 같은 행을 회수한다
 * (expireRequests). 회수 이벤트가 늦게 남아도 그 사이를 대기·점유로 세지 않아 포화를 부풀리지 않는다.
 */
export function modelRequestIntervals(events: readonly ModelEvent[], caps: { queueUntilMs: number; reservedUntilMs: number | null }) {
  let current: string | null = null, waitFrom: number | null = null, waitTo: number | null = null;
  let activeFrom: number | null = null, activeTo: number | null = null, dispatched = false;
  for (const event of events) {
    if (event.toState === current) continue;
    if (current === "waiting") waitTo ??= event.atMs;
    if (ACTIVE.has(current) && !ACTIVE.has(event.toState)) activeTo ??= event.atMs;
    if (event.toState === "waiting") waitFrom ??= event.atMs;
    if (ACTIVE.has(event.toState) && !ACTIVE.has(current)) activeFrom ??= event.atMs;
    if (event.toState === "dispatched" || event.toState === "indeterminate") dispatched = true;
    current = event.toState;
  }
  if (waitFrom !== null) waitTo = Math.max(waitFrom, Math.min(waitTo ?? Infinity, caps.queueUntilMs));
  if (activeFrom !== null && !dispatched && caps.reservedUntilMs !== null)
    activeTo = Math.max(activeFrom, Math.min(activeTo ?? Infinity, caps.reservedUntilMs));
  const finite = (value: number | null) => value === null || !Number.isFinite(value) ? null : value;
  return { waitFromMs: waitFrom, waitToMs: finite(waitTo), activeFromMs: activeFrom, activeToMs: finite(activeTo) };
}

type SlotTotals = { waitingMs: number; freeWhileWaitingMs: number; fullWhileWaitingMs: number; unknownWhileWaitingMs: number; busyMs: number };
const emptyTotals = (): SlotTotals => ({ waitingMs: 0, freeWhileWaitingMs: 0, fullWhileWaitingMs: 0, unknownWhileWaitingMs: 0, busyMs: 0 });
type Verdict = "free" | "full" | "unknown";
const RANK: Record<Verdict, number> = { full: 0, unknown: 1, free: 2 };

/**
 * 설계 §7 끝: "준비 대기가 있는데 슬롯이 비는 시간"과 "포화라 슬롯을 기다리는 시간"을 route/class별로 나눠 적분한다.
 * 준비 대기 = 장부의 waiting 요청(호출 준비가 끝나 슬롯을 요청한 일). 장부에 들어오지 않은 파이프라인 대기는 보지 않는다.
 * 대기 요청 w가 그 시각 전역·provider budget·group·pool 점유가 모두 한도 미만이면 free(슬롯이 비었는데 기다림),
 * 하나라도 한도에 닿았으면 full(포화 대기)이다. 요청의 policy hash가 현재 정책과 다르거나 한도를 모르면 unknown이다.
 * scope 안의 대기 중 하나라도 free면 free, 아니면 unknown이 하나라도 있으면 unknown, 모두 full일 때만 full로 센다
 * (포화를 과장하지 않는 보수적 정의). 점유는 reserved·dispatched·indeterminate 전부다(장부 승인과 같은 집계).
 * 구간은 [from, to)이며 [0, durationMs]로 자른다.
 */
export function integrateModelSlots(requests: readonly SlotRequest[], policy: ModelCapacityPolicy | null, durationMs: number) {
  const limitsHash = policy ? modelCapacityPolicyHash(policy) : null;
  const scopeKey = (row: SlotRequest) => JSON.stringify([row.routeId, row.class]);
  const clip = (from: number | null, to: number | null): [number, number] | null => {
    if (from === null) return null;
    const start = Math.max(0, from), end = Math.min(durationMs, to ?? durationMs);
    return start < end ? [start, end] : null;
  };
  type Change = { at: number; row: number; kind: "wait" | "unwait" | "activate" | "deactivate" };
  const changes: Change[] = [], points = new Set([0, durationMs]), scopes = new Map<string, SlotTotals>();
  requests.forEach((row, index) => {
    scopes.set(scopeKey(row), scopes.get(scopeKey(row)) ?? emptyTotals());
    const wait = clip(row.waitFromMs, row.waitToMs), active = clip(row.activeFromMs, row.activeToMs);
    if (wait) changes.push({ at: wait[0], row: index, kind: "wait" }, { at: wait[1], row: index, kind: "unwait" });
    if (active) changes.push({ at: active[0], row: index, kind: "activate" }, { at: active[1], row: index, kind: "deactivate" });
    for (const range of [wait, active]) if (range) range.forEach(point => points.add(point));
  });
  const times = [...points].sort((a, b) => a - b), all = emptyTotals();
  changes.sort((a, b) => a.at - b.at);
  const waiting = new Set<number>(), activeByScope = new Map<string, number>();
  const counts = { global: 0, provider: new Map<string, number>(), group: new Map<string, number>(), pool: new Map<string, number>() };
  const bump = (map: Map<string, number>, key: string, delta: number) => map.set(key, (map.get(key) ?? 0) + delta);
  const verdict = (row: SlotRequest): Verdict => {
    if (!policy || row.policyHash !== limitsHash) return "unknown";
    const limits = [[counts.global, policy.globalLimit], [counts.provider.get(row.providerBudgetId) ?? 0, policy.providerLimits[row.providerBudgetId]],
      [counts.group.get(row.groupId) ?? 0, policy.groupLimits[row.groupId]], [counts.pool.get(row.pool) ?? 0, policy.poolLimits[row.pool]]] as const;
    if (limits.some(([, limit]) => limit === undefined)) return "unknown";
    return limits.every(([used, limit]) => used < limit!) ? "free" : "full";
  };
  const add = (totals: SlotTotals, value: Verdict, span: number) => {
    totals.waitingMs += span;
    totals[value === "free" ? "freeWhileWaitingMs" : value === "full" ? "fullWhileWaitingMs" : "unknownWhileWaitingMs"] += span;
  };
  let next = 0;
  for (let i = 0; i < times.length - 1; i++) {
    for (; next < changes.length && changes[next].at <= times[i]; next++) {
      const { row: index, kind } = changes[next], row = requests[index];
      if (kind === "wait") waiting.add(index);
      else if (kind === "unwait") waiting.delete(index);
      else {
        const delta = kind === "activate" ? 1 : -1;
        counts.global += delta; bump(counts.provider, row.providerBudgetId, delta); bump(counts.group, row.groupId, delta);
        bump(counts.pool, row.pool, delta); bump(activeByScope, scopeKey(row), delta);
      }
    }
    const span = times[i + 1] - times[i], byScope = new Map<string, Verdict>();
    let overall: Verdict | null = null;
    for (const index of waiting) {
      const row = requests[index], value = verdict(row), key = scopeKey(row), seen = byScope.get(key);
      if (seen === undefined || RANK[value] > RANK[seen]) byScope.set(key, value);
      if (overall === null || RANK[value] > RANK[overall]) overall = value;
    }
    for (const [key, value] of byScope) add(scopes.get(key)!, value, span);
    if (overall) add(all, overall, span);
    for (const [key, active] of activeByScope) if (active > 0) scopes.get(key)!.busyMs += span;
    if (counts.global > 0) all.busyMs += span;
  }
  return { policyKnown: policy !== null, durationMs, all,
    scopes: [...scopes].map(([key, totals]) => { const [routeId, kind] = JSON.parse(key) as [string, string]; return { routeId, class: kind, ...totals }; })
      .sort((a, b) => a.routeId.localeCompare(b.routeId) || a.class.localeCompare(b.class)) };
}

type Evidence = { status: "verified"; count: number } | { status: "unverified" };
const rate = (failed: number, calls: number) => calls ? failed / calls : null;

/** 수집물 하나의 요약. 판정은 안전 위반(violations)만 한다. 미검증 칸은 evidenceIssues로 드러낸다. */
export function reportPipelineObservation(value: unknown) {
  const artifact = parsePipelineObservation(value), { window, baseline, current } = artifact, duration = window.durationMs;
  const issues: string[] = [];
  // 마지막 값만 남는 칸: 구간 뒤 값이면 구간 안에 있었는지 알 수 없다(null).
  const latestIn = (ms: number | null) => ms === null || ms <= 0 ? false : ms <= duration ? true : null;
  if (artifact.database.target === "replica" && !artifact.database.replicaCaughtUp) issues.push("replica_not_caught_up");
  for (const table of artifact.schema.absentTables) issues.push(`table_absent:${table}`);

  let baselineIssue: string | null = null;
  if (!baseline) baselineIssue = "baseline_missing";
  else if (baseline.database.name !== artifact.database.name || baseline.database.oid !== artifact.database.oid) baselineIssue = "baseline_database_mismatch";
  else if (Date.parse(baseline.capturedAt) > Date.parse(window.startedAt)) baselineIssue = "baseline_after_window_start";
  if (baselineIssue) issues.push(baselineIssue);
  const covered = baselineIssue === null ? baseline : null;
  const coverage = covered ? { fromMs: Date.parse(covered.capturedAt) - Date.parse(window.startedAt), toMs: duration + window.collectedAfterEndMs } : null;

  const roleNames = [...new Set([...current.roles, ...covered?.roles ?? [], ...artifact.jobs, ...artifact.acks.rows, ...artifact.readback]
    .map(row => row.role))].sort();
  const roles = roleNames.map(role => {
    const now = current.roles.find(row => row.role === role) ?? null, before = covered?.roles.find(row => row.role === role) ?? null;
    const jobs = artifact.jobs.filter(row => row.role === role).map(row => {
      const runsBefore = covered?.jobs.find(job => job.name === row.name)?.runs ?? (covered ? 0 : null);
      const runsNow = current.jobs.find(job => job.name === row.name)?.runs ?? null;
      return { name: row.name, ranInWindow: latestIn(row.lastRunMs), succeededInWindow: latestIn(row.lastSuccessMs),
        failingAtCollection: row.failingAtCollection, runsDelta: runsBefore === null || runsNow === null ? null : runsNow - runsBefore };
    });
    const acks = artifact.acks.rows.filter(row => row.role === role)
      .map(row => ({ instanceId: row.instanceId, job: row.job, host: row.host, latestInWindow: latestIn(row.recordedMs) }));
    return { role, owner: now?.ownerInstanceId ?? null, epoch: now?.epoch ?? null,
      handoff: covered ? { status: "verified" as const, epochDelta: (now?.epoch ?? 0) - (before?.epoch ?? 0),
        ownerChanged: now?.ownerInstanceId !== before?.ownerInstanceId || now?.ownerBootId !== before?.ownerBootId } : { status: "unverified" as const },
      jobs, acks, readback: artifact.readback.filter(row => row.role === role).map(row => ({ stage: row.stage, rows: row.rows })) };
  });
  const epochChange = <T>(pick: (value: z.infer<typeof controls>) => T | null, epoch: (value: T) => number) => {
    const now = pick(current.controls), before = covered ? pick(covered.controls) : null;
    return { now: now === null ? null : epoch(now), delta: !covered || now === null || before === null ? null : epoch(now) - epoch(before) };
  };
  const controlChanges = {
    stageModes: (current.controls.stageModes ?? []).map(row => ({ stage: row.stage, mode: row.mode,
      ...epochChange(value => value.stageModes?.find(stage => stage.stage === row.stage) ?? null, stage => stage.epoch) })),
    modelCapacity: { mode: current.controls.modelCapacity?.mode ?? null, ...epochChange(value => value.modelCapacity, model => model.epoch),
      revisionDelta: epochChange(value => value.modelCapacity, model => model.revision).delta },
    jobBatch: { mode: current.controls.jobBatch?.mode ?? null, ...epochChange(value => value.jobBatch, batch => batch.epoch) },
    writerFence: { state: current.controls.writerFence?.state ?? null, ...epochChange(value => value.writerFence, fence => fence.writerEpoch),
      eventsInWindow: artifact.fenceEvents?.map(row => ({ reason: row.reason, fromEpoch: row.fromEpoch, toEpoch: row.toEpoch })) ?? null },
  };

  const ledger = artifact.ledger;
  if (ledger.status !== "covered") issues.push(`evidence_ledger_${ledger.status}`);
  const fromLedger = (pick: (counts: z.infer<typeof ledgerCounts>) => number): Evidence =>
    ledger.counts ? { status: "verified", count: pick(ledger.counts) } : { status: "unverified" };
  const safety = { duplicatePublications: { status: "verified", count: artifact.duplicatePublications } as Evidence,
    humanDecisionOverrides: fromLedger(counts => counts.humanDecisionOverrides), leaseViolations: fromLedger(counts => counts.leaseViolations) };
  const violations = Object.entries(safety).filter(([, evidence]) => evidence.status === "verified" && evidence.count > 0).map(([name]) => name);

  const model = artifact.modelLedger, routes = new Map<string, { routeId: string; class: string; counts: Record<string, number> }>();
  for (const row of model?.events ?? []) {
    const key = JSON.stringify([row.routeId, row.class]), entry = routes.get(key) ?? { routeId: row.routeId, class: row.class, counts: {} };
    entry.counts[row.kind] = (entry.counts[row.kind] ?? 0) + row.count; routes.set(key, entry);
  }
  const modelRoutes = [...routes.values()].sort((a, b) => a.routeId.localeCompare(b.routeId) || a.class.localeCompare(b.class)).map(row => {
    const dispatched = row.counts.dispatch_started ?? 0, indeterminate = row.counts.dispatch_indeterminate ?? 0;
    return { routeId: row.routeId, class: row.class, queued: row.counts.queued ?? 0, reserved: row.counts.reserved ?? 0, dispatched,
      settled: row.counts.dispatch_settled ?? 0, indeterminate, released: row.counts.dispatch_released ?? 0,
      withdrawn: (row.counts.reservation_cancelled ?? 0) + (row.counts.reservation_expired ?? 0) + (row.counts.wait_expired ?? 0)
        + (row.counts.policy_changed ?? 0), indeterminateRate: rate(indeterminate, dispatched) };
  });
  let policy: ModelCapacityPolicy | null = null;
  if (model?.control?.policy) {
    try { policy = parseModelCapacityPolicy(model.control.policy); } catch { policy = null; }
    if (policy && modelCapacityPolicyHash(policy) !== model.control.policyHash) policy = null;
    if (!policy) issues.push("model_policy_unreadable");
  }
  if (model?.control?.changedSinceStart) issues.push("model_capacity_changed_since_window_start");
  const slots = model ? integrateModelSlots(model.requests, policy, duration) : null;
  if (slots && slots.all.unknownWhileWaitingMs > 0) issues.push("slot_limits_unknown");

  const ai1 = artifact.ai1, ai2 = ledger.counts;
  const stageFailures = [
    { stage: "ai1", status: "verified" as const, calls: ai1.calls, failed: ai1.technicalFailures, rate: rate(ai1.technicalFailures, ai1.calls) },
    ai2 ? { stage: "ai2", status: "verified" as const, calls: ai2.ai2Calls, failed: ai2.ai2Failed, rate: rate(ai2.ai2Failed, ai2.ai2Calls) }
      : { stage: "ai2", status: "unverified" as const, calls: null, failed: null, rate: null },
    ...modelRoutes.map(row => ({ stage: `model:${row.routeId}:${row.class}`, status: "verified" as const, calls: row.dispatched,
      failed: row.indeterminate, rate: row.indeterminateRate })),
  ];
  return { runId: artifact.runId, scope: "pipeline_observation" as const, window, database: artifact.database, schema: artifact.schema,
    coverage, roles, controls: controlChanges, ackRowsInvalid: artifact.acks.invalid, stageFailures,
    ledger: { status: ledger.status, startedAt: ledger.startedAt, humanDecisionRefusals: ledger.counts?.humanDecisionRefusals ?? null,
      lateWritesRefused: ledger.counts?.lateWritesRefused ?? null, ai2Chains: ledger.counts?.ai2Chains ?? null },
    safety, violations,
    modelLedger: model ? { mode: model.control?.mode ?? null, routes: modelRoutes, openAtCollection: model.openAtCollection } : null,
    slots, evidenceIssues: issues };
}
export type PipelineObservationReport = ReturnType<typeof reportPipelineObservation>;

const minutes = (ms: number | null) => ms === null ? "미상" : `${(ms / 60_000).toFixed(1)}분`;
const percent = (value: number | null) => value === null ? "미상" : `${(value * 100).toFixed(2)}%`;
const yes = (value: boolean | null) => value === null ? "미상" : value ? "예" : "아니오";

/** 사람이 읽는 요약. 수치는 report와 같은 값이다. */
export function formatPipelineObservation(report: PipelineObservationReport): string {
  const lines = [`# 운영 관측 ${report.runId}`, `구간 ${report.window.startedAt} ~ ${report.window.endedAt} (${minutes(report.window.durationMs)}),`
    + ` 수집 ${report.window.collectedAt} · ${report.database.target}`,
  `인계·epoch 근거: ${report.coverage ? `스냅숏 차이(구간 시작 기준 ${report.coverage.fromMs}ms ~ ${report.coverage.toMs}ms)` : "미검증(시작 전 스냅숏 없음)"}`, "", "## 역할"];
  for (const role of report.roles) {
    const handoff = role.handoff.status === "verified" ? `epoch +${role.handoff.epochDelta}, 소유자 변경 ${yes(role.handoff.ownerChanged)}` : "인계 미검증";
    lines.push(`- ${role.role}: 소유 ${role.owner ?? "없음"} · epoch ${role.epoch ?? "미상"} · ${handoff}`);
    for (const job of role.jobs) lines.push(`  - 잡 ${job.name}: 구간 성공 ${yes(job.succeededInWindow)} · 실행 증가 ${job.runsDelta ?? "미상"}`
      + `${job.failingAtCollection ? " · 수집 시 오류 상태" : ""}`);
    for (const ack of role.acks) lines.push(`  - ACK ${ack.instanceId}/${ack.job}@${ack.host}: 마지막 ACK가 구간 안 ${yes(ack.latestInWindow)}`);
    for (const row of role.readback) lines.push(`  - 실처리 ${row.stage}: ${row.rows ?? "미상"}행(하한)`);
  }
  lines.push("", "## 단계별 기술 실패율");
  for (const row of report.stageFailures) lines.push(`- ${row.stage}: ${row.status === "verified" ? `${row.failed}/${row.calls} = ${percent(row.rate)}` : "미검증"}`);
  lines.push("", "## 안전");
  for (const [name, evidence] of Object.entries(report.safety)) lines.push(`- ${name}: ${evidence.status === "verified" ? `${evidence.count}건` : "미검증"}`);
  lines.push(`- 증거 장부(0097): ${report.ledger.status}${report.ledger.startedAt ? ` (기록 시작 ${report.ledger.startedAt})` : ""}`);
  if (report.modelLedger) {
    lines.push("", `## 모델 장부 (mode ${report.modelLedger.mode ?? "미상"})`);
    for (const row of report.modelLedger.routes) lines.push(`- ${row.routeId}/${row.class}: dispatch ${row.dispatched} · settle ${row.settled}`
      + ` · indeterminate ${row.indeterminate} · release ${row.released} · 회수 ${row.withdrawn}`);
    for (const row of report.modelLedger.openAtCollection) lines.push(`- 수집 시 열린 ${row.routeId}/${row.class} ${row.state}: ${row.count}`);
  }
  if (report.slots) {
    lines.push("", "## 슬롯 대기 적분 (빈 슬롯 대기 / 포화 대기 / 한도 미상, 점유)");
    for (const row of [{ routeId: "전체", class: "", ...report.slots.all }, ...report.slots.scopes]) lines.push(`- ${row.routeId}${row.class ? `/${row.class}` : ""}:`
      + ` ${minutes(row.freeWhileWaitingMs)} / ${minutes(row.fullWhileWaitingMs)} / ${minutes(row.unknownWhileWaitingMs)}, 점유 ${minutes(row.busyMs)}`);
  }
  lines.push("", `위반: ${report.violations.length ? report.violations.join(", ") : "없음"}`,
    `미검증·주의: ${report.evidenceIssues.length ? report.evidenceIssues.join(", ") : "없음"}`);
  return `${lines.join("\n")}\n`;
}
