import { sql } from 'drizzle-orm';
import { KoreanQuerySchema } from '@/lib/crawl/korean-discovery/contracts';
import { DB_CLOCK_SQL, replicaCache } from './replica-cache';

export type KoreanDiscoveryStatus = {
  at: string; enabled: boolean; startAt: string | null; epoch: number; collectionEnabled: boolean;
  principalReady: boolean; queries: { label: string; query: string }[]; activeQueries: number;
  heartbeatAt: string | null; tickAt: string | null; pending: number; pendingTruncated: boolean;
  queryErrors: number; nextRetryAt: string | null; state: 'disabled' | 'blocked' | 'unconfirmed' | 'observed';
  blockers: string[];
};

const iso = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const nonnegative = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
/** Configuration, liveness and useful work are separate: an enabled switch never proves a running worker. */
export function buildKoreanDiscoveryStatus(source: {
  at: string; enabled: boolean; startAt: string | null; epoch: number; collectionEnabled: boolean;
  principalReady: boolean; queries: unknown; activeQueries: number; heartbeatAt: string | null;
  tickAt: string | null; pending: number; queryErrors: number; nextRetryAt: string | null;
}): KoreanDiscoveryStatus {
  const parsed = KoreanQuerySchema.array().max(30).safeParse(source.queries);
  if (!parsed.success || !Number.isFinite(Date.parse(source.at)) || !Number.isSafeInteger(source.epoch) || source.epoch < 1)
    throw new Error('invalid_korean_discovery_status');
  const heartbeatAt = iso(source.heartbeatAt), tickAt = iso(source.tickAt), startAt = iso(source.startAt);
  const fresh = heartbeatAt !== null && Date.parse(source.at) - Date.parse(heartbeatAt) >= 0 && Date.parse(source.at) - Date.parse(heartbeatAt) <= 90_000;
  const blockers: string[] = [];
  if (!source.enabled) blockers.push('disabled');
  if (!source.collectionEnabled) blockers.push('collection_disabled');
  if (!startAt) blockers.push('start_missing');
  if (!source.principalReady) blockers.push('principal_missing');
  if (!source.activeQueries) blockers.push('queries_not_transferred');
  if (!fresh) blockers.push('heartbeat_unconfirmed');
  if (source.queryErrors) blockers.push('query_retry');
  return { at: source.at, enabled: source.enabled, startAt, epoch: source.epoch, collectionEnabled: source.collectionEnabled,
    principalReady: source.principalReady, queries: parsed.data.map(({ label, query }) => ({ label, query })),
    activeQueries: nonnegative(source.activeQueries), heartbeatAt, tickAt,
    pending: Math.min(10_000, nonnegative(source.pending)), pendingTruncated: source.pending > 10_000,
    queryErrors: nonnegative(source.queryErrors), nextRetryAt: iso(source.nextRetryAt), blockers,
    state: !source.enabled ? 'disabled' : !source.collectionEnabled || !startAt || !source.principalReady ? 'blocked' : !fresh ? 'unconfirmed' : 'observed' };
}

const cache = replicaCache<KoreanDiscoveryStatus>({ event: 'operations.korean_discovery_status_unavailable', ttlMs: 15_000, bypass: true, perMinute: 4 });
/** Replica-only and bounded; query failure is unknown, never disabled or zero. */
export function readKoreanDiscoveryStatus(fresh = false) {
  return cache('v1', async replica => {
    const [row] = await replica.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '3s'`);
      return tx.execute<Parameters<typeof buildKoreanDiscoveryStatus>[0]>(sql`
        SELECT ${DB_CLOCK_SQL} AS at, c.enabled,
          to_char(c.start_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "startAt", c.epoch, c.queries,
          coalesce((SELECT (values->>'enabled')::boolean FROM crawl_settings WHERE id=1),false) AS "collectionEnabled",
          EXISTS(SELECT 1 FROM pg_roles WHERE rolname='nomorevibe_oracle_github_ko' AND rolcanlogin) AS "principalReady",
          (SELECT count(*)::integer FROM github_ko_discovery_queries WHERE enabled AND transferred) AS "activeQueries",
          (SELECT to_char(max(least(observed_at, CASE WHEN value->>'lastHeartbeatAt' ~ '^[0-9]{13}$'
            THEN to_timestamp((value->>'lastHeartbeatAt')::double precision/1000) AT TIME ZONE 'UTC' END)), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM operations_observations
            WHERE key LIKE 'service:crawler:github-ko-discovery-consumer-%' AND value->>'status'='running'
              AND value->>'lastHeartbeatAt' ~ '^[0-9]{13}$') AS "heartbeatAt",
          (SELECT to_char(max(observed_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM operations_observations
            WHERE key LIKE 'github-ko-discovery:github-ko-discovery-consumer-%') AS "tickAt",
          (SELECT count(*)::integer FROM (SELECT repo FROM github_ko_discovery_staging WHERE state='pending' LIMIT 10001) p) AS pending,
          (SELECT count(*)::integer FROM github_ko_discovery_queries WHERE enabled AND last_error IS NOT NULL) AS "queryErrors",
          (SELECT to_char(min(due_at), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') FROM github_ko_discovery_queries WHERE enabled AND last_error IS NOT NULL) AS "nextRetryAt"
        FROM github_ko_discovery_control c WHERE c.id=1`);
    }, { accessMode: 'read only' });
    if (!row) throw new Error('korean_discovery_control_missing');
    return buildKoreanDiscoveryStatus(row);
  }, fresh);
}
