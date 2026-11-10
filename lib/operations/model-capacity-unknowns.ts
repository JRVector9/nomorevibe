import { eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, onPrimary } from '@/lib/db';
import { withDbDeadline } from '@/lib/db/pool';
import { currentReplayDb } from '@/lib/db/replay-scope';
import { crawlCandidates, products } from '@/lib/db/schema';
import { MODEL_CAPACITY_INDETERMINATE_REASONS, inFlightStateSql, reviewStateSql } from '@/lib/llm/capacity-states';

/**
 * 감시(monitor·Oracle)가 읽는 모델 장부 요약 — 2026-10-31 판(소유자 결정 2026-10-30: 미확인은 일을 멈추지 않고 사람 검토 목록으로만 간다).
 *
 * - `review`  = "확인 못함 · 사람 검토": indeterminate 행이 있다. 슬롯을 점유하지 않고 아무것도 막지 않는다(lib/llm/capacity-states.ts).
 *               overall 경보·Kuma DOWN·Oracle 장애 알림을 만들지 않는다. 목록은 /admin/models 의 사람 검토 목록이다.
 * - `alarm`   = 아직 "일이 멈췄다"는 뜻인 것만: 검토 목록이 문턱을 넘게 쌓였거나(review_backlog·review_stale),
 *               점유 행(dispatched)이 기한을 한참 넘겨 슬롯을 잡고 있다(dispatch_stuck — 워커가 죽어 표식 없이 남은 전송 등).
 * - `unknown` = 장부를 읽지 못했다(빈 목록으로 보지 않는다).
 * - 2026-11-10 소유자 결정: `alarm` 사유가 검토 목록 문턱(review_*)뿐이고 기한 넘긴 점유 행이 없으면(stuckDispatched 0)
 *   장애가 아니라 사람 검토 알림이다(capacityReviewOnlyAlarm). 보고는 그대로 `alarm`·alarmReasons 이고, monitor overall·Kuma 만 UP 이다.
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

/**
 * 2026-11-10 소유자 결정: 장부 경보 사유가 검토 목록 문턱(review_backlog·review_stale 등 review_*)뿐이고 기한 넘긴 점유 행이 없으면
 * (stuckDispatched 0) 검토 행은 아무것도 막지 않으므로 장애가 아니다 — monitor overall 에 넣지 않고 Kuma 는 UP(메시지에 건수·나이)이다.
 * 문턱은 바꾸지 않는다. 같은 규칙: scripts/ops/recovery_gateway.py capacity_review_only(M3/mini gateway·Oracle watchdog).
 */
export function capacityReviewOnlyAlarm(report: CapacityUnknownReport | undefined): boolean {
  return report?.status === 'alarm' && report.stuckDispatched === 0 && report.alarmReasons.length > 0
    && report.alarmReasons.every(reason => reason.startsWith('review_'));
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
export type CapacityReviewGroup = { routeId: string; count: number };
export type CapacityReviewQueue = { items: CapacityReviewItem[]; truncated: boolean; error: string | null; groups: CapacityReviewGroup[] };

/** 관리자 '확인 못함 — 사람 검토' 목록(최대 100건, 오래된 전송부터). 읽기만 한다. */
export async function readModelCapacityReviewQueue(): Promise<CapacityReviewQueue> {
  if (currentReplayDb()) return { items: [], truncated: false, error: 'replay', groups: [] };
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
      if (control.length !== 1) return { items: [], truncated: false, error: 'control_missing', groups: [] };
      const groups = await tx.execute<{ route_id: string; n: number }>(sql`
        SELECT r.route_id, count(*)::int AS n FROM model_capacity_requests r
        WHERE ${reviewStateSql('r.state')} GROUP BY r.route_id ORDER BY n DESC, r.route_id`);
      return { items: Array.from(rows).slice(0, 100).map(row => capacityReviewItemSchema.parse(row)), truncated: rows.length > 100, error: null,
        groups: Array.from(groups).map(row => ({ routeId: row.route_id, count: Number(row.n) })) };
    }, { accessMode: 'read only' }));
  } catch (error) { return { items: [], truncated: false, error: error instanceof Error ? error.message : 'read_failed', groups: [] }; }
}

/**
 * 사람 검토 상세 — 실제 등록/후보 프로젝트·사유·모델/장비·대기/전송/표식/로컬 종료 DB 시각.
 * 기존 검토 행은 슬롯 점유가 아니며, 이 읽기는 닫기·종료·승인을 하지 않는다.
 */
export type CapacityReviewProject = { kind: 'candidate' | 'product'; id: number; label: string; href: string | null };
export type CapacityReviewDetailsItem = CapacityReviewItem & { queuedAt: string | null; localEndedAt: string | null;
  projects: CapacityReviewProject[]; projectsTruncated: boolean };
export type CapacityReviewDetailsQueue = { items: CapacityReviewDetailsItem[]; truncated: boolean; error: string | null;
  observedAt: string | null };

const CAPACITY_DETAIL_ITEM_LIMIT = 100;
const CAPACITY_DETAIL_PROJECT_LIMIT = 32;
type CapacityReviewProjectRef = { kind: 'candidate'; id: number } | { kind: 'product'; id: number }
  | { kind: 'product'; slug: string };
type CapacityReviewDetailsRow = {
  requestId: string; routeId: string; provider: string; model: string; groupId: string; providerBudgetId: string;
  workKey: string; logicalWorkKey: string | null; ownerInstanceId: string; dispatchedAt: string | null; queuedAt: string | null;
  markedAt: string | null; reason: string | null; oldPolicy: boolean; localEndRecorded: boolean; localEndedAt: string | null;
  privateBinding: unknown;
};

const capacityReviewObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const capacityReviewId = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : null;

function capacityReviewProjectRefs(binding: unknown): { refs: CapacityReviewProjectRef[]; truncated: boolean } {
  const refs: CapacityReviewProjectRef[] = [], seen = new Set<string>();
  let truncated = false;
  const add = (ref: CapacityReviewProjectRef) => {
    const key = ref.kind === 'candidate' ? `candidate:${ref.id}` : 'slug' in ref ? `product-slug:${ref.slug}` : `product:${ref.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (refs.length >= CAPACITY_DETAIL_PROJECT_LIMIT) { truncated = true; return; }
    refs.push(ref);
  };
  const addId = (kind: 'candidate' | 'product', value: unknown) => {
    const id = capacityReviewId(value);
    if (id !== null) {
      if (kind === 'candidate') add({ kind: 'candidate', id });
      else add({ kind: 'product', id });
    }
  };
  if (!capacityReviewObject(binding) || binding.version !== 1) return { refs, truncated };
  const kind = binding.kind;
  if (typeof kind !== 'string') return { refs, truncated };
  const addMembers = (target: 'candidate' | 'product') => {
    if (!Array.isArray(binding.members)) return;
    for (const member of binding.members) {
      if (capacityReviewObject(member)) addId(target, target === 'candidate' ? member.candidateId : member.productId);
    }
  };
  switch (kind) {
    case 'ai1_legacy_gateway':
    case 'ai1_legacy_cli':
      addId('candidate', binding.candidateId);
      break;
    case 'ai1_item_gateway':
    case 'ai1_item_cli':
    case 'ai2_item_gateway':
    case 'ai2_item_cli':
      if (capacityReviewObject(binding.review)) addId('candidate', binding.review.candidateId);
      break;
    case 'crawl_tagline_gateway':
      if (capacityReviewObject(binding.member)) addId('candidate', binding.member.candidateId);
      break;
    case 'publication_classify_gateway':
    case 'publication_classify_cli':
      addMembers('candidate');
      break;
    case 'text_profile_gateway':
    case 'product_audit_cli':
      addId('product', binding.productId);
      break;
    case 'search_verify_gateway':
      if (capacityReviewObject(binding.member)) addId('product', binding.member.productId);
      break;
    case 'product_translation_gateway':
    case 'product_tagline_ko_gateway':
    case 'intro_check_cli':
      addMembers('product');
      break;
    case 'local_model_direct': {
      if (!capacityReviewObject(binding.target)) break;
      const targetKind = binding.target.kind;
      if (targetKind === 'candidate' || targetKind === 'split') addId('candidate', binding.target.candidateId);
      else if (targetKind === 'audit' || targetKind === 'published') {
        const slug = binding.target.slug;
        if (typeof slug === 'string' && slug.length > 0 && slug.length <= 80) add({ kind: 'product', slug });
      }
      break;
    }
    default:
      break;
  }
  return { refs, truncated };
}

function capacityReviewProjects(refs: readonly CapacityReviewProjectRef[], candidates: ReadonlyMap<number, { repo: string; productName: string | null }>,
  productsById: ReadonlyMap<number, { id: number; slug: string; name: string }>,
  productsBySlug: ReadonlyMap<string, { id: number; slug: string; name: string }>, initiallyTruncated: boolean): {
    projects: CapacityReviewProject[]; projectsTruncated: boolean } {
  const projects: CapacityReviewProject[] = [], seen = new Set<string>();
  let projectsTruncated = initiallyTruncated;
  const add = (project: CapacityReviewProject) => {
    const key = `${project.kind}:${project.id}`;
    if (seen.has(key)) return;
    if (projects.length >= CAPACITY_DETAIL_PROJECT_LIMIT) { projectsTruncated = true; return; }
    seen.add(key);
    projects.push(project);
  };
  for (const ref of refs) {
    if (ref.kind === 'candidate') {
      const candidate = candidates.get(ref.id);
      add(candidate ? { kind: 'candidate', id: ref.id, label: candidate.productName ?? candidate.repo,
        href: `/admin/review?tab=all&focus=${ref.id}` } : { kind: 'candidate', id: ref.id, label: `candidate #${ref.id}`, href: null });
      continue;
    }
    if ('slug' in ref) {
      const product = productsBySlug.get(ref.slug);
      if (product) add({ kind: 'product', id: product.id, label: product.name,
        href: `/admin/products/${encodeURIComponent(product.slug)}` });
      continue;
    }
    const product = productsById.get(ref.id);
    add(product ? { kind: 'product', id: product.id, label: product.name,
      href: `/admin/products/${encodeURIComponent(product.slug)}` }
      : { kind: 'product', id: ref.id, label: `product #${ref.id}`, href: null });
  }
  return { projects, projectsTruncated };
}

/** 상세 검토 목록 — 같은 기본 키읽기 트랜잭션에서 101행만 잘라 본 뒤, 안전한 프로젝트 표시 정보만 배치로 붙인다. */
export async function readModelCapacityReviewDetailsQueue(scope: { routeId?: string; model?: string } = {}): Promise<CapacityReviewDetailsQueue> {
  const empty = (error: string): CapacityReviewDetailsQueue => ({ items: [], truncated: false, error, observedAt: null });
  if (currentReplayDb()) return empty('replay');
  try {
    return await onPrimary(() => withDbDeadline(Date.now() + 4_000, () => db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      const [meta] = await tx.execute<{ controlPresent: boolean; observedAt: string }>(sql`
        SELECT EXISTS (SELECT 1 FROM model_capacity_control WHERE id = 1) AS "controlPresent",
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"`);
      if (!meta?.controlPresent) return empty('control_missing');
      const rows = Array.from(await tx.execute<CapacityReviewDetailsRow>(sql`
        WITH review AS MATERIALIZED (
          SELECT r.request_id, r.route_id, r.provider, r.model, r.group_id, r.provider_budget_id, r.work_key,
            r.logical_work_key, r.owner_instance_id, r.owner_boot_id, r.dispatched_at, r.queued_at, r.queue_ordinal,
            r.dispatch_binding_hash, r.dispatch_binding,
            (r.epoch <> c.epoch OR r.revision <> c.revision OR r.policy_hash IS DISTINCT FROM c.policy_hash) AS "oldPolicy"
          FROM model_capacity_requests r CROSS JOIN model_capacity_control c
          WHERE c.id = 1 AND ${reviewStateSql('r.state')}
            ${scope.routeId === undefined ? sql`` : sql`AND r.route_id = ${scope.routeId}`}
            ${scope.model === undefined ? sql`` : sql`AND r.model = ${scope.model}`}
          ORDER BY coalesce(r.dispatched_at, r.queued_at), r.queue_ordinal
          LIMIT 101
        )
        SELECT r.request_id::text AS "requestId", r.route_id AS "routeId", r.provider, r.model,
          r.group_id AS "groupId", r.provider_budget_id AS "providerBudgetId", r.work_key AS "workKey",
          r.logical_work_key AS "logicalWorkKey", r.owner_instance_id AS "ownerInstanceId",
          to_char(r.dispatched_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dispatchedAt",
          to_char(r.queued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "queuedAt",
          r."oldPolicy", m.reason, m."markedAt", e."localEndedAt", (e.request_id IS NOT NULL) AS "localEndRecorded",
          r.dispatch_binding AS "privateBinding"
        FROM review r
        LEFT JOIN LATERAL (
          SELECT e.reason, to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "markedAt"
          FROM model_capacity_events e
          WHERE e.request_id = r.request_id AND e.kind = 'dispatch_indeterminate'
          ORDER BY e.id DESC LIMIT 1
        ) m ON true
        LEFT JOIN LATERAL (
          SELECT e.request_id, to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "localEndedAt"
          FROM model_capacity_events e
          WHERE e.request_id = r.request_id AND e.kind = 'dispatch_local_ended'
            AND e.evidence->'owner'->>'instanceId' = r.owner_instance_id
            AND e.evidence->'owner'->>'bootId' = r.owner_boot_id::text
            AND e.evidence->>'bindingHash' IS NOT DISTINCT FROM r.dispatch_binding_hash
          ORDER BY e.id DESC LIMIT 1
        ) e ON true
        ORDER BY coalesce(r.dispatched_at, r.queued_at), r.queue_ordinal`));
      const bounded = rows.slice(0, CAPACITY_DETAIL_ITEM_LIMIT).map(row => ({ row, ...capacityReviewProjectRefs(row.privateBinding) }));
      const candidateIds = new Set<number>(), productIds = new Set<number>(), productSlugs = new Set<string>();
      for (const item of bounded) for (const ref of item.refs) {
        if (ref.kind === 'candidate') candidateIds.add(ref.id);
        else if ('slug' in ref) productSlugs.add(ref.slug);
        else productIds.add(ref.id);
      }
      const candidateRows = candidateIds.size === 0 ? [] : await tx.select({ id: crawlCandidates.id, repo: crawlCandidates.repo,
        productName: products.name }).from(crawlCandidates)
        .leftJoin(products, eq(products.slug, crawlCandidates.publishedSlug))
        .where(inArray(crawlCandidates.id, [...candidateIds]));
      const productFilter = productIds.size && productSlugs.size
        ? or(inArray(products.id, [...productIds]), inArray(products.slug, [...productSlugs]))
        : productIds.size ? inArray(products.id, [...productIds])
        : productSlugs.size ? inArray(products.slug, [...productSlugs]) : null;
      const productRows = productFilter ? await tx.select({ id: products.id, slug: products.slug, name: products.name })
        .from(products).where(productFilter) : [];
      const candidates = new Map<number, { repo: string; productName: string | null }>();
      for (const row of candidateRows) candidates.set(Number(row.id), { repo: row.repo, productName: row.productName });
      const productsById = new Map<number, { id: number; slug: string; name: string }>();
      const productsBySlug = new Map<string, { id: number; slug: string; name: string }>();
      for (const row of productRows) {
        const product = { id: Number(row.id), slug: row.slug, name: row.name };
        productsById.set(product.id, product);
        productsBySlug.set(product.slug, product);
      }
      const items = bounded.map(({ row, refs, truncated }) => {
        const base = capacityReviewItemSchema.parse({ requestId: row.requestId, routeId: row.routeId, provider: row.provider,
          model: row.model, groupId: row.groupId, providerBudgetId: row.providerBudgetId, workKey: row.workKey,
          logicalWorkKey: row.logicalWorkKey, ownerInstanceId: row.ownerInstanceId, dispatchedAt: row.dispatchedAt,
          markedAt: row.markedAt, reason: row.reason, oldPolicy: row.oldPolicy, localEndRecorded: row.localEndRecorded });
        const projects = capacityReviewProjects(refs, candidates, productsById, productsBySlug, truncated);
        return { ...base, queuedAt: row.queuedAt, localEndedAt: row.localEndedAt, projects: projects.projects,
          projectsTruncated: projects.projectsTruncated };
      });
      return { items, truncated: rows.length > CAPACITY_DETAIL_ITEM_LIMIT, error: null, observedAt: meta.observedAt };
    }, { accessMode: 'read only', isolationLevel: 'repeatable read' })));
  } catch { return empty('read_failed'); }
}
