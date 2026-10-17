import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
import type * as schema from "@/lib/db/schema";
import { iso, readOnly, type ObservationTarget } from "../pipeline-observation-repository";
import type { WriterProcessStopped } from "./call-drain";
import { contentHash, latestEvidence, parseEvidence, promotionPlanHash, promotionPlanSchema, sealSnapshotSchema, type EvidenceKind } from "./promotion";
import { parseDrillArtifact, type DrillArtifact } from "./drill-report";

function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }

/**
 * 승격된(또는 seal된) 복원 DB에서 DR 증거 시각을 읽기 전용으로 모은다. 저장된 계획·근거는 승격 도구와 같은 계약·hash로 다시 검증한다
 * (손상·수동 변경 근거로 수치를 만들지 않는다). 장애 시각은 DB에 없어 운영자 선언값을 그대로 싣는다.
 */
export async function collectDrillReport(database: PostgresJsDatabase<typeof schema>,
  options: { promotionId: string; failureAt: string | null; target: ObservationTarget }): Promise<DrillArtifact> {
  const promotionId = z.uuid().parse(options.promotionId);
  return readOnly(database, options.target, async (query, session) => {
    const [tables] = await query(sql`select coalesce(has_table_privilege(to_regclass('public.dr_promotions'), 'SELECT'), false)
      and coalesce(has_table_privilege(to_regclass('public.dr_promotion_evidence'), 'SELECT'), false) as readable`);
    ensure(tables.readable === true, "dr_drill_schema_unavailable");
    // 첫 잡 성공: jobs.last_success_at은 시간대 없는 UTC 벽시계다. 승격 시각을 같은 벽시계로 바꿔 SQL에서 ms(올림)로 잰다.
    const [row] = await query(sql`select p.promotion_id::text as promotion_id, p.plan, p.plan_hash, p.state, p.seal_snapshot,
        p.from_epoch::float8 as from_epoch, p.to_epoch::float8 as to_epoch, ${iso(sql`p.sealed_at`)} as sealed_at, ${iso(sql`p.promoted_at`)} as promoted_at,
        case when p.promoted_at is null then null else (select ceil(extract(epoch from (min(j.last_success_at) - (p.promoted_at at time zone 'utc'))) * 1000)::float8
          from jobs j where j.last_success_at > (p.promoted_at at time zone 'utc')) end as first_job_ms
      from dr_promotions p where p.promotion_id = ${promotionId}::uuid`);
    ensure(row, "dr_promotion_missing");
    const plan = promotionPlanSchema.parse(row.plan), seal = sealSnapshotSchema.parse(row.seal_snapshot);
    ensure(promotionPlanHash(plan) === row.plan_hash && plan.promotionId === row.promotion_id, "dr_promotion_invalid");
    const rows = await query(sql`select id::float8 as id, kind, subject, payload, payload_hash, operator, ${iso(sql`recorded_at`)} as recorded_at
      from dr_promotion_evidence where promotion_id = ${promotionId}::uuid order by id limit 10001`);
    ensure(rows.length <= 10_000, "dr_drill_row_limit");
    const records = rows.map(evidence => {
      const parsed = parseEvidence(evidence.kind as EvidenceKind, String(evidence.subject), evidence.payload);
      ensure(contentHash(parsed.payload) === evidence.payload_hash, "dr_evidence_hash_mismatch");
      return { id: Number(evidence.id), kind: evidence.kind as EvidenceKind, subject: parsed.subject, payload: parsed.payload, operator: String(evidence.operator) };
    });
    // 승격 판정(G3)과 같은 대상: 계획에 적은 instance와 seal 직전 장부에 보인 모든 owner. 같은 subject는 마지막 기록이 유효하다.
    const latest = latestEvidence(records), required = [...new Set([...plan.oldInstances, ...seal.instances])].sort();
    const stops = required.flatMap(instanceId => {
      const stop = latest.get(`writer_process_stopped\u0000${instanceId}`)?.payload as WriterProcessStopped | undefined;
      return stop ? [{ instanceId, stoppedAt: stop.stoppedAt, skewBoundMs: stop.skewBoundMs, method: stop.method }] : [];
    });
    return parseDrillArtifact({ version: 1, scope: "dr_drill", promotionId, collectedAt: session.collected_at,
      database: { name: session.name, oid: session.oid, inRecovery: session.in_recovery === true, readOnly: true, writeXidAssigned: false },
      promotion: { state: row.state, fromEpoch: Number(row.from_epoch), toEpoch: Number(row.to_epoch), snapshotAt: plan.snapshotAt,
        sealedAt: row.sealed_at, promotedAt: row.promoted_at ?? null },
      failure: options.failureAt === null ? null : { at: options.failureAt, provenance: "operator_declared" },
      writers: { required, stops }, firstJobSuccessAfterPromotionMs: row.first_job_ms === null ? null : Number(row.first_job_ms),
      evidence: rows.map(evidence => ({ kind: evidence.kind, subject: evidence.subject, recordedAt: evidence.recorded_at })) });
  });
}
