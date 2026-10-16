import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
const transport = vi.hoisted(() => ({ gateway: vi.fn(), cli: vi.fn(), grok: vi.fn() }));
vi.mock('@/lib/crawl/agent-review-gateway', async load => ({ ...await load<typeof import('@/lib/crawl/agent-review-gateway')>(), reviewWithGateway: transport.gateway }));
vi.mock('@/lib/crawl/agent-review', async load => ({ ...await load<typeof import('@/lib/crawl/agent-review')>(), reviewWithAgent: transport.cli }));
vi.mock('@/lib/crawl/agent-review-grok', async load => ({ ...await load<typeof import('@/lib/crawl/agent-review-grok')>(), reviewWithGrokCli: transport.grok }));
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlSettings, crawlReviewAttempts } from '@/lib/db/schema';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { README_SAMPLE_VERSION } from '@/lib/crawl/readme';
import { REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { claimAgentReview, claimItemAgentReview, claimConsumerItemAgentReview, loadFirstReviewConsumerContext,
  loadReviewInput, recordAgentReview, type ReviewDomainContext, type ReviewClaim } from '@/lib/crawl/agent-review-repository';
import { executeFirstReviewConsumerItem } from '@/lib/crawl/agent-review-item-lifecycle';
import { runFirstReviewConsumer } from '@/lib/crawl/consumers/first';
import { reviewCrawlCandidates } from '@/lib/crawl/jobs/agent-review';
import { requestJob } from '@/lib/jobs/control';
import { runJob, type JobContext } from '@/lib/jobs/runner';
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from '@/lib/llm/capacity';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

type Raw = Record<string, unknown>;
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const marker = `pr06b-${randomUUID().slice(0, 8)}`, owner = { instanceId: `ai1-consumer-${marker}`, bootId: randomUUID() };
const managedJobs = ['crawl-agent-review', 'second-review', 'crawl-publish', 'crawl-fetch'];
const keys = { jobs: 'name', operations_observations: 'key', crawl_settings: 'id', model_capacity_control: 'id', pipeline_stage_modes: 'stage' } as const;
const work = new Set<Promise<unknown>>(), candidates = new Map<number, string>(), documents = new Map<number, string>();
const ownedRepos = new Set<string>(), itemKeys = new Map<string, number>();
const createdJobs = new Set<string>(), createdObservations = new Set<string>();
let baseline: Record<string, Raw[]> | undefined, cleanupFlight: Promise<void> | undefined, serial = 0;
function tracked<T>(value: Promise<T>): Promise<T> { work.add(value); void value.catch(() => {}); return value; }
function exercise(load: () => Promise<void>) { return tracked(Promise.resolve().then(load)); }
async function drain() { while (work.size) { const pending = [...work]; await Promise.allSettled(pending); pending.forEach(task => work.delete(task)); } }
async function steps(loaders: Array<() => Promise<unknown>>, prior: readonly unknown[] = []) {
  const errors = [...prior]; for (const load of loaders) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'pr06b_fixture_cleanup');
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin) {
  const result: Record<string, Raw[]> = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`)
    result[tablename] = (await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public."${String(tablename).replaceAll('"', '""')}" t ORDER BY to_jsonb(t)::text COLLATE "C"`)).map(row => row.row);
  return result;
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
        const [current] = await tx`SELECT to_jsonb(l) AS row FROM pipeline_item_leases l WHERE stage='ai1' AND work_key=${key} FOR UPDATE`;
        if (!current) continue;
        expect(current.row.token).toBeNull(); expect(current.row.binding.candidateId).toBe(candidateId);
        expect(current.row.binding.stage).toBe('ai1');
        expect(await tx`DELETE FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${key}
          AND to_jsonb(pipeline_item_leases)=${JSON.stringify(current.row)}::text::jsonb RETURNING work_key`).toHaveLength(1);
      }
      for (const [id, repo] of candidates) {
        const rows = await tx`SELECT to_jsonb(a) AS row FROM crawl_review_attempts a WHERE candidate_id=${id} ORDER BY id FOR UPDATE`;
        for (const { row } of rows) {
          expect(row.snapshot.product.repo).toBe(repo); expect(row.state).not.toBe('running');
          expect(await tx`DELETE FROM crawl_review_attempts WHERE id=${row.id} AND candidate_id=${id}
            AND to_jsonb(crawl_review_attempts)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
        }
        const [current] = await tx`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${id} AND repo=${repo} FOR UPDATE`;
        expect(current).toBeDefined();
        expect(await tx`DELETE FROM crawl_candidates WHERE id=${id} AND repo=${repo}
          AND to_jsonb(crawl_candidates)=${JSON.stringify(current.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      }
      for (const [id, repo] of documents) {
        const [current] = await tx`SELECT to_jsonb(d) AS row FROM crawl_documents d WHERE id=${id} AND repo=${repo} FOR UPDATE`;
        expect(current).toBeDefined();
        expect(await tx`DELETE FROM crawl_documents WHERE id=${id} AND repo=${repo}
          AND to_jsonb(crawl_documents)=${JSON.stringify(current.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      }
      for (const repo of ownedRepos) {
        const rows = await tx`SELECT to_jsonb(c) AS row FROM crawl_publication_changes c WHERE repo=${repo} FOR UPDATE`;
        for (const { row } of rows) expect(await tx`DELETE FROM crawl_publication_changes WHERE id=${row.id} AND repo=${repo}
          AND to_jsonb(crawl_publication_changes)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
      }
      for (const name of managedJobs) { await restore('jobs', name, tx); await restore('operations_observations', `job:${name}`, tx); }
      await restore('crawl_settings', 1, tx); await restore('model_capacity_control', 1, tx); await restore('pipeline_stage_modes', 'ai1', tx);
      expect(await whole(tx)).toEqual(baseline);
    });
    candidates.clear(); documents.clear(); ownedRepos.clear(); itemKeys.clear(); createdJobs.clear(); createdObservations.clear();
  })();
  cleanupFlight = task; void task.finally(() => { if (cleanupFlight === task) cleanupFlight = undefined; }).catch(() => {}); return task;
}
const settings = (): CrawlSettings => ({ ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: 'enforce',
  firstReview: { provider: 'abcllm', model: 'pr06b-first' }, agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enforceEligibility: false },
  secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: false } });
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { fixture: 1 }, groupLimits: { fixture: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: 'crawl-agent-review', provider: 'abcllm', model: 'pr06b-first', providerBudgetId: 'fixture', groupId: 'fixture' }] };
async function mode(value: 'disabled' | 'open' | 'draining') {
  await admin`UPDATE model_capacity_control SET mode=${value},policy=${JSON.stringify(policy)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(policy)} WHERE id=1`;
}
async function stage(value: 'legacy' | 'items' | 'draining') {
  await admin`UPDATE pipeline_stage_modes SET mode=${value},draining_from=${value === 'draining' ? 'items' : null},writer_contract_version=1 WHERE stage='ai1'`;
}
async function actualJob<T>(body: (ctx: JobContext<null>) => Promise<T>) {
  await tracked(requestJob('crawl-agent-review')); let value!: T, failure: { error: unknown } | undefined;
  const result = await tracked(runJob<null>('crawl-agent-review', async ctx => {
    try { value = await body(ctx); } catch (error) { failure = { error }; throw error; } return { done: true };
  }, { requestedOnly: true }));
  if (failure) throw failure.error; expect(result).toMatchObject({ status: 'completed' }); return value;
}
async function source(rules = false): Promise<ReviewDomainContext> {
  const repo = `${marker}/app-${++serial}`, now = new Date(Date.now() - 2_000), configured = settings();
  for (const table of ['crawl_candidates', 'crawl_documents', 'crawl_publication_changes'] as const)
    expect(await admin.unsafe(`SELECT repo FROM ${table} WHERE repo=$1`, [repo])).toHaveLength(0);
  ownedRepos.add(repo);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: `https://${repo.replaceAll('/', '-')}.example`, fetchedAt: now,
    pageStatus: rules ? 404 : 200, repoMeta: { description: 'A deployed task application', stargazers_count: 3 }, pageMeta: { title: 'Projects',
      description: 'Create projects and manage tasks', textSample: 'Manage projects online', readmeSample: 'A deployed task manager', readmeSampleVersion: README_SAMPLE_VERSION } }).returning();
  documents.set(document.id, repo);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: document.productUrl, state: 'approved',
    reason: 'passed', decidedBy: 'auto', judgedAt: now, updatedAt: now }).returning();
  candidates.set(candidate.id, repo);
  const key = `ai1:${candidate.id}`;
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${key}`).toHaveLength(0); itemKeys.set(key, candidate.id);
  return { candidate, document, settings: configured, input: await loadReviewInput(candidate, document, configured) };
}
function claimed(value: ReviewClaim) { expect(value.kind).not.toBe('skipped'); if (value.kind === 'skipped') throw new Error(`pr06b_claim_${value.reason}`); return value; }
beforeAll(() => tracked((async () => {
  ensureSchema(); baseline = await whole();
  // Required fresh-first CI service, after AI2 restored its row baseline. Sequence values may already have advanced.
  for (const name of ['crawl_candidates','crawl_review_attempts','second_reviews']) expect(baseline[name]).toHaveLength(0);
  expect(baseline.model_capacity_requests.filter(row => ['waiting','reserved','dispatched','indeterminate'].includes(String(row.state)))).toHaveLength(0);
  expect(baseline.pipeline_item_leases.filter(row => row.token !== null)).toHaveLength(0);
  for (const row of baseline.jobs.filter(row => managedJobs.includes(String(row.name)))) expect(row.lease_token).toBeNull();
})()));
beforeEach(() => tracked((async () => {
  await cleanup(); vi.resetAllMocks();
  const created = await admin.begin(async tx => {
    const inserted = { jobs: [] as string[], observations: [] as string[] };
    for (const name of managedJobs.toSorted()) {
      if (!baseline!.jobs.some(row => row.name === name)) { expect(await tx`INSERT INTO jobs(name) VALUES(${name}) ON CONFLICT DO NOTHING RETURNING name`).toHaveLength(1); inserted.jobs.push(name); }
      const key = `job:${name}`;
      if (!baseline!.operations_observations.some(row => row.key === key)) { expect(await tx`INSERT INTO operations_observations(key,value) VALUES(${key},'{}'::jsonb) ON CONFLICT DO NOTHING RETURNING key`).toHaveLength(1); inserted.observations.push(key); }
    } return inserted;
  });
  created.jobs.forEach(name => createdJobs.add(name)); created.observations.forEach(key => createdObservations.add(key));
  await db.insert(crawlSettings).values({ id: 1, values: settings(), updatedBy: marker })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings(), updatedBy: marker } });
  await mode('disabled'); await stage('legacy');
})()));
afterEach(async () => { await steps([drain, cleanup]); });
afterAll(async () => { await steps([drain, cleanup, async () => { if (baseline) expect(await whole()).toEqual(baseline); },
  () => admin.end(), async () => { await (globalThis as { pgClient?: ReturnType<typeof postgres> }).pgClient?.end(); }]); });

it.each(['disabled', 'open', 'draining'] as const)('fresh AI1 consumer in %s rolls back every attempt/item/outbox without a model call', value => exercise(async () => {
  const context = await source(); await stage('items'); await mode(value); const before = await whole();
  await expect(executeFirstReviewConsumerItem({ candidateId: context.candidate.id, owner })).rejects.toMatchObject({
    name: 'ModelCapacityDeferredError', reason: value === 'open' ? 'provider_contract_unavailable' : value });
  expect(await whole()).toEqual(before); for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
}));
it('model-control disabled and an unrequested legacy job do not block prepared server rules', () => exercise(async () => {
  const context = await source(true); await stage('items'); const before = (await whole()).jobs.find(row => row.name === 'crawl-agent-review');
  expect(await runFirstReviewConsumer({ owner, once: true })).toEqual({ attempted: 1, recorded: 1, skipped: 0, deferred: 0 });
  const [attempt] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, context.candidate.id));
  expect(attempt).toMatchObject({ state: 'succeeded', provider: 'rules', model: REVIEW_RULES_VERSION });
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, context.candidate.id));
  expect(candidate).toMatchObject({ state: 'rejected', decidedBy: 'auto' });
  expect((await whole()).jobs.find(row => row.name === 'crawl-agent-review')).toEqual(before);
  for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
}));
it('reuses a genuine prior result across a fresh equivalent source through the mandatory item writer', () => exercise(async () => {
  const context = await source(); let originalId = 0;
  await actualJob(async ctx => {
    const claim = claimed(await claimAgentReview({ ...context, provider: 'abcllm', model: 'pr06b-first', lease: ctx.lease! })); originalId = claim.attempt.id;
    expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: { decision: 'approve', reason: 'Deployed task manager', evidenceIds: ['product'] } })).toMatchObject({ state: 'succeeded' });
  });
  await admin`UPDATE crawl_documents SET fetched_at=clock_timestamp() - interval '1 second' WHERE id=${context.document.id}`;
  await stage('items');
  expect(await executeFirstReviewConsumerItem({ candidateId: context.candidate.id, owner })).toMatchObject({ applied: true, state: 'succeeded' });
  const attempts = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, context.candidate.id));
  expect(attempts).toHaveLength(2); expect(attempts.find(row => row.id !== originalId)).toMatchObject({ state: 'succeeded', reusedFromAttemptId: originalId });
  for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
}));
it('a human change after the actual claim is preserved by the original writer', () => exercise(async () => {
  const context = await source(true); await stage('items');
  const claim = claimed(await claimConsumerItemAgentReview({ ...context, provider: 'rules', model: REVIEW_RULES_VERSION, owner, ttlMs: 90_000 }));
  await admin`UPDATE crawl_candidates SET decided_by='admin',state='rejected',reason='not_a_product',updated_at=clock_timestamp() WHERE id=${context.candidate.id}`;
  const [before] = await admin`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${context.candidate.id}`;
  expect(await recordAgentReview({ ...context, receipt: claim.receipt, outcome: { decision: 'reject', reason: 'Server rule', evidenceIds: ['product'] } })).toEqual({ applied: false, state: 'superseded' });
  expect((await admin`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${context.candidate.id}`)[0].row).toEqual(before.row);
}));
it('healthy legacy and item owners survive a competing consumer without token or epoch mutation', () => exercise(async () => {
  const context = await source(); let release!: () => void, ready!: () => void;
  const settled = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { ready = done; });
  const running = tracked(actualJob(async ctx => {
    const claim = claimed(await claimAgentReview({ ...context, provider: 'abcllm', model: 'pr06b-first', lease: ctx.lease! })); ready(); await settled;
    await recordAgentReview({ ...context, receipt: claim.receipt, error: 'cancelled' });
  }));
  const errors: unknown[] = [];
  try {
    await Promise.race([started, running.then(() => { throw new Error('pr06b_legacy_ended_before_barrier'); })]);
    await stage('items'); const before = await whole();
    expect(await executeFirstReviewConsumerItem({ candidateId: context.candidate.id, owner })).toEqual({ state: 'skipped', reason: 'running' });
    expect(await whole()).toEqual(before);
  } catch (error) { errors.push(error); }
  finally { await steps([() => stage('legacy'), async () => { release(); await running; }], errors); }
  const second = await source(); await stage('items');
  const original = claimed(await claimItemAgentReview({ ...second, provider: 'abcllm', model: 'pr06b-first', owner, ttlMs: 90_000 }));
  const before = await whole(), itemErrors: unknown[] = [];
  try {
    expect(await executeFirstReviewConsumerItem({ candidateId: second.candidate.id, owner: { ...owner, bootId: randomUUID() } })).toEqual({ state: 'skipped', reason: 'running' });
    expect(await whole()).toEqual(before);
  } catch (error) { itemErrors.push(error); }
  finally { await steps([() => recordAgentReview({ ...second, receipt: original.receipt, error: 'cancelled' })], itemErrors); }
}));
it('item and draining controller jobs hand off exhaustion but preserve the original request and ACK boundary', () => exercise(async () => {
  for (const value of ['items', 'draining'] as const) {
    await stage('legacy'); const context = await source();
    for (let n = 0; n < 3; n++) {
      await actualJob(async ctx => { const claim = claimed(await claimAgentReview({ ...context, provider: 'abcllm', model: 'pr06b-first', lease: ctx.lease! }));
        expect(await recordAgentReview({ ...context, receipt: claim.receipt, error: 'fixture_failure' })).toMatchObject({ state: 'failed' }); });
      await admin`UPDATE crawl_review_attempts SET retry_after=clock_timestamp() - interval '1 second' WHERE candidate_id=${context.candidate.id} AND state='failed'`;
    }
    await stage(value); await tracked(requestJob('crawl-agent-review')); const before = (await whole()).jobs.find(row => row.name === 'crawl-agent-review')!;
    expect(await tracked(runJob('crawl-agent-review', reviewCrawlCandidates, { requestedOnly: true }))).toMatchObject({ status: 'deferred', reason: 'stage_blocked' });
    const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, context.candidate.id));
    expect(candidate).toMatchObject({ state: 'needs_review', reason: 'ai_review_exhausted' });
    const after = (await whole()).jobs.find(row => row.name === 'crawl-agent-review')!;
    for (const key of ['requested_version','processed_version','cursor','not_before','last_error','last_success_at']) expect(after[key]).toEqual(before[key]);
    expect(after.lease_token).toBeNull();
  }
  for (const mock of Object.values(transport)) expect(mock).not.toHaveBeenCalled();
}));
