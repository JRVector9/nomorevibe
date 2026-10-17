import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, secondReviews } from '@/lib/db/schema';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { runSecondReviewConsumer } from '@/lib/crawl/consumers/second';
import { secondReviewGeneration } from '@/lib/crawl/second-review-input';
import type { Ai2GatewayServingContract } from '@/lib/crawl/second-review-serving-contract';
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from '@/lib/llm/capacity';
import { createProviderCircuits } from '@/lib/llm/provider-circuit-breaker';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

/*
 * PR06e provider circuit breaker 를 실제 AI2 consumer 경로(실제 hint·item claim·공통 슬롯·native HTTP·필수 writer)에 건다.
 * 바꾸는 것은 second-review-item-model-capacity 와 같은 배포 allowlist(serving contract) 하나뿐이고 gateway 는 loopback 서버다.
 * 기술 장애가 연속되면 열리고, 열린 동안은 남은 표를 claim 하지 않으며(item·슬롯·POST·실패 수 불변), half-open 시험 하나로 닫힌다.
 * 판정 오류(invalid_output)는 세지 않는다. 살아 있는 남의 모델 요청이 없어야 시작하고, 끝나면 DB 전체를 기준선으로 되돌린다.
 */
const serving = vi.hoisted(() => ({ contract: null as Ai2GatewayServingContract | null }));
vi.mock('@/lib/crawl/second-review-serving-contract', async original => ({
  ...await original<typeof import('@/lib/crawl/second-review-serving-contract')>(),
  resolveAi2GatewayServingContract: () => serving.contract,
}));
type Raw = Record<string, unknown>;
type Snapshot = Record<string, Raw[]>;
const prefix = `pr06e-circuit-${randomUUID().slice(0, 12)}`, model = 'PR06e circuit native model';
const owner = { instanceId: prefix, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {}, connection: { application_name: 'pr06e-circuit-fixture' } });
const work = new Set<Promise<unknown>>(), bodies = new Set<Promise<unknown>>(), hooks = new Set<Promise<unknown>>();
const candidates = new Map<number, string>(), documents = new Map<number, string>(), slots = new Set<number>();
const managedJobs = ['second-review', 'crawl-publish'];
let baseline: Snapshot, initialized = false, setupWork: Promise<void> | undefined, cleaning: Promise<void> | undefined, serial = 0;
function tracked<T>(pending: Promise<T>, set = work): Promise<T> { set.add(pending); void pending.catch(() => {}); return pending; }
const exercise = (load: () => Promise<void>) => () => tracked(Promise.resolve().then(load), bodies);
async function drain(set: Set<Promise<unknown>>, keepErrors = false) {
  const pending = [...set], results = await Promise.allSettled(pending);
  pending.forEach(promise => set.delete(promise));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (keepErrors && errors.length) throw new AggregateError(errors, 'pr06e_circuit_pending_failed');
}
async function steps(loads: readonly (() => Promise<unknown>)[], prior: readonly unknown[] = []) {
  const errors = [...prior];
  for (const load of loads) try { await load(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'pr06e_circuit_cleanup_failed', { cause: errors[0] });
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
// 대체 모델 없음: 실패한 표가 새 대기 표를 만들지 않아 claim 수를 그대로 셀 수 있다
function policy(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: 'enforce',
    firstReview: { provider: 'abcllm', model: 'PR06e circuit first' }, secondReview: {
      ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true, voters: [{ provider: 'abcllm', model }], fallbacks: [] } };
}
const capacityPolicy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { local: 4 }, groupLimits: { engine: 4 },
  poolLimits: { reviewer: 4, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 12,
  queueTtlMs: 60_000, reservationTtlMs: 60_000, routes: [{ routeId: 'second-review', provider: 'abcllm', model, providerBudgetId: 'local', groupId: 'engine' }] };
async function install() {
  await db.insert(crawlSettings).values({ id: 1, values: policy(), updatedBy: prefix })
    .onConflictDoUpdate({ target: crawlSettings.id, set: { values: policy(), updatedBy: prefix } });
  await admin`UPDATE pipeline_stage_modes SET mode='items',draining_from=NULL,writer_contract_version=1 WHERE stage='ai2'`;
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(capacityPolicy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(capacityPolicy)},cursor=0 WHERE id=1`;
}
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
async function performCleanup() {
  if (!initialized) return;
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const managed = await tx`SELECT lease_token FROM jobs WHERE name=ANY(${managedJobs}) FOR UPDATE`;
    expect(managed.every(row => row.lease_token === null)).toBe(true);
    const ids = [...candidates.keys()];
    const requests = (await tx`SELECT to_jsonb(r) AS value FROM model_capacity_requests r
      WHERE owner_instance_id=${owner.instanceId} ORDER BY request_id FOR UPDATE`).map(row => row.value as Raw);
    // 이 fixture 의 owner·후보 key 만 지운다(owner 는 이 파일만의 무작위 instance 다)
    for (const row of requests) {
      expect([row.owner_boot_id, row.class, row.pool, row.route_id, row.provider, row.model])
        .toEqual([owner.bootId, 'second', 'reviewer', 'second-review', 'abcllm', model]);
      expect(ids.some(id => String(row.logical_work_key).startsWith(`ai2:${id}:`))).toBe(true);
    }
    const requestIds = requests.map(row => String(row.request_id));
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
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
      expect(row.token).toBeNull();
      expect(await tx`DELETE FROM pipeline_item_leases i WHERE stage='ai2' AND work_key=${String(row.work_key)}
        AND token IS NULL AND to_jsonb(i)=${JSON.stringify(row)}::text::jsonb RETURNING work_key`).toHaveLength(1);
    }
    for (const row of current.second_reviews.filter(row => ids.includes(Number(row.candidate_id))))
      expect(await tx`DELETE FROM second_reviews s WHERE id=${Number(row.id)} AND candidate_id=${Number(row.candidate_id)}
        AND repo=${String(row.repo)} AND to_jsonb(s)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    for (const row of current.crawl_review_attempts.filter(row => ids.includes(Number(row.candidate_id))))
      expect(await tx`DELETE FROM crawl_review_attempts a WHERE id=${Number(row.id)} AND candidate_id=${Number(row.candidate_id)}
        AND to_jsonb(a)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    for (const [id, repo] of candidates) {
      const row = current.crawl_candidates.find(row => row.id === id); expect(row?.repo).toBe(repo);
      expect(await tx`DELETE FROM crawl_candidates c WHERE id=${id} AND repo=${repo}
        AND to_jsonb(c)=${JSON.stringify(row)}::text::jsonb RETURNING id`).toHaveLength(1);
    }
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
    await restoreManaged(tx, 'crawl_settings', 'id', [1]);
    await restoreManaged(tx, 'pipeline_stage_modes', 'stage', ['ai2']);
    await restoreManaged(tx, 'model_capacity_control', 'id', [1]);
    await restoreManaged(tx, 'jobs', 'name', managedJobs);
    await restoreManaged(tx, 'operations_observations', 'key', managedJobs.map(name => `job:${name}`));
    expect(await whole(tx)).toEqual(baseline);
  });
  candidates.clear(); documents.clear(); slots.clear();
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
    // 공통 슬롯 만료 정리는 전역이다 — 남의 살아 있는 요청·item·잡 lease 가 있으면 fixture 전에 거절한다(끝난 요청 행은 건드리지 않는다)
    expect(baseline.model_capacity_requests.filter(row => ['waiting', 'reserved', 'dispatched', 'indeterminate'].includes(String(row.state)))).toEqual([]);
    expect(baseline.pipeline_item_leases.filter(row => row.stage === 'ai2' && row.token !== null)).toEqual([]);
    expect(baseline.jobs.filter(row => managedJobs.includes(String(row.name)) && row.lease_token !== null)).toEqual([]);
    initialized = true;
  })(); return tracked(setupWork, hooks);
});
beforeEach(() => tracked((async () => { await setupWork; await cleanup(); await install(); vi.stubEnv('ABCLLM_API_KEY', 'loopback-only'); })(), hooks));
afterEach(() => tracked(steps([async () => { await setupWork; }, () => drain(bodies), () => drain(work), cleanup,
  async () => { serving.contract = null; vi.unstubAllEnvs(); }]), hooks));
afterAll(() => steps([async () => { await setupWork; }, () => drain(hooks, true), () => drain(bodies, true),
  () => drain(work), cleanup, async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); }, () => admin.end()]));

async function fixture() {
  const repo = `${prefix}/app-${++serial}`, now = new Date(Date.now() - 2_000);
  expect(await admin`SELECT id FROM crawl_candidates WHERE repo=${repo}`).toEqual([]);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://${prefix}-${serial}.example`,
    state: 'approved', reason: 'passed', decidedBy: 'auto', judgedAt: now, decidedAt: now }).returning();
  candidates.set(candidate.id, repo);
  expect(await admin`SELECT id FROM crawl_publication_changes WHERE repo=${repo}`).toEqual([]);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: 'A deployed project manager', stargazers_count: 12 },
    pageMeta: { title: 'Circuit tasks', description: 'Create projects and manage tasks', textSample: 'Use a deployed task app' } }).returning();
  documents.set(document.id, repo);
  const input = await loadReviewInput(candidate, document, policy());
  // 과거 AI1 행은 원본 fixture 다(새 AI1 claim·권한 아님)
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: 'automatic', state: 'succeeded',
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: 'abcllm', model: 'PR06e circuit first', attemptNumber: 1, validUntil: input.validUntil, completedAt: now,
    outcome: { decision: 'approve', confidence: .94, reason: 'Deployed app', evidenceIds: ['product'] } }).returning();
  const [row] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo, trigger: 'ai_approved', firstDecision: 'approve',
    firstConfidence: .94, firstModel: first.model, firstAttemptId: first.id, publishedSlug: null,
    generationKey: secondReviewGeneration(first.id, input, 'ai_approved'), inputHash: input.inputHash, provider: 'abcllm', model }).returning();
  expect(await admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=${`ai2:${row.id}`}`).toEqual([]); slots.add(row.id);
  return row;
}
async function vote(id: number) { return (await admin`SELECT status,failure_count,error_code FROM second_reviews WHERE id=${id}`)[0]; }
async function leases(ids: number[]) { return admin`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND work_key=ANY(${ids.map(id => `ai2:${id}`)})`; }
async function requestCount() { return Number((await admin`SELECT count(*)::int AS n FROM model_capacity_requests WHERE owner_instance_id=${owner.instanceId}`)[0].n); }
const verdict = { decision: 'approve', confidence: .96, reason: 'A deployed product is shown', evidenceIds: ['product'] };
function envelope(content: string) { return { id: 'pr06e-native', object: 'chat.completion', created: 1, model: 'local-engine',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }, usage_provenance: 'upstream_reported' }; }
async function localServer(run: (state: { posts: string[]; setReply: (reply: (response: ServerResponse) => void) => void }) => Promise<void>) {
  const pending = new Set<Promise<unknown>>(), posts: string[] = [];
  let reply: (response: ServerResponse) => void = response => { response.end(JSON.stringify(envelope(JSON.stringify(verdict)))); };
  const http = createServer((request, response) => {
    const closed = new Promise<void>(done => response.once('close', done));
    const task = (async () => {
      let body = ''; for await (const chunk of request) body += chunk.toString(); posts.push(body);
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
      model, responseModel: 'local-engine', deploymentRevision: 'loopback-only',
      endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, totalTokenBound: 8_000 };
    await run({ posts, setReply: value => { reply = value; } });
  } catch (error) { errors.push(error); }
  finally {
    await steps([() => drain(work), async () => {
      const closing = http.listening ? new Promise<void>((done, fail) => http.close(error => error ? fail(error) : done())) : Promise.resolve();
      await steps([async () => { const results = await Promise.allSettled([...pending]);
        const rejected = results.filter(result => result.status === 'rejected'); if (rejected.length) throw new AggregateError(rejected.map(result => result.reason)); }, () => closing]);
    }, async () => { serving.contract = null; }], errors);
  }
}
const unavailable = (response: ServerResponse) => { response.statusCode = 503; response.end('{"error":"busy"}'); };

it('control: without a circuit every pending vote is claimed, POSTed and charged a failure during a gateway outage', exercise(async () => {
  const rows = [await fixture(), await fixture(), await fixture()];
  await localServer(async ({ posts, setReply }) => {
    setReply(unavailable);
    expect(await tracked(runSecondReviewConsumer({ owner, once: true }))).toEqual({ attempted: 3, recorded: 3, skipped: 0, deferred: 0 });
    expect(posts).toHaveLength(3);
    for (const row of rows) expect(await vote(row.id)).toEqual({ status: 'failed', failure_count: 1, error_code: 'gateway_error' });
  });
}));

it('opens after consecutive gateway failures, claims nothing while open, and closes through one half-open trial', exercise(async () => {
  const rows = [await fixture(), await fixture(), await fixture(), await fixture()], held = rows.slice(2).map(row => row.id);
  const logs: Raw[] = [], states: string[] = [];
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 2, openMs: 8_000 }, { log: (event, fields) => logs.push({ event, ...fields }) });
  await localServer(async ({ posts, setReply }) => {
    setReply(unavailable);
    const abort = new AbortController();
    const running = tracked(runSecondReviewConsumer({ owner, signal: abort.signal, circuits, report: state => { states.push(state); } }));
    try {
      await vi.waitFor(() => expect(logs).toEqual([{ event: 'provider_circuit.opened', key: 'ai2:abcllm', failures: 2, error: 'gateway_error', openMs: 8_000 }]),
        { timeout: 10_000, interval: 50 });
      // 다음 차례(5초 쉰 뒤)도 아직 열려 있다 — 그 차례가 hint 를 읽고 다시 쉴 때까지 기다린 뒤 본다
      await vi.waitFor(() => { expect(states.filter(state => state === 'polling')).toHaveLength(2); expect(states.at(-1)).toBe('idle'); },
        { timeout: 10_000, interval: 50 });
      expect(posts).toHaveLength(2); expect(await requestCount()).toBe(2); expect(await leases(held)).toEqual([]);
      for (const id of held) expect(await vote(id)).toEqual({ status: 'pending', failure_count: 0, error_code: null });
      setReply(response => { response.end(JSON.stringify(envelope(JSON.stringify(verdict)))); });
      await vi.waitFor(async () => { for (const id of held) expect((await vote(id)).status).toBe('agreed'); }, { timeout: 15_000, interval: 100 });
    } finally { abort.abort(); }
    // 빈 큐 재확인이 1초라 열린 동안 미룸 차례가 세 번(t0 직후 1초, +5초, +5초 뒤 half-open) — 표 2개씩 6, claim·POST 는 없다
    expect(await running).toEqual({ attempted: 4, recorded: 4, skipped: 0, deferred: 6 });
    expect(posts).toHaveLength(4);
    expect(logs.map(row => row.event)).toEqual(['provider_circuit.opened', 'provider_circuit.half_open', 'provider_circuit.closed']);
    for (const row of rows.slice(0, 2)) expect(await vote(row.id)).toEqual({ status: 'failed', failure_count: 1, error_code: 'gateway_error' });
    for (const id of held) expect(await vote(id)).toEqual({ status: 'agreed', failure_count: 0, error_code: null });
  });
}), 40_000);

it('never counts a model judgment failure: invalid output on every vote keeps the circuit closed', exercise(async () => {
  const rows = [await fixture(), await fixture(), await fixture()];
  const logs: string[] = [];
  const circuits = createProviderCircuits({ mode: 'enabled', failures: 2, openMs: 8_000 }, { log: event => logs.push(event) });
  await localServer(async ({ posts, setReply }) => {
    setReply(response => { response.end(JSON.stringify(envelope('not a verdict'))); });
    expect(await tracked(runSecondReviewConsumer({ owner, once: true, circuits }))).toEqual({ attempted: 3, recorded: 3, skipped: 0, deferred: 0 });
    expect(posts).toHaveLength(3); expect(logs).toEqual([]);
    for (const row of rows) expect(await vote(row.id)).toEqual({ status: 'failed', failure_count: 1, error_code: 'invalid_output' });
  });
}));
