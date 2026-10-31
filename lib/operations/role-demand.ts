import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";
import { currentReplayDb } from "@/lib/db/replay-scope";
import type { ProductTransaction } from "@/lib/domain/products/generation";
import { HELPER_SIGNAL_METRICS_MAX_BYTES, ROLE_DEMAND_BEACONS, SIGNAL_VALIDITY_MAX_MS, type RoleDemandMetrics } from "@/lib/llm/capacity-helpers";
import { logger } from "@/lib/observability/logger";
import { lockWriterFence } from "@/lib/operations/dr/epoch";

/**
 * 집 쪽 역할 수요 beacon(pr2-plan §3.6, D2) — main 역할(M3) 프로세스가 `model_role_demand` 에 쓰고 Oracle 감시자만 읽는다.
 * 감시자에게는 crawl·jobs 권한이 없으므로 자기 일 대기(사람 검수 대기 수 등)는 이미 그 권한을 가진 집 잡이 재서 넘긴다.
 * 없거나 만료된 beacon 은 감시자가 "그 역할은 바쁨"으로 본다(돕기에 대해 fail-closed) — 그래서 쓰기 실패는 도우미를 닫을 뿐 일을 막지 않는다.
 *
 * - 시각은 DB clock_timestamp() 한 값에서: observed_at = t, valid_until = t + ttl(≤ 5 분, 표 TTL CHECK). written_by = current_user.
 *   0154 stamp 트리거가 있으면 같은 값으로 다시 쓴다.
 * - 쓰는 TX 는 DR writer fence(SHARE)를 먼저 잡는다. fenced DB 에는 쓰지 않는다(false).
 * - 호출하는 잡(WP-2a-C: human-deepseek-review 끝·AI1 소비자 page loop)은 publishRoleDemand 를 쓴다 — 자기 TX 이고 오류를 삼킨다(잡을 멈추지 않는다).
 */

export type RoleDemandInput = Readonly<{
  roleId: string; deviceId: string; backlog: number; oldestAgeMs?: number | null; metrics?: RoleDemandMetrics;
}>;
export type RoleDemandBeaconName = keyof typeof ROLE_DEMAND_BEACONS;
export type RoleDemandValues = Readonly<{ backlog: number; oldestAgeMs?: number | null; metrics?: RoleDemandMetrics }>;

const INT_MAX = 2_147_483_647;
/** jsonb CHECK(pg_column_size ≤ 8192)보다 넉넉히 작게 — JSON 글자 수로 자른다. */
const METRICS_MAX_BYTES = HELPER_SIGNAL_METRICS_MAX_BYTES / 2;
const identity = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
const fail = (path: string): never => { throw new Error(`role_demand_invalid:${path}`); };

function metricValue(value: unknown): boolean {
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 200;
  return Array.isArray(value) && value.length <= 64 && value.every(item => identity(item, 120));
}

/** 입력 검증·정규화. backlog 는 정수로 자르고 int 상한에서 멈춘다. 거절은 `role_demand_invalid:<field>`. */
export function parseRoleDemand(input: RoleDemandInput, ttlMs: number): Required<RoleDemandInput> & { ttlMs: number; metricsJson: string } {
  if (!identity(input.roleId, 60)) fail("roleId");
  if (!identity(input.deviceId, 120)) fail("deviceId");
  if (typeof input.backlog !== "number" || !Number.isFinite(input.backlog) || input.backlog < 0) fail("backlog");
  const oldest = input.oldestAgeMs ?? null;
  if (oldest !== null && (typeof oldest !== "number" || !Number.isFinite(oldest) || oldest < 0)) fail("oldestAgeMs");
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > SIGNAL_VALIDITY_MAX_MS) fail("ttlMs");
  const metrics = input.metrics ?? {};
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) fail("metrics");
  for (const [key, value] of Object.entries(metrics)) if (!identity(key, 60) || !metricValue(value)) fail(`metrics.${key}`);
  const metricsJson = JSON.stringify(metrics);
  if (Buffer.byteLength(metricsJson, "utf8") > METRICS_MAX_BYTES) fail("metrics");
  return {
    roleId: input.roleId, deviceId: input.deviceId, backlog: Math.min(INT_MAX, Math.trunc(input.backlog)),
    oldestAgeMs: oldest === null ? null : Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(oldest)), metrics, ttlMs, metricsJson,
  };
}

/**
 * beacon 한 줄 upsert(호출자의 TX). fenced DB 면 쓰지 않고 false. 입력이 틀리면 던진다. replay 범위에서는 쓰지 않는다(false) —
 * 재생은 운영 감시자 신호를 만들지 않는다.
 */
export async function writeRoleDemand(tx: ProductTransaction, input: RoleDemandInput, ttlMs: number): Promise<boolean> {
  const value = parseRoleDemand(input, ttlMs);
  if (currentReplayDb()) return false;
  const fence = await lockWriterFence(tx, "share");
  if (fence.state !== "active") return false;
  await tx.execute(sql`WITH t AS (SELECT clock_timestamp() AS at)
    INSERT INTO model_role_demand (role_id, device_id, backlog, oldest_age_ms, metrics, observed_at, valid_until, written_by)
    SELECT ${value.roleId}::text, ${value.deviceId}::text, ${value.backlog}::int, ${value.oldestAgeMs}::bigint, ${value.metricsJson}::jsonb,
      t.at, t.at + ${value.ttlMs}::int * interval '1 millisecond', current_user::text FROM t
    ON CONFLICT (role_id) DO UPDATE SET device_id = EXCLUDED.device_id, backlog = EXCLUDED.backlog, oldest_age_ms = EXCLUDED.oldest_age_ms,
      metrics = EXCLUDED.metrics, observed_at = EXCLUDED.observed_at, valid_until = EXCLUDED.valid_until, written_by = EXCLUDED.written_by`);
  return true;
}

/** 자기 TX(primary)로 beacon 을 쓴다. 어떤 오류도 던지지 않는다(false + 경고 로그) — beacon 이 없으면 감시자가 도우미를 닫을 뿐이다. */
export async function publishRoleDemand(input: RoleDemandInput, ttlMs: number): Promise<boolean> {
  try {
    parseRoleDemand(input, ttlMs);
    if (currentReplayDb()) return false;
    return await onPrimary(() => db.transaction(tx => writeRoleDemand(tx, input, ttlMs)));
  } catch (error) {
    logger.warn("role_demand.write_failed", { roleId: typeof input?.roleId === "string" ? input.roleId.slice(0, 60) : null,
      error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return false;
  }
}

/**
 * 이름 붙은 beacon(ROLE_DEMAND_BEACONS: humanReview·ai1)을 쓰는 함수. 같은 프로세스 안에서 minIntervalMs(ai1 15 초) 보다 자주 쓰지 않는다 —
 * 건너뛴 호출은 false. human-review 는 간격 0(잡 틱마다), TTL 150 초.
 */
export function createRoleDemandPublisher(name: RoleDemandBeaconName, options: {
  now?: () => number; publish?: (input: RoleDemandInput, ttlMs: number) => Promise<boolean>;
} = {}): (values: RoleDemandValues) => Promise<boolean> {
  const beacon = ROLE_DEMAND_BEACONS[name];
  if (!beacon) throw new Error("role_demand_invalid:beacon");
  const now = options.now ?? (() => performance.now()), publish = options.publish ?? publishRoleDemand;
  let last = Number.NEGATIVE_INFINITY;
  return async values => {
    const at = now();
    if (at - last < beacon.minIntervalMs) return false;
    last = at;
    return publish({ roleId: beacon.roleId, deviceId: beacon.deviceId, backlog: values.backlog, oldestAgeMs: values.oldestAgeMs ?? null,
      metrics: values.metrics ?? {} }, beacon.ttlMs);
  };
}
