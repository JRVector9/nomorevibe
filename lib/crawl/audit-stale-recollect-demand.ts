import { sql, type SQL } from "drizzle-orm";

/**
 * 원본 다시 받기(audit-stale-recollect.ts)의 스캔 수요 — 스캔 줄 채우기(lib/domain/evidence/agents/claims.ts)가 읽는다.
 * 무거운 모듈(수집·감사)을 스캔 쪽 모듈 그래프에 끌어들이지 않게 SQL 만 따로 둔다.
 */

/** 원본·스캔이 이만큼보다 오래됐으면 다시 받는다 — 24시간에서 한 시간을 남겨 받는 동안 다시 지나지 않게 */
export const AUDIT_RECOLLECT_REFRESH_AGE_MS = 23 * 3600_000;

/**
 * 스캔 줄 채우기(fillAgentScanQueue)의 수요 — 다시 받는 중인 항목의 저장소 가운데 마지막 스캔이 끝난 지 23시간이 넘은 것.
 * 마지막 스캔이 끝나지 않았으면(partial — completed_at 없음) 입력 기한에 들지 않으므로 넣지 않는다(agent-review-contract.ts createReviewInput)
 */
export function auditRecollectScanDemand(): SQL {
  return sql`(
    SELECT DISTINCT lower(recollect.repo) AS repository_key FROM product_audit_recollects recollect
    LEFT JOIN LATERAL (SELECT scan.completed_at FROM agent_repository_scans scan
      WHERE scan.repository_key = lower(recollect.repo) AND scan.scope = ''
      ORDER BY scan.started_at DESC, scan.id DESC LIMIT 1) latest ON true
    WHERE recollect.state = 'waiting' AND latest.completed_at IS NOT NULL
      AND latest.completed_at <= clock_timestamp() - ${AUDIT_RECOLLECT_REFRESH_AGE_MS} * interval '1 millisecond'
  )`;
}

