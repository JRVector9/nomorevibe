import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import {
  HELPER_SIGNAL_METRICS_MAX_BYTES, SUPERVISOR_CONTROL_ID, SUPERVISOR_LEASE_LOOPS, SUPERVISOR_PRINCIPAL,
  type DeviceDemandDecision, type HelperDecision,
} from "@/lib/llm/capacity-helpers";
import { lockWriterFence } from "@/lib/operations/dr/epoch";
import type { OracleConsumerReadiness } from "@/lib/runtime/oracle-consumer-preflight";

/**
 * Oracle 감시자의 쓰기 경로(pr2-plan §3.3 TX-A·TX-B). WP-2a-A 의 capacity-helpers-repository 는 관리자 쪽 저장만 갖고,
 * 감시자 lease·신호·정지 쓰기는 여기에 있다. 모든 SQL 은 감시자 계정 권한 안이다(lib/runtime/oracle-db-profile.ts 'capacity-supervisor'):
 * control 의 lease 열만 UPDATE, 신호 두 표 INSERT/열 UPDATE, 정지 INSERT, 나머지는 읽기.
 *
 * 잠금 순서(입장 TX·관리자 저장과 같은 방향): DR writer fence(SHARE) → model_supervisor_control id=1(행 UPDATE) → 신호 행
 * (+ FK 검사로 model_helper_assignments 행 KEY SHARE). 감시자는 model_capacity_control 을 잠그지 않는다.
 * 신선도 시각(observed_at·valid_until)은 언제나 DB clock_timestamp() 한 값에서 나온다 — Oracle 호스트 시계는 쓰지 않는다.
 * 0154 의 stamp 트리거가 written_by := current_user, observed_at := clock_timestamp() 로 다시 쓰더라도 같은 뜻이다.
 */

export type SupervisorOwner = Readonly<{ instanceId: string; bootId: string; release: string | null }>;

export type SupervisorLease =
  | Readonly<{ kind: "fenced"; reason: string }>
  | Readonly<{ kind: "control_missing" }>
  /** 다른 살아 있는 owner 가 있다. 이 프로세스는 아무 신호도 쓰지 않는다. */
  | Readonly<{ kind: "standby"; ownerInstanceId: string | null; leaseUntil: string | null; loopMs: number; epoch: number }>
  | Readonly<{ kind: "owner"; epoch: number; enabled: boolean; signalTtlMs: number; loopMs: number; signalPrincipal: string; principalOk: boolean;
    leaseUntil: string; loopSeq: number }>;

export type SupervisorWritePlan = Readonly<{ helpers: readonly HelperDecision[]; devices: readonly DeviceDemandDecision[] }>;
export type SupervisorWriteResult =
  | Readonly<{ kind: "written"; helpers: number; devices: number; stops: number; skipped: number; signalTtlMs: number }>
  | Readonly<{ kind: "fenced"; reason: string }>
  /** owner·boot·epoch 가 바뀌었거나 lease 가 끝났다 — 아무것도 쓰지 않았다. */
  | Readonly<{ kind: "lease_lost" }>
  /** 관리자가 그 사이에 껐다 — 아무것도 쓰지 않았다(신호는 TTL 로 만료된다). */
  | Readonly<{ kind: "disabled" }>
  | Readonly<{ kind: "principal_mismatch" }>;

const iso = (value: Date | string | null): string | null => value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();
const replayGuard = () => { if (currentReplayDb()) throw new Error("capacity_supervisor_replay_unsupported"); };
const OWNER_ID = /^[A-Za-z0-9._-]{1,48}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function checkOwner(owner: SupervisorOwner): void {
  if (!OWNER_ID.test(owner.instanceId) || !UUID.test(owner.bootId) || (owner.release !== null && (owner.release.length > 80 || !owner.release.trim())))
    throw new Error("capacity_supervisor_owner_invalid");
}

/** 이 세션의 DB 계정. 감시자는 이 값이 SUPERVISOR_PRINCIPAL 이 아니면(main 역할 `nomorevibe` 포함) 아무것도 쓰기 전에 끝난다. */
export async function readSessionPrincipal(): Promise<{ currentUser: string; sessionUser: string }> {
  replayGuard();
  return onPrimary(async () => {
    const [row] = await db.execute<{ principal: string; session_principal: string }>(sql`SELECT current_user::text AS principal,
      session_user::text AS session_principal`);
    return { currentUser: row?.principal ?? "", sessionUser: row?.session_principal ?? "" };
  });
}

/** 계정 검사(순수): 정확히 감시자 계정이고 SET ROLE 로 빌린 것이 아니어야 한다. */
export function supervisorPrincipalAllowed(session: { currentUser: string; sessionUser: string }): boolean {
  return session.currentUser === SUPERVISOR_PRINCIPAL && session.sessionUser === session.currentUser;
}

type LeaseSqlRow = { epoch: string | number; enabled: boolean; signal_ttl_ms: number; loop_ms: number; signal_principal: string; principal_ok: boolean;
  lease_until: Date | string; loop_seq: string | number };
type ControlSqlRow = { owner_instance_id: string | null; lease_until: Date | string | null; loop_ms: number; epoch: string | number };

/**
 * TX-A(§3.3 1): fence SHARE 뒤 singleton lease 를 얻거나 갱신한다. owner(instance·boot)가 바뀌면 epoch + 1 — 새 epoch 의 신호만 입장이 믿는다.
 * lease = clock_timestamp() + 3 × loop_ms. 다른 owner 의 lease 가 살아 있으면 standby(아무것도 쓰지 않는다). fenced DB 에서는 lease 도 쓰지 않는다.
 */
export async function acquireSupervisorLease(owner: SupervisorOwner): Promise<SupervisorLease> {
  replayGuard(); checkOwner(owner);
  return onPrimary(() => db.transaction(async tx => acquireSupervisorLeaseIn(tx, owner)));
}

export async function acquireSupervisorLeaseIn(tx: ProductTransaction, owner: SupervisorOwner): Promise<SupervisorLease> {
  checkOwner(owner);
  const fence = await lockWriterFence(tx, "share");
  if (fence.state !== "active") return { kind: "fenced", reason: fence.reason ?? fence.state };
  const leaseLoops = sql.raw(String(SUPERVISOR_LEASE_LOOPS));
  const [row] = await tx.execute<LeaseSqlRow>(sql`UPDATE model_supervisor_control
    SET owner_instance_id = ${owner.instanceId}, owner_boot_id = ${owner.bootId}::uuid,
      epoch = CASE WHEN owner_instance_id IS NOT DISTINCT FROM ${owner.instanceId} AND owner_boot_id IS NOT DISTINCT FROM ${owner.bootId}::uuid
        THEN epoch ELSE epoch + 1 END,
      lease_until = clock_timestamp() + loop_ms * ${leaseLoops} * interval '1 millisecond',
      heartbeat_at = clock_timestamp(), loop_seq = loop_seq + 1, release = ${owner.release}
    WHERE id = ${SUPERVISOR_CONTROL_ID}
      AND (lease_until IS NULL OR lease_until < clock_timestamp()
        OR (owner_instance_id = ${owner.instanceId} AND owner_boot_id = ${owner.bootId}::uuid))
    RETURNING epoch, enabled, signal_ttl_ms, loop_ms, signal_principal, signal_principal = current_user::text AS principal_ok, lease_until, loop_seq`);
  if (row) {
    return { kind: "owner", epoch: Number(row.epoch), enabled: row.enabled === true, signalTtlMs: Number(row.signal_ttl_ms), loopMs: Number(row.loop_ms),
      signalPrincipal: row.signal_principal, principalOk: row.principal_ok === true, leaseUntil: iso(row.lease_until)!, loopSeq: Number(row.loop_seq) };
  }
  const [control] = await tx.execute<ControlSqlRow>(sql`SELECT owner_instance_id, lease_until, loop_ms, epoch FROM model_supervisor_control
    WHERE id = ${SUPERVISOR_CONTROL_ID}`);
  if (!control) return { kind: "control_missing" };
  return { kind: "standby", ownerInstanceId: control.owner_instance_id, leaseUntil: iso(control.lease_until), loopMs: Number(control.loop_ms),
    epoch: Number(control.epoch) };
}

/** jsonb 열 CHECK(pg_column_size ≤ 8192) 안에 들도록 metrics/evidence 를 자른다(글자 수가 넘으면 요약 한 줄만 남긴다). */
export function boundedJson(value: Readonly<Record<string, unknown>>, maxBytes = HELPER_SIGNAL_METRICS_MAX_BYTES / 2): string {
  const text = JSON.stringify(value);
  return Buffer.byteLength(text, "utf8") <= maxBytes ? text : JSON.stringify({ truncated: true, keys: Object.keys(value).length });
}

type WriteLeaseRow = { enabled: boolean; signal_ttl_ms: number; principal_ok: boolean };

/**
 * TX-B(§3.3 5): fence SHARE → lease 재확인(owner·boot·epoch 같고 lease 가 살아 있음, heartbeat 만 갱신) → 신호 upsert(valid_until =
 * clock_timestamp() + signal_ttl_ms) → 정지 insert. 재확인이 0 행이면 아무것도 쓰지 않는다(lease_lost). 그 사이 꺼졌으면 disabled.
 * 배정 신호는 배정 행의 version 이 판정 때와 같을 때만 쓴다(관리자가 다시 저장했으면 다음 순환이 새 version 으로 판정한다).
 * 정지는 같은 (배정, version) 에 같거나 더 센 정지가 없을 때만 넣는다: stop 은 stop 이 없을 때, demote_to_shadow 는 정지가 하나도 없을 때.
 */
export async function writeSupervisorSignals(owner: SupervisorOwner, epoch: number, plan: SupervisorWritePlan): Promise<SupervisorWriteResult> {
  replayGuard(); checkOwner(owner);
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("capacity_supervisor_epoch_invalid");
  return onPrimary(() => db.transaction(async tx => writeSupervisorSignalsIn(tx, owner, epoch, plan)));
}

export async function writeSupervisorSignalsIn(tx: ProductTransaction, owner: SupervisorOwner, epoch: number, plan: SupervisorWritePlan):
  Promise<SupervisorWriteResult> {
  const fence = await lockWriterFence(tx, "share");
  if (fence.state !== "active") return { kind: "fenced", reason: fence.reason ?? fence.state };
  const [lease] = await tx.execute<WriteLeaseRow>(sql`UPDATE model_supervisor_control SET heartbeat_at = clock_timestamp()
    WHERE id = ${SUPERVISOR_CONTROL_ID} AND owner_instance_id = ${owner.instanceId} AND owner_boot_id = ${owner.bootId}::uuid
      AND epoch = ${epoch} AND lease_until > clock_timestamp()
    RETURNING enabled, signal_ttl_ms, signal_principal = current_user::text AS principal_ok`);
  if (!lease) return { kind: "lease_lost" };
  if (lease.principal_ok !== true) return { kind: "principal_mismatch" };
  if (lease.enabled !== true) return { kind: "disabled" };
  const ttl = Number(lease.signal_ttl_ms);
  let helpers = 0, devices = 0, stops = 0, skipped = 0;
  for (const decision of plan.helpers) {
    const written = await tx.execute<{ assignment_id: string }>(sql`WITH t AS (SELECT clock_timestamp() AS at)
      INSERT INTO model_helper_signals (assignment_id, assignment_version, supervisor_epoch, verdict, reason, streak, state_since, last_exit_at,
        metrics, observed_at, valid_until, written_by)
      SELECT ha.assignment_id, ha.version, ${epoch}::bigint, ${decision.verdict}::text, ${decision.reason}::text, ${decision.streak}::int,
        ${decision.stateSince}::timestamptz, ${decision.lastExitAt}::timestamptz, ${boundedJson(decision.metrics)}::jsonb,
        t.at, t.at + ${ttl}::int * interval '1 millisecond', current_user::text
      FROM model_helper_assignments ha, t WHERE ha.assignment_id = ${decision.assignmentId} AND ha.version = ${decision.assignmentVersion}
      ON CONFLICT (assignment_id) DO UPDATE SET assignment_version = EXCLUDED.assignment_version, supervisor_epoch = EXCLUDED.supervisor_epoch,
        verdict = EXCLUDED.verdict, reason = EXCLUDED.reason, streak = EXCLUDED.streak, state_since = EXCLUDED.state_since,
        last_exit_at = EXCLUDED.last_exit_at, metrics = EXCLUDED.metrics, observed_at = EXCLUDED.observed_at, valid_until = EXCLUDED.valid_until,
        written_by = EXCLUDED.written_by
      RETURNING assignment_id`);
    if (!written.length) { skipped++; continue; }
    helpers++;
    if (!decision.stop) continue;
    const inserted = await tx.execute<{ id: string | number }>(sql`INSERT INTO model_helper_stops (assignment_id, assignment_version, effect, reason, evidence)
      SELECT ha.assignment_id, ha.version, ${decision.stop.effect}::text, ${decision.stop.reason}::text, ${boundedJson(decision.stop.evidence)}::jsonb
      FROM model_helper_assignments ha WHERE ha.assignment_id = ${decision.assignmentId} AND ha.version = ${decision.assignmentVersion}
        AND NOT EXISTS (SELECT 1 FROM model_helper_stops st WHERE st.assignment_id = ha.assignment_id AND st.assignment_version = ha.version
          AND (st.effect = 'stop' OR ${decision.stop.effect}::text = 'demote_to_shadow'))
      RETURNING id`);
    stops += inserted.length;
  }
  for (const decision of plan.devices) {
    await tx.execute(sql`WITH t AS (SELECT clock_timestamp() AS at)
      INSERT INTO model_device_signals (device_id, supervisor_epoch, primary_demand, backlog, metrics, observed_at, valid_until, written_by)
      SELECT ${decision.deviceId}::text, ${epoch}::bigint, ${decision.primaryDemand}::boolean, ${decision.backlog}::int, ${boundedJson(decision.metrics)}::jsonb,
        t.at, t.at + ${ttl}::int * interval '1 millisecond', current_user::text FROM t
      ON CONFLICT (device_id) DO UPDATE SET supervisor_epoch = EXCLUDED.supervisor_epoch, primary_demand = EXCLUDED.primary_demand,
        backlog = EXCLUDED.backlog, metrics = EXCLUDED.metrics, observed_at = EXCLUDED.observed_at, valid_until = EXCLUDED.valid_until,
        written_by = EXCLUDED.written_by`);
    devices++;
  }
  return { kind: "written", helpers, devices, stops, skipped, signalTtlMs: ttl };
}

/**
 * Oracle consumer preflight 의 consumer 항목(읽기만). control 행이 있고 그 signal_principal 이 이 계정이어야 verified 다.
 * 꺼져 있어도 verified 다 — 감시자는 꺼진 동안 신호를 쓰지 않고 쉰다(unit 이 exit 78 을 되풀이하지 않는다).
 */
export const capacitySupervisorOracleReadiness: OracleConsumerReadiness = async (tx, { principal }) => {
  const [row] = await tx.execute<{ signal_principal: string; enabled: boolean }>(sql`SELECT signal_principal, enabled FROM model_supervisor_control
    WHERE id = ${SUPERVISOR_CONTROL_ID}`);
  if (!row) return { status: "unknown", reason: "supervisor_control_missing" };
  if (principal !== SUPERVISOR_PRINCIPAL || row.signal_principal !== principal) return { status: "rejected", reason: "supervisor_principal_mismatch" };
  return { status: "verified", reason: row.enabled ? "supervisor_ready" : "supervisor_ready_disabled" };
};
