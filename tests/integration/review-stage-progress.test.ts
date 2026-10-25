import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, jobs, operationsObservations, pipelineStageModes, secondReviews } from '@/lib/db/schema';
import { saveSettings } from '@/lib/crawl/settings';
import { readWorkerProgress } from '@/lib/operations/worker-progress-query';
import { roleHasUnexplainedStall } from '@/scripts/role-worker';
import { ensureSchema } from './setup';

beforeAll(ensureSchema);
beforeEach(async () => {
  await db.delete(secondReviews); await db.delete(crawlCandidates); await db.delete(jobs); await db.delete(operationsObservations);
  await db.update(pipelineStageModes).set({ mode: 'legacy', drainingFrom: null }).where(inArray(pipelineStageModes.stage, ['ai1', 'ai2']));
  await saveSettings({ enabled: true, reviewMode: 'off', secondReview: { enabled: true } }, 'test');
  await db.insert(operationsObservations).values(['scheduler', 'crawler', 'reviewer', 'publisher', 'maintenance', 'text']
    .map(role => ({ key: `service:${role}:fixture`, value: { status: 'running' }, observedAt: new Date() })));
  const [candidate] = await db.insert(crawlCandidates).values({ repo: 'fixture/consumer-progress', state: 'needs_review' }).returning();
  await db.insert(secondReviews).values({ candidateId: candidate.id, repo: candidate.repo, trigger: 'sample', firstDecision: 'approve',
    inputHash: 'a'.repeat(64), provider: 'abcllm', model: 'fixture', createdAt: sql`now() - interval '8 hours'` as unknown as Date });
  await db.insert(jobs).values({ name: 'second-review', nextScheduledAt: new Date(Date.now() + 60_000) });
});
afterEach(async () => {
  await db.delete(secondReviews); await db.delete(crawlCandidates); await db.delete(jobs); await db.delete(operationsObservations);
  await db.update(pipelineStageModes).set({ mode: 'legacy', drainingFrom: null }).where(inArray(pipelineStageModes.stage, ['ai1', 'ai2']));
});

it('reads item ownership from the DB and retains the alarm without reviewer restart authority', async () => {
  await db.update(pipelineStageModes).set({ mode: 'items' }).where(eq(pipelineStageModes.stage, 'ai2'));
  await db.insert(operationsObservations).values({ key: 'service:reviewer:ai2-consumer-m3', value: { status: 'running' }, observedAt: new Date() });
  const report = await readWorkerProgress(undefined, { includeText: false });
  expect(report.stages.find(stage => stage.stage === 'second')).toMatchObject({ reason: 'no_progress', alarm: true, restartEligible: false });
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(false);
});

it('reports an absent item consumer separately from the live reviewer', async () => {
  await db.update(pipelineStageModes).set({ mode: 'items' }).where(eq(pipelineStageModes.stage, 'ai2'));
  const report = await readWorkerProgress(undefined, { includeText: false });
  expect(report.liveness.find(row => row.role === 'reviewer')).toMatchObject({ reason: 'present', alarm: false });
  expect(report.stages.find(stage => stage.stage === 'second')).toMatchObject({ reason: 'consumer_missing', alarm: true, restartEligible: false });
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(false);
});

it('reads intentional stage drain as backoff without requiring a consumer', async () => {
  await db.update(pipelineStageModes).set({ mode: 'draining', drainingFrom: 'items' }).where(eq(pipelineStageModes.stage, 'ai2'));
  const report = await readWorkerProgress(undefined, { includeText: false });
  expect(report.stages.find(stage => stage.stage === 'second')).toMatchObject({ reason: 'backoff', alarm: false, restartEligible: false });
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(false);
});
