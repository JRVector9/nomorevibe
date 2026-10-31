import { sql } from "drizzle-orm";
import { db, onPrimary } from "@/lib/db";

/** PostgreSQL lock_timeout(55P03 lock_not_available) — drizzle 은 원래 오류를 cause 에 싣는다. */
export function isLockNotAvailable(error: unknown): boolean {
  for (let value = error, depth = 0; value && typeof value === "object" && depth < 4; value = (value as { cause?: unknown }).cause, depth++)
    if ((value as { code?: unknown }).code === "55P03") return true;
  return false;
}

export type ControlLockHolder = Readonly<{ pid: number; application: string; state: string | null; xactAgeMs: number; waiting: string | null }>;

/**
 * model_capacity_control 을 잡은(또는 기다리는) 다른 세션 — 55P03 뒤 한 번 읽는 진단(2026-10-31, product-search-profile 이 10-29 부터
 * 매 틱 control FOR SHARE 에서 lock_timeout). 행 잠금(FOR UPDATE·FOR SHARE)은 표에 RowShareLock 을 함께 남기므로, 그 표 잠금을 쥔
 * 세션을 TX 나이 순으로 본다. 쿼리 본문·값은 읽지 않는다. 진단이 실패해도 원래 오류를 바꾸지 않는다.
 */
export async function readControlLockHolders(limit = 5): Promise<ControlLockHolder[]> {
  try {
    const rows = await onPrimary(() => db.execute<{ pid: number; application: string; state: string | null; xact_age_ms: number; waiting: string | null }>(sql`
      SELECT a.pid, coalesce(a.application_name, '') AS application, a.state,
        floor(extract(epoch FROM clock_timestamp() - a.xact_start) * 1000)::float8 AS xact_age_ms,
        CASE WHEN a.wait_event_type IS NULL THEN NULL ELSE a.wait_event_type || ':' || coalesce(a.wait_event, '') END AS waiting
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'relation' AND l.relation = 'model_capacity_control'::regclass AND l.granted
        AND l.mode IN ('RowShareLock', 'RowExclusiveLock') AND a.pid <> pg_backend_pid() AND a.xact_start IS NOT NULL
      ORDER BY a.xact_start LIMIT ${limit}`));
    return rows.map(row => Object.freeze({ pid: Number(row.pid), application: String(row.application).slice(0, 64), state: row.state,
      xactAgeMs: Number(row.xact_age_ms), waiting: row.waiting }));
  } catch { return []; }
}
