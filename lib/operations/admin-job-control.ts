import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db, onPrimary } from '@/lib/db';
import { jobs, operationsAudit } from '@/lib/db/schema';
import { JOB_NAMES } from '@/lib/jobs/catalog';
import { catalogJobsForBatch } from '@/lib/jobs/batches';
import { lockJobBatch } from '@/lib/jobs/batch-repository';
import { isPausedJob } from '@/lib/jobs/status';
import { writerSiteActive, DrWriterFencedError } from './dr/epoch';
import { adminAuditRow } from './admin-log';

const ACTIONS = ['job-pause', 'job-resume'];
export const controllableJob = (name: string) => name !== 'heartbeat' && JOB_NAMES.includes(name);
export type AdminJobControl = { name: string; pause: boolean; expectedNotBefore: string | null; expectedControlVersion: number; reason: string };

/** The job lock serializes operator changes and tick completion. Requests, cursor and live lease are preserved. */
export async function controlAdminJob(input: AdminJobControl, actor: string): Promise<void> {
  if (!controllableJob(input.name) || typeof input.pause !== 'boolean' || !Number.isSafeInteger(input.expectedControlVersion)
    || input.expectedControlVersion < 0 || (input.expectedNotBefore !== null && (typeof input.expectedNotBefore !== 'string'
      || !Number.isFinite(Date.parse(input.expectedNotBefore)))) || typeof input.reason !== 'string' || !input.reason.trim()
    || input.reason.length > 500 || !actor.trim()) throw new Error('job_control_invalid');
  await onPrimary(() => db.transaction(async tx => {
    if (!await writerSiteActive(tx)) throw new DrWriterFencedError('site_fenced');
    const batch = await lockJobBatch(tx);
    // Native consumers may not claim through jobs.not_before. Never report that those consumers have stopped.
    if (batch.mode !== 'legacy' || !catalogJobsForBatch(batch).some(job => job.name === input.name)) throw new Error('job_control_unsupported_mode');
    const [job] = await tx.select().from(jobs).where(eq(jobs.name, input.name)).for('update');
    if (!job) throw new Error('job_control_not_found');
    const [previous] = await tx.select().from(operationsAudit).where(and(eq(operationsAudit.target, input.name),
      inArray(operationsAudit.action, ACTIONS))).orderBy(desc(operationsAudit.id)).limit(1);
    const now = (await tx.select({ at: sql<Date>`clock_timestamp()`.mapWith(jobs.notBefore) }).from(jobs).where(eq(jobs.name, input.name)))[0].at!;
    if ((previous?.id ?? 0) !== input.expectedControlVersion || (job.notBefore?.toISOString() ?? null) !== input.expectedNotBefore
      || isPausedJob(job, now.getTime()) === input.pause) throw new Error('job_control_conflict');
    let notBefore: Date | null;
    if (input.pause) {
      notBefore = new Date(now.getTime() + 100 * 365 * 24 * 60 * 60_000);
    } else {
      const before = previous?.action === 'job-pause' && previous.detail?.afterNotBefore === job.notBefore?.toISOString()
        ? previous.detail.beforeNotBefore : null;
      const retry = typeof before === 'string' ? new Date(before) : null;
      notBefore = retry && retry.getTime() > now.getTime() ? retry : null;
    }
    await tx.update(jobs).set({ notBefore, updatedAt: now }).where(eq(jobs.name, input.name));
    await tx.insert(operationsAudit).values(await adminAuditRow(actor, { action: input.pause ? 'job-pause' : 'job-resume', target: input.name,
      detail: { reason: input.reason.trim(), beforeNotBefore: job.notBefore?.toISOString() ?? null,
        afterNotBefore: notBefore?.toISOString() ?? null, previousControlVersion: previous?.id ?? 0,
        inFlight: job.leaseToken !== null, requestedVersion: job.requestedVersion, processedVersion: job.processedVersion } }));
  }));
}

export async function adminJobControlVersions(): Promise<Record<string, number>> {
  const rows = await db.select({ target: operationsAudit.target, version: sql<number>`max(${operationsAudit.id})::int` })
    .from(operationsAudit).where(inArray(operationsAudit.action, ACTIONS)).groupBy(operationsAudit.target);
  return Object.fromEntries(rows.map(row => [row.target, row.version]));
}
