import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { assertJobLeaseAtWallTime, type JobLease } from '@/lib/jobs/control';
import { db } from '@/lib/db';
import { writerSiteActive } from '@/lib/operations/dr/epoch';
import type { CrawlSettings } from '@/lib/crawl/settings-schema';
import { KoreanCursorSchema, KoreanQuerySchema, firstKoreanCursor, isKoreanRepositoryQuery, resumeKoreanCursor, KOREAN_QUERY_LEASE_MS, KOREAN_STAGING_MAX_PENDING, type KoreanCursor, type KoreanQuery } from './contracts';
import type { KoreanLanguageResult } from './language';

export type KoreanQueryClaim = KoreanQuery & { token: string; epoch: number; controlEpoch: number; cursor: KoreanCursor; windowDays: number };
export type KoreanStagedRepository = { repo: string; signal: string; priority: number; description: string | null };
const queryHash = (query: string) => createHash('sha256').update(query).digest('hex');

/**
 * Home controller hands the enabled Korean repository queries to Oracle. M3 never searches them (m3DiscoveryQueries);
 * any original M3 cursor is retained verbatim in legacy_state for audit.
 */
export async function synchronizeKoreanQueries(settings: CrawlSettings, lease?: JobLease): Promise<void> {
  await db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return;
    if (lease) await assertJobLeaseAtWallTime(tx, lease);
    // Raw execute results do not apply Drizzle timestamp-column decoders. Read an epoch to keep the historical UTC boundary explicit.
    const [control] = await tx.execute<{ enabled: boolean; start_at_ms: number | null; queries: unknown }>(sql`SELECT enabled,
      (extract(epoch FROM start_at) * 1000)::double precision AS start_at_ms, queries FROM github_ko_discovery_control WHERE id=1 FOR SHARE`);
    if (!control?.enabled || control.start_at_ms === null || !settings.enabled) return;
    const selected = settings.discover.queries.filter(q => q.enabled && isKoreanRepositoryQuery(q)).map(q => ({label:q.label,query:q.query,priority:q.priority}));
    const configured = KoreanQuerySchema.array().max(30).parse(control.queries);
    const normalized = (query:string)=>query.trim().replace(/\s+/g,' ').toLowerCase();
    for (const query of configured) {
      if (!/[가-힣]/.test(query.query)) throw new Error('korean_query_requires_hangul');
      if (!selected.some(q=>q.label===query.label || normalized(q.query)===normalized(query.query))
        && !settings.discover.queries.some(q=>!q.enabled && normalized(q.query)===normalized(query.query))) selected.push(query);
    }
    const [job] = await tx.execute<{ cursor: { states?: Record<string, unknown>; signal?: string; window?: unknown; page?: number; pendingWindows?: unknown[]; incompleteWindows?:{signal:string;window:unknown;retryAt?:string}[]; retryAt?:string; searchSort?:string } | null }>(sql`SELECT cursor FROM jobs WHERE name='crawl-seed' FOR SHARE`);
    for (const query of selected) {
      const legacy = job?.cursor?.states?.[query.label] ?? (job?.cursor?.signal === query.label ? job.cursor : null);
      const parsed = KoreanCursorSchema.safeParse(legacy && typeof legacy === 'object' ? { window: (legacy as Record<string, unknown>).window,
        page: (legacy as Record<string, unknown>).page, pendingWindows: [...((legacy as {pendingWindows?:unknown[]}).pendingWindows ?? []), ...(job?.cursor?.incompleteWindows ?? []).filter(w=>w.signal===query.label).map(w=>w.window)],
        ...((legacy as Record<string,unknown>).windowIncomplete ? {unresolved:true} : {}),
        ...(job?.cursor?.retryAt ? {waitingUntil:job.cursor.retryAt} : {}) } : null);
      // A sort change makes page offsets incomparable. Preserve the fixed interval and replay from page one.
      const cursor = parsed.success ? {...parsed.data,page:job?.cursor?.searchSort==='recent' ? parsed.data.page : 1} : firstKoreanCursor(new Date(control.start_at_ms), settings.discover.windowDays, new Date());
      await tx.execute(sql`INSERT INTO github_ko_discovery_queries (label,query,priority,transferred,cursor,legacy_state,config_hash,due_at)
        VALUES (${query.label},${query.query},${query.priority},true,${JSON.stringify(cursor)}::jsonb,${JSON.stringify(legacy)}::jsonb,${queryHash(query.query)},coalesce(${cursor.waitingUntil ?? null}::timestamp,now()))
        ON CONFLICT (label) DO UPDATE SET enabled=true,priority=excluded.priority,transferred=true,
          query=excluded.query,config_hash=excluded.config_hash,
          cursor=CASE WHEN github_ko_discovery_queries.config_hash=excluded.config_hash THEN github_ko_discovery_queries.cursor ELSE excluded.cursor END,
          legacy_state=CASE WHEN github_ko_discovery_queries.config_hash=excluded.config_hash THEN github_ko_discovery_queries.legacy_state
            ELSE jsonb_build_object('previousQuery',github_ko_discovery_queries.query,'previousCursor',github_ko_discovery_queries.cursor,'imported',excluded.legacy_state) END,
          due_at=CASE WHEN github_ko_discovery_queries.config_hash=excluded.config_hash THEN github_ko_discovery_queries.due_at ELSE excluded.due_at END,
          token=CASE WHEN github_ko_discovery_queries.config_hash=excluded.config_hash THEN github_ko_discovery_queries.token ELSE NULL END,
          lease_until=CASE WHEN github_ko_discovery_queries.config_hash=excluded.config_hash THEN github_ko_discovery_queries.lease_until ELSE NULL END,
          updated_at=now()`);
    }
    const labels = selected.map(q => q.label);
    await tx.execute(sql`UPDATE github_ko_discovery_queries SET enabled=false,transferred=false,updated_at=now()
      WHERE enabled AND NOT (${labels.length ? sql`label IN (${sql.join(labels.map(label=>sql`${label}`),sql`,`)})` : sql`false`})`);
  });
}

export async function koreanDiscoveryEnabled(): Promise<boolean> {
  const [control] = await db.execute<{enabled:boolean}>(sql`SELECT enabled FROM github_ko_discovery_control WHERE id=1`);
  return Boolean(control?.enabled);
}

export async function claimKoreanQuery(windowDays: number): Promise<KoreanQueryClaim | null> {
  return db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return null;
    const [control] = await tx.execute<{ epoch: number; enabled: boolean }>(sql`SELECT epoch,enabled FROM github_ko_discovery_control WHERE id=1 FOR SHARE`);
    if (!control?.enabled) return null;
    const token = randomUUID();
    const [row] = await tx.execute<{ label: string; query: string; priority: number; epoch: number; cursor: unknown }>(sql`
      UPDATE github_ko_discovery_queries SET token=${token}::uuid,epoch=epoch+1,
        lease_until=now()+${KOREAN_QUERY_LEASE_MS}*interval '1 millisecond',updated_at=now()
      WHERE label=(SELECT label FROM github_ko_discovery_queries WHERE enabled AND transferred AND due_at<=now()
        AND (lease_until IS NULL OR lease_until<=now()) ORDER BY due_at,label FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING label,query,priority,epoch,cursor`);
    if (!row) return null;
    const cursor = resumeKoreanCursor(KoreanCursorSchema.parse(row.cursor),windowDays,new Date());
    return { label: row.label, query: row.query, priority: row.priority, token, epoch: row.epoch, controlEpoch: control.epoch, cursor, windowDays };
  });
}

export async function stageKoreanPage(claim: KoreanQueryClaim, repositories: KoreanStagedRepository[], cursor: KoreanCursor): Promise<boolean> {
  return db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return false;
    const [control] = await tx.execute<{ epoch: number; enabled: boolean }>(sql`SELECT epoch,enabled FROM github_ko_discovery_control WHERE id=1 FOR SHARE`);
    if (!control?.enabled || control.epoch !== claim.controlEpoch) return false;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('github-ko-staging-cap-v1'))`);
    const [capacity] = await tx.execute<{remaining:number}>(sql`SELECT greatest(0,${KOREAN_STAGING_MAX_PENDING}-count(*)::integer) AS remaining FROM github_ko_discovery_staging WHERE state='pending'`);
    const keys=[...new Set(repositories.map(row=>row.repo.toLowerCase()))];
    const known=keys.length ? await tx.execute<{repo:string}>(sql`SELECT repo FROM github_ko_discovery_staging WHERE repo IN (${sql.join(keys.map(key=>sql`${key}`),sql`,`)} )`) : [];
    if (keys.length-known.length > capacity.remaining) return false;
    const [owned] = await tx.execute(sql`SELECT label FROM github_ko_discovery_queries WHERE label=${claim.label} AND token=${claim.token}::uuid
      AND epoch=${claim.epoch} AND lease_until>now() AND enabled AND transferred FOR UPDATE`);
    if (!owned) return false;
    for (const row of repositories) await tx.execute(sql`INSERT INTO github_ko_discovery_staging (repo,signal,priority,description)
      VALUES (${row.repo.toLowerCase()},${row.signal},${row.priority},${row.description?.slice(0,4000) ?? null}) ON CONFLICT (repo) DO NOTHING`);
    await tx.execute(sql`UPDATE github_ko_discovery_queries SET cursor=${JSON.stringify(cursor)}::jsonb,token=NULL,lease_until=NULL,
      due_at=coalesce(${cursor.waitingUntil ?? null}::timestamp,now()),last_error=NULL,updated_at=now() WHERE label=${claim.label}`);
    return true;
  });
}

export async function deferKoreanQuery(claim: KoreanQueryClaim, dueAt: Date, reason: string): Promise<void> {
  await db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return;
    const [control]=await tx.execute<{enabled:boolean;epoch:number}>(sql`SELECT enabled,epoch FROM github_ko_discovery_control WHERE id=1 FOR SHARE`);
    if (!control?.enabled || control.epoch!==claim.controlEpoch) return;
    await tx.execute(sql`UPDATE github_ko_discovery_queries SET token=NULL,lease_until=NULL,due_at=${dueAt.toISOString()}::timestamp,last_error=${reason.slice(0,100)},updated_at=now()
      WHERE label=${claim.label} AND token=${claim.token}::uuid AND epoch=${claim.epoch} AND lease_until>now()`);
  });
}

export async function koreanLanguageBatch(limit=5): Promise<KoreanStagedRepository[]> {
  const rows = await db.execute<{ repo: string; signal: string; priority: number; description: string | null }>(sql`
    SELECT repo,signal,priority,description FROM github_ko_discovery_staging
    WHERE state='pending' AND language='unknown' AND due_at<=now() ORDER BY due_at,repo LIMIT ${limit}`);
  return [...rows];
}
export async function saveKoreanLanguage(repo: string, result: KoreanLanguageResult): Promise<void> {
  await db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return;
    await tx.execute(sql`UPDATE github_ko_discovery_staging SET language=${result.language},evidence=${JSON.stringify(result)}::jsonb,
      checked_at=now(),due_at=now()+interval '15 minutes',updated_at=now() WHERE repo=${repo} AND state='pending' AND language='unknown'
      AND EXISTS (SELECT 1 FROM github_ko_discovery_control WHERE id=1 AND enabled)`);
  });
}

/** Reuse bounded completed public repository pages without another GitHub search. Only Hangul-bearing descriptions enter language staging. */
export async function importSharedKoreanCandidates(): Promise<number> {
  return db.transaction(async tx => {
    if (!await writerSiteActive(tx)) return 0;
    const [control] = await tx.execute<{enabled:boolean;shared_cursor:{at?:string;key?:string}|null}>(sql`SELECT enabled,shared_cursor FROM github_ko_discovery_control WHERE id=1 FOR UPDATE`);
    if (!control?.enabled) return 0;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('github-ko-staging-cap-v1'))`);
    const [count] = await tx.execute<{total:number}>(sql`SELECT count(*)::integer AS total FROM github_ko_discovery_staging WHERE state='pending'`);
    // A cached page contains at most 100 candidates. Reserve a full page under the same lock as direct staging.
    if (count.total > KOREAN_STAGING_MAX_PENDING - 100) return 0;
    const pages = await tx.execute<{key:string;completed_at_key:string;result:{items?:{full_name?:string;description?:string|null}[]}}>(sql`
      SELECT key,completed_at::text AS completed_at_key,result FROM github_discovery_pages WHERE state='complete' AND kind='repositories' AND scope='public-v1'
        AND (completed_at,key) > (${control.shared_cursor?.at ?? '1970-01-01T00:00:00.000000'}::timestamp,${control.shared_cursor?.key ?? ''})
      ORDER BY completed_at,key LIMIT 1`);
    let staged=0;
    for (const page of pages) {
      if (Array.isArray(page.result?.items)) for (const item of page.result.items.slice(0,100)) {
        if (!item || !item.full_name || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.full_name) || !/[가-힣]/.test(item.description ?? '')) continue;
        const inserted=await tx.execute(sql`INSERT INTO github_ko_discovery_staging (repo,signal,priority,description)
          VALUES (${item.full_name.toLowerCase()},'공유 GitHub 한국어 후보',50,${item.description?.slice(0,4000) ?? null}) ON CONFLICT (repo) DO NOTHING RETURNING repo`);
        staged+=inserted.length;
      }
      await tx.execute(sql`UPDATE github_ko_discovery_control SET shared_cursor=${JSON.stringify({at:page.completed_at_key,key:page.key})}::jsonb WHERE id=1`);
    }
    return staged;
  });
}
