import { sql } from "drizzle-orm";
import { replicaCache } from "./replica-cache";
import { DB_CLOCK_SQL } from "./replica-cache";
import { DISCOVERY_PROGRESS_COUNTERS, DISCOVERY_PROGRESS_PREFIX, type DiscoveryProgressCounter } from "@/lib/crawl/discovery-progress-contract";

export type DiscoveryProgressRow = {
  worker: string; lane: "latest" | "full" | "korean"; signal: string;
  observedAt: string; lastProgressAt: string | null; pendingSince: string | null;
  window: { from: string; to: string } | null; page: number | null;
  completedThrough: string | null; lagMinutes: number | null; blockedBy: string | null;
  hour: Record<DiscoveryProgressCounter, number>;
};
export type DiscoveryProgressReport = { at: string; rows: DiscoveryProgressRow[]; truncated: boolean };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const iso = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const label = (value: unknown) => typeof value === "string" && /^[\p{L}\p{N} .:_/-]{1,96}$/u.test(value) ? value : null;
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const BLOCKERS = new Set(["queue_cap", "rate_cap", "api_wait", "auth", "incomplete", "measurement_unknown"]);

/** Ignore malformed/unrecognised fields rather than rendering arbitrary observation contents. */
export function buildDiscoveryProgress(at: string, source: unknown, truncated = false): DiscoveryProgressReport {
  const now = Date.parse(at);
  const rows: DiscoveryProgressRow[] = [];
  if (!Number.isFinite(now) || !Array.isArray(source)) return { at, rows, truncated };
  const since = Math.floor(now / 60_000) * 60_000 - 60 * 60_000;
  for (const raw of source) {
    if (!object(raw) || typeof raw.key !== "string" || !raw.key.startsWith(DISCOVERY_PROGRESS_PREFIX) || !object(raw.value)) continue;
    const v = raw.value;
    const worker = label(v.worker), signal = label(v.signal), observedAt = iso(v.at);
    if (v.v !== 1 || !worker || !signal || !observedAt || !["latest", "full", "korean"].includes(String(v.lane))) continue;
    const hour = Object.fromEntries(DISCOVERY_PROGRESS_COUNTERS.map(key => [key, 0])) as Record<DiscoveryProgressCounter, number>;
    for (const [key, number] of Object.entries(object(v.counts) ? v.counts : {})) {
      const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})\|([a-zA-Z]+)$/.exec(key);
      if (!match || !(DISCOVERY_PROGRESS_COUNTERS as readonly string[]).includes(match[2]) || count(number) === null) continue;
      const start = Date.parse(`${match[1]}:00Z`);
      if (!Number.isFinite(start) || start < since || start > now + 60_000) continue;
      hour[match[2] as DiscoveryProgressCounter] += number as number;
    }
    const from = object(v.window) ? iso(v.window.from) : null;
    const to = object(v.window) ? iso(v.window.to) : null;
    const completedThrough = iso(v.completedThrough);
    rows.push({ worker, signal, lane: v.lane as DiscoveryProgressRow["lane"], observedAt,
      lastProgressAt: iso(v.lastProgressAt), pendingSince: iso(v.pendingSince),
      window: from && to && from <= to ? { from, to } : null,
      page: count(v.page) !== null && Number(v.page) >= 1 && Number(v.page) <= 10 ? Number(v.page) : null,
      completedThrough, lagMinutes: completedThrough ? Math.max(0, Math.floor((now - Date.parse(completedThrough)) / 60_000)) : null,
      blockedBy: typeof v.blockedBy === "string" && BLOCKERS.has(v.blockedBy) ? v.blockedBy : null, hour });
  }
  rows.sort((a, b) => a.worker.localeCompare(b.worker) || a.lane.localeCompare(b.lane) || a.signal.localeCompare(b.signal));
  return { at, rows, truncated };
}

const cache = replicaCache<DiscoveryProgressReport>({ event: "operations.discovery_progress_unavailable", ttlMs: 15_000, bypass: true, perMinute: 4 });

/** Replica only, bounded 3s statement, no primary fallback when observations are unavailable. */
export function readDiscoveryProgress(fresh = false) {
  return cache("v1", async replica => {
    const [row] = await replica.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      return tx.execute<{ at: string; rows: unknown; truncated: boolean }>(sql`
        SELECT ${DB_CLOCK_SQL} AS at,
          (SELECT count(*) > 512 FROM operations_observations WHERE key LIKE 'discovery-progress:%') AS truncated,
          coalesce((SELECT jsonb_agg(jsonb_build_object('key', key, 'value', value)) FROM (
            SELECT key, value FROM operations_observations WHERE key LIKE 'discovery-progress:%'
            ORDER BY observed_at DESC LIMIT 512) recent), '[]'::jsonb) AS rows`);
    }, { accessMode: "read only" });
    return buildDiscoveryProgress(row.at, row.rows, row.truncated);
  }, fresh);
}
