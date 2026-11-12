import "server-only";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { sharedStore } from "@/lib/cache/shared";
import { db, onPrimary } from "@/lib/db";
import { withDbDeadline } from "@/lib/db/pool";
import { DEFAULT_MODEL_DEFINITIONS, readModelRegistry, type ModelDefinition } from "@/lib/llm/model-registry";
import { readAdminObservations, readRuntimeSettingsAudit, type AdminObservation } from "./admin-runtime-settings";
import { buildLimitsView, limitsMeasurementFromRows, limitsMeasureMap, type LimitsMeasureMap, type LimitsMeasurement, type LimitsMeasureRows, type LimitsView } from "./admin-limits-view";
import { adminWorkspaceReadOnly } from "./admin-workspace-preview";
import { readJobPauses } from "./llm-ops-read";
import { readRuntimeSettingsApply, readRuntimeSettingsRow } from "./runtime-settings";
import { resolveRuntimeSettings } from "./runtime-settings-schema";
import { sharedLoader } from "./shared-cache";

/**
 * 「실시간 한도」 화면의 읽기 — 저장 행·적용 확인·역할 관측·저장 기록·잡 멈춤·장부 24시간 실측을 함께 읽는다. 모두 읽기 전용이다.
 * 저장 행 말고는 덤이다: 하나를 못 읽어도 화면은 뜬다(실측을 못 읽으면 「측정을 읽지 못했습니다」, 칸은 그대로 저장할 수 있다).
 *
 * 장부 실측(readLimitsMeasurement)은 관리자 모델 관측(admin-models-repository.ts)과 같은 틀이다: 주 DB 의 읽기 전용·repeatable read 한 스냅숏,
 * statement_timeout 3초, 4초 기한. 창은 24시간이고 색인만 탄다 — 정산 행은 settled_at 부분 색인(0144), 미확정은 withdrawn_at 부분 색인(0144)·
 * unknown_hold 부분 색인(0172)으로 고른 행마다 event 를 request_id 색인으로 하나 찾는다(2026-11-11 프로드 실측: 정산 3.7만 행 0.2초대, 미확정 쪽 36ms).
 * 웹 여러 대가 같은 값을 60초 나눠 쓴다(sharedLoader, Valkey) — 열쇠는 작업 지도(분류 상한 포함)의 해시다.
 */

/**
 * 장부 24시간 — 작업 줄마다 정산 호출 수·p50/p99/최대(보낸 시각 → 정산)·상한에서 끊김, 결과 미확정의 갈래(틱이 끊음·상한 근처), 보내기 전 취소,
 * 그리고 작업 × 공급자 × 모델 × 장비의 정산 수. 장비 칸 수·정책 route·작업 순위(작은 표 셋)도 같은 스냅숏에서 읽는다. 쓰지 않는다.
 * 미확정 분류: 시간·중단(client_timeout·local_abort)으로 끊겼고 상한 - 2초보다 짧으면 「틱이 끊음」, 상한 - 2초 이상이면 「상한 근처」. 전송 오류(transport_unknown)는 둘 다 아니다.
 */
export async function queryLimitsMeasurement(map: LimitsMeasureMap): Promise<LimitsMeasurement> {
  const mapJson = JSON.stringify(map);
  return withDbDeadline(Date.now() + 4_000, () => onPrimary(() => db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
    const [clock] = await tx.execute<{ measuredAt: string }>(sql`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "measuredAt"`);
    const settled = await tx.execute<LimitsMeasureRows["tasks"][number] & LimitsMeasureRows["mix"][number] & { level: number | string }>(sql`
      WITH map AS (SELECT key AS route_id, value->>'task' AS task, (value->>'capMs')::float8 AS cap_ms, value->'providers' AS providers
                   FROM jsonb_each(${mapJson}::text::jsonb)),
      calls AS MATERIALIZED (
        SELECT m.task, r.provider, r.model, r.group_id,
          extract(epoch FROM (r.settled_at - r.dispatched_at)) * 1000 AS ms,
          coalesce((m.providers->>r.provider)::float8, m.cap_ms) AS cap_ms
        FROM model_capacity_requests r JOIN map m ON m.route_id = r.route_id
        WHERE r.state = 'settled' AND r.settled_at >= transaction_timestamp() - interval '24 hours' AND r.settled_at <= transaction_timestamp()
          AND r.dispatched_at IS NOT NULL AND r.settled_at >= r.dispatched_at
      )
      SELECT task, provider, model, group_id AS "groupId", GROUPING(provider, model, group_id)::int AS level, count(*)::int AS calls,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::float8 AS p50, percentile_cont(0.99) WITHIN GROUP (ORDER BY ms)::float8 AS p99,
        max(ms)::float8 AS "maxMs", count(*) FILTER (WHERE cap_ms IS NOT NULL AND ms >= cap_ms - 1000)::int AS "cutAtCap"
      FROM calls GROUP BY GROUPING SETS ((task), (task, provider, model, group_id)) ORDER BY task, provider NULLS FIRST, model, group_id LIMIT 2001`);
    const unknowns = await tx.execute<LimitsMeasureRows["unknowns"][number]>(sql`
      WITH map AS (SELECT key AS route_id, value->>'task' AS task, (value->>'capMs')::float8 AS cap_ms, value->'providers' AS providers
                   FROM jsonb_each(${mapJson}::text::jsonb)),
      ended AS MATERIALIZED (
        SELECT m.task, r.request_id, r.state, r.dispatched_at, coalesce((m.providers->>r.provider)::float8, m.cap_ms) AS cap_ms
        FROM model_capacity_requests r JOIN map m ON m.route_id = r.route_id
        WHERE (r.state = 'withdrawn' AND r.updated_at >= transaction_timestamp() - interval '24 hours' AND r.updated_at <= transaction_timestamp())
          OR r.state = 'indeterminate'
      ),
      unknown AS (
        SELECT ended.task, ended.cap_ms, e.reason, extract(epoch FROM (e.created_at - ended.dispatched_at)) * 1000 AS ms
        FROM ended CROSS JOIN LATERAL (SELECT ev.created_at, ev.reason FROM model_capacity_events ev
          WHERE ev.request_id = ended.request_id AND ev.kind = 'dispatch_indeterminate' ORDER BY ev.id LIMIT 1) e
        WHERE ended.dispatched_at IS NOT NULL AND e.created_at >= transaction_timestamp() - interval '24 hours'
      ),
      unknown_by_task AS (
        SELECT task, count(*)::int AS unknown,
          count(*) FILTER (WHERE reason IN ('client_timeout','local_abort') AND cap_ms IS NOT NULL AND ms < cap_ms - 2000)::int AS "tickCut",
          min(ms) FILTER (WHERE reason IN ('client_timeout','local_abort') AND cap_ms IS NOT NULL AND ms < cap_ms - 2000)::float8 AS "tickMin",
          max(ms) FILTER (WHERE reason IN ('client_timeout','local_abort') AND cap_ms IS NOT NULL AND ms < cap_ms - 2000)::float8 AS "tickMax",
          count(*) FILTER (WHERE cap_ms IS NOT NULL AND ms >= cap_ms - 2000)::int AS "atCap"
        FROM unknown GROUP BY task
      ),
      cancelled_by_task AS (
        SELECT task, count(*)::int AS cancelled FROM ended WHERE state = 'withdrawn' AND dispatched_at IS NULL GROUP BY task
      )
      SELECT coalesce(u.task, c.task) AS task, coalesce(u.unknown, 0) AS unknown, coalesce(u."tickCut", 0) AS "tickCut", u."tickMin", u."tickMax",
        coalesce(u."atCap", 0) AS "atCap", coalesce(c.cancelled, 0) AS cancelled
      FROM unknown_by_task u FULL JOIN cancelled_by_task c ON c.task = u.task`);
    const devices = await tx.execute<LimitsMeasureRows["devices"][number]>(sql`SELECT device_id AS "deviceId", limit_slots AS "limitSlots", enabled, model_limits AS "modelLimits"
      FROM model_capacity_devices ORDER BY device_id LIMIT 200`);
    const [control] = await tx.execute<{ routes: unknown }>(sql`SELECT policy->'routes' AS routes FROM model_capacity_control WHERE id = 1`);
    // 「지금 모델」은 사용자가 정한 이름으로 적는다(운영 콘솔 통합 — aiModelDisplayName 과 같은 규칙: options.displayName, 없으면 연결 이름표)
    const ranks = await tx.execute<LimitsMeasureRows["ranks"][number]>(sql`SELECT r.task, r.slot, r.rank, r.model, r.enabled,
        coalesce(nullif(btrim(c.options->>'displayName'), ''), c.label) AS name
      FROM ai_task_models r LEFT JOIN ai_connections c ON c.id = r.connection_id ORDER BY r.task, r.slot, r.rank LIMIT 500`);
    const rows = Array.from(settled);
    if (rows.length > 2000) throw new Error("limits_measurement_truncated");
    const num = (value: number | string) => Number(value);
    // GROUPING(...) = 0 이면 작업 × 공급자 × 모델 × 장비 줄, 아니면(모두 묶음) 작업 줄이다
    return limitsMeasurementFromRows({ measuredAt: clock.measuredAt, tasks: rows.filter(row => num(row.level) !== 0),
      mix: rows.filter(row => num(row.level) === 0),
      unknowns: Array.from(unknowns), devices: Array.from(devices), policyRoutes: control?.routes ?? [], ranks: Array.from(ranks) });
  }, { accessMode: "read only", isolationLevel: "repeatable read" })));
}

const measurementCache = sharedLoader<LimitsMeasurement>({ namespace: "admin:limits-measurement", ttlMs: 60_000, store: sharedStore });
/** 60초 나눠 쓰는 장부 실측 — 지도(작업·분류 상한)가 바뀌면 다른 열쇠다. 실패는 담지 않는다 */
export function readLimitsMeasurement(map: LimitsMeasureMap, fresh = false): Promise<LimitsMeasurement> {
  const key = createHash("sha256").update(JSON.stringify(map)).digest("hex").slice(0, 16);
  return measurementCache(`v1:${key}`, () => queryLimitsMeasurement(map), fresh);
}

/** 화면 한 번 그리기 — 저장 행이 먼저(실측 지도가 그 상한을 쓴다), 나머지는 함께. 행 말고는 덤이다 */
export async function readLimitsAdminView(now = new Date()): Promise<LimitsView> {
  let models: readonly ModelDefinition[];
  try { models = readModelRegistry().models; } catch { models = DEFAULT_MODEL_DEFINITIONS; }
  const row = await readRuntimeSettingsRow().then(value => ({ value, error: null as string | null }),
    (error: unknown) => ({ value: null, error: error instanceof Error ? error.message : String(error) }));
  const map = limitsMeasureMap(resolveRuntimeSettings(row.value?.values ?? null, { models }).settings, models);
  const [apply, observations, audit, pauses, measured] = await Promise.all([
    readRuntimeSettingsApply().catch(() => null),
    readAdminObservations().catch(() => [] as AdminObservation[]),
    readRuntimeSettingsAudit(),
    readJobPauses(now.getTime()),
    readLimitsMeasurement(map).then(value => ({ value, error: null as string | null }),
      (error: unknown) => ({ value: null, error: error instanceof Error ? error.message : String(error) })),
  ]);
  return buildLimitsView({ row: row.value, rowError: row.error, models, apply, observations, audit, pauses, measurement: measured.value, measureError: measured.error,
    readOnly: adminWorkspaceReadOnly(), now });
}
