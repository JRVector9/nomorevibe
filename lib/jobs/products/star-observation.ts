import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products, productStarObservationRuns, productStarObservations, type ProductStarObservation, type ProductStarObservationRun } from '@/lib/db/schema';
import { checkRepositories, REPOSITORY_BATCH, type RepositoryBatchResult, type RepositoryRef } from '@/lib/crawl/github-repositories';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { listedByDefault, notDown } from '@/lib/domain/products/repository';
import { nextStarObservationCycleAt, observationRepositoryKey, STAR_OBSERVATION_POLICY, STAR_OBSERVATION_POLICY_VERSION } from '@/lib/domain/products/star-observation-policy';
import { assertJobLease } from '@/lib/jobs/control';
import { assertRoleLease, roleLeaseFromEnv, type RoleLease } from '@/lib/jobs/role-leader';
import type { JobContext, JobOutcome } from '@/lib/jobs/runner';

export type StarObservationCursor = { cycleAt: string; retryAfter: string };
type Check = (repos: RepositoryRef[], options: { timeoutMs: number; deadlineAt?: number }) => Promise<RepositoryBatchResult>;
const MAX_ATTEMPTS = 3;
const BATCHES = 8;
const START_WITHIN_MS = 28_000;
const RETRY_MS = 2 * 60_000;
const MIN_REMAINING = 200;
const PUBLIC = ['seeded', 'verified'] as const;
const HOUR_MS = 60 * 60_000;

async function databaseNow(tx: ProductTransaction | typeof db = db): Promise<Date> {
  const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
  return new Date(clock.now);
}

async function assertOwnership(tx: ProductTransaction, ctx: JobContext<StarObservationCursor>, roleLease?: RoleLease) {
  // Election takes the role lock before revoking job tokens; keep that lock order.
  if (roleLease) await assertRoleLease(tx, roleLease);
  if (ctx.lease) await assertJobLease(tx, ctx.lease);
}

async function countRun(tx: ProductTransaction, runId: number) {
  await tx.execute(sql`update product_star_observation_runs r set
    success_count = (select count(*)::int from product_star_observations o where o.run_id = r.id and o.status = 'ok'),
    failure_count = (select count(*)::int from product_star_observations o where o.run_id = r.id and o.status not in ('pending','ok'))
    where r.id = ${runId} and r.status in ('preparing','collecting')`);
}

/** Closing owns the same run lock as result writes. A late response cannot reopen it. */
async function closeExpiredRuns(ctx: JobContext<StarObservationCursor>, roleLease?: RoleLease) {
  return db.transaction(async tx => {
    await assertOwnership(tx, ctx, roleLease);
    const expired = await tx.select().from(productStarObservationRuns).where(and(
      inArray(productStarObservationRuns.status, ['preparing', 'collecting']),
      sql`${productStarObservationRuns.deadlineAt} <= clock_timestamp()`,
    )).orderBy(productStarObservationRuns.cycleAt).limit(3).for('update');
    for (const run of expired) {
      await tx.update(productStarObservations).set({ status: 'failed', stars: null, observedAt: null,
        errorClass: 'deadline', nextAttemptAt: null }).where(and(
        eq(productStarObservations.runId, run.id), eq(productStarObservations.status, 'pending'),
      ));
      await countRun(tx, run.id);
      await tx.update(productStarObservationRuns).set({ status: run.status === 'preparing' ? 'failed' : 'closed', closedAt: sql`clock_timestamp()` })
        .where(eq(productStarObservationRuns.id, run.id));
    }
    return expired.length;
  });
}

/** The complete target set and policy become visible in one commit, never per resumed tick. */
async function prepareRun(ctx: JobContext<StarObservationCursor>, cycleAt: Date, roleLease?: RoleLease): Promise<ProductStarObservationRun | null> {
  return db.transaction(async tx => {
    await assertOwnership(tx, ctx, roleLease);
    const now = await databaseNow(tx);
    const [existing] = await tx.select().from(productStarObservationRuns).where(eq(productStarObservationRuns.cycleAt, cycleAt));
    if (existing) return existing;
    const windowStartsAt = new Date(cycleAt.getTime() - STAR_OBSERVATION_POLICY.collectionWindowHours * HOUR_MS);
    if (now < windowStartsAt || now >= cycleAt) return null;
    const [created] = await tx.insert(productStarObservationRuns).values({ cycleAt, windowStartsAt, deadlineAt: cycleAt,
      policyVersion: STAR_OBSERVATION_POLICY_VERSION, policy: { ...STAR_OBSERVATION_POLICY }, startedAt: now,
    }).onConflictDoNothing({ target: productStarObservationRuns.cycleAt }).returning();
    if (!created) {
      const [existing] = await tx.select().from(productStarObservationRuns).where(eq(productStarObservationRuns.cycleAt, cycleAt));
      return existing ?? null;
    }
    const candidates = await tx.select({ productId: products.id, slug: products.slug, repoUrl: products.repoUrl, repoLinkVersion: products.repoLinkVersion })
      .from(products).where(and(inArray(products.status, [...PUBLIC]), listedByDefault, notDown,
        eq(products.repoStatus, 'ok'), eq(products.repoArchived, false),
        sql`${products.stars} >= ${created.policy.minStars} and ${products.stars} < ${created.policy.maxStarsExclusive}`,
        // Delayed startup must not add products discovered during this collection window.
        sql`${products.createdAt} < (${windowStartsAt.toISOString()}::timestamptz at time zone 'UTC')`,
      ));
    const targets = candidates.flatMap(row => {
      const repositoryKey = observationRepositoryKey(row.repoUrl);
      return repositoryKey && row.repoUrl ? [{ ...row, runId: created.id, repoUrl: row.repoUrl, repositoryKey }] : [];
    });
    for (let offset = 0; offset < targets.length; offset += 1000) {
      await tx.insert(productStarObservations).values(targets.slice(offset, offset + 1000));
    }
    const [run] = await tx.update(productStarObservationRuns).set({ targetCount: targets.length,
      status: sql`case when clock_timestamp() < ${cycleAt.toISOString()}::timestamptz then 'collecting' else 'preparing' end`,
    }).where(eq(productStarObservationRuns.id, created.id)).returning();
    return run;
  });
}

async function claimBatch(ctx: JobContext<StarObservationCursor>, runId: number, roleLease?: RoleLease): Promise<ProductStarObservation[]> {
  return db.transaction(async tx => {
    await assertOwnership(tx, ctx, roleLease);
    const [run] = await tx.select().from(productStarObservationRuns).where(and(
      eq(productStarObservationRuns.id, runId), eq(productStarObservationRuns.status, 'collecting'),
      sql`clock_timestamp() >= ${productStarObservationRuns.windowStartsAt} and clock_timestamp() < ${productStarObservationRuns.deadlineAt}`,
    )).for('update');
    if (!run) return [];
    // A worker may have died after the third request but before its result commit.
    await tx.update(productStarObservations).set({ status: 'failed', errorClass: 'retry_exhausted', nextAttemptAt: null })
      .where(and(eq(productStarObservations.runId, runId), eq(productStarObservations.status, 'pending'),
        sql`${productStarObservations.attempts} >= ${MAX_ATTEMPTS} and ${productStarObservations.nextAttemptAt} <= clock_timestamp()`));
    const rows = await tx.select().from(productStarObservations).where(and(
      eq(productStarObservations.runId, runId), eq(productStarObservations.status, 'pending'),
      sql`${productStarObservations.attempts} < ${MAX_ATTEMPTS}`,
      sql`(${productStarObservations.nextAttemptAt} is null or ${productStarObservations.nextAttemptAt} <= clock_timestamp())`,
    )).orderBy(sql`${productStarObservations.nextAttemptAt} asc nulls first`, productStarObservations.productId).limit(REPOSITORY_BATCH).for('update');
    if (!rows.length) { await countRun(tx, runId); return []; }
    const current = await tx.select({ id: products.id, repoUrl: products.repoUrl, repoLinkVersion: products.repoLinkVersion })
      .from(products).where(and(inArray(products.id, rows.map(row => row.productId)), inArray(products.status, [...PUBLIC]), listedByDefault, notDown)).for('share');
    const valid = rows.filter(row => current.some(product => product.id === row.productId && product.repoUrl === row.repoUrl && product.repoLinkVersion === row.repoLinkVersion));
    const invalid = rows.filter(row => !valid.includes(row));
    if (invalid.length) await tx.update(productStarObservations).set({ status: 'failed', errorClass: 'product_changed', nextAttemptAt: null })
      .where(and(eq(productStarObservations.runId, runId), inArray(productStarObservations.productId, invalid.map(row => row.productId))));
    if (valid.length) await tx.update(productStarObservations).set({ attempts: sql`${productStarObservations.attempts} + 1`,
      nextAttemptAt: sql`clock_timestamp() + interval '2 minutes'` }).where(and(
        eq(productStarObservations.runId, runId), inArray(productStarObservations.productId, valid.map(row => row.productId)),
      ));
    await countRun(tx, runId);
    return valid.map(row => ({ ...row, attempts: row.attempts + 1 }));
  });
}

async function recordBatch(ctx: JobContext<StarObservationCursor>, runId: number, rows: ProductStarObservation[],
  result: RepositoryBatchResult, observedAt: Date, retryAt: Date, roleLease?: RoleLease) {
  return db.transaction(async tx => {
    await assertOwnership(tx, ctx, roleLease);
    const [run] = await tx.select().from(productStarObservationRuns).where(and(
      eq(productStarObservationRuns.id, runId), eq(productStarObservationRuns.status, 'collecting'),
      sql`clock_timestamp() < ${productStarObservationRuns.deadlineAt}`,
      sql`${observedAt.toISOString()}::timestamptz >= ${productStarObservationRuns.windowStartsAt} and ${observedAt.toISOString()}::timestamptz < ${productStarObservationRuns.deadlineAt}`,
    )).for('update');
    if (!run) return 0;
    // Product-row SHARE locks serialize relinks/deletions until this evidence commit.
    const current = await tx.select({ id: products.id, repoUrl: products.repoUrl, repoLinkVersion: products.repoLinkVersion })
      .from(products).where(and(inArray(products.id, rows.map(row => row.productId)), inArray(products.status, [...PUBLIC]), listedByDefault, notDown)).for('share');
    const waiting = !result.ok && (result.error.kind === 'rate_limited' || result.error.kind === 'auth_unavailable');
    const values = rows.map((row, index) => {
      const product = current.find(product => product.id === row.productId);
      const linked = product?.repoUrl === row.repoUrl && product?.repoLinkVersion === row.repoLinkVersion;
      const check = result.ok ? result.checks[index] : null;
      const observed = Boolean(check?.status && (check.status !== 'ok' || (check.facts?.stars != null && check.facts.repositoryId?.trim())));
      // Local shared cooldowns do not consume the reserved network-failure attempt.
      const attempts = waiting ? Math.max(0, row.attempts - 1) : row.attempts;
      const status = !linked ? 'failed' : observed ? check!.status : attempts < MAX_ATTEMPTS ? 'pending' : 'failed';
      return { product_id: row.productId, status, stars: linked && status === 'ok' ? check!.facts!.stars : null,
        repository_id: linked && observed ? check?.facts?.repositoryId ?? null : null, attempts,
        observed_at: linked && observed ? observedAt.toISOString() : null, archived: linked && observed ? check?.facts?.archived ?? null : null,
        error_class: !linked ? 'product_changed' : observed ? null : result.ok ? 'invalid_repository_response' : result.error.kind,
        next_attempt_at: status === 'pending' ? retryAt.toISOString() : null };
    });
    const changed = await tx.execute<{ product_id: number }>(sql`update product_star_observations o set
      status = v.status, stars = v.stars, repository_id = v.repository_id, attempts = v.attempts, observed_at = v.observed_at, archived = v.archived,
      error_class = v.error_class, next_attempt_at = v.next_attempt_at
      from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) as v(product_id int, status text, stars int, repository_id text, attempts int,
        observed_at timestamptz, archived boolean, error_class text, next_attempt_at timestamptz)
      where o.run_id = ${runId} and o.product_id = v.product_id and o.status = 'pending'
        and clock_timestamp() < ${run.deadlineAt.toISOString()}::timestamptz returning o.product_id`);
    await countRun(tx, runId);
    return changed.length;
  });
}

/** Minute scheduling resumes one 8-hour cycle; GitHub is contacted only in its final hour. */
export async function observeProductStars(ctx: JobContext<StarObservationCursor>, dependencies: { check?: Check } = {}): Promise<JobOutcome<StarObservationCursor>> {
  const startedAt = Date.now();
  const roleLease = roleLeaseFromEnv('crawler', process.env);
  const closed = await closeExpiredRuns(ctx, roleLease);
  const now = await databaseNow();
  const cycleAt = nextStarObservationCycleAt(now);
  const run = await prepareRun(ctx, cycleAt, roleLease);
  if (!run || run.status !== 'collecting' || now < run.windowStartsAt || now >= run.deadlineAt) {
    if (closed) ctx.log('product_star_observation.closed', { runs: closed });
    return { done: true, cursor: null };
  }
  if (ctx.cursor?.cycleAt === cycleAt.toISOString() && Date.parse(ctx.cursor.retryAfter) > now.getTime()) return { done: true, cursor: ctx.cursor };
  const check = dependencies.check ?? checkRepositories;
  let examined = 0, recorded = 0, batches = 0;
  const wait = (retryAfter: Date): JobOutcome<StarObservationCursor> => ({ done: true,
    cursor: { cycleAt: cycleAt.toISOString(), retryAfter: new Date(Math.min(retryAfter.getTime(), run.deadlineAt.getTime())).toISOString() } });
  for (; batches < BATCHES; batches++) {
    if (!ctx.hasBudget() || ctx.signal?.aborted || Date.now() - startedAt > START_WITHIN_MS) break;
    if (batches) await new Promise(resolve => setTimeout(resolve, 1000));
    const rows = await claimBatch(ctx, run.id, roleLease);
    if (!rows.length) break;
    const requestAt = await databaseNow();
    const remainingMs = run.deadlineAt.getTime() - requestAt.getTime();
    // Leave one full collector timeout before cutoff; in-flight late answers are still fenced below.
    if (remainingMs <= 10_000 || !ctx.hasBudget() || ctx.signal?.aborted) break;
    const refs = rows.map(row => { const [owner, name] = row.repositoryKey.split('/'); return { owner, name }; });
    let result: RepositoryBatchResult;
    try { result = await check(refs, { timeoutMs: Math.min(10_000, remainingMs), deadlineAt: run.deadlineAt.getTime() }); }
    catch { result = { ok: false, error: { kind: 'transport' } }; }
    const observedAt = await databaseNow();
    let retryAt = new Date(observedAt.getTime() + RETRY_MS);
    if (!result.ok && (result.error.kind === 'rate_limited' || result.error.kind === 'auth_unavailable'))
      retryAt = result.error.resetAt ?? new Date(observedAt.getTime() + 15 * 60_000);
    else if (!result.ok && result.error.kind === 'http' && result.error.status === 401) retryAt = new Date(observedAt.getTime() + HOUR_MS);
    recorded += await recordBatch(ctx, run.id, rows, result, observedAt, retryAt, roleLease);
    examined += rows.length;
    if (!result.ok) {
      ctx.log('product_star_observation.waiting', { examined, recorded, batches: batches + 1 });
      return wait(retryAt);
    }
    if (result.rateLimit && result.rateLimit.remaining < MIN_REMAINING) {
      const reset = result.rateLimit.resetAt ? Date.parse(result.rateLimit.resetAt) : Number.NaN;
      return wait(new Date(Number.isFinite(reset) && reset > observedAt.getTime() ? reset : observedAt.getTime() + 15 * 60_000));
    }
  }
  await closeExpiredRuns(ctx, roleLease);
  ctx.log('product_star_observation.collected', { examined, recorded, batches, targets: run.targetCount });
  return { done: true, cursor: null };
}

/** Existing hourly maintenance removes at most 1000 observations and 3 emptied runs. */
export async function pruneStarObservations(ctx: JobContext<null>): Promise<number> {
  const roleLease = roleLeaseFromEnv('maintenance', process.env);
  return db.transaction(async tx => {
    if (roleLease) await assertRoleLease(tx, roleLease);
    if (ctx.lease) await assertJobLease(tx, ctx.lease);
    const removed = await tx.execute<{ run_id: number }>(sql`delete from product_star_observations o using (
      select o.run_id, o.product_id from product_star_observations o join product_star_observation_runs r on r.id = o.run_id
      where r.status in ('closed','failed') and r.cycle_at < clock_timestamp() - ${STAR_OBSERVATION_POLICY.retentionDays} * interval '1 day'
      order by r.cycle_at, o.product_id limit 1000
    ) expired where o.run_id = expired.run_id and o.product_id = expired.product_id returning o.run_id`);
    await tx.execute(sql`delete from product_star_observation_runs r using (
      select r.id from product_star_observation_runs r where r.status in ('closed','failed')
        and r.cycle_at < clock_timestamp() - ${STAR_OBSERVATION_POLICY.retentionDays} * interval '1 day'
        and not exists (select 1 from product_star_observations o where o.run_id = r.id)
      order by r.cycle_at limit 3
    ) expired where r.id = expired.id`);
    return removed.length;
  });
}
