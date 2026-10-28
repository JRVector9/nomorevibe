import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { logger } from "@/lib/observability/logger";
import { DISCOVERY_PROGRESS_COUNTERS, DISCOVERY_PROGRESS_PREFIX, type DiscoveryProgressCounter } from "./discovery-progress-contract";
export type DiscoveryProgressInput = {
  worker: string;
  lane: "latest" | "full" | "korean";
  signal: string;
  window?: { from: string; to: string };
  page?: number;
  /** Only a fully processed range can advance this watermark. */
  completedThrough?: string;
  counts: Partial<Record<DiscoveryProgressCounter, number>>;
  blockedBy?: "queue_cap" | "rate_cap" | "api_wait" | "auth" | "incomplete" | "measurement_unknown" | null;
};

const iso = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const label = (value: string, fallback: string) => /^[\p{L}\p{N} .:_/-]{1,96}$/u.test(value) ? value : fallback;

/** Bounded factual projection. Search strings, commit messages and credentials never enter these observations. */
export function discoveryProgressValue(input: DiscoveryProgressInput) {
  const counts = Object.fromEntries(DISCOVERY_PROGRESS_COUNTERS.flatMap(key => {
    const count = input.counts[key];
    return Number.isSafeInteger(count) && count! >= 0 ? [[key, Math.min(1_000_000_000, count!)]] : [];
  }));
  const from = iso(input.window?.from), to = iso(input.window?.to);
  const completed = iso(input.completedThrough);
  return { v: 1, worker: label(input.worker, "unknown-worker"), lane: input.lane, signal: label(input.signal, "unknown-signal"),
    window: from && to && from <= to ? { from, to } : null,
    page: Number.isSafeInteger(input.page) && input.page! >= 1 && input.page! <= 10 ? input.page : null,
    completedThrough: completed && (!to || completed <= to) ? completed : null,
    blockedBy: input.blockedBy ?? null, counts };
}

export function discoveryProgressKey(input: DiscoveryProgressInput) {
  const value = discoveryProgressValue(input);
  const hash = (text: string, length: number) => createHash("sha256").update(text).digest("hex").slice(0, length);
  return `${DISCOVERY_PROGRESS_PREFIX}${value.lane}:${hash(value.worker, 16)}:${hash(value.signal, 24)}`;
}

/** One atomic counter row per worker/lane/signal; minute buckets retain at most 61 minutes. */
export function discoveryProgressUpsert(input: DiscoveryProgressInput) {
  const value = discoveryProgressValue(input);
  const key = discoveryProgressKey(input);
  const progress = (value.counts.pagesVisited ?? 0) > 0 || (value.counts.examined ?? 0) > 0;
  return sql`WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at),
    tick AS (SELECT ${JSON.stringify(value)}::jsonb AS v), added AS (
      SELECT to_char(date_trunc('minute', clock.at), 'YYYY-MM-DD"T"HH24:MI') || '|' || c.key AS k, c.value::bigint AS n
      FROM clock, tick, LATERAL jsonb_each_text(tick.v->'counts') c)
    INSERT INTO operations_observations (key, value, observed_at)
    SELECT ${key}, (tick.v - 'counts') || jsonb_build_object(
      'at', to_char(clock.at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'lastProgressAt', CASE WHEN ${progress} THEN to_char(clock.at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
      'pendingSince', CASE WHEN tick.v->>'completedThrough' IS NULL THEN to_char(clock.at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') ELSE NULL END,
      'counts', coalesce((SELECT jsonb_object_agg(k, n) FROM added), '{}'::jsonb)), clock.at FROM clock, tick
    ON CONFLICT (key) DO UPDATE SET observed_at = excluded.observed_at, value =
      (excluded.value - 'counts') || jsonb_build_object(
        'lastProgressAt', CASE WHEN ${progress} THEN excluded.value->'at' ELSE operations_observations.value->'lastProgressAt' END,
        'completedThrough', coalesce(excluded.value->>'completedThrough', operations_observations.value->>'completedThrough'),
        'pendingSince', CASE WHEN excluded.value->>'completedThrough' IS NOT NULL THEN NULL ELSE
          coalesce(operations_observations.value->>'pendingSince', excluded.value->>'at') END,
        'counts', (SELECT coalesce(jsonb_object_agg(kept.k, kept.n), '{}'::jsonb) FROM (
          SELECT merged.k, least(sum(merged.n), 1000000000000)::bigint AS n FROM (
            SELECT p.key AS k, p.value::bigint AS n FROM jsonb_each_text(
              CASE WHEN jsonb_typeof(operations_observations.value->'counts') = 'object' THEN operations_observations.value->'counts' ELSE '{}'::jsonb END) p
            WHERE p.key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}[|][a-zA-Z]+$' AND p.value ~ '^[0-9]{1,13}$'
            UNION ALL SELECT p.key, p.value::bigint FROM jsonb_each_text(excluded.value->'counts') p
          ) merged WHERE merged.k >= to_char(excluded.observed_at - interval '60 minutes', 'YYYY-MM-DD"T"HH24:MI')
          GROUP BY merged.k) kept))`;
}

/** Metrics cannot roll back successful discovery or replace its failure reason. */
export async function recordDiscoveryProgress(input: DiscoveryProgressInput): Promise<void> {
  try { await db.execute(discoveryProgressUpsert(input)); }
  catch { logger.warn("crawl.discovery_progress_unavailable", { lane: input.lane }); }
}
