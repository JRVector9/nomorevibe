import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlFrontier, crawlCandidates, crawlDocuments, githubDiscoveryPages } from '@/lib/db/schema';
import { assertJobLease, type JobLease } from '@/lib/jobs/control';
import { writerSiteActive } from '@/lib/operations/dr/epoch';
import { lockFrontierIdentity } from './repository';
import { readReviewBacklogInTransaction, reviewBacklogAdmission } from './review-backlog';
import { discoveryPageKey, projectDiscoverySearchValue, type DiscoverySearchIdentity } from './discovery-contract';
import type { GitHubResult } from './github';

export const DISCOVERY_PAGE_LEASE_MS = 90_000;
export type DiscoveryBusy = { ok: false; error: { kind: 'discovery_busy'; retryAt: Date } };
export type SharedDiscoveryResult<T> = (GitHubResult<T> & { cached?: boolean }) | DiscoveryBusy;
type SearchInput = DiscoverySearchIdentity & { lease?: JobLease; cleanup?: boolean };

/** No network runs inside these short claim/publish transactions. The immutable
 * cached page is not a coverage assertion: callers must still paginate and split.
 * Public-only callers share public-v1; other credential visibility needs a new scope.
 */
export async function sharedDiscoverySearch<T>(input: SearchInput,
  load: () => Promise<GitHubResult<T>>): Promise<SharedDiscoveryResult<T>> {
  const key = discoveryPageKey(input);
  if (input.scope === 'public-v1' && !/(?:^|\s)is:public(?:\s|$)/.test(input.query)) throw new Error('public_discovery_query_required');
  const token = randomUUID();
  const claimed = await db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new Error('discovery_writer_fenced');
    if (input.lease) await assertJobLease(tx, input.lease);
    // Bounded cleanup keeps the response cache from becoming an unbounded archive.
    if (input.cleanup) await tx.execute(sql`delete from ${githubDiscoveryPages} where key in (select key from ${githubDiscoveryPages}
      where updated_at < clock_timestamp()-interval '7 days' order by updated_at limit 20 for update skip locked)`);
    await tx.insert(githubDiscoveryPages).values({ key, kind: input.kind, query: input.query,
      sort: input.sort, page: input.page, scope: input.scope, generation: input.generation ?? 'v1',
      state: 'running', owner: token, ownerName: (input.ownerName ?? process.env.HOSTNAME ?? 'crawler').slice(0, 120),
      leaseUntil: sql`clock_timestamp() + ${DISCOVERY_PAGE_LEASE_MS} * interval '1 millisecond'`,
    }).onConflictDoNothing();
    const [row] = await tx.select().from(githubDiscoveryPages).where(eq(githubDiscoveryPages.key, key)).for('update');
    // Read wall time after the row lock, and compare timestamps in PostgreSQL.
    // Raw execute() timestamps are strings even when declared as Date in TS.
    const [timing] = await tx.execute<{ leaseActive: boolean; cacheFresh: boolean | null }>(sql`
      select lease_until > clock_timestamp() as "leaseActive",
        completed_at > clock_timestamp() - interval '1 minute' as "cacheFresh"
      from ${githubDiscoveryPages} where key = ${key}`);
    if (row.state === 'complete') {
      // A partial API response is reusable briefly, never frozen as complete coverage.
      const incomplete = (row.result as { incomplete_results?: unknown } | null)?.incomplete_results === true;
      if (!incomplete || timing.cacheFresh)
        return { cached: row.result as T };
    } else if (row.owner !== token && timing.leaseActive) return { busy: row.leaseUntil };
    await tx.update(githubDiscoveryPages).set({ owner: token, state: 'running', result: null, completedAt: null,
      ownerName: (input.ownerName ?? process.env.HOSTNAME ?? 'crawler').slice(0, 120),
      leaseUntil: sql`clock_timestamp() + ${DISCOVERY_PAGE_LEASE_MS} * interval '1 millisecond'`, updatedAt: sql`clock_timestamp()`,
    }).where(eq(githubDiscoveryPages.key, key));
    return { owned: true };
  });
  if ('cached' in claimed) return { ok: true, value: claimed.cached!, cached: true };
  if ('busy' in claimed) return { ok: false, error: { kind: 'discovery_busy', retryAt: claimed.busy! } };
  let result: GitHubResult<T>;
  try { result = await load(); }
  catch (error) { await releasePage(key, token); throw error; }
  if (!result.ok) { await releasePage(key, token); return result; }
  if (!result.value || typeof result.value !== 'object' || !('items' in result.value) || !Array.isArray(result.value.items)
    || Buffer.byteLength(JSON.stringify(result.value)) > 2 * 1024 * 1024) {
    await releasePage(key, token);
    return { ok: false, error: { kind: 'invalid_response' } };
  }
  const value = projectDiscoverySearchValue(input.kind, result.value) as T;
  const published = await db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new Error('discovery_writer_fenced');
    if (input.lease) await assertJobLease(tx, input.lease);
    return tx.update(githubDiscoveryPages).set({ state: 'complete', result: value,
      completedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(githubDiscoveryPages.key, key), eq(githubDiscoveryPages.owner, token),
        eq(githubDiscoveryPages.state, 'running'), sql`${githubDiscoveryPages.leaseUntil}>clock_timestamp()`))
      .returning({ key: githubDiscoveryPages.key });
  });
  return published.length ? { ok:true, value, cached: false }
    : { ok: false, error: { kind: 'discovery_busy', retryAt: new Date(Date.now() + 60_000) } };
}
async function releasePage(key: string, token: string) {
  await db.transaction(async tx=>{
    if (!await writerSiteActive(tx)) return;
    await tx.update(githubDiscoveryPages).set({ leaseUntil: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(githubDiscoveryPages.key, key), eq(githubDiscoveryPages.owner, token), eq(githubDiscoveryPages.state, 'running')));
  });
}

export type DiscoveryEntry = { repo: string; signal: string; builder?: string | null; priority?: number };
export type DiscoveryLimits = { maxNewPerHour: number; maxReviewBacklog: number };

/** Both producers commit through the same admission lock. Re-read capacity after
 * acquiring it; existing repositories spend no quota. This reserves and confirms
 * only actual insertions in one transaction, so no abandoned reservation exists.
 */
export async function enqueueDiscoveryBatch(entries: DiscoveryEntry[], limits: DiscoveryLimits, lease?: JobLease)
  : Promise<{ added: number; processed: number; remainingNew: number }> {
  if (![limits.maxNewPerHour, limits.maxReviewBacklog].every(n => Number.isSafeInteger(n) && n >= 1))
    throw new Error('invalid_discovery_limits');
  if (entries.some(e => !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(e.repo) || e.repo.length > 200))
    throw new Error('invalid_discovery_repository');
  if (!entries.length) return { added: 0, processed: 0, remainingNew: 0 };
  return db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new Error('discovery_writer_fenced');
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('github-discovery-admission-v1'))`);
    // Keep lock ordering the same as enqueue(): identity locks before the job fence.
    const keys = [...new Set(entries.map(e => e.repo.toLowerCase()))].sort();
    for (const key of keys) await lockFrontierIdentity(tx, key);
    const [clock] = await tx.execute<{ wall: string }>(sql`select to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as wall`);
    const snapshot = await readReviewBacklogInTransaction(tx, clock.wall, Date.now() + 3_000);
    const admission = reviewBacklogAdmission(snapshot, limits.maxNewPerHour, limits.maxReviewBacklog);
    const known = (column:typeof crawlFrontier.repo | typeof crawlDocuments.repo | typeof crawlCandidates.repo) => inArray(sql`lower(${column})`,keys);
    const rows = await tx.select({repo:sql<string>`lower(${crawlFrontier.repo})`}).from(crawlFrontier).where(known(crawlFrontier.repo))
      .union(tx.select({repo:sql<string>`lower(${crawlDocuments.repo})`}).from(crawlDocuments).where(known(crawlDocuments.repo)))
      .union(tx.select({repo:sql<string>`lower(${crawlCandidates.repo})`}).from(crawlCandidates).where(known(crawlCandidates.repo)));
    const existing = new Set(rows.map(r => r.repo.toLowerCase()));
    const accepted: DiscoveryEntry[] = [];
    let processed = 0;
    for (const entry of entries) {
      const key = entry.repo.toLowerCase();
      if (!existing.has(key)) {
        if (accepted.length >= admission.remainingNew) break;
        accepted.push(entry); existing.add(key);
      }
      processed++;
    }
    const inserted = accepted.length ? await tx.insert(crawlFrontier).values(accepted.map(e => ({
      repo: e.repo, signal: e.signal, builder: e.builder ?? null, priority: e.priority ?? 0,
    }))).onConflictDoNothing({ target: crawlFrontier.repo }).returning({ id: crawlFrontier.id }) : [];
    if (lease) await assertJobLease(tx, lease);
    return { added: inserted.length, processed, remainingNew: Math.max(0, admission.remainingNew - inserted.length) };
  });
}
