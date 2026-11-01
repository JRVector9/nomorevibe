import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { checkpointDiscovery } from '@/lib/crawl/discovery-checkpoint';
import { discoveryHash, type DiscoveryCheckpointInput } from '@/lib/crawl/discovery-checkpoint-contract';
import { jobs } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getJobState, runJob } from '@/lib/jobs/runner';
import { ensureSchema } from './setup';

const prefix = `int-discovery-${randomUUID()}`;
const subjects: string[] = [], keys: string[] = [], jobNames: string[] = [];
const input = (label: string, extra: Partial<DiscoveryCheckpointInput> = {}): DiscoveryCheckpointInput => {
  const subject = discoveryHash(`${prefix}-${label}`);
  subjects.push(subject);
  return { source: 'github-full', subject, generation: discoveryHash('config'), semantic: discoveryHash('cursor-1'),
    intent: 'ready', progressed: true, acknowledged: true, ...extra };
};
const productive = async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0], suffix: string) => {
  const key = `${prefix}-${suffix}`; keys.push(key);
  await tx.execute(sql`INSERT INTO operations_observations(key,value) VALUES(${key},'{}'::jsonb)`);
  return key;
};
const read = async (subject: string) => (await db.execute<{ revision: string; semantic: string; progress: string | null; ack: string | null }>(sql`
  SELECT revision::text,semantic,progress_at::text AS progress,acknowledged_at::text AS ack FROM discovery_checkpoints WHERE source='github-full' AND subject=${subject}`))[0];
beforeAll(() => ensureSchema());
afterAll(async () => {
  if (subjects.length) await db.execute(sql`DELETE FROM discovery_checkpoints WHERE subject IN (${sql.join(subjects.map(s => sql`${s}`), sql`,`)})`);
  if (keys.length) await db.execute(sql`DELETE FROM operations_observations WHERE key IN (${sql.join(keys.map(k => sql`${k}`), sql`,`)})`);
  for (const name of jobNames) await db.delete(jobs).where(eq(jobs.name, name));
});

it('commits receipt and productive work atomically and rolls both back when the enclosing work fails', async () => {
  const receipt = input('rollback'); let key = '';
  await expect(db.transaction(async tx => {
    key = await productive(tx, 'rollback');
    await checkpointDiscovery(tx, [receipt]);
    throw new Error('domain_rollback');
  })).rejects.toThrow('domain_rollback');
  expect(await read(receipt.subject)).toBeUndefined();
  expect(await db.execute(sql`SELECT key FROM operations_observations WHERE key=${key}`)).toHaveLength(0);
});

it('rolls back a failed monitoring savepoint while preserving productive work and caller timeouts', async () => {
  const receipt = input('savepoint', { intent: 'invalid' as DiscoveryCheckpointInput['intent'] });
  let key = '';
  await db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL statement_timeout='7s'`);
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    key = await productive(tx, 'savepoint');
    await checkpointDiscovery(tx, [receipt]); // Actual SQL CHECK failure, not a mocked throw.
    const [settings] = await tx.execute<{ statement: string; lock: string }>(sql`SELECT current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`);
    expect(settings).toEqual({ statement: '7s', lock: '2s' });
  });
  expect(await read(receipt.subject)).toBeUndefined();
  expect(await db.execute(sql`SELECT key FROM operations_observations WHERE key=${key}`)).toHaveLength(1);
});

it('does not turn repeated successful saves or retry timestamps into cursor progress', async () => {
  const receipt = input('revision');
  await db.transaction(tx => checkpointDiscovery(tx, [receipt]));
  await db.execute(sql`UPDATE discovery_checkpoints SET first_seen_at=clock_timestamp()-interval '2 hours',progress_at=clock_timestamp()-interval '1 hour'
    WHERE source=${receipt.source} AND subject=${receipt.subject}`);
  const before = await read(receipt.subject);
  await db.transaction(tx => checkpointDiscovery(tx, [{ ...receipt, intent: 'backoff', resumeAt: '2099-01-01T00:00:00Z' }]));
  expect(await read(receipt.subject)).toMatchObject({ revision: '1', progress: before.progress });
  const semantic = discoveryHash('cursor-2');
  await db.transaction(tx => checkpointDiscovery(tx, [{ ...receipt, semantic }]));
  expect(await read(receipt.subject)).toMatchObject({ revision: '2', semantic });
  expect((await read(receipt.subject)).progress).not.toBe(before.progress);
  // A new config/obligation gets a grace baseline, never inherited old success.
  await db.transaction(tx => checkpointDiscovery(tx, [{ ...receipt, generation: discoveryHash('new-config'), progressed: false, acknowledged: false }]));
  expect(await read(receipt.subject)).toMatchObject({ revision: '0', progress: null, ack: null });
});

it('keeps runner cursor work after a receipt error and refuses a receipt after job ownership is lost', async () => {
  const name = `${prefix}-lease`; jobNames.push(name); keys.push(`job:${name}`);
  const receipt = input('runner');
  await runJob<{ page: number }>(name, async ctx => {
    await ctx.save({ page: 1 }, [{ ...receipt, intent: 'invalid' as DiscoveryCheckpointInput['intent'] }]);
    expect((await getJobState(name))?.cursor).toEqual({ page: 1 });
    expect(await read(receipt.subject)).toBeUndefined();
    await ctx.save({ page: 2 }, [receipt]);
    await db.update(jobs).set({ leaseToken: randomUUID() }).where(eq(jobs.name, name));
    await expect(ctx.save({ page: 3 }, [{ ...receipt, semantic: discoveryHash('unowned') }])).rejects.toThrow();
    return { done: false, cursor: { page: 3 } };
  });
  expect((await getJobState(name))?.cursor).toEqual({ page: 2 });
  expect(await read(receipt.subject)).toMatchObject({ revision: '1', semantic: receipt.semantic });
});
