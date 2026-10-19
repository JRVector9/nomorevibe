import { sql, type SQL } from 'drizzle-orm';

/**
 * 범위 제한(coverage limited)으로 끝나 더 볼 것이 남지 않은 partial. 머리 커밋이 같으면 다시 돌려도 같은 제한에 걸려
 * 끝내 complete 가 되지 못한다 — 2026-10-19 프로드에서 2,180개가 매일 다시 돌았다(대기의 약 60%).
 */
export function agentLimitedSettledSql(scan: SQL): SQL {
  return sql`(${scan}.state = 'partial' AND ${scan}.last_error_code IS NULL
    AND coalesce(${scan}.coverage->'limited', 'false'::jsonb) = 'true'::jsonb
    AND jsonb_array_length(coalesce(${scan}.cursor->'pendingTrees', '[]'::jsonb)) = 0
    AND jsonb_array_length(coalesce(${scan}.cursor->'pendingBlobs', '[]'::jsonb)) = 0
    AND jsonb_array_length(coalesce(${scan}.cursor->'pendingCommits', '[]'::jsonb)) = 0)`;
}

/**
 * Scheduling only: never change persisted confirmation/retry clocks or the judge's 24h freshness.
 * 공개 제품만 원하는 저장소는 깨끗한 complete 와 범위 제한으로 끝난 partial 을 배경 주기(backgroundRefreshDays)로 다시 본다.
 * 후보가 원하는 저장소(requiresDaily)는 지금처럼 저장된 시계를 따른다.
 */
export function agentRefreshDueAtSql(scan: SQL, requiresDaily: SQL, backgroundRefreshDays = 1, at: SQL = sql`now()`): SQL {
  const nextAttemptAt = sql`${scan}.next_attempt_at`;
  if (backgroundRefreshDays === 1) return nextAttemptAt;
  return sql`CASE WHEN NOT ${requiresDaily} AND ${scan}.state = 'complete'
    AND ${scan}.last_error_code IS NULL AND ${scan}.cursor IS NULL
    AND coalesce(${scan}.coverage->'limited', 'false'::jsonb) = 'false'::jsonb
    AND ${scan}.completed_at <= ${at}
    THEN greatest(${nextAttemptAt}, ${scan}.completed_at + ${backgroundRefreshDays} * interval '1 day')
    WHEN NOT ${requiresDaily} AND ${agentLimitedSettledSql(scan)} AND ${scan}.started_at <= ${at}
    THEN greatest(${nextAttemptAt}, ${scan}.started_at + ${backgroundRefreshDays} * interval '1 day')
    ELSE ${nextAttemptAt} END`;
}
