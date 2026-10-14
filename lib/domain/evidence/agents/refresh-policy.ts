import { sql, type SQL } from 'drizzle-orm';

/** Scheduling only: never change persisted confirmation/retry clocks or the judge's 24h freshness. */
export function agentRefreshDueAtSql(scan: SQL, requiresDaily: SQL, backgroundRefreshDays = 1, at: SQL = sql`now()`): SQL {
  const nextAttemptAt = sql`${scan}.next_attempt_at`;
  if (backgroundRefreshDays === 1) return nextAttemptAt;
  return sql`CASE WHEN NOT ${requiresDaily} AND ${scan}.state = 'complete'
    AND ${scan}.last_error_code IS NULL AND ${scan}.cursor IS NULL
    AND coalesce(${scan}.coverage->'limited', 'false'::jsonb) = 'false'::jsonb
    AND ${scan}.completed_at <= ${at}
    THEN greatest(${nextAttemptAt}, ${scan}.completed_at + ${backgroundRefreshDays} * interval '1 day')
    ELSE ${nextAttemptAt} END`;
}
