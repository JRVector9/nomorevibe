import { sql } from "drizzle-orm";
import { z } from "zod";
import { operationsAudit } from "@/lib/db/schema";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { markOwnerGoneDispatchIndeterminate, type OwnerGoneCandidate } from "@/lib/llm/capacity-repository";
import { adminAuditRow } from "../admin-log";
import { identity, writerSiteActive } from "./epoch";
import { judgeOwnerGone, OWNER_GONE_MAX_REQUESTS, OWNER_GONE_QUIET_MS, ownerGoneEvidenceSchema, type OwnerFact, type OwnerFactSource,
  type OwnerGoneEvidence, type OwnerGoneVerdict } from "./owner-gone-contract";
import { drTransactionMaybeDry } from "./repository";

/** 판정 규칙·근거 모양은 ./owner-gone-contract.ts(DB 를 열지 않는 순수 모듈). 이 파일은 같은 TX 에서 기록을 읽고 전환·감사 기록을 쓴다. */

const FACT_LIMIT = 2000;
const ISO_FMT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
/** timestamptz 열. */
const tz = (column: string) => sql.raw(`to_char((${column}) AT TIME ZONE 'UTC', ${ISO_FMT})`);
/** JS Date(UTC)로 쓴 timestamp(없는 tz) 열 — operations_observations.observed_at. */
const utc = (column: string) => sql.raw(`to_char(${column}, ${ISO_FMT})`);
/** now() 로 쓴 timestamp(없는 tz) 열 — role_leases. 코드(renewRole 등)와 같이 세션 시간대로 읽는다. */
const local = (column: string) => sql.raw(`to_char((${column})::timestamptz AT TIME ZONE 'UTC', ${ISO_FMT})`);

/**
 * 한 instance 의 모든 boot 생존 기록(읽기만). 요청 행 lock 뒤 같은 TX 에서 읽는다. 장부 활동은 이 요청의 queue_ordinal 이후 행만 본다(색인 범위).
 * http_origin_hops 는 instance 색인이 없어 읽지 않는다(그만큼 덜 보수적이다) — 다른 생존 기록과 quiet 창이 그 몫을 진다.
 */
export async function readOwnerFacts(tx: Pick<ProductTransaction, "execute">, instanceId: string, fromQueueOrdinal: number):
  Promise<{ facts: OwnerFact[]; truncated: boolean }> {
  const rows = await tx.execute<{ boot_id: string; source: OwnerFactSource; at: string; live: boolean; detail: Record<string, unknown> | null }>(sql`
    SELECT boot_id, source, at, live, detail FROM (
      SELECT owner_boot_id::text AS boot_id, 'process_group_opened' AS source, ${tz("recorded_at")} AS at, false AS live, detail
        FROM dr_process_group_events WHERE owner_instance_id = ${instanceId} AND kind = 'owner_opened'
      UNION ALL
      SELECT owner_boot_id::text, 'process_group_event', ${tz("max(recorded_at)")}, false,
          jsonb_build_object('unexitedSpawns', greatest(0, count(*) FILTER (WHERE kind = 'spawned') - count(*) FILTER (WHERE kind = 'group_exited')))
        FROM dr_process_group_events WHERE owner_instance_id = ${instanceId} GROUP BY owner_boot_id
      UNION ALL
      SELECT owner_boot_id::text, 'ledger_activity', ${tz("max(greatest(queued_at, coalesce(dispatched_at, queued_at)))")}, false, NULL::jsonb
        FROM model_capacity_requests WHERE owner_instance_id = ${instanceId} AND queue_ordinal >= ${fromQueueOrdinal} GROUP BY owner_boot_id
      UNION ALL
      SELECT owner_boot_id, 'role_lease', ${local("updated_at")}, lease_until > clock_timestamp(), jsonb_build_object('role', role)
        FROM role_leases WHERE owner_instance_id = ${instanceId} AND owner_boot_id IS NOT NULL
      UNION ALL
      SELECT r.owner_boot_id, 'role_lease_acquired', ${tz("to_timestamp((b.value->>'at')::numeric / 1000)")}, false, jsonb_build_object('role', r.role)
        FROM role_leases r CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(r.primary_boots) = 'array' THEN r.primary_boots ELSE '[]'::jsonb END) b
        WHERE r.owner_instance_id = ${instanceId} AND b.value->>'id' = r.owner_boot_id AND jsonb_typeof(b.value->'at') = 'number'
      UNION ALL
      SELECT owner_boot_id::text, 'item_lease', ${tz("max(updated_at)")}, true, NULL::jsonb
        FROM pipeline_item_leases WHERE owner_instance_id = ${instanceId} AND token IS NOT NULL AND lease_until > clock_timestamp() GROUP BY owner_boot_id
      UNION ALL
      SELECT boot_id, 'batch_candidate', ${tz("observed_at")}, false, jsonb_build_object('role', role) FROM job_batch_candidates WHERE instance_id = ${instanceId}
      UNION ALL
      SELECT value->>'bootId', 'candidate_observation', ${utc("observed_at")}, false, jsonb_build_object('key', key)
        FROM operations_observations WHERE key LIKE 'candidate:%' AND value->>'instanceId' = ${instanceId}
      UNION ALL
      SELECT value->>'bootId', 'worker_exit', ${utc("observed_at")}, false, jsonb_build_object('key', key)
        FROM operations_observations WHERE key LIKE 'worker-exit:%' AND value->>'instanceId' = ${instanceId}
    ) f WHERE boot_id IS NOT NULL AND at IS NOT NULL ORDER BY boot_id, source, at LIMIT ${FACT_LIMIT + 1}`);
  const facts = Array.from(rows).slice(0, FACT_LIMIT).map(row => Object.freeze({ bootId: String(row.boot_id), source: row.source, at: String(row.at),
    live: row.live === true, detail: row.detail ?? null }));
  return { facts, truncated: rows.length > FACT_LIMIT };
}

export type OwnerGoneRow = Readonly<{ requestId: string; status: "marked" | "refused" | "not_dispatched"; reason: string | null; state: string | null;
  evidence: OwnerGoneEvidence | null; verdict: OwnerGoneVerdict | null }>;

/** 장부 요청 하나를 짧은 TX 하나로 판정·전환한다(dry-run 이면 같은 TX 를 실행한 뒤 ROLLBACK). */
async function markOne(requestId: string, value: { operator: string; quietMs: number }, apply: boolean): Promise<OwnerGoneRow> {
  return drTransactionMaybeDry(apply, async tx => {
    // 워커 정산·입장과 겨루지 않게 짧게 기다리고 포기한다(전역 회수의 긴 control 잠금 교훈, 2026-11-02).
    await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    await tx.execute(sql`SET LOCAL transaction_timeout = '15s'`);
    if (!await writerSiteActive(tx)) throw new Error("dr_writer_site_fenced");
    let verdict: OwnerGoneVerdict | null = null;
    const result = await markOwnerGoneDispatchIndeterminate(tx, requestId, async (candidate: OwnerGoneCandidate) => {
      const { facts, truncated } = await readOwnerFacts(tx, candidate.owner.instanceId, candidate.queueOrdinal);
      verdict = judgeOwnerGone({ state: candidate.state, dispatchAt: candidate.dispatchAt, owner: candidate.owner, now: candidate.now,
        quietMs: value.quietMs, facts, truncated });
      if (verdict.status !== "gone") return { blocked: verdict.status === "refused" ? verdict.reason : `not_dispatched:${verdict.state}` };
      const successor = verdict.successor;
      return ownerGoneEvidenceSchema.parse({ version: 1, kind: "owner_gone", requestId: candidate.requestId, owner: candidate.owner, fromState: "dispatched",
        dispatchAt: candidate.dispatchAt, evaluatedAt: candidate.now, quietMs: value.quietMs, basis: verdict.basis, ownerLastSeen: verdict.ownerLastSeen,
        ownerExitRecordedAt: verdict.owner.exitRecordedAt, ownerKernelBootId: verdict.owner.kernelBootId, unexitedSpawns: verdict.owner.unexitedSpawns,
        successor: successor && successor.firstStart && successor.lastSeen ? { bootId: successor.bootId, firstStart: successor.firstStart,
          lastSeen: successor.lastSeen, kernelBootId: successor.kernelBootId, roleLease: successor.roleLease } : null,
        operator: value.operator });
    });
    if (result.kind === "not_dispatched") return { requestId, status: "not_dispatched", reason: "not_dispatched", state: result.state, evidence: null, verdict };
    if (result.kind === "blocked") return { requestId, status: "refused", reason: result.reason, state: "dispatched", evidence: null, verdict };
    // 감사 기록은 같은 TX 다(dry-run 이면 함께 ROLLBACK). operations_audit 는 덧붙이기만 된다.
    await tx.insert(operationsAudit).values(await adminAuditRow(value.operator, { action: "model-capacity-owner-gone", target: requestId,
      detail: { fromState: "dispatched", toState: "indeterminate", reason: "process_exit", evidence: result.evidence } }));
    return { requestId, status: "marked", reason: null, state: "indeterminate", evidence: result.evidence, verdict };
  });
}

/**
 * 운영자가 명시한 요청 id 들만(전체 일괄 없음, 최대 20건) 한 건씩 판정·전환한다. 근거가 없는 행은 그대로 두고 이유를 돌려준다.
 * dry-run(apply=false)은 같은 TX 를 실행한 뒤 ROLLBACK 한다 — 장부·event·감사 기록이 남지 않는다.
 */
export async function markOwnerGoneIndeterminate(value: { requestIds: readonly string[]; operator: string; quietMs?: number }, apply: boolean):
  Promise<{ rows: OwnerGoneRow[] }> {
  const operator = identity(120).parse(value.operator);
  const requestIds = z.array(z.uuid()).min(1).max(OWNER_GONE_MAX_REQUESTS).parse(value.requestIds);
  if (new Set(requestIds).size !== requestIds.length) throw new Error("owner_gone_duplicate_request");
  const quietMs = z.number().int().min(OWNER_GONE_QUIET_MS.min).max(OWNER_GONE_QUIET_MS.max).parse(value.quietMs ?? OWNER_GONE_QUIET_MS.default);
  const rows: OwnerGoneRow[] = [];
  for (const requestId of requestIds) rows.push(await markOne(requestId, { operator, quietMs }, apply));
  return { rows };
}

export type OwnerGoneReviewRow = Readonly<{ requestId: string; result: "reviewed" | "would_review" | "not_indeterminate"; state: string | null;
  reviewedAt: string | null }>;

/**
 * mark 뒤 사람 검토로 닫기 — 관리자 화면 '검토 완료'(app/(operator)/admin/models/unknown-review-actions.ts)와 같은 함수(closeModelCapacityUnknownReview)와
 * 같은 감사 기록(model-capacity-unknown-reviewed)을 쓴다. 이 함수는 자기 TX 를 열므로 dry-run 은 상태만 읽는다(무엇이 닫힐지).
 */
export async function closeOwnerGoneReviews(value: { requestIds: readonly string[]; operator: string; note: string }, apply: boolean):
  Promise<{ rows: OwnerGoneReviewRow[] }> {
  const operator = identity(120).parse(value.operator), note = z.string().trim().min(1).max(400).parse(value.note);
  const requestIds = z.array(z.uuid()).min(1).max(OWNER_GONE_MAX_REQUESTS).parse(value.requestIds);
  const rows: OwnerGoneReviewRow[] = [];
  if (!apply) {
    const states = await drTransactionMaybeDry(false, tx => tx.execute<{ request_id: string; state: string }>(sql`SELECT request_id::text, state
      FROM model_capacity_requests WHERE request_id IN (${sql.join(requestIds.map(id => sql`${id}::uuid`), sql`, `)})`));
    const byId = new Map(Array.from(states).map(row => [row.request_id, row.state]));
    for (const requestId of requestIds) {
      const state = byId.get(requestId) ?? null;
      rows.push({ requestId, result: state === "indeterminate" ? "would_review" : "not_indeterminate", state, reviewedAt: null });
    }
    return { rows };
  }
  const [{ closeModelCapacityUnknownReview }, { db }] = await Promise.all([import("@/lib/llm/capacity-repository"), import("@/lib/db")]);
  for (const requestId of requestIds) {
    const result = await closeModelCapacityUnknownReview({ requestId, operator, note });
    await db.insert(operationsAudit).values(await adminAuditRow(operator, { action: "model-capacity-unknown-reviewed", target: requestId,
      detail: { note, result: result.kind, via: "scripts/ops/model-owner-gone.ts", ...(result.kind === "reviewed" ? { reviewedAt: result.evidence.reviewedAt } : { state: result.state }) },
      ok: result.kind === "reviewed", error: result.kind === "reviewed" ? null : `request_${result.state ?? "missing"}` }));
    rows.push(result.kind === "reviewed" ? { requestId, result: "reviewed", state: "withdrawn", reviewedAt: result.evidence.reviewedAt }
      : { requestId, result: "not_indeterminate", state: result.state, reviewedAt: null });
  }
  return { rows };
}
