import { and, eq, sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/lib/db/schema";
import { jobBatchControl, operationsAudit } from "@/lib/db/schema";
import { uptimeSplitControl } from "@/lib/db/product-uptime-schema";
import { RECHECK_AFTER_MINUTES } from "@/lib/domain/products/health-freshness";
import { adminAuditRow } from "./admin-log";
import { lockWriterFence } from "./dr/epoch";
import { planUptimeSplit, uptimeExclusionError, uptimeSplitReadbackSchema, uptimeSplitSnapshotSchema, uptimeSplitStageInput, type UptimeSplitPlan,
  type UptimeSplitReadback, type UptimeSplitResult, type UptimeSplitSnapshot, type UptimeSplitTransition } from "./uptime-split";
import type { ProgressStageInput } from "./worker-progress";

type Database = PostgresJsDatabase<typeof schema>;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
const iso = (value: SQL) => sql`to_char(${value} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const minutesSince = (at: SQL, value: SQL) => sql`extract(epoch FROM (${at} - ${value})) / 60`;

/**
 * split 장부 한 덩어리(jsonb, uptimeSplitReadbackSchema). at 은 같은 문장의 DB 시계(timestamptz)다 — 운영 상태 문장
 * (pipeline-control-status)에도 그대로 끼운다. 잠그지 않는다.
 * due 는 home claim(uptime-claims.ts)과 같은 조건이다: 공개 website 제품, 진행 중이 아님(idle 또는 만료된 claim),
 * 재확인 요청이거나 마지막 확인 뒤 6시간이 지났고 due 가 지났다. 기다린 시각은 둘 중 늦은 것부터 잰다.
 */
export function uptimeSplitReadbackSql(at: SQL): SQL {
  // 바깥 문장의 시계 별칭(c)과 겹치지 않게 claim 행은 uc 로 부른다
  const eligibleSince = sql`CASE WHEN uc.confirm_class IS NOT NULL OR h.checked_at IS NULL THEN uc.due_at
    ELSE greatest(uc.due_at, (h.checked_at AT TIME ZONE 'UTC') + ${RECHECK_AFTER_MINUTES} * interval '1 minute') END`;
  return sql`jsonb_build_object(
    'at', ${iso(at)},
    'control', (SELECT jsonb_build_object('mode', s.mode, 'epoch', s.epoch, 'policy', s.policy, 'policyHash', s.policy_hash)
      FROM uptime_split_control s WHERE s.id = 1),
    'uptimeControl', coalesce((SELECT jsonb_build_object('observationsEnabled', u.observations_enabled, 'gateEnabled', u.gate_enabled)
      FROM uptime_control u WHERE u.id = 1), jsonb_build_object('observationsEnabled', false, 'gateEnabled', false)),
    'queue', (SELECT jsonb_build_object(
        'due', count(*) FILTER (WHERE q.due),
        'dueOldestMinutes', ${minutesSince(at, sql`min(q.since) FILTER (WHERE q.due)`)},
        'claimed', count(*) FILTER (WHERE q.state = 'claimed' AND q.lease_until > ${at}),
        'submitted', count(*) FILTER (WHERE q.state = 'submitted'),
        'submittedOldestMinutes', ${minutesSince(at, sql`min(q.submitted_at)`)},
        -- 재확인 대기도 공개 website 제품만 센다 — 대기 중 비공개가 된 제품은 claim 조건에서 빠져 confirm 칸이 영영 남는다(review F9)
        'confirm', count(*) FILTER (WHERE q.confirm_class IS NOT NULL AND q.listed),
        'confirmOldestMinutes', ${minutesSince(at, sql`min(q.confirm_requested_at) FILTER (WHERE q.confirm_class IS NOT NULL AND q.listed)`)},
        'applied5m', count(*) FILTER (WHERE q.last_applied_at > ${at} - interval '5 minutes' AND q.last_applied_at <= ${at}),
        'missingRows', (SELECT count(*) FROM products p WHERE p.status IN ('verified', 'seeded') AND p.access_mode = 'website'
          AND NOT EXISTS (SELECT 1 FROM uptime_claims m WHERE m.product_id = p.id)))
      FROM (SELECT uc.state, uc.lease_until, uc.submitted_at, uc.confirm_class, uc.confirm_requested_at, uc.last_applied_at,
          ${eligibleSince} AS since, p.status IN ('verified', 'seeded') AND p.access_mode = 'website' AS listed,
          p.status IN ('verified', 'seeded') AND p.access_mode = 'website'
            AND (uc.state = 'idle' OR (uc.state = 'claimed' AND uc.lease_until <= ${at})) AND ${eligibleSince} <= ${at} AS due
        FROM uptime_claims uc JOIN products p ON p.id = uc.product_id LEFT JOIN product_health h ON h.slug = p.slug) q),
    'breakers', coalesce((SELECT jsonb_agg(jsonb_build_object('host', b.host, 'state', b.state, 'reason', b.reason, 'ratio', b.ratio,
        'openedAt', CASE WHEN b.opened_at IS NOT NULL THEN ${iso(sql`b.opened_at`)} END,
        'probeAfter', CASE WHEN b.probe_after IS NOT NULL THEN ${iso(sql`b.probe_after`)} END,
        'probeChecks', b.probe_checks, 'probeFailures', b.probe_failures) ORDER BY b.host) FROM uptime_host_breakers b), '[]'::jsonb),
    'outcomes1h', coalesce((SELECT jsonb_object_agg(o.last_outcome, o.n) FROM (SELECT last_outcome, count(*) AS n FROM uptime_claims
        WHERE last_outcome IS NOT NULL AND updated_at > ${at} - interval '1 hour' GROUP BY last_outcome) o), '{}'::jsonb),
    'applied1h', coalesce((SELECT jsonb_object_agg(a.host, a.n) FROM (SELECT last_applied_host AS host, count(*) AS n FROM uptime_claims
        WHERE last_applied_host IS NOT NULL AND last_applied_at > ${at} - interval '1 hour' GROUP BY last_applied_host) a), '{}'::jsonb),
    -- 지금 home 확인을 맡은 instance(legacy batch 의 maintenance 역할 임대 주인). 오래 열림 경보가 이 instance 의 host 차단기만 본다
    'maintenanceOwner', (SELECT r.owner_instance_id FROM role_leases r WHERE r.role = 'maintenance'))`;
}

/** 장부만 읽는다(한 문장). 배포 관문·운영 상태용 — executor 는 주 DB 또는 읽기 TX 다 */
export async function readUptimeSplitReadback(executor: Pick<Database, "execute">): Promise<UptimeSplitReadback> {
  const [row] = await executor.execute<{ readback: unknown }>(sql`WITH c AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT ${uptimeSplitReadbackSql(sql`c.at`)} AS readback FROM c`);
  return uptimeSplitReadbackSchema.parse(row?.readback);
}

/**
 * 배포 관문·감시(readWorkerProgress)용. 역할 워커가 15초마다 부르므로 legacy 면 한 행만 읽고 null 이다(관문은 지금 그대로).
 * claims 면 장부를 읽어 uptime 단계 입력을 낸다.
 */
export async function readUptimeSplitStage(executor: Pick<Database, "execute">): Promise<ProgressStageInput | null> {
  const [row] = await executor.execute<{ mode: string }>(sql`SELECT mode FROM uptime_split_control WHERE id = 1`);
  return row?.mode === "claims" ? uptimeSplitStageInput(await readUptimeSplitReadback(executor)) : null;
}

async function snapshotIn(tx: Pick<Tx, "execute">): Promise<UptimeSplitSnapshot> {
  const [row] = await tx.execute<{ snapshot: unknown }>(sql`WITH c AS MATERIALIZED (SELECT clock_timestamp() AS at)
    SELECT jsonb_build_object('readback', ${uptimeSplitReadbackSql(sql`c.at`)},
      'fence', (SELECT state FROM dr_writer_fence WHERE id = 1),
      'batchMode', (SELECT mode FROM job_batch_control WHERE id = 1),
      -- role-worker 는 15초마다 candidate:<role>:<SERVICE_INSTANCE_ID> 를 남긴다(uptime-gate 의 실행자 범위와 같은 창)
      'runners', coalesce((SELECT jsonb_agg(DISTINCT split_part(o.key, ':', 3)) FROM operations_observations o
        WHERE o.key LIKE 'candidate:maintenance:%' AND o.observed_at >= localtimestamp - interval '24 hours'), '[]'::jsonb)
    ) AS snapshot FROM c`);
  const snapshot = uptimeSplitSnapshotSchema.parse(row?.snapshot);
  return { ...snapshot, runners: [...snapshot.runners].sort() };
}

/** 읽기 전용 TX. dry-run과 status는 이것만 쓴다(행 잠금·쓰기 0). */
export function readUptimeSplitSnapshot(database: Database): Promise<UptimeSplitSnapshot> {
  return database.transaction(async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    return snapshotIn(tx);
  });
}

class Rejected extends Error { constructor(readonly plan: UptimeSplitPlan, readonly snapshot: UptimeSplitSnapshot) { super("uptime_split_rejected"); } }

/**
 * 기본 dry-run: 읽기 전용 readback과 계획만 낸다. --execute면 한 TX에서 fence(share) → uptime_control(share) → split 행(update) → job_batch_control(share)을 잡고
 * 잠근 상태로 같은 계획을 다시 세워 기대 상태(compare-and-set)를 확인한 뒤 split 행(epoch+1)과 관리자 작업 로그를 함께 commit한다.
 * uptime_control 을 split 보다 먼저 잡는다 — 0104 트리거가 split 을 claims 로 쓸 때 같은 행을 SHARE 로 잡고, PR09 전환(uptime-gate)은
 * uptime_control → split 순서로 잡으므로 순서가 같아 교착하지 않는다. 계획·CAS·트리거 어느 쪽이든 거절되면 TX 전체가 rollback된다.
 */
export async function runUptimeSplitControl(database: Database, command: UptimeSplitTransition, policyFile?: unknown): Promise<UptimeSplitResult> {
  const before = await readUptimeSplitSnapshot(database);
  const plan = planUptimeSplit(command, before, policyFile);
  if (!command.execute || plan.blocked.length) return { command: command.name, dryRun: !command.execute, executed: false, blocked: plan.blocked.length > 0, plan, before };
  let executed: { plan: UptimeSplitPlan; before: UptimeSplitSnapshot; auditId: number };
  try {
    executed = await database.transaction(async tx => {
      await lockWriterFence(tx, "share");
      await tx.execute(sql`SELECT id FROM uptime_control WHERE id = 1 FOR SHARE`);
      await tx.select({ id: uptimeSplitControl.id }).from(uptimeSplitControl).where(eq(uptimeSplitControl.id, 1)).for("update");
      // batch mode 판정(claims 는 legacy 에서만)을 commit 까지 유효하게 — pipeline-control batch 전환은 split(share) → batch(update) 순서로 잡는다
      await tx.select({ id: jobBatchControl.id }).from(jobBatchControl).where(eq(jobBatchControl.id, 1)).for("share");
      const locked = await snapshotIn(tx);
      const checked = planUptimeSplit(command, locked, policyFile);
      if (checked.blocked.length) throw new Rejected(checked, locked);
      const [row] = await tx.update(uptimeSplitControl).set({ mode: checked.next.mode, policy: checked.next.policy, policyHash: checked.next.policyHash,
        epoch: sql`${uptimeSplitControl.epoch} + 1`, updatedAt: sql`clock_timestamp()` })
        .where(and(eq(uptimeSplitControl.id, 1), eq(uptimeSplitControl.epoch, command.expectEpoch))).returning({ epoch: uptimeSplitControl.epoch });
      if (!row) throw new Error("uptime_split_epoch_conflict");
      const after = await snapshotIn(tx);
      const audit = await adminAuditRow(command.operator, { action: `uptime-split-${command.name}`, target: checked.target,
        detail: { reason: command.reason, expected: command.name === "policy" ? { epoch: command.expectEpoch, policyHash: command.expectPolicyHash }
          : { epoch: command.expectEpoch, mode: command.fromMode }, change: checked.change, warnings: checked.warnings,
          before: { mode: locked.readback.control.mode, epoch: locked.readback.control.epoch, policyHash: locked.readback.control.policyHash },
          after: { mode: after.readback.control.mode, epoch: after.readback.control.epoch, policyHash: after.readback.control.policyHash,
            policy: after.readback.control.policy } } });
      // 운영 CLI에는 로그인 방식이 없다 — 스크립트 행 관례(actor_kind 없음)로 남긴다(pipeline-control 과 같다).
      const [inserted] = await tx.insert(operationsAudit).values({ ...audit, actorKind: null }).returning({ id: operationsAudit.id });
      return { plan: checked, before: locked, auditId: inserted.id };
    });
  } catch (error) {
    if (error instanceof Rejected) return { command: command.name, dryRun: false, executed: false, blocked: true, plan: error.plan, before: error.snapshot };
    const code = uptimeExclusionError(error);
    if (code) return { command: command.name, dryRun: false, executed: false, blocked: true, plan: { ...plan, blocked: [code] }, before };
    throw error;
  }
  return { command: command.name, dryRun: false, executed: true, blocked: false, ...executed, after: await readUptimeSplitSnapshot(database) };
}
