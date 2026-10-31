import { and, asc, eq, sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import { modelHelperAssignments, modelHelperSignals, modelHelperStops, modelRoleDemand, modelSupervisorControl } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import type { ModelCapacityDeviceState } from "@/lib/llm/capacity-devices";
import { readModelCapacityDeviceStates } from "@/lib/llm/capacity-devices-repository";
import {
  HELPER_DECISION_LIMITS, HELPER_SHADOW_PROVIDER, ROLE_DEMAND_BEACONS, SUPERVISOR_CONTROL_ID, roleDemandFresh,
  type DeviceDemandInputs, type HelperAssignmentRow, type HelperGateKind, type HelperStage, type HelperHealthCounts, type HelperInputs, type HelperMetrics,
  type HelperPrimaryDeviceSample, type HelperShadowRunState, type HelperSignalRow, type HelperStopRow, type RoleDemandMetrics, type RoleDemandRow,
  type SupervisorControlRow,
} from "@/lib/llm/capacity-helpers";

/**
 * Oracle 감시자의 한 번 읽기(pr2-plan §3.3 3단계·§3.4). `REPEATABLE READ READ ONLY` 한 TX, 잠그지 않는다. 읽는 것은 감시자 계정
 * (`nomorevibe_oracle_capacity_supervisor`, lib/runtime/oracle-db-profile.ts)이 가진 표·열뿐이다 — 장부(열 제한)·장비·도우미 표·집 쪽 beacon.
 * crawl·도메인 표·jobs·role_leases·dispatch_binding·terminal_evidence 는 읽지 않는다(D2: 측정은 집, 판정은 Oracle, 집행은 Layer A).
 *
 * 읽기 실패는 던진다 → 감시자는 그 순환에 아무것도 쓰지 않는다 → TTL 이 도우미를 닫는다(fail-closed).
 * 아래 builder(supervisorHelperInputs·supervisorDeviceDemandInputs)는 순수 함수다(시험은 가짜 스냅샷으로 본다).
 */

const L = HELPER_DECISION_LIMITS;
/** AI2 주 투표자의 장부 경로(§3.4): policy route `second-review` 중 local-direct. 도우미 장비 자신의 같은 경로(PR 2c)는 뺀다. */
export const AI2_PRIMARY_ROUTE = Object.freeze({ routeId: "second-review", provider: "local-direct" } as const);
/** 배정마다 건강 창에서 읽는 장부 행 상한(도우미는 틱마다 per_tick ≤ 16 건이라 30분 창에 이보다 많지 않다). */
export const HELPER_LEDGER_ROWS_MAX = 500;
/** 연속 미확인을 셀 때 보는 최근 섀도 실행 수. */
const RECENT_SHADOW_STATES = 20;
/** 결정 쌍으로 세는 일치 분류(기권 둘은 결정 쌍이 아니다). */
const DECIDED_AGREEMENTS = sql.raw(`('same','helper_approve_primary_reject','helper_reject_primary_approve','other')`);
const INT_MAX = 2_147_483_647;
/** 건강 창 길이(상수라 bind 가 아니라 글자로 넣는다 — 계획 캐시 키가 같고 렌더된 SQL 이 읽힌다). */
const HEALTH_WINDOW = sql.raw(`interval '${L.healthWindowMs} milliseconds'`);

export type SupervisorPolicyRoute = Readonly<{ routeId: string; provider: string; model: string; groupId: string }>;
/** 건강 창의 도우미 경로 장부 행(종료 상태만). dispatched = dispatched_at 이 있었는가(withdrawn 이면 not_started 로 센다). */
export type HelperLedgerRow = Readonly<{ assignmentId: string; kind: HelperGateKind; state: "settled" | "indeterminate" | "withdrawn"; dispatched: boolean; at: string }>;
/** 배정 × 현재 evidence_key 의 섀도 집계. lastHour 는 evidence_key 와 상관없이 cancelled 를 뺀 최근 1시간 실행 수(시간당 몫). */
export type HelperShadowStats = Readonly<{
  assignmentId: string; lastHour: number; n: number; succeeded: number; failed: number; unknown: number; decided: number; agreed: number;
  wrongApproval: number; wrongRejection: number; rollingDecided: number; rollingAgreed: number;
  /** 건강 창(최근 30분 또는 마지막 저장 뒤, 더 짧은 쪽)의 failed 실행 수. */
  failedRecent: number;
  /** 건강 창의 최근 종료 실행 상태(새것부터, 최대 20). */
  recentStates: readonly HelperShadowRunState[];
}>;
/** 배정 × 현재 version × 현재 evidence_key 의 최근 실전 결과(최대 200). */
export type HelperLiveStats = Readonly<{ assignmentId: string; ai2Agreed: number; ai2Disagreed: number; humanOverturned: number }>;
/** 장비별 현재 세대 local-direct second-review 대기 행(가장 오래된 나이 ms). */
export type Ai2WaitingSample = Readonly<{ deviceId: string; waiting: number; oldestAgeMs: number }>;

export type SupervisorSnapshot = Readonly<{
  /** 스냅샷 첫 문장의 DB clock_timestamp()(ms). 모든 판정 시각은 이 시계다 — Oracle 호스트 시계와 견주지 않는다. */
  nowMs: number;
  control: SupervisorControlRow;
  routes: readonly SupervisorPolicyRoute[];
  deviceStates: readonly ModelCapacityDeviceState[];
  assignments: readonly HelperAssignmentRow[];
  signals: readonly HelperSignalRow[];
  /** 현재 배정 version 의 정지 행만. */
  stops: readonly HelperStopRow[];
  roleDemand: readonly RoleDemandRow[];
  ledger: readonly HelperLedgerRow[];
  ai2Waiting: readonly Ai2WaitingSample[];
  shadow: readonly HelperShadowStats[];
  live: readonly HelperLiveStats[];
}>;

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const isoOrNull = (value: Date | string | null | undefined): string | null => value === null || value === undefined ? null : iso(value);
const num = (value: unknown): number => Number(value ?? 0);
const object = <T>(value: unknown): T => (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as T;

type Reader = Pick<ProductTransaction, "execute" | "select">;

/** 감시자 control 한 행. 없으면 `model_supervisor_control_missing`. */
export async function readSupervisorControl(reader: Pick<ProductTransaction, "select">): Promise<SupervisorControlRow> {
  const [row] = await reader.select().from(modelSupervisorControl).where(eq(modelSupervisorControl.id, SUPERVISOR_CONTROL_ID));
  if (!row) throw new Error("model_supervisor_control_missing");
  return Object.freeze({
    enabled: row.enabled, signalPrincipal: row.signalPrincipal, signalTtlMs: row.signalTtlMs, loopMs: row.loopMs,
    ownerInstanceId: row.ownerInstanceId, ownerBootId: row.ownerBootId, epoch: Number(row.epoch), leaseUntil: isoOrNull(row.leaseUntil),
    heartbeatAt: isoOrNull(row.heartbeatAt), loopSeq: Number(row.loopSeq), release: row.release, updatedBy: row.updatedBy, updatedAt: iso(row.updatedAt),
  });
}

async function readAssignments(reader: Reader): Promise<HelperAssignmentRow[]> {
  // 도우미 행(role 'helper', 단계는 ai1·ai2 — 0156 role_stage CHECK)만. 배정 표 행(role 'primary')은 감시자가 판정하지 않는다.
  const rows = await reader.select().from(modelHelperAssignments).where(eq(modelHelperAssignments.role, "helper"))
    .orderBy(asc(modelHelperAssignments.deviceId), asc(modelHelperAssignments.stage));
  return rows.map(row => Object.freeze({
    assignmentId: row.assignmentId, stage: row.stage as HelperStage, deviceId: row.deviceId, model: row.model, shadowRouteId: row.shadowRouteId,
    liveRouteId: row.liveRouteId, liveProvider: row.liveProvider, mode: row.mode, maxSlots: row.maxSlots, perTick: row.perTick,
    shadowPerHour: row.shadowPerHour, minShadowSamples: row.minShadowSamples, minAgreement: Number(row.minAgreement),
    maxWrongApproval: Number(row.maxWrongApproval), maxWrongRejection: Number(row.maxWrongRejection), maxUnknownRate: Number(row.maxUnknownRate),
    maxFailureRate: Number(row.maxFailureRate), maxLiveDisagreement: Number(row.maxLiveDisagreement), enterSamples: row.enterSamples,
    exitSamples: row.exitSamples, minHelpMs: row.minHelpMs, reenterCooldownMs: row.reenterCooldownMs, note: row.note,
    version: Number(row.version), evidenceKey: row.evidenceKey, promotedAt: isoOrNull(row.promotedAt), promotedBy: row.promotedBy,
    updatedBy: row.updatedBy, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    registryKey: row.registryKey, transport: row.transport, rank: row.rank, role: row.role, vote: row.vote,
  }));
}

async function readSignals(reader: Reader): Promise<HelperSignalRow[]> {
  const rows = await reader.select().from(modelHelperSignals).orderBy(asc(modelHelperSignals.assignmentId));
  return rows.map(row => Object.freeze({
    assignmentId: row.assignmentId, assignmentVersion: Number(row.assignmentVersion), supervisorEpoch: Number(row.supervisorEpoch),
    verdict: row.verdict, reason: row.reason, streak: row.streak, stateSince: iso(row.stateSince), lastExitAt: isoOrNull(row.lastExitAt),
    metrics: object<HelperMetrics>(row.metrics), observedAt: iso(row.observedAt), validUntil: iso(row.validUntil), writtenBy: row.writtenBy,
  }));
}

async function readCurrentStops(reader: Reader): Promise<HelperStopRow[]> {
  const rows = await reader.select({ stop: modelHelperStops }).from(modelHelperStops)
    .innerJoin(modelHelperAssignments, and(eq(modelHelperAssignments.assignmentId, modelHelperStops.assignmentId),
      eq(modelHelperAssignments.version, modelHelperStops.assignmentVersion)))
    .orderBy(asc(modelHelperStops.id));
  return rows.map(({ stop }) => Object.freeze({
    id: Number(stop.id), assignmentId: stop.assignmentId, assignmentVersion: Number(stop.assignmentVersion), effect: stop.effect, reason: stop.reason,
    evidence: object<Record<string, unknown>>(stop.evidence), createdAt: iso(stop.createdAt), writtenBy: stop.writtenBy,
  }));
}

async function readRoleDemand(reader: Reader): Promise<RoleDemandRow[]> {
  const rows = await reader.select().from(modelRoleDemand).orderBy(asc(modelRoleDemand.roleId));
  return rows.map(row => Object.freeze({
    roleId: row.roleId, deviceId: row.deviceId, backlog: row.backlog, oldestAgeMs: row.oldestAgeMs === null ? null : Number(row.oldestAgeMs),
    metrics: object<RoleDemandMetrics>(row.metrics), observedAt: iso(row.observedAt), validUntil: iso(row.validUntil), writtenBy: row.writtenBy,
  }));
}

type GenerationRow = { epoch: string | number; revision: string | number; policy_hash: string | null; routes: unknown };
async function readPolicy(reader: Reader): Promise<{ generation: { epoch: number; revision: number; policyHash: string }; routes: SupervisorPolicyRoute[] }> {
  const [row] = await reader.execute<GenerationRow>(sql`SELECT epoch, revision, policy_hash,
      CASE WHEN jsonb_typeof(policy->'routes') = 'array' THEN policy->'routes' ELSE '[]'::jsonb END AS routes
    FROM model_capacity_control WHERE id = 1`);
  if (!row) throw new Error("model_capacity_control_missing");
  const routes = (Array.isArray(row.routes) ? row.routes : []).flatMap((route: unknown): SupervisorPolicyRoute[] => {
    const value = object<Record<string, unknown>>(route);
    return typeof value.routeId === "string" && typeof value.provider === "string" && typeof value.model === "string" && typeof value.groupId === "string"
      ? [Object.freeze({ routeId: value.routeId, provider: value.provider, model: value.model, groupId: value.groupId })] : [];
  });
  return { generation: { epoch: Number(row.epoch), revision: Number(row.revision), policyHash: row.policy_hash ?? "" }, routes };
}

type LedgerSqlRow = { assignment_id: string; kind: HelperGateKind; state: HelperLedgerRow["state"]; dispatched: boolean; at: Date | string };
/** 배정별 건강 창(최근 30분과 마지막 저장 뒤 중 짧은 쪽)의 도우미 경로 종료 행. 저장(자동 정지 해제 포함)은 새 창을 연다. */
async function readHelperLedger(reader: Reader): Promise<HelperLedgerRow[]> {
  const rows = await reader.execute<LedgerSqlRow>(sql`SELECT a.assignment_id, x.kind, x.state, x.dispatched, x.at
    FROM model_helper_assignments a
    CROSS JOIN LATERAL (
      SELECT CASE WHEN r.route_id = a.live_route_id AND r.provider = a.live_provider THEN 'live' ELSE 'shadow' END AS kind,
        r.state, r.dispatched_at IS NOT NULL AS dispatched, r.updated_at AS at, r.request_id
      FROM model_capacity_requests r
      WHERE r.group_id = a.device_id AND r.model = a.model
        AND ((r.route_id = a.live_route_id AND r.provider = a.live_provider)
          OR (r.route_id = a.shadow_route_id AND r.provider = ${HELPER_SHADOW_PROVIDER}))
        AND r.state IN ('settled','indeterminate','withdrawn')
        AND r.updated_at >= greatest(clock_timestamp() - ${HEALTH_WINDOW}, a.updated_at)
      ORDER BY r.updated_at DESC, r.request_id DESC LIMIT ${HELPER_LEDGER_ROWS_MAX}
    ) x
    WHERE a.role = 'helper'
    ORDER BY a.assignment_id, x.at DESC, x.request_id DESC`);
  return rows.map(row => Object.freeze({ assignmentId: row.assignment_id, kind: row.kind, state: row.state, dispatched: row.dispatched === true, at: iso(row.at) }));
}

type WaitingSqlRow = { device_id: string; waiting: number; oldest_age_ms: string | number };
async function readAi2Waiting(reader: Reader, generation: { epoch: number; revision: number; policyHash: string }): Promise<Ai2WaitingSample[]> {
  const rows = await reader.execute<WaitingSqlRow>(sql`SELECT r.group_id AS device_id, count(*)::int AS waiting,
      floor(extract(epoch FROM clock_timestamp() - min(r.queued_at)) * 1000)::bigint AS oldest_age_ms
    FROM model_capacity_requests r
    WHERE r.route_id = ${AI2_PRIMARY_ROUTE.routeId} AND r.provider = ${AI2_PRIMARY_ROUTE.provider} AND r.state = 'waiting'
      AND r.epoch = ${generation.epoch} AND r.revision = ${generation.revision} AND r.policy_hash = ${generation.policyHash}
      AND r.queue_until > clock_timestamp()
    GROUP BY r.group_id ORDER BY r.group_id`);
  return rows.map(row => Object.freeze({ deviceId: row.device_id, waiting: num(row.waiting), oldestAgeMs: Math.max(0, num(row.oldest_age_ms)) }));
}

type ShadowSqlRow = { assignment_id: string; last_hour: number; n: number; succeeded: number; failed: number; unknown: number; decided: number;
  agreed: number; wrong_approval: number; wrong_rejection: number; rolling_decided: number; rolling_agreed: number; failed_recent: number;
  recent_states: string | null };
async function readShadowStats(reader: Reader): Promise<HelperShadowStats[]> {
  const window = sql`greatest(clock_timestamp() - ${HEALTH_WINDOW}, a.updated_at)`;
  const rows = await reader.execute<ShadowSqlRow>(sql`SELECT a.assignment_id,
      (SELECT count(*) FROM model_helper_shadow_runs s WHERE s.assignment_id = a.assignment_id AND s.state <> 'cancelled'
        AND s.created_at >= clock_timestamp() - interval '1 hour')::int AS last_hour,
      w.n, w.succeeded, w.failed, w.unknown, w.decided, w.agreed, w.wrong_approval, w.wrong_rejection,
      rl.decided AS rolling_decided, rl.agreed AS rolling_agreed,
      (SELECT count(*) FROM model_helper_shadow_runs s WHERE s.assignment_id = a.assignment_id AND s.evidence_key = a.evidence_key
        AND s.state = 'failed' AND s.created_at >= ${window})::int AS failed_recent,
      (SELECT string_agg(t.state, ',' ORDER BY t.created_at DESC, t.id DESC) FROM (
        SELECT s.state, s.created_at, s.id FROM model_helper_shadow_runs s
        WHERE s.assignment_id = a.assignment_id AND s.evidence_key = a.evidence_key AND s.state IN ('succeeded','failed','unknown')
          AND s.created_at >= ${window}
        ORDER BY s.created_at DESC, s.id DESC LIMIT ${RECENT_SHADOW_STATES}) t) AS recent_states
    FROM model_helper_assignments a
    CROSS JOIN LATERAL (
      SELECT count(*) FILTER (WHERE x.state IN ('succeeded','failed','unknown'))::int AS n,
        count(*) FILTER (WHERE x.state = 'succeeded')::int AS succeeded, count(*) FILTER (WHERE x.state = 'failed')::int AS failed,
        count(*) FILTER (WHERE x.state = 'unknown')::int AS unknown,
        count(*) FILTER (WHERE x.state = 'succeeded' AND x.agreement IN ${DECIDED_AGREEMENTS})::int AS decided,
        count(*) FILTER (WHERE x.state = 'succeeded' AND x.agreement = 'same')::int AS agreed,
        count(*) FILTER (WHERE x.state = 'succeeded' AND x.agreement = 'helper_approve_primary_reject')::int AS wrong_approval,
        count(*) FILTER (WHERE x.state = 'succeeded' AND x.agreement = 'helper_reject_primary_approve')::int AS wrong_rejection
      FROM (SELECT s.state, s.agreement FROM model_helper_shadow_runs s
        WHERE s.assignment_id = a.assignment_id AND s.evidence_key = a.evidence_key
        ORDER BY s.created_at DESC, s.id DESC LIMIT ${L.shadowStatsWindow}) x
    ) w
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS decided, count(*) FILTER (WHERE y.agreement = 'same')::int AS agreed
      FROM (SELECT s.agreement FROM model_helper_shadow_runs s
        WHERE s.assignment_id = a.assignment_id AND s.evidence_key = a.evidence_key AND s.state = 'succeeded' AND s.agreement IN ${DECIDED_AGREEMENTS}
        ORDER BY s.created_at DESC, s.id DESC LIMIT ${L.rollingShadowWindow}) y
    ) rl
    WHERE a.role = 'helper'
    ORDER BY a.assignment_id`);
  return rows.map(row => Object.freeze({
    assignmentId: row.assignment_id, lastHour: num(row.last_hour), n: num(row.n), succeeded: num(row.succeeded), failed: num(row.failed),
    unknown: num(row.unknown), decided: num(row.decided), agreed: num(row.agreed), wrongApproval: num(row.wrong_approval),
    wrongRejection: num(row.wrong_rejection), rollingDecided: num(row.rolling_decided), rollingAgreed: num(row.rolling_agreed),
    failedRecent: num(row.failed_recent),
    recentStates: Object.freeze((row.recent_states ? row.recent_states.split(",") : []) as HelperShadowRunState[]),
  }));
}

type LiveSqlRow = { assignment_id: string; ai2_agreed: number; ai2_disagreed: number; human_overturned: number };
async function readLiveStats(reader: Reader): Promise<HelperLiveStats[]> {
  const rows = await reader.execute<LiveSqlRow>(sql`SELECT a.assignment_id,
      count(*) FILTER (WHERE x.downstream = 'ai2_agreed')::int AS ai2_agreed,
      count(*) FILTER (WHERE x.downstream = 'ai2_disagreed')::int AS ai2_disagreed,
      count(*) FILTER (WHERE x.downstream = 'human_overturned')::int AS human_overturned
    FROM model_helper_assignments a
    LEFT JOIN LATERAL (SELECT o.downstream FROM model_helper_live_outputs o
      WHERE o.assignment_id = a.assignment_id AND o.assignment_version = a.version AND o.evidence_key = a.evidence_key
      ORDER BY o.created_at DESC, o.id DESC LIMIT ${L.liveStatsRecent}) x ON true
    WHERE a.role = 'helper'
    GROUP BY a.assignment_id ORDER BY a.assignment_id`);
  return rows.map(row => Object.freeze({ assignmentId: row.assignment_id, ai2Agreed: num(row.ai2_agreed), ai2Disagreed: num(row.ai2_disagreed),
    humanOverturned: num(row.human_overturned) }));
}

/** 주어진 TX(REPEATABLE READ READ ONLY 여야 한 장면이다) 안의 스냅샷. */
export async function readSupervisorSnapshotIn(tx: ProductTransaction): Promise<SupervisorSnapshot> {
  const [clock] = await tx.execute<{ now_ms: string | number }>(sql`SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now_ms`);
  const nowMs = num(clock?.now_ms);
  const control = await readSupervisorControl(tx);
  const policy = await readPolicy(tx);
  const deviceStates = await readModelCapacityDeviceStates(tx);
  const assignments = await readAssignments(tx);
  const signals = await readSignals(tx);
  const stops = await readCurrentStops(tx);
  const roleDemand = await readRoleDemand(tx);
  const ledger = assignments.length ? await readHelperLedger(tx) : [];
  const ai2Waiting = assignments.some(row => row.stage === "ai2") ? await readAi2Waiting(tx, policy.generation) : [];
  const shadow = assignments.length ? await readShadowStats(tx) : [];
  const live = assignments.length ? await readLiveStats(tx) : [];
  return Object.freeze({ nowMs, control, routes: policy.routes, deviceStates, assignments, signals, stops, roleDemand, ledger, ai2Waiting, shadow, live });
}

/** 감시자 스냅샷 한 번(primary, `REPEATABLE READ READ ONLY`). replay 범위에서는 열지 않는다. */
export async function readSupervisorSnapshot(): Promise<SupervisorSnapshot> {
  if (currentReplayDb()) throw new Error("capacity_supervisor_replay_unsupported");
  return onPrimary(() => db.transaction(tx => readSupervisorSnapshotIn(tx), { isolationLevel: "repeatable read", accessMode: "read only" }));
}

// ── 순수 builder ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * 도우미 장비 자기 역할 beacon: `device_id` 가 그 장비인 beacon 행. 여럿이면 하나로 합친다(backlog 합, 가장 이른 만료 — 하나라도 만료면 만료).
 * 없으면 null(⇒ 바쁨으로 본다, fail-closed).
 */
export function helperOwnRoleBeacon(roleDemand: readonly RoleDemandRow[], deviceId: string): RoleDemandRow | null {
  const rows = roleDemand.filter(row => row.deviceId === deviceId);
  if (rows.length <= 1) return rows[0] ?? null;
  const earliest = (values: string[]) => values.reduce((a, b) => Date.parse(a) <= Date.parse(b) ? a : b);
  const ages = rows.map(row => row.oldestAgeMs).filter((value): value is number => value !== null);
  return Object.freeze({
    roleId: rows.map(row => row.roleId).join("+"), deviceId, backlog: Math.min(INT_MAX, rows.reduce((sum, row) => sum + row.backlog, 0)),
    oldestAgeMs: ages.length ? Math.max(...ages) : null, metrics: {},
    observedAt: earliest(rows.map(row => row.observedAt)), validUntil: earliest(rows.map(row => row.validUntil)), writtenBy: rows[0].writtenBy,
  });
}

/**
 * 배정의 주 장비 표본(§3.4). null = 모름(⇒ stale_inputs): ai1 beacon 이 없거나 만료·모양 틀림, 또는 나열된 주 장비의 상태가 없음.
 * - ai1: AI1 소비자 beacon(`model_role_demand['ai1']`)의 metrics.devices(감시자는 crawl_settings 를 읽지 못한다, Q9). 도우미 장비는 뺀다.
 * - ai2: 정책 route `second-review`/local-direct 의 groupId(도우미 장비 제외) + 그 장비의 대기 행 나이.
 * 빈 목록은 null 이 아니다 — 주 장비가 없으면 가득일 수 없다(decide 가 돕지 않는다).
 */
export function helperPrimaryDevices(snapshot: Pick<SupervisorSnapshot, "nowMs" | "roleDemand" | "routes" | "deviceStates" | "ai2Waiting">,
  assignment: Pick<HelperAssignmentRow, "stage" | "deviceId">): HelperPrimaryDeviceSample[] | null {
  let ids: string[];
  if (assignment.stage === "ai1") {
    const beacon = snapshot.roleDemand.find(row => row.roleId === ROLE_DEMAND_BEACONS.ai1.roleId) ?? null;
    if (!beacon || !roleDemandFresh({ nowMs: snapshot.nowMs, beacon })) return null;
    const devices = beacon.metrics.devices;
    if (!Array.isArray(devices) || devices.some(device => typeof device !== "string" || !device)) return null;
    ids = [...new Set(devices as readonly string[])];
  } else {
    ids = [...new Set(snapshot.routes.filter(route => route.routeId === AI2_PRIMARY_ROUTE.routeId && route.provider === AI2_PRIMARY_ROUTE.provider)
      .map(route => route.groupId))];
  }
  const samples: HelperPrimaryDeviceSample[] = [];
  for (const deviceId of ids.filter(id => id !== assignment.deviceId).sort()) {
    const state = snapshot.deviceStates.find(row => row.deviceId === deviceId);
    if (!state) return null;
    const waiting = assignment.stage === "ai2" ? snapshot.ai2Waiting.find(row => row.deviceId === deviceId) : undefined;
    samples.push(Object.freeze({ deviceId, active: state.active, limitSlots: state.limitSlots, waiting: state.waiting,
      oldestWaitingAgeMs: waiting ? waiting.oldestAgeMs : null }));
  }
  return samples;
}

/**
 * 건강 창 집계(§3.4). 장부: settled = 끝남, indeterminate = 미확인, dispatch 뒤 withdrawn = not_started(dispatch 전 withdrawn 은 세지 않는다).
 * 장부에는 실패 상태가 없다(검증 실패 호출도 settled) — failed 는 같은 창의 섀도 실행 failed 수(settled 를 넘지 않게)이고 ok 에서 뺀다.
 * 연속 미확인 = 장부 종료 행과 섀도 실행 중 더 긴 쪽의 맨 앞 미확인 연속(보수적).
 */
export function helperHealthCounts(assignmentId: string, ledger: readonly HelperLedgerRow[], shadow: HelperShadowStats | undefined,
  live: HelperLiveStats | undefined): HelperHealthCounts {
  const rows = ledger.filter(row => row.assignmentId === assignmentId && (row.state !== "withdrawn" || row.dispatched))
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const settled = rows.filter(row => row.state === "settled").length, unknown = rows.filter(row => row.state === "indeterminate").length;
  const notStarted = rows.filter(row => row.state === "withdrawn").length, failed = Math.min(shadow?.failedRecent ?? 0, settled);
  const leading = <T>(values: readonly T[], match: (value: T) => boolean) => { let count = 0; for (const value of values) { if (!match(value)) break; count++; } return count; };
  const consecutiveUnknowns = Math.max(leading(rows, row => row.state === "indeterminate"), leading(shadow?.recentStates ?? [], state => state === "unknown"));
  return Object.freeze({
    dispatch: Object.freeze({ n: settled + unknown + notStarted, ok: settled - failed, unknown, failed, notStarted }),
    shadow: Object.freeze({ n: shadow?.n ?? 0, succeeded: shadow?.succeeded ?? 0, failed: shadow?.failed ?? 0, unknown: shadow?.unknown ?? 0,
      decided: shadow?.decided ?? 0, agreed: shadow?.agreed ?? 0, wrongApproval: shadow?.wrongApproval ?? 0, wrongRejection: shadow?.wrongRejection ?? 0 }),
    rollingShadow: Object.freeze({ decided: shadow?.rollingDecided ?? 0, agreed: shadow?.rollingAgreed ?? 0 }),
    live: Object.freeze({ ai2Agreed: live?.ai2Agreed ?? 0, ai2Disagreed: live?.ai2Disagreed ?? 0, humanOverturned: live?.humanOverturned ?? 0 }),
    consecutiveUnknowns,
  });
}

/** 스냅샷 → 배정마다 decideHelper 입력. 도우미 장비 상태·섀도/실전 집계가 없으면 snapshotComplete=false(⇒ hold/stale_inputs). */
export function supervisorHelperInputs(snapshot: SupervisorSnapshot, epoch: number): HelperInputs[] {
  return snapshot.assignments.map(assignment => {
    const helperState = snapshot.deviceStates.find(row => row.deviceId === assignment.deviceId);
    const shadow = snapshot.shadow.find(row => row.assignmentId === assignment.assignmentId);
    const live = snapshot.live.find(row => row.assignmentId === assignment.assignmentId);
    const beacon = helperOwnRoleBeacon(snapshot.roleDemand, assignment.deviceId);
    return Object.freeze({
      nowMs: snapshot.nowMs, epoch, assignment,
      previous: snapshot.signals.find(row => row.assignmentId === assignment.assignmentId) ?? null,
      stops: snapshot.stops.filter(row => row.assignmentId === assignment.assignmentId && row.assignmentVersion === assignment.version),
      snapshotComplete: helperState !== undefined && shadow !== undefined && live !== undefined,
      primaryDevices: helperPrimaryDevices(snapshot, assignment),
      ownRole: Object.freeze({ ledgerBusy: helperState?.primaryBusy ?? true, beacon, beaconFresh: roleDemandFresh({ nowMs: snapshot.nowMs, beacon }) }),
      health: helperHealthCounts(assignment.assignmentId, snapshot.ledger, shadow, live),
      shadowRunsLastHour: shadow?.lastHour ?? 0,
    });
  });
}

/**
 * 스냅샷 → 장비마다 decideDeviceDemand 입력. 대상은 mode 가 'off' 가 아닌 배정의 장비뿐이다 — 도우미가 모두 꺼진 장비에는 빌려주기 제한
 * 신호를 쓰지 않는다(PR 1b 동작 그대로).
 */
export function supervisorDeviceDemandInputs(snapshot: SupervisorSnapshot, epoch: number): DeviceDemandInputs[] {
  const devices = [...new Set(snapshot.assignments.filter(row => row.mode !== "off").map(row => row.deviceId))].sort();
  return devices.map(deviceId => Object.freeze({ nowMs: snapshot.nowMs, epoch, deviceId,
    beacons: snapshot.roleDemand.filter(row => row.deviceId === deviceId) }));
}
