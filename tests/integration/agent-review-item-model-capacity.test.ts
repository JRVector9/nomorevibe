import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings } from '@/lib/db/schema';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { README_SAMPLE_VERSION } from '@/lib/crawl/readme';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { AgentReviewItemModelReservationRequired, claimConsumerItemAgentReview,
  claimConsumerItemAgentReviewWithModelReservation, loadReviewInput, recordAgentReview,
  type ItemModelCapacityReviewClaim } from '@/lib/crawl/agent-review-repository';
import { executeFirstReviewConsumerItem } from '@/lib/crawl/agent-review-item-lifecycle';
import { claimAgentReviewItemModelCapacity, abandonAgentReviewItemModelCapacity } from '@/lib/crawl/agent-review-model-capacity';
import { prepareAi1GatewayCall, reviewWithReservedAi1ItemGateway, readAi1ItemGatewayTerminal } from '@/lib/crawl/agent-review-gateway';
import type { Ai1GatewayServingContract } from '@/lib/crawl/agent-review-serving-contract';
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequestIdentity } from '@/lib/llm/capacity';
import { requestAi1ModelSlot, reconcileAi1ItemGatewayTerminal, cancelReservedModelSlot } from '@/lib/llm/capacity-repository';
import { agentReviewBinding } from '@/lib/crawl/agent-review-ownership';
import { itemBindingHash } from '@/lib/jobs/items/types';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// Only the fixed deployment allowlist is replaced. Claims, queue, native HTTP,
// terminal verifier, observer/renew and the mandatory business writer are real.
const serving = vi.hoisted(() => ({ contract: null as Ai1GatewayServingContract | null }));
vi.mock('@/lib/crawl/agent-review-serving-contract', async load => ({ ...await load<typeof import('@/lib/crawl/agent-review-serving-contract')>(),
  resolveAi1GatewayServingContract: () => serving.contract }));
type Raw = Record<string, unknown>;
type Snapshot = Record<string, Raw[]>;
const marker = `ai1-item-native-${randomUUID().slice(0, 12)}`, model = 'AI1 exact item native model';
const owner = { instanceId: marker, bootId: randomUUID() }, ownBoots = new Set<string>([owner.bootId]);
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'ai1-item-native-fixture' } });
const work = new Set<Promise<unknown>>(), bodies = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
const candidates = new Map<number, string>(), documents = new Map<number, string>();
const requestModels = new Map<number, string>();
const managedJobs = ['crawl-agent-review', 'second-review', 'crawl-publish'];
let baseline: Snapshot, setupWork: Promise<void> | undefined, initialized = false, cleaning: Promise<void> | undefined, serial = 0;
let triggerAttempted = false, eventFaultBody = '';
const faultName = 'pr05b6_ai1_item_runtime_event';
function tracked<T>(pending: Promise<T>, set = work): Promise<T> { set.add(pending); void pending.catch(() => {}); return pending; }
const exercise = (load: () => Promise<void>) => () => tracked(Promise.resolve().then(load), bodies);
async function drain(set: Set<Promise<unknown>>, retainErrors = false) {
  const pending = [...set], results = await Promise.allSettled(pending); pending.forEach(task => set.delete(task));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (retainErrors && errors.length) throw new AggregateError(errors, 'ai1_item_native_pending_failed');
}
async function steps(loaders: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior]; for (const load of loaders) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'ai1_item_native_cleanup_failed', { cause: errors[0] });
}
async function whole(tx: postgres.Sql | postgres.TransactionSql = admin): Promise<Snapshot> {
  const result: Snapshot = {};
  for (const { tablename } of await tx`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`) {
    const [row] = await tx.unsafe(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text COLLATE "C"),'[]'::jsonb) AS value
      FROM public."${String(tablename).replaceAll('"', '""')}" t`); result[tablename] = row.value;
  }
  return result;
}
const settings = (): CrawlSettings => ({ ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: 'enforce',
  firstReview: { provider: 'abcllm', model }, agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enforceEligibility: false },
  secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: false } });
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { local: 4 }, groupLimits: { engine: 4 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: 'crawl-agent-review', provider: 'abcllm', model, providerBudgetId: 'local', groupId: 'engine' }] };
async function install(mode: 'disabled' | 'draining' | 'open' = 'open', capacityPolicy = policy) {
  await db.insert(crawlSettings).values({ id: 1, values: settings(), updatedBy: marker })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings(), updatedBy: marker } });
  await admin`UPDATE pipeline_stage_modes SET mode='items',draining_from=NULL,writer_contract_version=1 WHERE stage='ai1'`;
  await admin`UPDATE model_capacity_control SET mode=${mode},policy=${JSON.stringify(capacityPolicy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(capacityPolicy)},cursor=0 WHERE id=1`;
}
async function restoreManaged(tx: postgres.TransactionSql, table: string, key: string, values: readonly unknown[]) {
  if (!['crawl_settings', 'pipeline_stage_modes', 'model_capacity_control', 'jobs', 'operations_observations'].includes(table)) throw new Error('invalid_fixture_table');
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  for (const value of values) {
    const original = baseline[table].find(row => row[key] === value);
    const [found] = await tx.unsafe(`SELECT to_jsonb(t) AS row FROM public.${quote(table)} t WHERE ${quote(key)}::text=$1 FOR UPDATE`, [String(value)]);
    if (!found) { expect(original).toBeUndefined(); continue; }
    const current = found.row as Raw;
    if (table === 'jobs') expect(current.lease_token).toBeNull();
    if (original) {
      const columns = Object.keys(original).filter(column => column !== key);
      expect(await tx.unsafe(`UPDATE public.${quote(table)} t SET ${columns.map(column => `${quote(column)}=saved.${quote(column)}`).join(',')}
        FROM jsonb_populate_record(NULL::public.${quote(table)},$1::text::jsonb) saved
        WHERE t.${quote(key)}=saved.${quote(key)} AND to_jsonb(t)=$2::text::jsonb RETURNING t.${quote(key)}`,
      [JSON.stringify(original), JSON.stringify(current)])).toHaveLength(1);
    } else {
      // Dedicated/exclusive DB with no external worker. NULL alone is not an
      // ownership proof for arbitrary concurrent idle foreign replacements.
      expect(await tx.unsafe(`DELETE FROM public.${quote(table)} t WHERE ${quote(key)}::text=$1
        AND to_jsonb(t)=$2::text::jsonb RETURNING ${quote(key)}`, [String(value), JSON.stringify(current)])).toHaveLength(1);
    }
  }
}
async function removeFault() {
  if (!triggerAttempted) return;
  await admin.begin(async tx => {
    const functions = await tx`SELECT oid::text,prosrc FROM pg_proc WHERE oid=to_regprocedure('public.pr05b6_ai1_item_runtime_event()')`;
    const triggers = await tx`SELECT tgfoid::text,tgtype::int FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass AND tgname=${faultName}`;
    if (functions.length) expect(functions[0].prosrc).toBe(eventFaultBody);
    if (triggers.length) {
      expect(functions).toHaveLength(1); expect(Array.from(triggers)).toEqual([{ tgfoid: functions[0].oid, tgtype: 7 }]);
      await tx.unsafe(`DROP TRIGGER ${faultName} ON model_capacity_events`);
    }
    if (functions.length) await tx.unsafe(`DROP FUNCTION public.${faultName}()`);
  }); triggerAttempted = false;
}
async function performCleanup() {
  if (!initialized) return;
  await removeFault();
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    expect((await tx`SELECT lease_token FROM jobs WHERE name=ANY(${managedJobs}) FOR UPDATE`).every(row => row.lease_token === null)).toBe(true);
    const ids = [...candidates.keys()];
    const items = await tx`SELECT to_jsonb(i) AS row FROM pipeline_item_leases i WHERE stage='ai1' AND work_key=ANY(${ids.map(id => `ai1:${id}`)}) FOR UPDATE`;
    for (const { row } of items) { expect(row.token).toBeNull(); expect(ids).toContain(row.binding.candidateId); expect(row.binding.stage).toBe('ai1'); }
    const attempts = await tx`SELECT to_jsonb(a) AS row FROM crawl_review_attempts a WHERE candidate_id=ANY(${ids}) ORDER BY id FOR UPDATE`;
    for (const { row } of attempts) { expect(candidates.get(row.candidate_id)).toBe(row.snapshot.product.repo); expect(row.state).not.toBe('running'); }
    const requests = (await tx`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${owner.instanceId} ORDER BY request_id FOR UPDATE`).map(row => row.row as Raw);
    for (const row of requests) {
      expect(row.owner_instance_id).toBe(owner.instanceId); expect(ownBoots.has(String(row.owner_boot_id))).toBe(true);
      expect([row.class, row.pool, row.route_id, row.provider]).toEqual(['first', 'reviewer', 'crawl-agent-review', 'abcllm']);
      const candidateId = ids.find(id => row.logical_work_key === `ai1:${id}` && new RegExp(`^ai1:${id}:[a-f0-9]{64}$`).test(String(row.work_key)));
      expect(candidateId).toBeDefined(); expect(row.model).toBe(requestModels.get(candidateId!));
      expect(baseline.model_capacity_requests.some(old => old.request_id === row.request_id)).toBe(false);
    }
    const requestIds = requests.map(row => String(row.request_id));
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    const guard = () => tx`SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname IN ('model_capacity_events_no_change','model_capacity_events_no_truncate') ORDER BY tgname`;
    const expectedGuards = [{ tgname: 'model_capacity_events_no_change', tgenabled: 'A' }, { tgname: 'model_capacity_events_no_truncate', tgenabled: 'A' }];
    expect(Array.from(await guard())).toEqual(expectedGuards);
    const events = await tx`SELECT id::text,request_id,to_jsonb(e) AS row FROM model_capacity_events e WHERE request_id=ANY(${requestIds}::uuid[]) ORDER BY id`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) expect(await tx`DELETE FROM model_capacity_events e WHERE id=${event.id}::bigint
        AND request_id=${event.request_id}::uuid AND to_jsonb(e)=${JSON.stringify(event.row)}::text::jsonb RETURNING id`).toHaveLength(1);
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    expect(Array.from(await guard())).toEqual(expectedGuards);
    for (const row of requests) expect(await tx`DELETE FROM model_capacity_requests r WHERE request_id=${String(row.request_id)}::uuid
      AND owner_instance_id=${owner.instanceId} AND to_jsonb(r)=${JSON.stringify(row)}::text::jsonb RETURNING request_id`).toHaveLength(1);
    for (const { row } of items) expect(await tx`DELETE FROM pipeline_item_leases i WHERE stage='ai1' AND work_key=${row.work_key}
      AND token IS NULL AND to_jsonb(i)=${JSON.stringify(row)}::text::jsonb RETURNING work_key`).toHaveLength(1);
    for (const { row } of attempts) expect(await tx`DELETE FROM crawl_review_attempts a WHERE id=${row.id} AND candidate_id=${row.candidate_id}
      AND to_jsonb(a)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    for (const [id, repo] of candidates) {
      const [current] = await tx`SELECT to_jsonb(c) AS row FROM crawl_candidates c WHERE id=${id} AND repo=${repo} FOR UPDATE`;
      expect(current).toBeDefined();
      expect(await tx`DELETE FROM crawl_candidates c WHERE id=${id} AND repo=${repo} AND to_jsonb(c)=${JSON.stringify(current.row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    const changes = await tx`SELECT to_jsonb(c) AS row FROM crawl_publication_changes c WHERE repo=ANY(${[...candidates.values()]}) ORDER BY id FOR UPDATE`;
    for (const { row } of changes) {
      expect(baseline.crawl_publication_changes.some(old => old.id === row.id || old.repo === row.repo)).toBe(false);
      expect(await tx`DELETE FROM crawl_publication_changes c WHERE id=${row.id} AND repo=${row.repo}
        AND to_jsonb(c)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    for (const [id, repo] of documents) {
      const [current] = await tx`SELECT to_jsonb(d) AS row FROM crawl_documents d WHERE id=${id} AND repo=${repo} FOR UPDATE`;
      expect(current).toBeDefined();
      expect(await tx`DELETE FROM crawl_documents d WHERE id=${id} AND repo=${repo} AND to_jsonb(d)=${JSON.stringify(current.row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
    await restoreManaged(tx, 'crawl_settings', 'id', [1]); await restoreManaged(tx, 'pipeline_stage_modes', 'stage', ['ai1']);
    await restoreManaged(tx, 'model_capacity_control', 'id', [1]); await restoreManaged(tx, 'jobs', 'name', managedJobs);
    await restoreManaged(tx, 'operations_observations', 'key', managedJobs.map(name => `job:${name}`));
    expect(await whole(tx)).toEqual(baseline);
  }); candidates.clear(); documents.clear(); requestModels.clear();
}
function cleanup() {
  if (cleaning) return cleaning;
  const pending = performCleanup(); cleaning = pending;
  const clear = () => { if (cleaning === pending) cleaning = undefined; }; void pending.then(clear, clear); return pending;
}
beforeAll(() => {
  setupWork = (async () => {
    ensureSchema(); baseline = await whole();
    // Actual queue expiry is global: reject before DML instead of adopting or
    // parking foreign requests. Inert foreign candidate/document rows are allowed.
    expect(baseline.model_capacity_requests).toEqual([]);
    expect(baseline.pipeline_item_leases.filter(row => row.stage === 'ai1' && row.token !== null)).toEqual([]);
    expect(baseline.jobs.filter(row => managedJobs.includes(String(row.name)) && row.lease_token !== null)).toEqual([]);
    expect((await admin`SELECT to_regprocedure('public.pr05b6_ai1_item_runtime_event()') AS value`)[0].value).toBeNull();
    expect(await admin`SELECT tgname FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass AND tgname=${faultName}`).toHaveLength(0);
    expect(await admin`SELECT request_id FROM model_capacity_requests WHERE owner_instance_id=${owner.instanceId}`).toHaveLength(0);
    initialized = true;
  })(); return tracked(setupWork, hooks);
});
beforeEach(() => tracked((async () => { await setupWork; await cleanup(); await install(); vi.stubEnv('ABCLLM_API_KEY', 'loopback-only'); })(), hooks));
afterEach(() => tracked(steps([async () => { await setupWork; }, () => drain(bodies), () => drain(work), cleanup,
  async () => { serving.contract = null; vi.unstubAllEnvs(); }]), hooks));
afterAll(() => steps([async () => { await setupWork; }, () => drain(hooks, true), () => drain(bodies, true), () => drain(work), cleanup,
  async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); }, () => admin.end()]));

async function fixture() {
  const repo = `${marker}/app-${++serial}`, now = new Date(Date.now() - 2_000), configured = settings();
  for (const table of ['crawl_candidates', 'crawl_documents', 'crawl_publication_changes'])
    expect(await admin.unsafe(`SELECT repo FROM ${table} WHERE repo=$1`, [repo])).toHaveLength(0);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: `https://${marker}-${serial}.example`, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: 'A deployed project manager', homepage: `https://${marker}-${serial}.example`, stargazers_count: 3, owner: { type: 'User' } },
    pageMeta: { title: 'Native tasks', description: 'Manage projects and tasks', textSample: 'Use a deployed task app',
      readmeSample: 'A deployed project and task manager', readmeSampleVersion: README_SAMPLE_VERSION } }).returning(); documents.set(document.id, repo);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: document.productUrl, state: 'approved',
    reason: 'passed', decidedBy: 'auto', judgedAt: now, updatedAt: now }).returning(); candidates.set(candidate.id, repo); requestModels.set(candidate.id, model);
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai1' AND work_key=${`ai1:${candidate.id}`}`).toHaveLength(0);
  return { candidate, document, settings: configured, input: await loadReviewInput(candidate, document, configured) };
}
const latch = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const outcome = { decision: 'approve' as const, confidence: .96, reason: 'A deployed product is shown', evidenceIds: ['product'] };
function envelope() { return { id: 'native-ai1-item-response', object: 'chat.completion', created: 1, model: 'local-engine',
  choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(outcome) }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, usage_provenance: 'upstream_reported' }; }
async function localServer(run: (state: { posts: string[]; received: Promise<void>; release: () => void; setReply: (reply: (response: ServerResponse) => void) => void }) => Promise<void>, held = false) {
  const gate = latch(), received = latch(), pending = new Set<Promise<unknown>>(), posts: string[] = [];
  let reply = (response: ServerResponse) => { response.end(JSON.stringify(envelope())); };
  const http = createServer((request, response) => {
    const closed = new Promise<void>(done => response.once('close', done));
    const task = (async () => { let body = ''; for await (const chunk of request) body += chunk.toString(); posts.push(body); received.resolve();
      if (held) await gate.promise; if (!response.destroyed) reply(response); await closed; })(); pending.add(task); void task.catch(() => {});
  }); const errors: unknown[] = [];
  try {
    await new Promise<void>((done, fail) => { const failed = (error: Error) => fail(error); http.once('error', failed);
      http.listen(0, '127.0.0.1', () => { http.off('error', failed); done(); }); });
    const address = http.address(); if (!address || typeof address === 'string') throw new Error('fixture_address');
    serving.contract = { version: 1, protocol: 'abcllm-raw-total-bound-v1', routeId: 'crawl-agent-review', provider: 'abcllm', model,
      responseModel: 'local-engine', deploymentRevision: 'loopback-only', endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, totalTokenBound: 8_000 };
    await run({ posts, received: received.promise, release: gate.resolve, setReply: value => { reply = value; } });
  } catch (error) { errors.push(error); }
  finally { gate.resolve(); await steps([() => drain(work), async () => {
    const closing = http.listening ? new Promise<void>((done, fail) => http.close(error => error ? fail(error) : done())) : Promise.resolve();
    await steps([async () => { const result = await Promise.allSettled([...pending]); const errors = result.flatMap(value => value.status === 'rejected' ? [value.reason] : []);
      if (errors.length) throw new AggregateError(errors, 'fixture_http_response_failed'); }, () => closing]);
  }, async () => { serving.contract = null; }], errors); }
}
function execute(id: number, signal?: AbortSignal, useOwner = owner) {
  expect(useOwner.instanceId).toBe(owner.instanceId); ownBoots.add(useOwner.bootId);
  return tracked(executeFirstReviewConsumerItem({ candidateId: id, owner: useOwner, signal }));
}
async function capacityRows() { return (await admin`SELECT to_jsonb(r) AS row FROM model_capacity_requests r WHERE owner_instance_id=${owner.instanceId} ORDER BY queue_ordinal`).map(row => row.row as Raw); }
async function item(id: number) { return (await admin`SELECT to_jsonb(i) AS row,lease_until>clock_timestamp() AS live FROM pipeline_item_leases i WHERE stage='ai1' AND work_key=${`ai1:${id}`}`)[0] as { row: Raw; live: boolean } | undefined; }
async function reserve(context: Awaited<ReturnType<typeof fixture>>) {
  const error: unknown = await tracked(claimConsumerItemAgentReview({ ...context, owner, ttlMs: 90_000, provider: 'abcllm', model })).then(() => null, error => error);
  expect(error).toBeInstanceOf(AgentReviewItemModelReservationRequired); const intent = error as AgentReviewItemModelReservationRequired;
  expect(await item(context.candidate.id)).toBeUndefined(); expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, context.candidate.id))).toHaveLength(0);
  const call = prepareAi1GatewayCall(intent.intent.context.input, { model }); expect(call.kind).toBe('prepared');
  if (call.kind !== 'prepared') throw new Error('actual_prepared_required');
  const identity: ModelCapacityRequestIdentity = { owner, class: 'first', pool: 'reviewer', routeId: 'crawl-agent-review', provider: 'abcllm', model,
    workKey: `ai1:${context.candidate.id}:${itemBindingHash(agentReviewBinding(context.candidate.id, context.input, { provider: 'abcllm', model }))}` };
  const slot = await tracked(requestAi1ModelSlot({ ...identity, requestId: randomUUID() }, context.candidate.id));
  expect(slot.kind).toBe('granted'); if (slot.kind !== 'granted') throw new Error('actual_reservation_required');
  return { expected: intent.intent, reservation: slot.reservation, identity, call, intent };
}
function fresh(claim: ItemModelCapacityReviewClaim) {
  expect(claim.kind).toBe('claimed'); if (claim.kind !== 'claimed' || !claim.dispatch || claim.receipt.ownership.kind !== 'item') throw new Error('actual_fresh_dispatch_required');
  return { ...claim, dispatch: claim.dispatch, lease: claim.receipt.ownership.lease };
}

it('disabled draining unmapped and unsupported fresh work preserve all domain and producer rows', exercise(async () => {
  const f = await fixture();
  for (const [mode, reason, value] of [ ['disabled', 'disabled', policy], ['draining', 'draining', policy],
    ['open', 'unmapped', { ...policy, routes: [{ ...policy.routes[0], model: 'Other model' }] }], ['open', 'provider_contract_unavailable', policy] ] as const) {
    await install(mode, value); const before = await whole(); await expect(execute(f.candidate.id)).rejects.toMatchObject({ reason });
    expect(await whole()).toEqual(before); expect(await item(f.candidate.id)).toBeUndefined();
  }
  const directBefore = await whole();
  await expect(tracked(claimConsumerItemAgentReview({ ...f, provider: 'abcllm', model, owner, ttlMs: 90_000 })))
    .rejects.toMatchObject({ reason: 'provider_contract_unavailable' });
  expect(await whole()).toEqual(directBefore);
}));
it('commits a genuine fresh attempt and item before native POST1 then terminal and the mandatory writer', exercise(async () => {
  const f = await fixture();
  await localServer(async ({ posts }) => {
    expect(await execute(f.candidate.id)).toEqual({ applied: true, state: 'succeeded' }); expect(posts).toHaveLength(1);
    const [request] = await capacityRows(); expect(request).toMatchObject({ state: 'settled', logical_work_key: `ai1:${f.candidate.id}` });
    const bound = request.dispatch_binding as Raw, token = (bound.item as Raw).token;
    expect(bound).toMatchObject({ kind: 'ai1_item_gateway', chargedTokens: 8_000, item: { workKey: `ai1:${f.candidate.id}`, owner },
      review: agentReviewBinding(f.candidate.id, f.input, { provider: 'abcllm', model }) });
    const [attempt] = await admin`SELECT to_jsonb(a) AS row FROM crawl_review_attempts a WHERE candidate_id=${f.candidate.id}`;
    expect(attempt.row).toMatchObject({ id: bound.attemptId, kind: 'automatic', state: 'succeeded', lease_token: token, reused_from_attempt_id: null,
      input_tokens: 100, output_tokens: 20 }); expect((await item(f.candidate.id))?.row.token).toBeNull();
    expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, f.candidate.id)))[0]).toMatchObject({ state: 'approved', decidedBy: 'auto' });
    expect(Array.from(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${String(request.request_id)}::uuid ORDER BY id`))
      .toEqual([{ kind: 'queued' }, { kind: 'reserved' }, { kind: 'dispatch_started' }, { kind: 'dispatch_settled' }]);
    expect((await admin`SELECT requested_version::text AS value FROM jobs WHERE name='crawl-publish'`)[0].value)
      .toBe(String(Number(baseline.jobs.find(row => row.name === 'crawl-publish')?.requested_version ?? 0) + 1));
  });
}));
it('rechecks actual direct reuse after reservation and cancels unused capacity without a native POST', exercise(async () => {
  const alternate = `${model} alternate`;
  // Both legitimate routes are in the same installed policy before any request;
  // this is configured-reviewer consistency, not a changed-policy fence.
  await install('open', { ...policy, routes: [...policy.routes, { ...policy.routes[0], model: alternate }] });
  const f = await fixture();
  await localServer(async ({ posts }) => {
    const reserved = await reserve(f);
    // An independently completed valid result appeared while this caller waited.
    // This stored source fixture is not a newly claimed model invocation.
    const [previous] = await db.insert(crawlReviewAttempts).values({ candidateId: f.candidate.id, kind: 'automatic', state: 'succeeded',
      inputHash: f.input.inputHash, sourceRevisionHash: f.input.sourceRevisionHash, policyHash: f.input.policyHash, snapshot: f.input.snapshot,
      source: f.input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: 'abcllm', model,
      attemptNumber: 1, validUntil: f.input.validUntil, outcome, completedAt: new Date() }).returning();
    const admitted = await tracked(claimAgentReviewItemModelCapacity(reserved.intent));
    expect(admitted.claim.kind).toBe('reused'); if (admitted.claim.kind === 'skipped') throw new Error('actual_reuse_required');
    expect(admitted.claim.receipt).toMatchObject({ origin: 'direct_reuse', attemptId: previous.id }); expect(admitted.claim.dispatch).toBeUndefined();
    expect((await capacityRows())[0]).toMatchObject({ state: 'withdrawn', dispatch_binding: null }); expect(posts).toHaveLength(0);
    expect(await tracked(recordAgentReview({ ...f, receipt: admitted.claim.receipt, outcome }))).toMatchObject({ state: 'succeeded' });
    expect((await item(f.candidate.id))?.row.token).toBeNull();
    const other = await fixture();
    requestModels.set(other.candidate.id, alternate);
    serving.contract = { ...serving.contract!, model: alternate };
    const expected = new AgentReviewItemModelReservationRequired({ context: other, provider: 'abcllm', model: alternate, owner }).intent;
    const call = prepareAi1GatewayCall(other.input, { model: alternate });
    expect(call.kind).toBe('prepared'); if (call.kind !== 'prepared') throw new Error('actual_alternate_prepared_required');
    const identity: ModelCapacityRequestIdentity = { owner, class: 'first', pool: 'reviewer', routeId: 'crawl-agent-review', provider: 'abcllm', model: alternate,
      workKey: `ai1:${other.candidate.id}:${itemBindingHash(agentReviewBinding(other.candidate.id, other.input, { provider: 'abcllm', model: alternate }))}` };
    const slot = await tracked(requestAi1ModelSlot({ ...identity, requestId: randomUUID() }, other.candidate.id));
    expect(slot.kind).toBe('granted'); if (slot.kind !== 'granted') throw new Error('actual_alternate_reservation_required');
    let changed: ItemModelCapacityReviewClaim;
    try { changed = await tracked(claimConsumerItemAgentReviewWithModelReservation({ expected, reservation: slot.reservation, identity, call })); }
    catch (error) {
      try { await tracked(cancelReservedModelSlot(slot.reservation)); }
      catch (cleanup) { throw new AggregateError([error, cleanup], 'alternate_claim_cleanup_failed'); }
      throw error;
    }
    if (changed.kind === 'claimed') {
      // Missing configured-reviewer validation is observed after its actual
      // commit. No HTTP is started: retain full C, then use the original writer
      // to settle/release this genuine fixture owner before asserting the RED.
      if (!changed.dispatch) throw new Error('actual_alternate_dispatch_missing');
      await tracked(abandonAgentReviewItemModelCapacity(changed.dispatch));
      await tracked(recordAgentReview({ ...other, receipt: changed.receipt, error: 'cancelled' }));
      expect((await item(other.candidate.id))?.row.token).toBeNull();
    } else await tracked(cancelReservedModelSlot(slot.reservation));
    expect(posts).toHaveLength(0);
    expect(changed).toMatchObject({ kind: 'skipped', reason: 'input_changed' });
    expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, other.candidate.id))).toHaveLength(0);
    expect(await item(other.candidate.id)).toBeUndefined();
    expect((await capacityRows()).find(row => row.request_id === slot.reservation.requestId)).toMatchObject({ state: 'withdrawn', dispatch_binding: null });
  });
}));
it('EOF keeps full-C unknown and original AI1 failure backoff across source change and new boot', exercise(async () => {
  const f = await fixture();
  await localServer(async ({ posts, setReply }) => {
    setReply(response => response.end(JSON.stringify({ ...envelope(), choices: [] })));
    const before = Date.now(); expect(await execute(f.candidate.id)).toEqual({ applied: false, state: 'failed' }); expect(posts).toHaveLength(1);
    const original = structuredClone((await capacityRows())[0]); expect(original).toMatchObject({ state: 'indeterminate', terminal_evidence: null, dispatch_binding: { chargedTokens: 8_000 } });
    const [attempt] = await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, f.candidate.id));
    expect(attempt.state).toBe('failed'); expect(attempt.retryAfter!.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    await admin`UPDATE crawl_documents SET fetched_at=fetched_at-interval '1 second' WHERE id=${f.document.id}`;
    await expect(execute(f.candidate.id, undefined, { instanceId: owner.instanceId, bootId: randomUUID() })).rejects.toMatchObject({ reason: 'capacity' });
    expect(posts).toHaveLength(1); expect(await capacityRows()).toEqual([original]);
    expect(await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, f.candidate.id))).toHaveLength(1);
    expect((await item(f.candidate.id))?.row.token).toBeNull();
  });
}));
it('late human authority supersedes business writing after physical historical terminal settlement', exercise(async () => {
  const f = await fixture();
  await localServer(async ({ posts, received, release }) => {
    const running = execute(f.candidate.id); void running.catch(() => {});
    try { await Promise.race([received, running.then(() => { throw new Error('native_ended_before_request'); })]);
      expect((await item(f.candidate.id))?.live).toBe(true);
      await admin`UPDATE crawl_candidates SET decided_by='admin',state='rejected',reason='not_a_product' WHERE id=${f.candidate.id}`;
    } finally { release(); }
    expect(await running).toEqual({ applied: false, state: 'superseded' }); expect(posts).toHaveLength(1);
    expect((await capacityRows())[0]).toMatchObject({ state: 'settled', dispatch_binding: { chargedTokens: 8_000 } });
    expect((await db.select().from(crawlReviewAttempts).where(eq(crawlReviewAttempts.candidateId, f.candidate.id)))[0]).toMatchObject({ state: 'superseded', errorCode: 'input_changed' });
    expect((await item(f.candidate.id))?.row.token).toBeNull();
  }, true);
}));
it('actual candidate lock wait beyond reservation DBwall rolls back attempt item and dispatch', exercise(async () => {
  const f = await fixture();
  await localServer(async ({ posts }) => {
    const reserved = await reserve(f), blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false });
    const locked = latch(), release = latch(); let holderPid = 0, waitingPid = 0, error: unknown, before: Snapshot | undefined;
    const holder = blocker.begin(async tx => { holderPid = (await tx`SELECT pg_backend_pid() AS pid`)[0].pid;
      await tx`SELECT id FROM crawl_candidates WHERE id=${f.candidate.id} FOR UPDATE`; locked.resolve(); await release.promise; }); void holder.catch(() => {});
    let running: Promise<void | undefined> | undefined; const errors: unknown[] = [];
    try {
      await Promise.race([locked.promise, holder.then(() => { throw new Error('holder_ended_before_lock'); })]);
      const [anchor] = await admin`UPDATE model_capacity_requests SET reserved_until=clock_timestamp()+interval '750 milliseconds'
        WHERE request_id=${reserved.reservation.requestId}::uuid RETURNING reserved_until::text AS expiry`;
      before = await whole(); running = tracked(claimConsumerItemAgentReviewWithModelReservation(reserved)).then(() => undefined, value => { error = value; });
      await expect.poll(async () => { waitingPid = (await admin`SELECT pid FROM pg_stat_activity WHERE ${holderPid}=ANY(pg_blocking_pids(pid))`)[0]?.pid ?? 0;
        return waitingPid; }, { timeout: 3_000, interval: 10 }).toBeGreaterThan(0);
      expect((await admin`SELECT reserved_until>clock_timestamp() AS live FROM model_capacity_requests WHERE request_id=${reserved.reservation.requestId}::uuid`)[0].live).toBe(true);
      await expect.poll(async () => (await admin`SELECT clock_timestamp()>${anchor.expiry}::text::timestamptz AS expired`)[0].expired,
        { timeout: 3_000, interval: 10 }).toBe(true);
    } catch (error) { errors.push(error); }
    finally { release.resolve(); await steps([async () => {
      const settled = await Promise.allSettled([holder, ...(running ? [running] : [])]);
      const failures = settled.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, 'fixture_holder_or_claim_failed');
    }, () => blocker.end()], errors); }
    expect(waitingPid).toBeGreaterThan(0); expect(error).toMatchObject({ reason: 'reservation_lost' });
    expect(await whole()).toEqual(before); expect(await item(f.candidate.id)).toBeUndefined(); expect(posts).toHaveLength(0);
  });
}));
it('own dispatch event INSERT fault rolls back actual fresh attempt item and binding before POST', exercise(async () => {
  const f = await fixture();
  await localServer(async ({ posts }) => {
    const reserved = await reserve(f), before = await whole();
    expect(reserved.reservation.requestId).toMatch(/^[a-f0-9-]{36}$/);
    eventFaultBody = `\n BEGIN IF NEW.kind='dispatch_started' AND NEW.request_id='${reserved.reservation.requestId}'::uuid THEN RAISE EXCEPTION 'ai1_item_runtime_event_fault'; END IF; RETURN NEW; END `;
    triggerAttempted = true;
    await admin.begin(async tx => { await tx.unsafe(`CREATE FUNCTION public.${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$${eventFaultBody}$$`);
      await tx.unsafe(`CREATE TRIGGER ${faultName} BEFORE INSERT ON model_capacity_events FOR EACH ROW EXECUTE FUNCTION public.${faultName}()`); });
    let error: unknown; try { await tracked(claimConsumerItemAgentReviewWithModelReservation(reserved)); } catch (value) { error = value; }
    finally { try { await removeFault(); } catch (cleanup) { throw new AggregateError([...(error ? [error] : []), cleanup], 'fixture_fault_cleanup_failed'); } }
    expect(error).toBeDefined(); expect(String((error as { cause?: unknown }).cause ?? error)).toContain('ai1_item_runtime_event_fault');
    expect(await whole()).toEqual(before); expect(await item(f.candidate.id)).toBeUndefined(); expect(posts).toHaveLength(0);
  });
}));
it('opaque historical settlement remains idempotent after original item release mode epoch and policy change', exercise(async () => {
  const f = await fixture();
  await localServer(async ({ posts }) => {
    const reserved = await reserve(f), claim = fresh(await tracked(claimConsumerItemAgentReviewWithModelReservation(reserved)));
    const response = await tracked(reviewWithReservedAi1ItemGateway(f.input, claim.dispatch, reserved.call));
    expect(posts).toHaveLength(1); expect(response.result.ok).toBe(true); expect(response.terminal).not.toBeNull();
    if (!response.terminal || !response.result.ok) throw new Error('actual_terminal_required');
    expect(readAi1ItemGatewayTerminal(response.terminal)?.dispatch).toEqual(claim.dispatch);
    // Deliberately exercise late ledger reconciliation independently of the
    // runtime ordering proved above: actual transport is settled, writer releases.
    await tracked(recordAgentReview({ ...f, receipt: claim.receipt, outcome: response.result.outcome }));
    expect((await item(f.candidate.id))?.row.token).toBeNull();
    await admin`UPDATE pipeline_stage_modes SET mode='draining',draining_from='items',epoch=epoch+1 WHERE stage='ai1'`;
    const revised = { ...policy, globalLimit: 3 };
    await admin`UPDATE model_capacity_control SET mode='draining',revision=revision+1,policy=${JSON.stringify(revised)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(revised)} WHERE id=1`;
    expect(await tracked(reconcileAi1ItemGatewayTerminal(response.terminal))).toEqual({ kind: 'settled' });
    expect(await tracked(reconcileAi1ItemGatewayTerminal(response.terminal))).toEqual({ kind: 'already_settled' });
    const before = await whole(); await expect(tracked(reconcileAi1ItemGatewayTerminal({ ...response.terminal }))).rejects.toThrow('invalid_ai1_item_gateway_terminal');
    expect(await whole()).toEqual(before);
    expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=${claim.dispatch.requestId}::uuid AND kind='dispatch_settled'`).toHaveLength(1);
    expect((await capacityRows())[0]).toMatchObject({ state: 'settled', dispatch_binding: { attemptId: claim.attempt.id, chargedTokens: 8_000 } });
  });
}));
