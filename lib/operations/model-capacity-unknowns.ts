import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { MODEL_CAPACITY_INDETERMINATE_REASONS, reviewStateSql } from '@/lib/llm/capacity-states';

const label = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:@+/-]+$/);
export const capacityUnknownSchema = z.object({ requestId: z.uuid(), routeId: label, groupId: label,
  oldPolicy: z.boolean(), localEndRecorded: z.boolean() }).strict();
export const capacityUnknownReportSchema = z.object({ status: z.enum(['ok', 'alarm', 'unknown']), truncated: z.boolean(),
  requests: z.array(capacityUnknownSchema).max(64) }).strict().refine(value =>
  value.status === 'alarm' ? value.requests.length > 0 || value.truncated : value.requests.length === 0 && !value.truncated);
export type CapacityUnknownReport = z.infer<typeof capacityUnknownReportSchema>;
export const unknownCapacityReport = (): CapacityUnknownReport => ({ status: 'unknown', truncated: false, requests: [] });

/** Bounded primary SELECT. A pause, policy revision or new successful work cannot hide an unresolved physical call.
 * 2026-10-30: 'alarm' here means "사람 검토 대기" — these rows hold no slot and block nothing (lib/llm/capacity-states.ts). */
export async function readModelCapacityUnknowns(): Promise<CapacityUnknownReport> {
  if (currentReplayDb()) return unknownCapacityReport();
  try {
    return await onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      const rows = await tx.execute<{ request_id: string; route_id: string; group_id: string; old_policy: boolean; local_end_recorded: boolean }>(sql`
        SELECT r.request_id::text, r.route_id, r.group_id,
          (r.epoch <> c.epoch OR r.revision <> c.revision OR r.policy_hash IS DISTINCT FROM c.policy_hash) AS old_policy,
          EXISTS (SELECT 1 FROM model_capacity_events e WHERE e.request_id = r.request_id AND e.kind = 'dispatch_local_ended'
            AND e.evidence->'owner'->>'instanceId' = r.owner_instance_id
            AND e.evidence->'owner'->>'bootId' = r.owner_boot_id::text
            AND e.evidence->>'bindingHash' IS NOT DISTINCT FROM r.dispatch_binding_hash) AS local_end_recorded
        FROM model_capacity_requests r CROSS JOIN model_capacity_control c
        WHERE c.id = 1 AND ${reviewStateSql('r.state')} ORDER BY r.queue_ordinal LIMIT 65`);
      // Missing control must not look like an empty queue.
      const control = await tx.execute(sql`SELECT id FROM model_capacity_control WHERE id = 1`);
      if (control.length !== 1) return unknownCapacityReport();
      const requests = Array.from(rows).slice(0, 64).map(row => capacityUnknownSchema.parse({ requestId: row.request_id,
        routeId: row.route_id, groupId: row.group_id, oldPolicy: row.old_policy, localEndRecorded: row.local_end_recorded }));
      return { status: rows.length ? 'alarm' : 'ok', truncated: rows.length > 64, requests };
    }, { accessMode: 'read only', isolationLevel: 'repeatable read' }));
  } catch { return unknownCapacityReport(); }
}

/** 사람 검토 목록 한 줄 — 경로·모델/장비·작업 키·전송 시각·미확인 사유. 슬롯 점유가 아니다(2026-10-30). */
export const capacityReviewItemSchema = z.object({ requestId: z.uuid(), routeId: label, provider: label, model: z.string().min(1).max(200),
  groupId: label, providerBudgetId: label, workKey: z.string().min(1).max(400), logicalWorkKey: z.string().max(400).nullable(),
  ownerInstanceId: z.string().min(1).max(200), dispatchedAt: z.string().nullable(), markedAt: z.string().nullable(),
  reason: z.enum(MODEL_CAPACITY_INDETERMINATE_REASONS).nullable(), oldPolicy: z.boolean(), localEndRecorded: z.boolean() }).strict();
export type CapacityReviewItem = z.infer<typeof capacityReviewItemSchema>;
export type CapacityReviewQueue = { items: CapacityReviewItem[]; truncated: boolean; error: string | null };

/** 관리자 '확인 못함 — 사람 검토' 목록(최대 100건, 오래된 전송부터). 읽기만 한다. */
export async function readModelCapacityReviewQueue(): Promise<CapacityReviewQueue> {
  if (currentReplayDb()) return { items: [], truncated: false, error: 'replay' };
  try {
    return await onPrimary(() => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      const iso = (value: string) => sql`to_char(${sql.raw(value)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
      const rows = await tx.execute<Record<string, unknown>>(sql`
        SELECT r.request_id::text AS "requestId", r.route_id AS "routeId", r.provider, r.model, r.group_id AS "groupId",
          r.provider_budget_id AS "providerBudgetId", r.work_key AS "workKey", r.logical_work_key AS "logicalWorkKey", r.owner_instance_id AS "ownerInstanceId",
          ${iso('r.dispatched_at')} AS "dispatchedAt",
          (r.epoch <> c.epoch OR r.revision <> c.revision OR r.policy_hash IS DISTINCT FROM c.policy_hash) AS "oldPolicy",
          m.reason, m."markedAt",
          EXISTS (SELECT 1 FROM model_capacity_events e WHERE e.request_id = r.request_id AND e.kind = 'dispatch_local_ended') AS "localEndRecorded"
        FROM model_capacity_requests r CROSS JOIN model_capacity_control c
        LEFT JOIN LATERAL (SELECT e.reason, ${iso('e.created_at')} AS "markedAt" FROM model_capacity_events e
          WHERE e.request_id = r.request_id AND e.kind = 'dispatch_indeterminate' ORDER BY e.id DESC LIMIT 1) m ON true
        WHERE c.id = 1 AND ${reviewStateSql('r.state')} ORDER BY coalesce(r.dispatched_at, r.queued_at), r.queue_ordinal LIMIT 101`);
      const control = await tx.execute(sql`SELECT id FROM model_capacity_control WHERE id = 1`);
      if (control.length !== 1) return { items: [], truncated: false, error: 'control_missing' };
      return { items: Array.from(rows).slice(0, 100).map(row => capacityReviewItemSchema.parse(row)), truncated: rows.length > 100, error: null };
    }, { accessMode: 'read only' }));
  } catch (error) { return { items: [], truncated: false, error: error instanceof Error ? error.message : 'read_failed' }; }
}
