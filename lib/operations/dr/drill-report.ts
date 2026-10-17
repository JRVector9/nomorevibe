import { z } from "zod";
import { identity, isoMillis, positiveEpoch } from "./epoch";

/**
 * PR17a DR drill RPO/RTO 기록. 시각은 모두 기존 DR 증거에서 온다 — 근거가 없으면 그 값은 unknown이고 추정하지 않는다.
 * - 마지막 복제 확정 S: seal된 승격 계획의 snapshotAt(운영자 선언, plan hash로 고정).
 * - 장애 F: drill을 주입한 운영자가 선언한 시각(DB 장부에 장애 시각 칸이 없어 provenance를 operator_declared로 남긴다).
 * - 옛 writer 정지 W: writer_process_stopped 근거의 stoppedAt 최댓값(계획·seal 장부의 모든 instance에 근거가 있을 때만).
 * - 승격 완료 P: dr_promotions.promoted_at(DB clock).
 * - 첫 정상 쓰기: P 뒤 잡 성공 중 가장 이른 jobs.last_success_at. 잡마다 마지막 성공만 남아 실제 첫 성공보다 늦거나 같다(상한).
 * RPO = F − S(F가 S보다 이르면 0과 snapshot_after_failure), 옛 writer 쓰기 창 = W − S(기존 G5 정산 창과 같은 정의).
 * RTO = P − F, 첫 정상 쓰기까지 RTO ≤ (P − F) + (첫 잡 성공 − P).
 */
const integer = z.number().int().nonnegative().safe();
export const drillArtifactSchema = z.object({ version: z.literal(1), scope: z.literal("dr_drill"), promotionId: z.uuid(), collectedAt: isoMillis,
  database: z.object({ name: identity(63), oid: z.string().regex(/^[1-9][0-9]{0,9}$/), inRecovery: z.boolean(), readOnly: z.literal(true),
    writeXidAssigned: z.literal(false) }).strict(),
  promotion: z.object({ state: z.enum(["sealed", "promoted"]), fromEpoch: positiveEpoch, toEpoch: positiveEpoch, snapshotAt: isoMillis,
    sealedAt: isoMillis, promotedAt: isoMillis.nullable() }).strict(),
  failure: z.object({ at: isoMillis, provenance: z.literal("operator_declared") }).strict().nullable(),
  writers: z.object({ required: z.array(identity(120)).max(4096), stops: z.array(z.object({ instanceId: identity(120), stoppedAt: isoMillis,
    skewBoundMs: integer, method: identity(40) }).strict()).max(4096) }).strict(),
  /** 승격 완료 뒤 첫 잡 성공까지(ms, SQL ceil). 승격 전이거나 성공이 없으면 null. */
  firstJobSuccessAfterPromotionMs: integer.nullable(),
  evidence: z.array(z.object({ kind: identity(40), subject: identity(200), recordedAt: isoMillis }).strict()).max(10_000),
}).strict();
export type DrillArtifact = z.infer<typeof drillArtifactSchema>;

function ensure(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
export function parseDrillArtifact(value: unknown): DrillArtifact {
  const artifact = drillArtifactSchema.parse(value), { promotion, writers } = artifact;
  ensure(promotion.toEpoch === promotion.fromEpoch + 1 && (promotion.state === "promoted") === (promotion.promotedAt !== null)
    && (promotion.promotedAt !== null || artifact.firstJobSuccessAfterPromotionMs === null)
    && new Set(writers.required).size === writers.required.length
    && new Set(writers.stops.map(row => row.instanceId)).size === writers.stops.length
    && writers.stops.every(row => writers.required.includes(row.instanceId)), "dr_drill_artifact_mismatch");
  return artifact;
}

export function reportDrill(value: unknown) {
  const artifact = parseDrillArtifact(value), { promotion, writers } = artifact;
  const unknown: Record<string, string> = {}, issues: string[] = [];
  const S = Date.parse(promotion.snapshotAt), F = artifact.failure ? Date.parse(artifact.failure.at) : null;
  const P = promotion.promotedAt ? Date.parse(promotion.promotedAt) : null;
  let rpoMs: number | null = null, writeWindowMs: number | null = null, rtoPromotionMs: number | null = null;
  if (F === null) unknown.rpo = "failure_time_undeclared";
  else {
    if (F < S) issues.push("snapshot_after_failure");
    rpoMs = Math.max(0, F - S);
  }
  const stops = writers.stops.filter(row => writers.required.includes(row.instanceId));
  if (!writers.required.length) unknown.writeWindow = "writer_instances_undeclared";
  else if (stops.length !== writers.required.length) unknown.writeWindow = "writer_stop_evidence_missing";
  else {
    const W = Math.max(...stops.map(row => Date.parse(row.stoppedAt)));
    if (W < S) issues.push("writers_stopped_before_snapshot");
    writeWindowMs = Math.max(0, W - S);
  }
  const rtoReason = F === null ? "failure_time_undeclared" : P === null ? "promotion_not_completed" : P < F ? "promotion_before_failure" : null;
  if (rtoReason) { unknown.rtoPromotion = rtoReason; if (rtoReason === "promotion_before_failure") issues.push(rtoReason); }
  else rtoPromotionMs = P! - F!;
  const firstJob = artifact.firstJobSuccessAfterPromotionMs;
  if (rtoReason) unknown.rtoFirstJobSuccess = rtoReason;
  else if (firstJob === null) unknown.rtoFirstJobSuccess = "no_job_success_after_promotion";
  return { scope: "dr_drill" as const, promotionId: artifact.promotionId, state: promotion.state, epochs: { from: promotion.fromEpoch, to: promotion.toEpoch },
    times: { snapshotAt: promotion.snapshotAt, failureAt: artifact.failure?.at ?? null, sealedAt: promotion.sealedAt, promotedAt: promotion.promotedAt,
      lastWriterStopAt: writeWindowMs === null ? null : new Date(S + writeWindowMs).toISOString() },
    rpoMs, writeWindowMs, maxSkewMs: stops.length ? Math.max(...stops.map(row => row.skewBoundMs)) : null,
    rtoPromotionMs, rtoFirstJobSuccessAtMostMs: rtoPromotionMs === null || firstJob === null ? null : rtoPromotionMs + firstJob,
    unknown, issues, failureProvenance: artifact.failure?.provenance ?? null };
}
export type DrillReport = ReturnType<typeof reportDrill>;

const duration = (ms: number | null, reason?: string) => ms === null ? `unknown(${reason ?? "missing"})` : `${(ms / 1000).toFixed(3)}초`;
export function formatDrillReport(report: DrillReport): string {
  return `${[`# DR drill ${report.promotionId} (${report.state}, epoch ${report.epochs.from}→${report.epochs.to})`,
    `- 마지막 복제 확정(snapshotAt): ${report.times.snapshotAt}`,
    `- 장애 시각: ${report.times.failureAt ?? "선언 없음"}${report.failureProvenance ? ` (${report.failureProvenance})` : ""}`,
    `- RPO(장애 − 마지막 복제 확정): ${duration(report.rpoMs, report.unknown.rpo)}`,
    `- 옛 writer 쓰기 창(마지막 정지 − 마지막 복제 확정): ${duration(report.writeWindowMs, report.unknown.writeWindow)}`
      + `${report.maxSkewMs === null ? "" : `, 시계 오차 한도 ${report.maxSkewMs}ms`}`,
    `- RTO(승격 완료 − 장애): ${duration(report.rtoPromotionMs, report.unknown.rtoPromotion)}`,
    `- RTO(첫 잡 성공 − 장애, 상한): ${duration(report.rtoFirstJobSuccessAtMostMs, report.unknown.rtoFirstJobSuccess)}`,
    `- 주의: ${report.issues.length ? report.issues.join(", ") : "없음"}`].join("\n")}\n`;
}
