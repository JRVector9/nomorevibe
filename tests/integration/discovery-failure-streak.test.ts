import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { checkpointDiscovery } from '@/lib/crawl/discovery-checkpoint';
import { discoveryHash, type DiscoveryCheckpointInput } from '@/lib/crawl/discovery-checkpoint-contract';
import { saveKoreanLanguage } from '@/lib/crawl/korean-discovery/repository';
import { seedFromShowHN, type ShowHnCursor } from '@/lib/crawl/jobs/hn-show';
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';
import { readDiscoveryMonitor } from '@/lib/operations/discovery-monitor';
import type { CappedRequest } from '@/lib/net/fetch';
import { ensureSchema } from './setup';

const suffix = randomUUID(), languageSubject = discoveryHash('language'), hnSubject = discoveryHash('show-hn');
const consumerKey = `service:crawler:github-ko-discovery-consumer-${suffix.slice(0, 8)}`;
const workerKey = `service:crawler:discovery-int-${suffix.slice(0, 8)}`;
const settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, discover: { ...DEFAULT_CRAWL_SETTINGS.discover,
  queries: DEFAULT_CRAWL_SETTINGS.discover.queries.map(q => ({ ...q, enabled: false })),
  showHn: { ...DEFAULT_CRAWL_SETTINGS.discover.showHn, enabled: true } } };
let priorSettings: unknown, priorControl: { enabled: boolean; start: string | null; queries: unknown; shared: unknown };
let priorBatch: string, priorHn: { cursor: unknown; notBefore: string | null } | undefined;
const unknown = (reason = 'document_unavailable') => ({ language: 'unknown' as const, source: null, contentHash: null, hangul: 0, reason });
const readFailure = async (source: string) => (await db.execute<{ started: string | null; first: string; progress: string | null; ack: string | null }>(sql`
  SELECT failure_started_at::text AS started,first_seen_at::text AS first,progress_at::text AS progress,acknowledged_at::text AS ack
  FROM discovery_checkpoints WHERE source=${source} AND subject=${source === 'show-hn' ? hnSubject : languageSubject}`))[0];
const assertSource = async (source: 'korean-language' | 'show-hn', failing: boolean) => {
  const report = await readDiscoveryMonitor();
  expect(report.failures.covered).toContain(source);
  expect(report.failures.failures.filter(row => row.source === source)).toEqual(failing ? [{ source, reason: 'upstream_stalled' }] : []);
};

beforeAll(() => ensureSchema());
beforeEach(async () => {
  const [setting] = await db.execute<{ values: unknown }>(sql`SELECT values FROM crawl_settings WHERE id=1`);
  priorSettings = setting.values;
  [priorControl] = await db.execute<typeof priorControl>(sql`SELECT enabled,start_at::text AS start,queries,shared_cursor AS shared FROM github_ko_discovery_control WHERE id=1`);
  [priorHn] = await db.execute<NonNullable<typeof priorHn>>(sql`SELECT cursor,not_before::text AS "notBefore" FROM jobs WHERE name='hn-show-seed'`);
  [{ mode: priorBatch }] = await db.execute<{ mode: string }>(sql`SELECT mode FROM job_batch_control WHERE id=1`);
  // These canonical staging tables are shared CI fixtures, matching korean-discovery.test.ts isolation.
  await db.execute(sql`TRUNCATE github_ko_discovery_queries,github_ko_discovery_staging`);
  await db.execute(sql`DELETE FROM discovery_checkpoints WHERE (source='korean-language' AND subject=${languageSubject}) OR (source='show-hn' AND subject=${hnSubject})`);
  await db.execute(sql`UPDATE crawl_settings SET values=${JSON.stringify(settings)}::jsonb WHERE id=1`);
  await db.execute(sql`UPDATE job_batch_control SET mode='legacy' WHERE id=1`);
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=true,start_at='2026-01-01',queries='[]'::jsonb,shared_cursor=NULL WHERE id=1`);
  await db.execute(sql`INSERT INTO operations_observations(key,value) VALUES
    (${consumerKey},${JSON.stringify({ status: 'running', enabled: true, lastHeartbeatAt: Date.now() })}::jsonb),
    (${workerKey},${JSON.stringify({ status: 'running', enabled: true, lastHeartbeatAt: Date.now() })}::jsonb)`);
  await db.execute(sql`INSERT INTO jobs(name,cursor,not_before) VALUES('hn-show-seed','{"seenUntil":77,"seenIds":["old"]}'::jsonb,NULL)
    ON CONFLICT(name) DO UPDATE SET cursor=excluded.cursor,not_before=NULL`);
});
afterEach(async () => {
  await db.execute(sql`DELETE FROM operations_observations WHERE key IN (${consumerKey},${workerKey})`);
  await db.execute(sql`DELETE FROM discovery_checkpoints WHERE (source='korean-language' AND subject=${languageSubject}) OR (source='show-hn' AND subject=${hnSubject})`);
  await db.execute(sql`TRUNCATE github_ko_discovery_queries,github_ko_discovery_staging`);
  await db.execute(sql`UPDATE crawl_settings SET values=${JSON.stringify(priorSettings)}::jsonb WHERE id=1`);
  await db.execute(sql`UPDATE job_batch_control SET mode=${priorBatch} WHERE id=1`);
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=${priorControl.enabled},start_at=${priorControl.start}::timestamp,
    queries=${JSON.stringify(priorControl.queries)}::jsonb,shared_cursor=${priorControl.shared === null ? null : JSON.stringify(priorControl.shared)}::jsonb WHERE id=1`);
  if (priorHn) await db.execute(sql`UPDATE jobs SET cursor=${priorHn.cursor === null ? null : JSON.stringify(priorHn.cursor)}::jsonb,not_before=${priorHn.notBefore}::timestamp WHERE name='hn-show-seed'`);
  else await db.execute(sql`DELETE FROM jobs WHERE name='hn-show-seed'`);
});

it('keeps repeated 15-minute language failures alarmable through actual storage and monitor reads, then clears on resolution', async () => {
  for (const repo of ['int-discovery/a', 'int-discovery/b']) await db.execute(sql`
    INSERT INTO github_ko_discovery_staging(repo,signal,priority,discovered_at) VALUES(${repo},'fixture',60,clock_timestamp()-interval '2 hours')`);
  expect((await readDiscoveryMonitor()).failures.covered).not.toContain('korean-language'); // Active demand without its first receipt is unknown.
  await saveKoreanLanguage('int-discovery/a', unknown());
  await assertSource('korean-language', false); // Initial fifteen-minute retry is healthy grace.
  for (const elapsed of [15, 31, 46]) {
    // Simulate elapsed DB time without waiting; the production helper must preserve this clock on every retry.
    await db.execute(sql`UPDATE discovery_checkpoints SET failure_started_at=clock_timestamp()-${elapsed}*interval '1 minute'
      WHERE source='korean-language' AND subject=${languageSubject}`);
    const before = await readFailure('korean-language');
    await saveKoreanLanguage(elapsed === 31 ? 'int-discovery/b' : 'int-discovery/a', unknown(elapsed === 46 ? 'http_503' : 'document_unavailable'));
    expect((await readFailure('korean-language')).started).toBe(before.started);
    await db.execute(sql`UPDATE github_ko_discovery_staging SET due_at='2099-01-01' WHERE language='unknown'`);
    await assertSource('korean-language', elapsed >= 30); // Even a far-future retry cannot mute the error streak.
  }
  await saveKoreanLanguage('int-discovery/a', { ...unknown('resolved'), language: 'yes' });
  expect((await readFailure('korean-language')).started).toBeNull();
  await assertSource('korean-language', false); // Actual unknown-to-yes progress resets the source streak.
  await saveKoreanLanguage('int-discovery/b', { ...unknown('resolved'), language: 'no' });
  await assertSource('korean-language', false); // Resolved empty unknown queue is an explicit clear.
  await db.execute(sql`INSERT INTO github_ko_discovery_staging(repo,signal,priority) VALUES('int-discovery/new','fixture',60)`);
  await saveKoreanLanguage('int-discovery/new', unknown());
  await assertSource('korean-language', false); // New demand receives its own grace.
});

it('uses immutable new demand for grace after an empty queue and requires a new receipt after a control generation change', async () => {
  await db.execute(sql`INSERT INTO github_ko_discovery_staging(repo,signal,priority,discovered_at)
    VALUES('int-discovery/old','fixture',60,clock_timestamp()-interval '2 hours')`);
  await saveKoreanLanguage('int-discovery/old', unknown());
  await db.execute(sql`UPDATE discovery_checkpoints SET failure_started_at=clock_timestamp()-interval '45 minutes'
    WHERE source='korean-language' AND subject=${languageSubject}`);
  const old = await readFailure('korean-language');
  await assertSource('korean-language', true);
  await db.execute(sql`DELETE FROM github_ko_discovery_staging WHERE repo='int-discovery/old'`);
  await assertSource('korean-language', false); // Canonical empty demand is sufficient even without a new receipt.
  await db.execute(sql`INSERT INTO github_ko_discovery_staging(repo,signal,priority) VALUES('int-discovery/new','fixture',60)`);
  await saveKoreanLanguage('int-discovery/new', unknown('http_503'));
  expect((await readFailure('korean-language')).started).toBe(old.started);
  await assertSource('korean-language', false); // The oldest pending creation time, not the next retry, starts new-demand grace.
  await db.execute(sql`UPDATE github_ko_discovery_control SET start_at='2026-01-02' WHERE id=1`);
  expect((await readDiscoveryMonitor()).failures.covered).not.toContain('korean-language');
  await saveKoreanLanguage('int-discovery/new', unknown());
  expect((await readFailure('korean-language')).started).not.toBe(old.started);
  await assertSource('korean-language', false);
});

it('does not renew HN empty coverage when the same oldest page succeeds but the next page repeatedly fails', async () => {
  await db.execute(sql`UPDATE github_ko_discovery_control SET enabled=false WHERE id=1`);
  let cursor: ShowHnCursor = { seenUntil: 77, seenIds: ['old'] };
  const save = async (next: ShowHnCursor, receipts: readonly DiscoveryCheckpointInput[] = []) => db.transaction(async tx => {
    await tx.execute(sql`UPDATE jobs SET cursor=${JSON.stringify(next)}::jsonb WHERE name='hn-show-seed'`);
    await checkpointDiscovery(tx, receipts);
    cursor = next;
  });
  const request: CappedRequest = async url => new URL(url).searchParams.get('page') === '1'
    ? new Response('{}', { status: 500 })
    : new Response(JSON.stringify({ nbPages: 3, nbHits: 3, hits: [{ objectID: 'old', created_at_i: 77, url: null }] }), { status: 200 });
  for (const elapsed of [0, 31, 61, 91]) {
    if (elapsed) await db.execute(sql`UPDATE discovery_checkpoints SET failure_started_at=clock_timestamp()-${elapsed}*interval '1 minute'
      WHERE source='show-hn' AND subject=${hnSubject}`);
    const before = await readFailure('show-hn');
    expect(await seedFromShowHN({ cursor, save, hasBudget: () => true, log: () => {} }, request)).toEqual({ done: false, cursor });
    const after = await readFailure('show-hn');
    expect(after.ack).toBeNull();
    if (before) expect(after.started).toBe(before.started);
    await assertSource('show-hn', elapsed >= 90);
  }
  const empty: CappedRequest = async () => new Response(JSON.stringify({ nbPages: 1, hits: [] }), { status: 200 });
  expect((await seedFromShowHN({ cursor, save, hasBudget: () => true, log: () => {} }, empty)).done).toBe(true);
  expect(await readFailure('show-hn')).toMatchObject({ started: null, ack: expect.any(String) });
  await assertSource('show-hn', false);
});
