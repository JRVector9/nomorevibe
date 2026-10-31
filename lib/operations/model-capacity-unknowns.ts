import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, onPrimary } from '@/lib/db';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { MODEL_CAPACITY_INDETERMINATE_REASONS, inFlightStateSql, reviewStateSql } from '@/lib/llm/capacity-states';

/**
 * 감시(monitor·Oracle)가 읽는 모델 장부 요약 — 2026-10-31 판(소유자 결정 2026-10-30: 미확인은 일을 멈추지 않고 사람 검토 목록으로만 간다).
 *
 * - `review`  = "확인 못함 · 사람 검토": indeterminate 행이 있다. 슬롯을 점유하지 않고 아무것도 막지 않는다(lib/llm/capacity-states.ts).
 *               overall 경보·Kuma DOWN·Oracle 장애 알림을 만들지 않는다. 목록은 /admin/models 의 사람 검토 목록이다.
 * - `alarm`   = 아직 "일이 멈췄다"는 뜻인 것만: 검토 목록이 문턱을 넘게 쌓였거나(review_backlog·review_stale),
 *               점유 행(dispatched)이 기한을 한참 넘겨 슬롯을 잡고 있다(dispatch_stuck — 워커가 죽어 표식 없이 남은 전송 등).
 * - `unknown` = 장부를 읽지 못했다(빈 목록으로 보지 않는다).
 *
 * 전송 형식(heartbeat → SSH gateway → Oracle): status·truncated·requests(최대 64건)는 예전 그대로이고, 요약(count·oldestAgeSeconds·
 * stuckDispatched·alarmReasons)은 unknown 이 아닐 때 항상 붙는다. 예전(요약 없는) 'alarm' 은 "검토 대기"였다 — Oracle·gateway 는 요약 없는 alarm 을 review 로 읽는다.
 */
export const CAPACITY_ALARM_REASONS = Object.freeze(['dispatch_stuck', 'review_backlog', 'review_stale'] as const);
export type CapacityAlarmReason = (typeof CAPACITY_ALARM_REASONS)[number];

/** 경보 문턱 기본값. 검토 목록 > 50행, 가장 오래된 검토 행 > 24시간, 보낸 호출(dispatched) > 30분(가장 긴 기본 호출 상한 300초의 6배). */
export const CAPACITY_MONITOR_DEFAULTS = Object.freeze({ reviewMaxRows: 50, reviewMaxAgeSeconds: 86_400, dispatchStuckSeconds: 1_800 });
export type CapacityMonitorThresholds = { reviewMaxRows: number; reviewMaxAgeSeconds: number; dispatchStuckSeconds: number };
const THRESHOLD_ENV = {
  reviewMaxRows: ['MONITOR_CAPACITY_REVIEW_MAX_ROWS', 1_000_000],
  reviewMaxAgeSeconds: ['MONITOR_CAPACITY_REVIEW_MAX_AGE_SECONDS', 31_536_000],
  dispatchStuckSeconds: ['MONITOR_CAPACITY_DISPATCH_STUCK_SECONDS', 86_400],
} as const satisfies Record<keyof CapacityMonitorThresholds, readonly [string, number]>;

/** monitor env 의 문턱(양의 정수). 비었거나 틀린 값은 기본값을 쓴다 — 감시가 설정 실수로 꺼지지 않는다. */
export function capacityMonitorThresholds(env: Readonly<Record<string, string | undefined>> = process.env): CapacityMonitorThresholds {
  const read = (key: keyof CapacityMonitorThresholds) => {
    const [name, max] = THRESHOLD_ENV[key], raw = env[name]?.trim() ?? '';
    const value = /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : NaN;
    return Number.isSafeInteger(value) && value <= max ? value : CAPACITY_MONITOR_DEFAULTS[key];
  };
  return { reviewMaxRows: read('reviewMaxRows'), reviewMaxAgeSeconds: read('reviewMaxAgeSeconds'), dispatchStuckSeconds: read('dispatchStuckSeconds') };
}

const label = z.string().min(1).max(120).regex(/^[A-Za-z0-9_.:@+/-]+$/);
const total = z.number().int().min(0).max(1_000_000_000);
export const capacityUnknownSchema = z.object({ requestId: z.uuid(), routeId: label, groupId: label,
  oldPolicy: z.boolean(), localEndRecorded: z.boolean() }).strict();
const unreadReportSchema = z.object({ status: z.literal('unknown'), truncated: z.literal(false), requests: z.array(capacityUnknownSchema).max(0) }).strict();
const observedReportSchema = z.object({ status: z.enum(['ok', 'review', 'alarm']), truncated: z.boolean(), requests: z.array(capacityUnknownSchema).max(64),
  count: total, oldestAgeSeconds: total.nullable(), stuckDispatched: total, alarmReasons: z.array(z.enum(CAPACITY_ALARM_REASONS)).max(3) }).strict()
  .refine(value => value.requests.length === Math.min(value.count, 64) && value.truncated === value.count > 64
    && (value.count === 0) === (value.oldestAgeSeconds === null)
    && value.alarmReasons.every((reason, index) => index === 0 || value.alarmReasons[index - 1] < reason)
    && value.alarmReasons.includes('dispatch_stuck') === value.stuckDispatched > 0
    && (!value.alarmReasons.some(reason => reason !== 'dispatch_stuck') || value.count > 0)
    && value.status === (value.alarmReasons.length ? 'alarm' : value.count ? 'review' : 'ok'));
export const capacityUnknownReportSchema = z.union([unreadReportSchema, observedReportSchema]);
export type CapacityUnknown = z.infer<typeof capacityUnknownSchema>;
export type CapacityUnknownReport = z.infer<typeof capacityUnknownReportSchema>;
export const unknownCapacityReport = (): CapacityUnknownReport => ({ status: 'unknown', truncated: false, requests: [] });

/** 장부 관측 → 감시 요약(순수). count·oldestAgeSeconds 는 검토 행 전체, requests 는 오래된 순 최대 64건이다. */
export function summarizeCapacityReview(observed: { requests: readonly CapacityUnknown[]; count: number; oldestAgeSeconds: number | null;
  stuckDispatched: number }, thresholds: CapacityMonitorThresholds = CAPACITY_MONITOR_DEFAULTS): CapacityUnknownReport {
  const { count, stuckDispatched } = observed, oldestAgeSeconds = count ? observed.oldestAgeSeconds ?? 0 : null;
  const alarmReasons = CAPACITY_ALARM_REASONS.filter(reason => reason === 'dispatch_stuck' ? stuckDispatched > 0
    : reason === 'review_backlog' ? count > thresholds.reviewMaxRows : oldestAgeSeconds !== null && oldestAgeSeconds > thresholds.reviewMaxAgeSeconds);
  return capacityUnknownReportSchema.parse({ status: alarmReasons.length ? 'alarm' : count ? 'review' : 'ok', truncated: count > 64,
    requests: observed.requests.slice(0, 64), count, oldestAgeSeconds, stuckDispatched, alarmReasons });
}

/** Bounded primary SELECT (한 repeatable-read 스냅숏). 멈춤·정책 개정·새 성공 작업이 검토 행을 숨기지 않는다. 쓰지 않는다. */
export async function readModelCapacityUnknowns(thresholds: CapacityMonitorThresholds = capacityMonitorThresholds()): Promise<CapacityUnknownReport> {
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
        WHERE c.id = 1 AND ${reviewStateSql('r.state')} ORDER BY coalesce(r.dispatched_at, r.queued_at), r.queue_ordinal LIMIT 65`);
      // 검토 행 전체 수·가장 오래된 나이, 그리고 기한을 한참 넘긴 보낸 호출(점유 행). 나이는 관리자 목록과 같은 기준(전송 시각, 없으면 접수 시각).
      const [summary] = await tx.execute<{ review_count: number; oldest_age_seconds: number | null; stuck_dispatched: number }>(sql`
        SELECT count(*) FILTER (WHERE ${reviewStateSql('r.state')})::int AS review_count,
          greatest(0, floor(extract(epoch FROM clock_timestamp() - min(coalesce(r.dispatched_at, r.queued_at)) FILTER (WHERE ${reviewStateSql('r.state')}))))::int
            AS oldest_age_seconds,
          count(*) FILTER (WHERE ${inFlightStateSql('r.state')}
            AND coalesce(r.dispatched_at, r.updated_at) < clock_timestamp() - make_interval(secs => ${thresholds.dispatchStuckSeconds}))::int AS stuck_dispatched
        FROM model_capacity_requests r WHERE ${reviewStateSql('r.state')} OR ${inFlightStateSql('r.state')}`);
      // Missing control must not look like an empty queue.
      const control = await tx.execute(sql`SELECT id FROM model_capacity_control WHERE id = 1`);
      if (control.length !== 1 || !summary) return unknownCapacityReport();
      const requests = Array.from(rows).slice(0, 64).map(row => capacityUnknownSchema.parse({ requestId: row.request_id,
        routeId: row.route_id, groupId: row.group_id, oldPolicy: row.old_policy, localEndRecorded: row.local_end_recorded }));
      return summarizeCapacityReview({ requests, count: Number(summary.review_count), stuckDispatched: Number(summary.stuck_dispatched),
        oldestAgeSeconds: summary.oldest_age_seconds === null ? null : Number(summary.oldest_age_seconds) }, thresholds);
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
