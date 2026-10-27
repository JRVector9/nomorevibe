import { sql } from "drizzle-orm";
import { z } from "zod";
import { sharedStore } from "@/lib/cache/shared";
import { replicaCache } from "./replica-cache";
import type { ReplicaRead } from "./replica-hold";

export const FIRST_REVIEW_SAMPLE_LIMIT = 10_000;
export const FIRST_REVIEW_STATUS_TTL_MS = 60_000;
const count = z.number().int().nonnegative().safe();
const timestamp = z.iso.datetime({ offset: true });
const windowSchema = z.object({
  minutes: z.union([z.literal(5), z.literal(15), z.literal(60)]),
  succeeded: count, failed: count, unique: count, approve: count, reject: count, handoff: count,
  cancelled: count, reuse: count, rules: count,
}).strict().refine(row => row.unique <= row.succeeded
  && row.approve + row.reject + row.handoff === row.succeeded);
const statusSchema = z.object({
  at: timestamp, sampled: count.max(FIRST_REVIEW_SAMPLE_LIMIT), truncated: z.boolean(),
  windows: z.array(windowSchema).length(3),
  recent: z.array(z.object({ id: count.positive(), candidateId: count.positive(), provider: z.string().max(80).nullable(),
    model: z.string().max(160).nullable(), state: z.enum(["succeeded", "failed"]),
    decision: z.enum(["approve", "reject", "needs_review"]).nullable(), completedAt: timestamp,
  }).strict()).max(5),
}).strict().refine(row => new Set(row.windows.map(window => window.minutes)).size === 3);

export type FirstReviewStatus = z.infer<typeof statusSchema>;

/**
 * Read at most 10,001 PK entries before any time/kind filter. There is no completed_at
 * index, so a time-filtered count would scan the growing attempt history. The extra row
 * detects an incomplete sample; even an apparently old sample is never called complete.
 * Domain outcomes include legacy calls. Approve/reject/handoff are all technical success.
 */
export function firstReviewStatusSql() {
  return sql`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at),
    tail AS MATERIALIZED (
      SELECT id, candidate_id, kind, state, provider, model, reused_from_attempt_id, error_code, completed_at,
        outcome->>'decision' AS decision
      FROM crawl_review_attempts ORDER BY id DESC LIMIT ${FIRST_REVIEW_SAMPLE_LIMIT + 1}),
    sampled AS MATERIALIZED (SELECT * FROM tail ORDER BY id DESC LIMIT ${FIRST_REVIEW_SAMPLE_LIMIT}),
    ended AS MATERIALIZED (
      SELECT s.*, CASE WHEN s.provider = 'rules' THEN 'rules'
        WHEN s.reused_from_attempt_id IS NOT NULL THEN 'reuse'
        WHEN s.state = 'failed' AND s.error_code IN ('cancelled', 'deferred') THEN 'cancelled'
        WHEN s.state IN ('succeeded', 'failed') THEN 'call' END AS category
      FROM sampled s CROSS JOIN clock c WHERE s.kind = 'automatic'
        AND s.completed_at > c.at - interval '60 minutes' AND s.completed_at <= c.at),
    windows AS (
      SELECT w.minutes, jsonb_build_object('minutes', w.minutes,
        'succeeded', count(e.id) FILTER (WHERE e.category = 'call' AND e.state = 'succeeded'),
        'failed', count(e.id) FILTER (WHERE e.category = 'call' AND e.state = 'failed'),
        'unique', count(DISTINCT e.candidate_id) FILTER (WHERE e.category = 'call' AND e.state = 'succeeded'),
        'approve', count(e.id) FILTER (WHERE e.category = 'call' AND e.state = 'succeeded' AND e.decision = 'approve'),
        'reject', count(e.id) FILTER (WHERE e.category = 'call' AND e.state = 'succeeded' AND e.decision = 'reject'),
        'handoff', count(e.id) FILTER (WHERE e.category = 'call' AND e.state = 'succeeded' AND e.decision = 'needs_review'),
        'cancelled', count(e.id) FILTER (WHERE e.category = 'cancelled'),
        'reuse', count(e.id) FILTER (WHERE e.category = 'reuse'), 'rules', count(e.id) FILTER (WHERE e.category = 'rules')) AS value
      FROM (VALUES (5), (15), (60)) w(minutes) CROSS JOIN clock c
      LEFT JOIN ended e ON e.completed_at > c.at - w.minutes * interval '1 minute' GROUP BY w.minutes)
    SELECT jsonb_build_object('at', to_char(c.at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'sampled', (SELECT count(*) FROM sampled), 'truncated', (SELECT count(*) FROM tail) > ${FIRST_REVIEW_SAMPLE_LIMIT},
      'windows', (SELECT jsonb_agg(value ORDER BY minutes) FROM windows),
      'recent', coalesce((SELECT jsonb_agg(jsonb_build_object('id', r.id, 'candidateId', r.candidate_id,
        'provider', r.provider, 'model', r.model, 'state', r.state, 'decision', r.decision,
        'completedAt', to_char(r.completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ORDER BY r.completed_at DESC, r.id DESC)
        FROM (SELECT * FROM ended WHERE category = 'call' ORDER BY completed_at DESC, id DESC LIMIT 5) r), '[]'::jsonb)
    ) AS snapshot FROM clock c`;
}

const readCached = replicaCache<FirstReviewStatus>({ event: "operations.first_review_status_unavailable",
  ttlMs: FIRST_REVIEW_STATUS_TTL_MS, bypass: true, perMinute: 3,
  shared: { store: sharedStore, namespace: "admin:first-review-status:v1" } });

/** New status data stays on the replica. Hold/timeout/invalid data is unknown, never zero. */
export function readFirstReviewStatus(fresh = false): Promise<ReplicaRead<FirstReviewStatus>> {
  return readCached("recent", async replica => {
    const [row] = await replica.transaction(async tx => {
      await tx.execute(sql`SET LOCAL jit = off`);
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      return tx.execute<{ snapshot: unknown }>(firstReviewStatusSql());
    }, { accessMode: "read only" });
    return statusSchema.parse(row?.snapshot);
  }, fresh);
}
