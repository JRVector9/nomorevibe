import { sql, type SQL } from "drizzle-orm";
import type { SecondReview } from "@/lib/db/schema";

export const STALE_RECONCILE_LIMIT = 25;
export const STALE_RECONCILE_EXAMINE_LIMIT = 80;
export const SOURCE_REFRESH_COOLDOWN_MS = 24 * 3600_000;
/** Only demand closed by this controller is carried forward, without an age cutoff. */
export const STALE_REVIEW_OWNER = "stale-input-reconciler";

/** Wrap only after consuming the whole final page, never when the mutation budget stopped mid-page. */
export function staleReviewCursorAfterPage(ids: number[], visited: number, limit: number): number {
  return visited === ids.length && ids.length < limit ? 0 : ids[visited - 1];
}

export type CapacityProbe = { state: string; reservedUntil: Date | string | null };
/** Unknown state or reservation time protects the existing owner. No capacity row is reclaimed here. */
export function capacityBlocksStaleReconcile(row: CapacityProbe, now: Date): boolean {
  if (row.state === "waiting" || row.state === "withdrawn" || row.state === "settled") return false;
  if (row.state === "reserved") {
    if (row.reservedUntil == null) return true;
    const until = row.reservedUntil instanceof Date ? row.reservedUntil : new Date(row.reservedUntil);
    return !Number.isFinite(until.getTime()) || until.getTime() > now.getTime();
  }
  return true;
}

export function protectingCapacityStateSql(cap: SQL): SQL {
  return sql`(${cap}.state IN ('dispatched', 'indeterminate')
    OR (${cap}.state = 'reserved' AND (${cap}.reserved_until IS NULL OR ${cap}.reserved_until > clock_timestamp()))
    OR coalesce(${cap}.state, '') NOT IN ('waiting', 'reserved', 'dispatched', 'indeterminate', 'withdrawn', 'settled'))`;
}

/** A second-review request with no readable candidate protects all AI2 candidates, never unrelated routes. */
export function staleReviewCapacityIdentitySql(cap: SQL, candidateId: SQL): SQL {
  return sql`(${cap}.logical_work_key LIKE 'ai2:' || (${candidateId})::text || ':%'
    OR (${cap}.route_id = 'second-review' AND (
      ${cap}.work_key LIKE 'ai2:' || (${candidateId})::text || ':%'
      OR (coalesce(${cap}.logical_work_key, '') !~ '^ai2:[1-9][0-9]*:[1-9][0-9]*$'
        AND coalesce(${cap}.work_key, '') !~ '^ai2:[1-9][0-9]*:[1-9][0-9]*:[a-f0-9]{64}$')
    )))`;
}

/** Filter history once before candidate-dependent LIKE/regex checks. MATERIALIZED callers
 * keep PostgreSQL from rescanning all capacity history for every candidate. */
function protectingCapacityRowsSql(): SQL {
  return sql`SELECT cap.state, cap.reserved_until, cap.logical_work_key, cap.work_key, cap.route_id
    FROM model_capacity_requests cap WHERE ${protectingCapacityStateSql(sql`cap`)}`;
}

export function protectingCapacityExistsSql(candidateId: SQL, source = sql`model_capacity_requests`): SQL {
  return sql`EXISTS (SELECT 1 FROM ${source} cap
    WHERE ${staleReviewCapacityIdentitySql(sql`cap`, candidateId)} AND ${protectingCapacityStateSql(sql`cap`)})`;
}

/** Recheck current protection inside the candidate transaction; hints grant no authority. */
export function staleReviewCapacityProbeSql(candidateId: number): SQL {
  return sql`WITH stale_review_protecting_capacity AS MATERIALIZED (${protectingCapacityRowsSql()})
    SELECT cap.state, cap.reserved_until FROM stale_review_protecting_capacity cap
    WHERE ${staleReviewCapacityIdentitySql(sql`cap`, sql`${candidateId}`)}`;
}

/** A replaced primary is still the demand owner until its unfinished fallback chain is superseded too. */
export function staleFallbackRootIds(votes: SecondReview[], stale: SecondReview[]): number[] {
  return votes.filter(root => root.fallbackForId === null && root.status === "resolved" && root.resolution === "fallback"
    && stale.some(child => child.fallbackForId === root.id && child.candidateId === root.candidateId
      && child.publishedSlug === root.publishedSlug && child.generationKey === root.generationKey && child.inputHash === root.inputHash)
    && !votes.some(child => child.fallbackForId === root.id && !stale.some(row => row.id === child.id)
      && !(child.status === "resolved" && ["superseded", "model_removed", "fallback"].includes(child.resolution ?? ""))))
    .map(root => root.id);
}

const carriedDemandSql = (s: SQL) => sql`(${s}.status = 'resolved' AND ${s}.resolution = 'superseded'
  AND ${s}.resolved_by = ${STALE_REVIEW_OWNER} AND ${s}.fallback_for_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM second_reviews taken
    WHERE taken.candidate_id = ${s}.candidate_id AND taken.published_slug IS NOT DISTINCT FROM ${s}.published_slug
      AND regexp_replace(lower(trim(taken.model)), '^[[]mlx[]][[:space:]]*', '', 'i')
        = regexp_replace(lower(trim(${s}.model)), '^[[]mlx[]][[:space:]]*', '', 'i')
      AND NOT (taken.status = 'resolved' AND coalesce(taken.resolution, '') IN ('superseded', 'model_removed'))))`;

/** Existing pending/failed fallback votes count as demand. Old unrelated superseded samples do not. */
export function staleSecondReviewScanDemand(detectorVersion: string, enabled = true): SQL {
  if (!enabled) return sql`(SELECT NULL::text AS repository_key WHERE false)`;
  return sql`(
    SELECT DISTINCT lower(c.repo) AS repository_key
    FROM second_reviews s JOIN crawl_candidates c ON c.id = s.candidate_id
    LEFT JOIN products p ON p.slug = c.published_slug
    LEFT JOIN LATERAL (SELECT scan.* FROM agent_repository_scans scan
      WHERE scan.repository_key = lower(c.repo) AND scan.scope = ''
      ORDER BY scan.started_at DESC, scan.id DESC LIMIT 1) latest ON true
    WHERE (s.status IN ('pending', 'failed') OR ${carriedDemandSql(sql`s`)})
      AND ((s.published_slug IS NOT NULL AND s.trigger IN ('risk', 'sample')
        AND c.state = 'published' AND c.published_slug = s.published_slug
        AND c.decided_by IS NOT NULL AND c.decided_by <> 'admin' AND p.status IN ('seeded', 'verified'))
        OR (s.published_slug IS NULL AND c.published_slug IS NULL AND c.decided_by = 'auto'
          AND c.reason IS DISTINCT FROM 'second_review_split'
          AND ((s.trigger = 'ai_approved' AND c.state = 'approved')
            OR (s.trigger IN ('ai_decided', 'ai_held') AND c.state = 'needs_review'))))
      AND (latest.id IS NULL OR latest.completed_at IS NULL
        OR latest.completed_at <= clock_timestamp() - interval '24 hours'
        OR latest.detector_version IS DISTINCT FROM ${detectorVersion}
        OR latest.last_error_code IS NOT NULL OR latest.state IS DISTINCT FROM 'complete')
  )`;
}

/**
 * Examine every active input shape, including policy-only changes and fallback children.
 * A job-owned candidate-ID cursor survives ticks and restarts; a valid prefix cannot starve later demand.
 * Owned closed demand also reaches the callback for an explicit no-longer-required outcome.
 */
export function staleSecondReviewHintSql(afterCandidateId: number, limit: number): SQL {
  return sql`WITH stale_review_protecting_capacity AS MATERIALIZED (${protectingCapacityRowsSql()})
    SELECT DISTINCT s.candidate_id FROM second_reviews s
    JOIN crawl_candidates c ON c.id = s.candidate_id
    WHERE s.candidate_id > ${afterCandidateId}
      AND ((s.status IN ('pending', 'failed') AND (
        (s.published_slug IS NOT NULL AND c.state = 'published' AND c.published_slug = s.published_slug
          AND c.decided_by IS NOT NULL AND c.decided_by <> 'admin')
        OR (s.published_slug IS NULL AND c.published_slug IS NULL AND c.decided_by = 'auto'
          AND c.reason IS DISTINCT FROM 'second_review_split'
          AND ((s.trigger = 'ai_approved' AND c.state = 'approved')
            OR (s.trigger IN ('ai_decided', 'ai_held') AND c.state = 'needs_review')))))
        OR ${carriedDemandSql(sql`s`)})
      AND NOT ${protectingCapacityExistsSql(sql`s.candidate_id`, sql`stale_review_protecting_capacity`)}
    ORDER BY s.candidate_id LIMIT ${limit}`;
}
