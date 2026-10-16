import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, products, secondReviews } from '@/lib/db/schema';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { executeSecondReviewConsumerItem } from '@/lib/crawl/second-review-item-lifecycle';
import { claimConsumerItemSecondReview, claimSecondReviewItemWithModelReservation,
  SecondReviewModelReservationRequired } from '@/lib/crawl/second-review-ownership';
import { secondReviewGeneration } from '@/lib/crawl/second-review-input';
import { publishedInputHash } from '@/lib/crawl/second-review';
import { markPublished } from '@/lib/crawl/repository';
import { prepareAi2GatewayCall, type PreparedAi2GatewayCall } from '@/lib/crawl/agent-review-gateway';
import type { Ai2GatewayServingContract } from '@/lib/crawl/second-review-serving-contract';
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequestIdentity,
  type ModelCapacityReservation } from '@/lib/llm/capacity';
import { requestAi2ItemModelSlot } from '@/lib/llm/capacity-repository';
import { itemBindingHash } from '@/lib/jobs/items/types';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// The only authority-boundary replacement is the fixed deployment allowlist.
// Native HTTP, the queue, item claim/observer/renew and mandatory writer are real.
const serving = vi.hoisted(() => ({ contract: null as Ai2GatewayServingContract | null }));
vi.mock('@/lib/crawl/second-review-serving-contract', async original => ({
  ...await original<typeof import('@/lib/crawl/second-review-serving-contract')>(),
  resolveAi2GatewayServingContract: () => serving.contract,
}));
type Raw = Record<string, unknown>;
type Snapshot = Record<string, Raw[]>;
const prefix = `ai2-native-${randomUUID().slice(0, 12)}`, model = 'AI2 exact native model';
const owner = { instanceId: prefix, bootId: randomUUID() }, ownBoots = new Set<string>([owner.bootId]);
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: 'ai2-native-runtime-fixture' } });
const work = new Set<Promise<unknown>>(), bodies = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
const candidates = new Map<number, string>(), documents = new Map<number, string>(), productIds = new Map<number, string>();
const slots = new Set<number>(), managedJobs = ['second-review', 'crawl-publish'];
let baseline: Snapshot, initialized = false, setupWork: Promise<void> | undefined, cleaning: Promise<void> | undefined, serial = 0;
let triggerAttempted = false;
const eventFaultBody = "\n      BEGIN IF NEW.kind='dispatch_started' THEN RAISE EXCEPTION 'ai2_runtime_event_fault'; END IF; RETURN NEW; END ";
const functionName = 'pr05b5_ai2_runtime_event', triggerName = 'pr05b5_ai2_runtime_event';
function tracked<T>(pending: Promise<T>, set = work): Promise<T> { set.add(pending); void pending.catch(() => {}); return pending; }
const exercise = (load: () => Promise<void>) => () => tracked(Promise.resolve().then(load), bodies);
async function drain(set: Set<Promise<unknown>>, keepErrors = false) {
  const pending = [...set], results = await Promise.allSettled(pending);
  pending.forEach(promise => set.delete(promise));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (keepErrors && errors.length) throw new AggregateError(errors, 'ai2_native_pending_failed');
}
async function steps(loads: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior];
  for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'ai2_native_cleanup_failed', { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS value
      FROM public."${String(tablename).replaceAll('"', '""')}" t`);
    result[tablename] = row.value;
  }
  return result;
}
function policy(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: 'enforce',
    firstReview: { provider: 'abcllm', model: 'AI2 native first' }, secondReview: {
      ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: 'abcllm', model }], fallbacks: [{ provider: 'abcllm', model: `${model} backup` }] } };
}
const capacityPolicy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { local: 4 }, groupLimits: { engine: 4 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60_000, reservationTtlMs: 60_000, routes: [model, `${model} backup`].map(value => ({
    routeId: 'second-review', provider: 'abcllm', model: value, providerBudgetId: 'local', groupId: 'engine' })) };
async function install(mode: 'open' | 'disabled' = 'open') {
  await db.insert(crawlSettings).values({ id: 1, values: policy(), updatedBy: prefix })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: policy(), updatedBy: prefix } });
  await admin`UPDATE pipeline_stage_modes SET mode='items',draining_from=NULL,writer_contract_version=1 WHERE stage='ai2'`;
  await admin`UPDATE model_capacity_control SET mode=${mode},policy=${JSON.stringify(capacityPolicy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(capacityPolicy)},cursor=0 WHERE id=1`;
}
// Fixed managed rows are restored with PostgreSQL's full-row JSON parser, so
// timestamps never pass through Date/millisecond conversion.
async function restoreManaged(tx: postgres.TransactionSql, table: string, key: string, values: readonly unknown[]) {
  if (!['crawl_settings', 'pipeline_stage_modes', 'model_capacity_control', 'jobs', 'operations_observations'].includes(table))
    throw new Error('invalid_fixture_restore_table');
  const rows = baseline[table].filter(row => values.includes(row[key]));
  const columns = (await tx`SELECT column_name FROM information_schema.columns WHERE table_schema='public'
    AND table_name=${table} ORDER BY ordinal_position`).map(row => String(row.column_name));
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  for (const value of values) {
    const original = rows.find(row => row[key] === value);
    if (!original) await tx.unsafe(`DELETE FROM public.${quote(table)} WHERE ${quote(key)}=$1`, [value as string]);
    else await tx.unsafe(`INSERT INTO public.${quote(table)} SELECT r.* FROM jsonb_populate_record(NULL::public.${quote(table)},$1::text::jsonb) r
      ON CONFLICT (${quote(key)}) DO UPDATE SET ${columns.filter(column => column !== key).map(column => `${quote(column)}=EXCLUDED.${quote(column)}`).join(',')}`,
    [JSON.stringify(original)]);
  }
}
async function removeTrigger() {
  if (!triggerAttempted) return;
  await admin.begin(async tx => {
    const functions = await tx`SELECT oid::text,prosrc FROM pg_proc WHERE oid=to_regprocedure('public.pr05b5_ai2_runtime_event()')`;
    const triggers = await tx`SELECT tgfoid::text,tgtype::int FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass AND tgname=${triggerName}`;
    if (functions.length) expect(functions[0].prosrc).toBe(eventFaultBody);
    if (triggers.length) {
      expect(functions).toHaveLength(1); expect(triggers).toEqual([{ tgfoid: functions[0].oid, tgtype: 7 }]);
      await tx.unsafe(`DROP TRIGGER ${triggerName} ON model_capacity_events`);
    }
    if (functions.length) await tx.unsafe(`DROP FUNCTION public.${functionName}()`);
  });
  triggerAttempted = false;
}
async function performCleanup() {
  if (!initialized) return;
  await removeTrigger();
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const managed = await tx`SELECT lease_token FROM jobs WHERE name=ANY(${managedJobs}) FOR UPDATE`;
    expect(managed.every(row => row.lease_token === null)).toBe(true);
    const ids = [...candidates.keys()];
    const requestRows = await tx`SELECT to_jsonb(r) AS value FROM model_capacity_requests r
      WHERE owner_instance_id=${owner.instanceId} ORDER BY request_id FOR UPDATE`;
    // UUID/owner was absent before setup, and every row must belong to one of
    // this fixture's private candidate+vote keys. Never delete by prefix alone.
    const requests = requestRows.map(row => row.value as Raw);
    for (const row of requests) {
      expect(row.owner_instance_id).toBe(owner.instanceId); expect(ownBoots.has(String(row.owner_boot_id))).toBe(true);
      expect([row.class, row.pool, row.route_id, row.provider]).toEqual(['second', 'reviewer', 'second-review', 'abcllm']);
      expect([model, `${model} backup`]).toContain(row.model);
      expect(ids.some(id => String(row.logical_work_key).startsWith(`ai2:${id}:`))).toBe(true);
      expect(baseline.model_capacity_requests.some(old => old.request_id === row.request_id)).toBe(false);
    }
    const requestIds = requests.map(row => String(row.request_id));
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    expect(await tx`SELECT tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`)
      .toEqual([{ tgenabled: 'A' }, { tgenabled: 'A' }]);
    const events = await tx`SELECT id::text,request_id,to_jsonb(e) AS value FROM model_capacity_events e
      WHERE request_id=ANY(${requestIds}::uuid[]) ORDER BY id`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events e WHERE id=${event.id}::bigint
        AND request_id=${event.request_id}::uuid AND to_jsonb(e)=${JSON.stringify(event.value)}::text::jsonb RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    for (const row of requests) expect(await tx`DELETE FROM model_capacity_requests r WHERE request_id=${String(row.request_id)}::uuid
      AND owner_instance_id=${owner.instanceId} AND to_jsonb(r)=${JSON.stringify(row)}::text::jsonb RETURNING request_id`).toHaveLength(1);
    const current = await whole(tx);
    for (const row of current.pipeline_item_leases.filter(row => row.stage === 'ai2' && slots.has(Number(String(row.work_key).slice(4))))) {
      expect(ids).toContain((row.binding as Raw).candidateId);
      expect(row.token).toBeNull(); // Actual writers, never fixture force-release, settle committed owners.
      expect(await tx`DELETE FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${String(row.work_key)}
        AND token IS NULL AND to_jsonb(i)=${JSON.stringify(row)}::text::jsonb RETURNING work_key`).toHaveLength(1);
    }
    for (const row of current.second_reviews.filter(row => ids.includes(Number(row.candidate_id)))) {
      expect(candidates.get(Number(row.candidate_id))).toBe(row.repo);
      expect(baseline.second_reviews.some(old => old.id === row.id)).toBe(false);
      expect(await tx`DELETE FROM second_reviews s WHERE id=${Number(row.id)} AND candidate_id=${Number(row.candidate_id)}
        AND repo=${String(row.repo)} AND to_jsonb(s)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    for (const row of current.crawl_review_attempts.filter(row => ids.includes(Number(row.candidate_id))))
      expect(await tx`DELETE FROM crawl_review_attempts a WHERE id=${Number(row.id)} AND candidate_id=${Number(row.candidate_id)}
        AND to_jsonb(a)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    for (const [id, repo] of candidates) {
      const row = current.crawl_candidates.find(row => row.id === id); expect(row?.repo).toBe(repo);
      expect(await tx`DELETE FROM crawl_candidates c WHERE id=${id} AND repo=${repo}
        AND to_jsonb(c)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    // Deleting a published candidate appends its -1 transition. Capture only
    // this fixture's pre-guarded repo history after that actual trigger runs.
    const changes = await tx`SELECT to_jsonb(c) AS value FROM crawl_publication_changes c WHERE repo=ANY(${[...candidates.values()]}) ORDER BY id FOR UPDATE`;
    for (const { value: row } of changes) {
      expect(baseline.crawl_publication_changes.some(old => old.id === row.id || old.repo === row.repo)).toBe(false);
      expect(await tx`DELETE FROM crawl_publication_changes c WHERE id=${Number(row.id)} AND repo=${String(row.repo)}
        AND to_jsonb(c)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    for (const [id, repo] of documents) {
      const row = current.crawl_documents.find(row => row.id === id); expect(row?.repo).toBe(repo);
      expect(await tx`DELETE FROM crawl_documents d WHERE id=${id} AND repo=${repo}
        AND to_jsonb(d)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    for (const [id, slug] of productIds) {
      const row = current.products.find(row => row.id === id); expect(row?.slug).toBe(slug);
      expect(await tx`DELETE FROM products p WHERE id=${id} AND slug=${slug}
        AND to_jsonb(p)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    const purges = await tx`SELECT to_jsonb(c) AS value FROM cdn_purges c WHERE slug=ANY(${[...productIds.values()]}) ORDER BY id FOR UPDATE`;
    for (const { value: row } of purges) {
      expect([...productIds.values()]).toContain(row.slug); expect(row.reason).toBe('deleted');
      expect(baseline.cdn_purges.some(old => old.id === row.id || old.slug === row.slug)).toBe(false);
      expect(await tx`DELETE FROM cdn_purges c WHERE id=${Number(row.id)} AND slug=${String(row.slug)} AND reason='deleted'
        AND to_jsonb(c)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    await restoreManaged(tx, 'crawl_settings', 'id', [1]);
    await restoreManaged(tx, 'pipeline_stage_modes', 'stage', ['ai2']);
    await restoreManaged(tx, 'model_capacity_control', 'id', [1]);
    await restoreManaged(tx, 'jobs', 'name', managedJobs);
    await restoreManaged(tx, 'operations_observations', 'key', managedJobs.map(name => `job:${name}`));
    expect(await whole(tx)).toEqual(baseline);
  });
  candidates.clear(); documents.clear(); productIds.clear(); slots.clear();
}
function cleanup() {
  if (cleaning) return cleaning;
  const pending = performCleanup(); cleaning = pending;
  const clear = () => { if (cleaning === pending) cleaning = undefined; };
  void pending.then(clear, clear); return pending;
}
beforeAll(() => {
  setupWork = (async () => {
    ensureSchema(); baseline = await whole();
    // Expiry sweeps are global to the actual capacity queue. Refuse before any
    // fixture DML rather than alter or adopt an existing request as baseline.
    expect(baseline.model_capacity_requests).toEqual([]);
    expect(baseline.pipeline_item_leases.filter(row => row.stage === 'ai2' && row.token !== null)).toEqual([]);
    expect(baseline.jobs.filter(row => managedJobs.includes(String(row.name)) && row.lease_token !== null)).toEqual([]);
    expect(await admin`SELECT to_regprocedure('public.pr05b5_ai2_runtime_event()') AS value`).toEqual([{ value: null }]);
    initialized = true;
  })(); return tracked(setupWork, hooks);
});
beforeEach(() => tracked((async () => { await setupWork; await cleanup(); await install(); vi.stubEnv('ABCLLM_API_KEY', 'loopback-only'); })(), hooks));
afterEach(() => tracked(steps([async () => { await setupWork; }, () => drain(bodies), () => drain(work), cleanup,
  async () => { serving.contract = null; vi.unstubAllEnvs(); }]), hooks));
afterAll(() => steps([async () => { await setupWork; }, () => drain(hooks, true), () => drain(bodies, true),
  () => drain(work), cleanup, async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); }, () => admin.end()]));

async function fixture(published = false, fallback = false) {
  const repo = `${prefix}/app-${++serial}`, now = new Date(Date.now() - 2_000);
  expect(await admin`SELECT id FROM crawl_candidates WHERE repo=${repo}`).toEqual([]);
  expect(await admin`SELECT id FROM crawl_documents WHERE repo=${repo}`).toEqual([]);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://${prefix}-${serial}.example`,
    state: 'approved', reason: 'passed', decidedBy: 'auto', judgedAt: now, decidedAt: now }).returning();
  candidates.set(candidate.id, repo);
  expect(await admin`SELECT id FROM crawl_publication_changes WHERE repo=${repo}`).toEqual([]);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: 'A deployed project manager', stargazers_count: 12 },
    pageMeta: { title: 'Native tasks', description: 'Create projects and manage tasks', textSample: 'Use a deployed task app' } }).returning();
  documents.set(document.id, repo);
  let currentCandidate = candidate;
  let product: typeof products.$inferSelect | undefined;
  if (published) {
    const slug = `${prefix}-${serial}`;
    expect(await admin`SELECT id FROM products WHERE slug=${slug}`).toEqual([]);
    expect(baseline.cdn_purges.filter(row => row.slug === slug)).toEqual([]);
    expect(await admin`SELECT id FROM cdn_purges WHERE slug=${slug}`).toEqual([]);
    [product] = await db.insert(products).values({ slug, url: candidate.productUrl!, repoUrl: `https://github.com/${repo}`,
      name: 'Native published tasks', tagline: 'Manage projects', description: 'A deployed app', category: 'Dev', status: 'seeded',
      source: 'crawler', verifyToken: randomUUID(), editTokenHash: 'a'.repeat(64) }).returning();
    productIds.set(product.id, slug);
    await markPublished(repo, slug);
    [currentCandidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidate.id));
  }
  const input = await loadReviewInput(currentCandidate, document, policy());
  // Historical AI1 rows are source fixtures, not fresh AI1 claims or authority.
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: 'automatic', state: 'succeeded',
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: 'abcllm', model: 'AI2 native first', attemptNumber: 1, validUntil: input.validUntil, completedAt: now,
    outcome: { decision: 'approve', confidence: .94, reason: 'Deployed app', evidenceIds: ['product'] } }).returning();
  const base = { candidateId: candidate.id, repo, trigger: published ? 'sample' as const : 'ai_approved' as const,
    firstDecision: 'approve', firstConfidence: published ? null : .94, firstModel: published ? null : first.model,
    firstAttemptId: published ? null : first.id, publishedSlug: product?.slug ?? null,
    generationKey: secondReviewGeneration(published ? null : first.id, input, published ? 'sample' : 'ai_approved'),
    inputHash: published ? publishedInputHash(product!.slug) : input.inputHash, provider: 'abcllm' as const, model };
  const [root] = await db.insert(secondReviews).values({ ...base, ...(fallback ? { status: 'resolved', resolution: 'fallback' } : {}) }).returning();
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${root.id}`}`).toEqual([]); slots.add(root.id);
  const row = fallback ? (await db.insert(secondReviews).values({ ...base, model: `${model} backup`, fallbackForId: root.id, failureCount: 1 }).returning())[0] : root;
  if (fallback) { expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`).toEqual([]); slots.add(row.id); }
  return { candidate: currentCandidate, document, first, root, row, input, product };
}
async function capacityRows() { return (await admin`SELECT to_jsonb(r) AS value FROM model_capacity_requests r
  WHERE owner_instance_id=${owner.instanceId} ORDER BY queue_ordinal`).map(row => row.value as Raw); }
async function vote(id: number) { return (await admin`SELECT to_jsonb(s) AS value FROM second_reviews s WHERE id=${id}`)[0]?.value as Raw; }
async function item(id: number) { return (await admin`SELECT to_jsonb(i) AS value,lease_until>clock_timestamp() AS live
  FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${`ai2:${id}`}`)[0] as { value: Raw; live: boolean } | undefined; }
const latch = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const outcome = { decision: 'approve', confidence: .96, reason: 'A deployed product is shown', evidenceIds: ['product'] };
function envelope() { return { id: 'native-ai2-response', object: 'chat.completion', created: 1, model: 'local-engine',
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(outcome) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, usage_provenance: 'upstream_reported' }; }
async function localServer(run: (state: { posts: string[]; received: Promise<void>; release: () => void;
  setReply: (reply: (response: ServerResponse) => void) => void }) => Promise<void>, held = false, requestedModel = model) {
  const gate = latch(), received = latch(), pending = new Set<Promise<unknown>>(), posts: string[] = [];
  let reply: (response: ServerResponse) => void = response => { response.end(JSON.stringify(envelope())); };
  const http = createServer((request, response) => {
    const closed = new Promise<void>(done => response.once('close', done));
    const task = (async () => {
      let body = ''; for await (const chunk of request) body += chunk.toString(); posts.push(body); received.resolve();
      if (held) await gate.promise;
      if (!response.destroyed) reply(response);
      await closed;
    })(); pending.add(task); void task.catch(() => {});
  });
  const errors: unknown[] = [];
  try {
    await new Promise<void>((done, fail) => { const failed = (error: Error) => fail(error); http.once('error', failed);
      http.listen(0, '127.0.0.1', () => { http.off('error', failed); done(); }); });
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('fixture_address');
    serving.contract = { version: 1, protocol: 'abcllm-raw-total-bound-v1', routeId: 'second-review', provider: 'abcllm',
      model: requestedModel, responseModel: 'local-engine', deploymentRevision: 'loopback-only',
      endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, totalTokenBound: 8_000 };
    await run({ posts, received: received.promise, release: gate.resolve, setReply: value => { reply = value; } });
  } catch (error) { errors.push(error); }
  finally {
    gate.resolve();
    await steps([() => drain(work), async () => {
      const closing = http.listening ? new Promise<void>((done, fail) => http.close(error => error ? fail(error) : done())) : Promise.resolve();
      await steps([async () => { const results = await Promise.allSettled([...pending]);
        const rejected = results.filter(result => result.status === 'rejected'); if (rejected.length) throw new AggregateError(rejected.map(result => result.reason)); }, () => closing]);
    }, async () => { serving.contract = null; }], errors);
  }
}
function execute(id: number, signal?: AbortSignal, useOwner = owner) {
  expect(useOwner.instanceId).toBe(owner.instanceId); ownBoots.add(useOwner.bootId);
  return tracked(executeSecondReviewConsumerItem({ secondReviewId: id, owner: useOwner, signal }));
}
async function reserve(id: number) {
  const error: unknown = await tracked(claimConsumerItemSecondReview(id, owner, 90_000)).then(() => null, error => error);
  expect(error).toBeInstanceOf(SecondReviewModelReservationRequired);
  const intent = error as SecondReviewModelReservationRequired;
  expect(await item(id)).toBeUndefined();
  const call = prepareAi2GatewayCall(intent.intent.input, { model: intent.intent.binding.reviewer.model });
  expect(call.kind).toBe('prepared'); if (call.kind !== 'prepared') throw new Error('actual_prepared_required');
  const binding = intent.intent.binding;
  const identity: ModelCapacityRequestIdentity = { owner, class: 'second', pool: 'reviewer', routeId: 'second-review', provider: 'abcllm',
    model: binding.reviewer.model, workKey: `ai2:${binding.candidateId}:${binding.vote}:${itemBindingHash(binding)}` };
  const slot = await tracked(requestAi2ItemModelSlot({ ...identity, requestId: randomUUID() }, { candidateId: binding.candidateId, vote: binding.vote }));
  expect(slot.kind).toBe('granted'); if (slot.kind !== 'granted') throw new Error('actual_reservation_required');
  return { secondReviewId: id, owner, expected: intent.intent, identity, call: call as PreparedAi2GatewayCall, reservation: slot.reservation as ModelCapacityReservation };
}

it('consumer disabled and production unsupported each roll back item/domain and allocate no model request', exercise(async () => {
  const f = await fixture();
  await admin`UPDATE model_capacity_control SET mode='disabled' WHERE id=1`;
  const disabledBefore = await whole();
  await expect(execute(f.row.id)).rejects.toMatchObject({ reason: 'disabled' });
  expect(await whole()).toEqual(disabledBefore);
  await install(); const unsupportedBefore = await whole();
  await expect(execute(f.row.id)).rejects.toMatchObject({ reason: 'provider_contract_unavailable' });
  expect(await whole()).toEqual(unsupportedBefore); expect(await item(f.row.id)).toBeUndefined();
}));

it('commits a genuine fresh item and one native POST then historical terminal before mandatory vote/outbox', exercise(async () => {
  const f = await fixture();
  await localServer(async ({ posts }) => {
    expect(await execute(f.row.id)).toEqual({ state: 'recorded' }); expect(posts).toHaveLength(1);
    const [request] = await capacityRows();
    expect(request).toMatchObject({ state: 'settled', logical_work_key: `ai2:${f.candidate.id}:${f.row.id}` });
    const bound = request.dispatch_binding as Raw, lease = bound.item as Raw;
    expect(bound).toMatchObject({ failureCount: 0, inputPolicyHash: f.input.policyHash, chargedTokens: 8_000,
      review: { secondReviewId: f.row.id, source: { kind: 'first_attempt', firstAttemptId: f.first.id } } });
    expect(lease).toMatchObject({ owner, workKey: `ai2:${f.row.id}`, itemEpoch: 1, token: expect.any(String) });
    expect((await item(f.row.id))?.value).toMatchObject({ token: null, owner_instance_id: null, lease_until: null });
    expect(await vote(f.row.id)).toMatchObject({ status: 'agreed', second_decision: 'approve', failure_count: 0 });
    expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${String(request.request_id)}::uuid ORDER BY id`)
      .toEqual([{ kind: 'queued' }, { kind: 'reserved' }, { kind: 'dispatch_started' }, { kind: 'dispatch_settled' }]);
    expect((await admin`SELECT requested_version::text AS version FROM jobs WHERE name='crawl-publish'`)[0].version)
      .toBe(String(Number(baseline.jobs.find(row => row.name === 'crawl-publish')?.requested_version ?? 0) + 1));
  });
}));

it('binds a published generation and fallback to its actual product and original root vote', exercise(async () => {
  const f = await fixture(true, true);
  await localServer(async ({ posts }) => {
    expect(await execute(f.row.id)).toEqual({ state: 'recorded' }); expect(posts).toHaveLength(1);
    const [request] = await capacityRows();
    expect(request).toMatchObject({ state: 'settled', logical_work_key: `ai2:${f.candidate.id}:${f.root.id}` });
    expect(request.dispatch_binding).toMatchObject({ failureCount: 1, review: { vote: f.root.id,
      fallbackForId: f.root.id, source: { kind: 'published', slug: f.product!.slug, productId: f.product!.id } } });
    expect(await vote(f.row.id)).toMatchObject({ status: 'agreed', second_decision: 'approve' });
  }, false, `${model} backup`);
}));

it('EOF leaves full-C unknown and blocks a same-root fallback across a new boot without a second POST', exercise(async () => {
  const f = await fixture();
  await localServer(async ({ posts, setReply }) => {
    setReply(response => response.end(JSON.stringify({ ...envelope(), choices: [] })));
    expect(await execute(f.row.id)).toEqual({ state: 'recorded' }); expect(posts).toHaveLength(1);
    const [request] = await capacityRows(), original = structuredClone(request);
    expect(request).toMatchObject({ state: 'indeterminate', dispatch_binding: { chargedTokens: 8_000 }, terminal_evidence: null });
    const [fallback] = await admin`SELECT id FROM second_reviews WHERE fallback_for_id=${f.root.id}`;
    expect(fallback).toBeDefined();
    expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${fallback.id}`}`).toEqual([]); slots.add(fallback.id);
    serving.contract = { ...serving.contract!, model: `${model} backup` };
    await expect(execute(fallback.id, undefined, { instanceId: owner.instanceId, bootId: randomUUID() })).rejects.toMatchObject({ reason: 'capacity' });
    expect(posts).toHaveLength(1); expect(await capacityRows()).toEqual([original]);
    expect(await item(fallback.id)).toBeUndefined(); expect(await vote(fallback.id)).toMatchObject({ status: 'pending', failure_count: 1 });
  });
}));

it('caller abort drains the actual native Promise before cancelled writing and preserves the unknown root charge', exercise(async () => {
  const f = await fixture(), abort = new AbortController();
  await localServer(async ({ posts, received, release }) => {
    let ended = false;
    const running = execute(f.row.id, abort.signal).finally(() => { ended = true; }); void running.catch(() => {});
    try {
      await Promise.race([received, running.then(() => { throw new Error('native_ended_before_request'); })]);
      expect((await item(f.row.id))?.live).toBe(true); abort.abort();
      // Await native settlement even when the local signal has been cancelled.
    } finally { release(); await running; }
    expect(ended).toBe(true); expect(posts).toHaveLength(1);
    expect((await capacityRows())[0]).toMatchObject({ state: 'indeterminate', dispatch_binding: { chargedTokens: 8_000 } });
    expect(await vote(f.row.id)).toMatchObject({ status: 'pending', failure_count: 0 });
    expect((await item(f.row.id))?.value.token).toBeNull();
  }, true);
}));

it('historical terminal remains settled when current human authority rejects the late business vote', exercise(async () => {
  const f = await fixture();
  await localServer(async ({ posts, received, release }) => {
    const running = execute(f.row.id); void running.catch(() => {});
    try { await Promise.race([received, running.then(() => { throw new Error('native_ended_before_request'); })]);
      await admin`UPDATE crawl_candidates SET decided_by='human',state='rejected',reason='not_a_product' WHERE id=${f.candidate.id}`; }
    finally { release(); }
    expect(await running).toEqual({ state: 'input_changed', reason: 'context_invalid' }); expect(posts).toHaveLength(1);
    expect((await capacityRows())[0]).toMatchObject({ state: 'settled', dispatch_binding: { chargedTokens: 8_000 } });
    expect(await vote(f.row.id)).toMatchObject({ status: 'resolved', resolution: 'superseded', second_decision: null });
    expect((await item(f.row.id))?.value.token).toBeNull();
  }, true);
}));

it('reservation DBwall expiry during an actual candidate-row wait rolls back fresh item and dispatch', exercise(async () => {
  const f = await fixture();
  await localServer(async ({ posts }) => {
    const reserved = await reserve(f.row.id), blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
    const locked = latch(), release = latch(); let holderPid = 0;
    const holder = blocker.begin(async tx => { const [pid] = await tx`SELECT pg_backend_pid() AS pid`; holderPid = pid.pid;
      await tx`SELECT id FROM crawl_candidates WHERE id=${f.candidate.id} FOR UPDATE`; locked.resolve(); await release.promise; }); void holder.catch(() => {});
    let error: unknown, before: Snapshot | undefined, waitingPid = 0;
    try {
      await Promise.race([locked.promise, holder.then(() => { throw new Error('holder_ended_before_lock'); })]);
      const [anchor] = await admin`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()+interval '750 milliseconds'
        WHERE request_id=${reserved.reservation.requestId}::uuid RETURNING reserved_until::text AS expiry`;
      before = await whole();
      const running = tracked(claimSecondReviewItemWithModelReservation(reserved)).then(() => undefined, value => { error = value; });
      try {
        await expect.poll(async () => { const [row] = await admin`SELECT pid FROM pg_stat_activity WHERE ${holderPid}=ANY(pg_blocking_pids(pid))`;
          waitingPid = row?.pid ?? 0; return waitingPid; }, { timeout: 3_000, interval: 10 }).toBeGreaterThan(0);
        expect((await admin`SELECT reserved_until>clock_timestamp() AS live FROM model_capacity_requests
          WHERE request_id=${reserved.reservation.requestId}::uuid`)[0].live).toBe(true);
        await expect.poll(async () => (await admin`SELECT clock_timestamp()>${anchor.expiry}::text::timestamptz AS expired`)[0].expired,
          { timeout: 3_000, interval: 10 }).toBe(true);
      } finally { release.resolve(); await holder; await running; }
    } finally { release.resolve(); await Promise.allSettled([holder]); await blocker.end(); }
    expect(waitingPid).toBeGreaterThan(0); expect(error).toMatchObject({ reason: 'reservation_lost' });
    expect(await whole()).toEqual(before); expect(await item(f.row.id)).toBeUndefined(); expect(posts).toHaveLength(0);
  });
}));

it('dispatch event INSERT failure rolls back the fresh token and binding before native POST', exercise(async () => {
  const f = await fixture();
  await localServer(async ({ posts }) => {
    const reserved = await reserve(f.row.id), before = await whole();
    triggerAttempted = true;
    await admin.begin(async tx => {
      await tx.unsafe(`CREATE FUNCTION public.${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$${eventFaultBody}$$`);
      await tx.unsafe(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON model_capacity_events FOR EACH ROW EXECUTE FUNCTION public.${functionName}()`);
    });
    let error: unknown;
    try { await tracked(claimSecondReviewItemWithModelReservation(reserved)); }
    catch (value) { error = value; }
    finally { await removeTrigger(); }
    expect(error).toBeDefined(); expect(String((error as { cause?: unknown }).cause ?? error)).toContain('ai2_runtime_event_fault');
    expect(await whole()).toEqual(before); expect(await item(f.row.id)).toBeUndefined(); expect(posts).toHaveLength(0);
  });
}));
