import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
const transport = vi.hoisted(() => ({ gateway: vi.fn(), cli: vi.fn(), grok: vi.fn() }));
vi.mock('@/lib/crawl/agent-review-gateway', async load => ({
  ...await load<typeof import('@/lib/crawl/agent-review-gateway')>(), reviewWithGateway: transport.gateway,
}));
vi.mock('@/lib/crawl/agent-review', async load => ({
  ...await load<typeof import('@/lib/crawl/agent-review')>(), reviewWithAgent: transport.cli,
}));
vi.mock('@/lib/crawl/agent-review-grok', async load => ({
  ...await load<typeof import('@/lib/crawl/agent-review-grok')>(), reviewWithGrokCli: transport.grok,
}));
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlSettings, secondReviews } from '@/lib/db/schema';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { README_SAMPLE_VERSION } from '@/lib/crawl/readme';
import { claimAgentReview, loadReviewInput, recordAgentReview } from '@/lib/crawl/agent-review-repository';
import { enqueueSecondReviews, recordSecondReview } from '@/lib/crawl/second-review';
import { claimItemSecondReview } from '@/lib/crawl/second-review-ownership';
import { executeSecondReviewConsumerItem } from '@/lib/crawl/second-review-item-lifecycle';
import { secondReviewCandidates } from '@/lib/crawl/jobs/second-review';
import { runSecondReviewConsumer } from '@/lib/crawl/consumers/second';
import { requestJob, JobLeaseLostError, type JobLease } from '@/lib/jobs/control';
import { runJob, type JobContext } from '@/lib/jobs/runner';
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from '@/lib/llm/capacity';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

type Raw = Record<string, unknown>;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const marker = `pr06a-${randomUUID().slice(0, 8)}`;
const owner = { instanceId: marker, bootId: randomUUID() };
const managedJobs = ['crawl-agent-review', 'second-review', 'crawl-publish'];
const keys = { jobs: 'name', operations_observations: 'key', crawl_settings: 'id', model_capacity_control: 'id', pipeline_stage_modes: 'stage' } as const;
const work = new Set<Promise<unknown>>(), candidates = new Map<number, string>(), documents = new Map<number, string>();
const itemKeys = new Map<string, number>(), itemRows = new Map<string, Raw>(), votes = new Map<number, Raw>();
const createdJobs = new Set<string>(), createdObservations = new Set<string>();
let baseline: Record<string, Raw[]> | undefined, cleanupFlight: Promise<void> | undefined;
function tracked<T>(value: Promise<T>): Promise<T> { work.add(value); void value.catch(() => {}); return value; }
function exercise(load: () => Promise<void>) { return tracked(Promise.resolve().then(load)); }
async function drain() {
  while (work.size) { const snapshot = [...work]; await Promise.allSettled(snapshot); snapshot.forEach(task => work.delete(task)); }
}
async function steps(loaders: Array<() => Promise<unknown>>) {
  const errors: unknown[] = [];
  for (const load of loaders) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'pr06a_fixture_cleanup');
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const result: Record<string, Raw[]> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    result[tablename] = (await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public."${String(tablename).replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text COLLATE "C"`)).map(row => row.row);
  }
  return result;
}
async function rememberVote(id: number, candidateId: number, repo: string) {
  expect(candidates.get(candidateId)).toBe(repo);
  const rows = await admin`SELECT to_jsonb(s) AS row FROM second_reviews s WHERE id=${id} AND candidate_id=${candidateId} AND repo=${repo}`;
  expect(rows).toHaveLength(1); votes.set(id, rows[0].row);
}
async function restore(table: keyof typeof keys, key: unknown, tx: postgres.TransactionSql) {
  const column = keys[table];
  const [row] = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM "${table}" t WHERE "${column}"::text=$1 FOR UPDATE`, [String(key)]);
  const original = baseline![table].find(value => String(value[column]) === String(key));
  if (!row) { expect(original).toBeUndefined(); return; }
  const current = row.row as Raw;
  if (table === 'jobs') expect(current.lease_token).toBeNull();
  if (original) {
    if (JSON.stringify(current) === JSON.stringify(original)) return;
    const columns = Object.keys(original).filter(name => name !== column);
    expect(await tx.unsafe(`UPDATE "${table}" t SET ${columns.map(name => `"${name}"=saved."${name}"`).join(',')}
      FROM jsonb_populate_record(NULL::"${table}",$1::text::jsonb) saved
      WHERE t."${column}"=saved."${column}" AND to_jsonb(t)=$2::text::jsonb RETURNING t."${column}"`,
    [JSON.stringify(original), JSON.stringify(current)])).toHaveLength(1);
  } else {
    expect(table === 'jobs' ? createdJobs.has(String(key)) : table === 'operations_observations' ? createdObservations.has(String(key))
      : table === 'crawl_settings' && current.updated_by === marker).toBe(true);
    expect(await tx.unsafe(`DELETE FROM "${table}" t WHERE "${column}"::text=$1 AND to_jsonb(t)=$2::text::jsonb RETURNING "${column}"`,
    [String(key), JSON.stringify(current)])).toHaveLength(1);
  }
}
function cleanup(): Promise<void> {
  if (cleanupFlight) return cleanupFlight;
  const task = (async () => {
    if (!baseline) return;
    await admin.begin(async tx => {
      for (const [key, candidateId] of itemKeys) {
        const [current] = await tx`SELECT to_jsonb(l) AS row FROM pipeline_item_leases l WHERE stage='ai2' AND work_key=${key} FOR UPDATE`;
        if (!current) continue;
        expect(current.row).toEqual(itemRows.get(key)); expect(current.row.token).toBeNull();
        expect(await tx`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${key}
          AND binding->>'candidateId'=${String(candidateId)} AND to_jsonb(pipeline_item_leases)=${JSON.stringify(current.row)}::text::jsonb RETURNING work_key`).toHaveLength(1);
      }
      for (const [id, original] of votes) {
        expect(candidates.get(Number(original.candidate_id))).toBe(original.repo);
        expect(await tx`DELETE FROM second_reviews WHERE id=${id} AND candidate_id=${Number(original.candidate_id)}
          AND repo=${String(original.repo)} AND to_jsonb(second_reviews)=${JSON.stringify(original)}::text::jsonb RETURNING id`).toHaveLength(1);
      }
      for (const [id, repo] of candidates) await tx`DELETE FROM crawl_candidates WHERE id=${id} AND repo=${repo}`;
      for (const [id, repo] of documents) await tx`DELETE FROM crawl_documents WHERE id=${id} AND repo=${repo}`;
      for (const repo of candidates.values()) {
        const rows = await tx`SELECT id FROM crawl_publication_changes WHERE repo=${repo}`;
        for (const row of rows) await tx`DELETE FROM crawl_publication_changes WHERE id=${row.id} AND repo=${repo}`;
      }
      for (const name of managedJobs) {
        await restore('jobs', name, tx); await restore('operations_observations', `job:${name}`, tx);
      }
      await restore('crawl_settings', 1, tx); await restore('model_capacity_control', 1, tx);
      await restore('pipeline_stage_modes', 'ai2', tx);
      expect(await whole(tx)).toEqual(baseline);
    });
    candidates.clear(); documents.clear(); votes.clear(); itemKeys.clear(); itemRows.clear(); createdJobs.clear(); createdObservations.clear();
  })();
  cleanupFlight = task; void task.finally(() => { if (cleanupFlight === task) cleanupFlight = undefined; }).catch(() => {});
  return task;
}
const settings = (): CrawlSettings => ({ ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: 'enforce',
  firstReview: { provider: 'abcllm', model: 'pr06-first' }, secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview),
    enabled: true, voters: [{ provider: 'abcllm', model: 'pr06-second' }], fallbacks: [] } });
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { fixture: 1 }, groupLimits: { fixture: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: 'second-review', provider: 'abcllm', model: 'pr06-second', providerBudgetId: 'fixture', groupId: 'fixture' }] };
async function mode(value: 'disabled' | 'open' | 'draining') {
  await admin`UPDATE model_capacity_control SET mode=${value},policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)} WHERE id=1`;
}
async function stage(value: 'legacy' | 'items' | 'draining') {
  await admin`UPDATE pipeline_stage_modes SET mode=${value},draining_from=${value === 'draining' ? 'items' : null},writer_contract_version=1 WHERE stage='ai2'`;
}
async function actualJob<T>(name: 'crawl-agent-review' | 'second-review', body: (ctx: JobContext<null>) => Promise<T>) {
  await tracked(requestJob(name));
  let value!: T, failure: { error: unknown } | undefined;
  const result = await tracked(runJob<null>(name, async ctx => {
    try { value = await body(ctx); } catch (error) { failure = { error }; throw error; }
    return { done: true };
  }, { requestedOnly: true }));
  if (failure) throw failure.error;
  expect(result).toMatchObject({ status: 'completed' }); return value;
}
async function source(enqueue = true) {
  const repo = `${marker}/app-${candidates.size + 1}`, now = new Date(Date.now() - 2_000), configured = settings();
  expect(await admin`SELECT id FROM crawl_publication_changes WHERE repo=${repo}`).toHaveLength(0);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: `https://${repo.replaceAll('/', '-')}.example`, fetchedAt: now,
    pageStatus: 200, repoMeta: { description: 'A deployed application', stargazers_count: 3 }, pageMeta: { title: 'Projects',
      description: 'Create projects and manage tasks', textSample: 'Manage projects online', readmeSample: 'A deployed task manager', readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  documents.set(document.id, repo);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: document.productUrl, state: 'approved',
    reason: 'passed', decidedBy: 'auto', judgedAt: now, updatedAt: now }).returning();
  candidates.set(candidate.id, repo);
  const input = await loadReviewInput(candidate, document, configured);
  await actualJob('crawl-agent-review', async ctx => {
    const context = { candidate, document, settings: configured, input, provider: 'abcllm' as const, model: 'pr06-first', lease: ctx.lease! };
    const claim = await claimAgentReview(context); expect(claim.kind).toBe('claimed');
    if (claim.kind === 'skipped') throw new Error('pr06_first_claim_skipped');
    expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: { decision: 'approve', confidence: .99,
      reason: 'Deployed task application', evidenceIds: ['product'] } })).toMatchObject({ applied: true, state: 'succeeded' });
  });
  if (!enqueue) return { candidate, row: null };
  expect(await actualJob('second-review', ctx => enqueueSecondReviews(configured, undefined, ctx.lease!))).toBe(1);
  const [row] = await db.select().from(secondReviews).where(eq(secondReviews.candidateId, candidate.id));
  await rememberVote(row.id, candidate.id, repo);
  expect(row).toMatchObject({ status: 'pending', model: 'pr06-second' });
  const key = `ai2:${row.id}`;
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${key}`).toHaveLength(0);
  itemKeys.set(key, candidate.id);
  return { candidate, row };
}
beforeAll(() => tracked((async () => {
  ensureSchema(); baseline = await whole();
  // No selector parking or foreign restoration: refuse shared active work before any fixture DML.
  expect(baseline.crawl_candidates).toHaveLength(0); expect(baseline.second_reviews).toHaveLength(0);
  expect(baseline.model_capacity_requests.filter(row => ['waiting','reserved','dispatched','indeterminate'].includes(String(row.state)))).toHaveLength(0);
  expect(baseline.pipeline_item_leases.filter(row => row.token !== null)).toHaveLength(0);
  for (const row of baseline.jobs.filter(row => managedJobs.includes(String(row.name)))) expect(row.lease_token).toBeNull();
})()));
beforeEach(() => tracked((async () => {
  await cleanup(); vi.resetAllMocks();
  const created = await admin.begin(async tx => {
    const inserted = { jobs: [] as string[], observations: [] as string[] };
    for (const name of managedJobs.toSorted()) {
      if (!baseline!.jobs.some(row => row.name === name)) {
        expect(await tx`INSERT INTO jobs(name) VALUES(${name}) ON CONFLICT DO NOTHING RETURNING name`).toHaveLength(1); inserted.jobs.push(name);
      }
      const key = `job:${name}`;
      if (!baseline!.operations_observations.some(row => row.key === key)) {
        expect(await tx`INSERT INTO operations_observations(key,value) VALUES(${key},'{}'::jsonb) ON CONFLICT DO NOTHING RETURNING key`).toHaveLength(1); inserted.observations.push(key);
      }
    }
    return inserted;
  });
  created.jobs.forEach(name => createdJobs.add(name)); created.observations.forEach(key => createdObservations.add(key));
  await db.insert(crawlSettings).values({ id: 1, values: settings(), updatedBy: marker })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings(), updatedBy: marker } });
  await mode('disabled'); await stage('legacy');
})()));
afterEach(async () => { await steps([drain, cleanup]); });
afterAll(async () => { await steps([drain, cleanup, async () => { if (baseline) expect(await whole()).toEqual(baseline); },
  () => admin.end(), async () => { await (globalThis as { pgClient?: ReturnType<typeof postgres> }).pgClient?.end(); }]); });

it.each(['disabled', 'open', 'draining'] as const)('consumer admission in %s rolls back vote, item, capacity and outbox without transport', value => exercise(async () => {
  const context = await source(); await stage('items'); await mode(value);
  const before = await whole();
  await expect(executeSecondReviewConsumerItem({ secondReviewId: context.row!.id, owner })).rejects.toMatchObject({
    name: 'ModelCapacityDeferredError', reason: value === 'open' ? 'provider_contract_unavailable' : value,
  });
  expect(await whole()).toEqual(before); for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
}));
it('real once consumer reads pending hints and preserves work on its disabled admission', () => exercise(async () => {
  await source(); await stage('items'); const before = await whole();
  expect(await runSecondReviewConsumer({ owner, once: true })).toEqual({ attempted: 1, recorded: 0, skipped: 0, deferred: 1 });
  expect(await whole()).toEqual(before); for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
}));
it('disabled compatibility entry still claims an actual item and settles its original cancelled writer', () => exercise(async () => {
  const context = await source(); await stage('items');
  const claimed = await claimItemSecondReview(context.row!.id, owner, 90_000); expect(claimed.kind).toBe('claimed');
  if (claimed.kind !== 'claimed') throw new Error('pr06_compatibility_claim_skipped');
  expect(claimed.receipt.ownership.kind).toBe('item');
  expect(await recordSecondReview({ receipt: claimed.receipt, result: { ok: false, error: 'cancelled', provider: 'abcllm', model: 'pr06-second' } })).toEqual({ state: 'cancelled' });
  const key = `ai2:${context.row!.id}`;
  const [released] = await admin`SELECT to_jsonb(l) AS row FROM pipeline_item_leases l WHERE stage='ai2' AND work_key=${key}`;
  expect(released.row).toMatchObject({ token: null, owner_instance_id: null }); itemRows.set(key, released.row);
  expect(await admin`SELECT request_id FROM model_capacity_requests`).toHaveLength(baseline!.model_capacity_requests.length);
}));
it.each(['items', 'draining'] as const)('actual %s controller job produces AI2 work without legacy claims or producer ACK', value => exercise(async () => {
  const context = await source(false); await stage(value); await mode('open'); await requestJob('second-review');
  const before = (await whole()).jobs.find(row => row.name === 'second-review')!;
  expect(await tracked(runJob('second-review', secondReviewCandidates, { requestedOnly: true }))).toMatchObject({ status: 'deferred', reason: 'stage_blocked' });
  const [vote] = await db.select().from(secondReviews).where(eq(secondReviews.candidateId, context.candidate.id));
  await rememberVote(vote.id, context.candidate.id, context.candidate.repo);
  expect(vote).toMatchObject({ status: 'pending', model: 'pr06-second' });
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${vote.id}`}`).toHaveLength(0);
  itemKeys.set(`ai2:${vote.id}`, context.candidate.id);
  const after = (await whole()).jobs.find(row => row.name === 'second-review')!;
  for (const key of ['requested_version','processed_version','cursor','not_before','last_error','last_success_at']) expect(after[key]).toEqual(before[key]);
  expect(after.lease_token).toBeNull(); for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
}));
it('items controllers reject an actually issued but released job token and roll back their candidate unit', () => exercise(async () => {
  await source(false); await stage('items');
  let original!: JobLease;
  await actualJob('second-review', async ctx => { original = ctx.lease!; });
  const before = await whole();
  const context = { cursor: null, lease: original, hasBudget: () => true, save: vi.fn(), log: vi.fn() };
  await expect(secondReviewCandidates(context)).rejects.toBeInstanceOf(JobLeaseLostError);
  expect(await whole()).toEqual(before);
  for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
}));
