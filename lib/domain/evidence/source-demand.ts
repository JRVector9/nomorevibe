import { sql } from "drizzle-orm";

/** Current source demand shared by administrator counts and worker progress.
 * Keep the LEFT JOIN: visible links without a persisted source are initial work.
 * A canonical site's replaced URL does not inherit the old URL's observations.
 */
export function evidenceSourceTargetCtesSql() {
  return sql`public_products AS MATERIALIZED (
    SELECT slug, url, repo_url, created_at, updated_at FROM products WHERE status IN ('seeded','verified')
  ), source_targets AS (
    SELECT greatest(l.created_at, s.created_at, s.next_attempt_at) AS due_at,
      CASE WHEN s.source_url = l.url THEN s.last_success_at END AS success_at,
      CASE WHEN s.source_url = l.url THEN s.last_failure_at END AS failure_at,
      CASE WHEN s.source_url = l.url THEN s.last_error_code END AS error_code,
      CASE WHEN s.source_url = l.url THEN s.state END AS state,
      greatest(l.created_at, s.created_at, s.last_success_at) AS error_since
    FROM public_products p JOIN product_links l ON l.slug = p.slug AND l.visible
    LEFT JOIN product_evidence_sources s ON s.slug = l.slug AND s.kind = l.kind AND s.source_key = l.normalized_key
    UNION ALL
    SELECT CASE WHEN s.id IS NOT NULL AND s.source_url IS DISTINCT FROM p.url THEN p.updated_at
        ELSE greatest(p.created_at, s.created_at, s.next_attempt_at) END,
      CASE WHEN s.source_url = p.url THEN s.last_success_at END,
      CASE WHEN s.source_url = p.url THEN s.last_failure_at END,
      CASE WHEN s.source_url = p.url THEN s.last_error_code END,
      CASE WHEN s.source_url = p.url THEN s.state END,
      greatest(p.created_at, s.created_at, s.last_success_at)
    FROM public_products p JOIN product_evidence_sources s ON s.slug = p.slug
      AND s.provider = 'product_site' AND s.source_key = 'canonical_site'
  )`;
}
