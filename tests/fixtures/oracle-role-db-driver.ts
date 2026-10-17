/** Child process for tests/integration/oracle-db-roles.test.ts. It runs the real role runtime path with only
 * the DATABASE_URL principal it was given; external HTTP is a loopback fixture supplied by the parent. */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { fetchCapped } from '@/lib/net/fetch';
import { JOBS, type AnyJob } from '@/lib/jobs/registry';
import { runJob } from '@/lib/jobs/runner';
import { tryAcquireRole, renewRole, releaseRole, roleLeaseFromEnv, type RoleLease } from '@/lib/jobs/role-leader';
import { claimCanonicalEvidenceSource, recordCanonicalEvidenceSource } from '@/lib/domain/evidence/source-claims';
import type { JobContext, JobOutcome } from '@/lib/jobs/runner';
import { markSchedulerSeen, requestDueJobs } from '@/lib/jobs/control';
import { refreshNews } from '@/lib/news/refresh';
import { observe, observeService } from '@/lib/operations/observations';
import { readOracleRuntimePreflight } from '@/lib/runtime/oracle-preflight';
import type { BatchRole } from '@/lib/jobs/batches';
import postgres from 'postgres';
import { attestOracleCanary, attestOracleSchedulerCanary, oracleCanaryIdentity, refreshOracleCapability, runOracleBootstrap, runOracleCanary,
  runOracleLegacySeedTick, runOracleRecanary, runOracleSchedulerCanary } from '@/lib/runtime/oracle-canary';
import { oracleSchedulerIdentity } from '@/lib/runtime/oracle-scheduler-evidence';

type Input = { role: BatchRole | 'scheduler'; jobs: string[]; httpBase: string; bootId: string; negatives: string[];
  mode?: 'role' | 'canary' | 'attest' | 'refresh' | 'preflight' | 'heartbeat' | 'negatives' | 'seed' | 'bootstrap' | 'recanary' };
const input = JSON.parse(process.env.ORACLE_DRIVER_INPUT ?? '{}') as Input;
const instanceId = process.env.SERVICE_INSTANCE_ID!, release = process.env.RELEASE_TAG!;
const failure = (error: unknown) => {
  for (let value = error, depth = 0; value && depth < 8; depth++) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    value = (value as { cause?: unknown }).cause;
  }
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown';
};
function setLease(lease: RoleLease) {
  Object.assign(process.env, { ROLE_LEASE_ROLE: lease.role, ROLE_LEASE_INSTANCE_ID: lease.instanceId, ROLE_LEASE_BOOT_ID: lease.bootId,
    ROLE_LEASE_RELEASE: lease.release, ROLE_LEASE_EPOCH: String(lease.epoch), ROLE_LEASE_BATCH_VERSION: '1',
    ROLE_LEASE_BATCH_EPOCH: String(lease.batchEpoch), ROLE_LEASE_HOST: lease.host });
}

/** The real claim/record DB path; only the public-site HTTP collection is replaced by a fixed fixture result. */
async function siteEvidence(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const roleLease = roleLeaseFromEnv('site-evidence', process.env)!;
  const lease = await claimCanonicalEvidenceSource({ owner: { instanceId: roleLease.instanceId, bootId: roleLease.bootId }, roleLease, job: ctx.lease });
  if (!lease) { ctx.log('evidence.site_refresh_batch', { attempted: 0, succeeded: 0 }); return { done: true }; }
  const result = await recordCanonicalEvidenceSource(lease, { state: 'ok', etag: null, lastModified: null, facts: { type: 'site_fingerprint',
    finalUrl: lease.binding.sourceUrl, bodyDigest: 'f'.repeat(64), parserVersion: 1, repositoryKeys: [] } });
  ctx.log('evidence.site_refresh_batch', { attempted: 1, succeeded: result.state === 'recorded' ? 1 : 0, factsChanged: result.factsChanged });
  return { done: false };
}

/** Canary/bootstrap ticks: the same fixture collection plus one real loopback GET through the shared origin permits,
 * so the attest's strict released-hop requirement for the site job is met by actual participation, not by a seed. */
async function siteEvidenceWithHttp(ctx: JobContext<null>): Promise<JobOutcome<null>> {
  const response = await fetchCapped(`${input.httpBase}/site/${instanceId}`, { maxBytes: 65_536, timeoutMs: 5_000, signal: ctx.signal });
  if (!response.ok || response.status !== 200) throw new Error('fixture_site_fetch_failed');
  return siteEvidence(ctx);
}

async function main() {
  const result: Record<string, unknown> = { principal: (await db.execute<{ user: string }>(sql`SELECT current_user AS user`))[0].user };
  if (input.mode === 'negatives') { /* Only the statements below, under this principal. */ }
  else if (input.mode && input.mode !== 'role' && input.role === 'scheduler') {
    // PR11g scheduler canary paths (tests/integration/oracle-scheduler-canary.test.ts): same functions the operator CLI calls.
    const identity = oracleSchedulerIdentity(process.env);
    const attest = postgres(process.env.ORACLE_ATTEST_DATABASE_URL ?? '', { max: 1, prepare: false, onnotice: () => {} });
    try {
      if (input.mode === 'canary') result.canary = await runOracleSchedulerCanary({ identity, attest });
      if (input.mode === 'attest') result.attest = await attestOracleSchedulerCanary({ identity, attest });
      if (input.mode === 'preflight') result.preflight = await readOracleRuntimePreflight({ role: 'scheduler' });
    } finally { await attest.end({ timeout: 5 }); }
  } else if (input.mode && input.mode !== 'role') {
    const identity = oracleCanaryIdentity(input.role, process.env), permits = process.env.HTTP_ORIGIN_PERMITS === '1';
    const attest = postgres(process.env.ORACLE_ATTEST_DATABASE_URL ?? '', { max: 1, prepare: false, onnotice: () => {} });
    // Same fixed site collection as the role path: the real claim/record/admission run, the public URL is never fetched.
    if (input.role === 'site-evidence') JOBS['product-site-evidence-refresh'] = siteEvidenceWithHttp as AnyJob;
    try {
      if (input.mode === 'seed') result.seed = await runOracleLegacySeedTick(identity, input.jobs[0], input.bootId);
      if (input.mode === 'canary') result.canary = await runOracleCanary({ identity, job: input.jobs[0], attest, permits });
      if (input.mode === 'bootstrap') result.bootstrap = await runOracleBootstrap({ identity, job: input.jobs[0], attest, permits });
      if (input.mode === 'recanary') result.recanary = await runOracleRecanary({ identity, job: input.jobs[0], attest, permits });
      if (input.mode === 'attest') result.attest = await attestOracleCanary({ identity, job: input.jobs[0], attest, permits, anchor: 'if_stale' });
      if (input.mode === 'refresh') result.refresh = await refreshOracleCapability({ identity, attest, permits });
      if (input.mode === 'preflight') result.preflight = await readOracleRuntimePreflight({ role: input.role });
      if (input.mode === 'heartbeat') {
        // A restarted worker: new boot candidate heartbeat/election through the normal batch path, then release.
        const lease = await tryAcquireRole({ role: identity.role, instanceId, bootId: input.bootId, release, kind: 'primary', batchVersion: 1, host: 'oracle-osaka-smoke' });
        result.elected = Boolean(lease); if (lease) result.released = await releaseRole(lease);
      }
    } finally { await attest.end({ timeout: 5 }); }
  } else if (input.role === 'scheduler') {
    await observeService('scheduler', { status: 'polling', release, bootId: input.bootId, bootedAt: Date.now() });
    await markSchedulerSeen(); result.requested = await requestDueJobs();
  } else {
    const candidate = { role: input.role, instanceId, bootId: input.bootId, release, kind: 'primary' as const,
      batchVersion: 1 as const, host: 'oracle-osaka-smoke' as const };
    await observe(`candidate:${input.role}:${instanceId}`, { ...candidate, phase: 'standby', epoch: null });
    const lease = await tryAcquireRole(candidate);
    if (!lease) throw new Error('fixture_role_not_elected');
    setLease(lease);
    await observeService(input.role, { status: 'running', release, bootId: input.bootId, bootedAt: Date.now() });
    const runs: Record<string, unknown> = {};
    for (const name of input.jobs) {
      const handler: AnyJob = name === 'news-refresh'
        ? (ctx: Parameters<typeof refreshNews>[0]) => refreshNews(ctx, (url, options) =>
          fetchCapped(`${input.httpBase}/news/${encodeURIComponent(url)}`, options))
        : name === 'product-site-evidence-refresh' ? siteEvidence : JOBS[name];
      runs[name] = await runJob(name, handler, { roleLease: lease, budgetMs: 25_000 });
    }
    result.runs = runs;
    result.renewed = await renewRole(lease);
    result.preflight = await readOracleRuntimePreflight({ role: input.role });
    result.released = await releaseRole(lease);
  }
  const negatives: Record<string, string> = {};
  for (const statement of input.negatives) {
    try { await db.execute(sql.raw(statement)); negatives[statement] = 'allowed'; }
    catch (error) { negatives[statement] = failure(error); }
  }
  result.negatives = negatives;
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().then(() => (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 }),
  async error => {
    process.stdout.write(`${JSON.stringify({ error: failure(error), message: error instanceof Error ? error.message.slice(0, 300) : String(error) })}\n`);
    await (globalThis as { pgClient?: { end: (o: { timeout: number }) => Promise<void> } }).pgClient?.end({ timeout: 5 });
    process.exitCode = 1;
  });
