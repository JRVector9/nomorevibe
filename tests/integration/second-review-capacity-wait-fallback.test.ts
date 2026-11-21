import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, secondReviews } from '@/lib/db/schema';
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from '@/lib/crawl/settings-schema';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { lockSecondReviewDomain, secondReviewGeneration } from '@/lib/crawl/second-review-input';
import { lockPipelineInputStages } from '@/lib/crawl/pipeline-stage-context';
import { claimItemLease, releaseItemLease } from '@/lib/jobs/items/repository';
import { itemBindingHash, type ItemLease } from '@/lib/jobs/items/types';
import { claimConsumerItemSecondReview, claimSecondReviewItemWithModelReservation, fallbackWaitingSecondReview,
  SecondReviewModelReservationRequired } from '@/lib/crawl/second-review-ownership';
import { executeSecondReviewConsumerItem } from '@/lib/crawl/second-review-item-lifecycle';
import { ai2GatewayServingContractHash, type Ai2GatewayServingContract } from '@/lib/crawl/second-review-serving-contract';
import { modelCapacityPolicyHash, type ModelCapacityPolicy, type ModelCapacityRequestIdentity } from '@/lib/llm/capacity';
import { markModelDispatchIndeterminate, requestAi2ItemModelSlot, requestModelSlot } from '@/lib/llm/capacity-repository';
import { setServingContractSnapshotForTest } from '@/lib/llm/serving-contract-store';
import { ensureSchema, TEST_DATABASE_URL } from './setup';
import { directContractRow } from './direct-engine-fixtures';

// Only the deployment allowlist is replaced. Domain locks, queue, events,
// transaction rollback and the preflight HTTP request all use their real paths.
const serving = vi.hoisted(() => ({ contracts: new Map<string, Ai2GatewayServingContract>() }));
vi.mock('@/lib/crawl/second-review-serving-contract', async original => ({
  ...await original<typeof import('@/lib/crawl/second-review-serving-contract')>(),
  resolveAi2GatewayServingContract: (model: string, provider = 'abcllm') => serving.contracts.get(`${provider}:${model}`) ?? null,
}));
const prefix = `ai2-wait-${randomUUID()}`, owner = { instanceId: prefix, bootId: randomUUID() };
const mainModel = 'wait-direct', backupModel = 'wait-backup', firstModel = 'wait-first';
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: 'ai2-wait-fallback-fixture' } });
type Raw = Record<string, unknown>;
const managed = { model_capacity_control: ['id', 1], pipeline_stage_modes: ['stage', 'ai2'],
  crawl_settings: ['id', 1], jobs: ['name', 'second-review'] } as const;
const baseline: Record<string, Raw[]> = {};
let initialized = false, serial = 0;
const candidates = new Map<number, string>(), documents = new Map<number, string>(), leases: ItemLease[] = [];
type PrimaryProvider = 'local-direct' | 'abcllm';
function settings(fallback = true, primary: PrimaryProvider = 'local-direct'): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: 'enforce',
    firstReview: { provider: 'abcllm', model: firstModel }, secondReview: {
      ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: primary, model: mainModel }],
      fallbacks: fallback ? [{ provider: 'abcllm', model: backupModel }] : [] } };
}
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { gpu: 1, abc: 1, fixture: 1 },
  groupLimits: { gpu: 1, abc: 1, fixture: 1 }, poolLimits: { reviewer: 1, text: 1 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 16, queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: 'second-review', provider: 'local-direct', model: mainModel, providerBudgetId: 'gpu', groupId: 'gpu' },
    // 오늘 운영 꼴(abcllm 계약의 주 투표자)도 같은 장비에 둔다 — 아래 「abcllm 표는 기다린다」 시험이 쓴다
    { routeId: 'second-review', provider: 'abcllm', model: mainModel, providerBudgetId: 'gpu', groupId: 'gpu' },
    { routeId: 'second-review', provider: 'abcllm', model: backupModel, providerBudgetId: 'abc', groupId: 'abc' },
    // PR 1b: 입장은 장비별이다 — 막는 행은 주 AI2 경로와 같은 장비(gpu, 한도 1)에 둬야 주 경로가 대기한다(전역 한도 1 은 더 읽지 않는다).
    { routeId: 'wait-fixture', provider: 'fixture', model: 'blocker', providerBudgetId: 'fixture', groupId: 'gpu' }] };
function contracts(origin = 'http://127.0.0.1:1') {
  const direct: Ai2GatewayServingContract = { version: 1, protocol: 'ai2-direct-openai-chat-v1', routeId: 'second-review',
    provider: 'local-direct', model: mainModel, responseModel: mainModel, deploymentRevision: 'fixture',
    endpoint: `${origin}/v1/chat/completions`, tokenizerEndpoint: `${origin}/tokenize`, backendId: 'gpu', physicalGroup: 'gpu',
    totalTokenBound: 40_960, requestTokenBound: 32_000, maxOutputTokens: 10_000 };
  serving.contracts.set(`local-direct:${mainModel}`, direct);
  serving.contracts.set(`abcllm:${backupModel}`, { version: 1, protocol: 'abcllm-raw-total-bound-v1', routeId: 'second-review',
    provider: 'abcllm', model: backupModel, responseModel: backupModel, deploymentRevision: 'fixture',
    endpoint: `${origin}/v1/chat/completions`, totalTokenBound: 8_000 });
  return direct;
}
async function rows(table: string, tx: postgres.Sql | postgres.TransactionSql = admin): Promise<Raw[]> {
  return (await tx.unsafe(`SELECT to_jsonb(r) AS value FROM public."${table}" r ORDER BY to_jsonb(r)::text`)).map(row => row.value as Raw);
}
async function restore(tx: postgres.TransactionSql, table: keyof typeof managed) {
  const [key, value] = managed[table], original = baseline[table].filter(row => row[key] === value);
  const columns = (await tx`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=${table}
    ORDER BY ordinal_position`).map(row => String(row.column_name));
  if (!original.length) await tx.unsafe(`DELETE FROM public."${table}" WHERE "${key}"::text=$1`, [String(value)]);
  else await tx.unsafe(`INSERT INTO public."${table}" SELECT r.* FROM jsonb_populate_record(NULL::public."${table}",$1::text::jsonb) r
    ON CONFLICT ("${key}") DO UPDATE SET ${columns.filter(column => column !== key).map(column => `"${column}"=EXCLUDED."${column}"`).join(',')}`,
  [JSON.stringify(original[0])]);
}
async function releaseLeases() {
  for (const lease of leases.splice(0)) await db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx); await lockSecondReviewDomain(tx, Number(lease.workKey.slice(4)));
    await releaseItemLease(tx, stages.ai2, lease);
  });
}
async function cleanup() {
  if (!initialized) return;
  await releaseLeases();
  await admin.begin(async tx => {
    await tx`SELECT id FROM model_capacity_control WHERE id=1 FOR UPDATE`;
    const requests = await tx`SELECT to_jsonb(r) AS value FROM model_capacity_requests r WHERE owner_instance_id=${owner.instanceId} FOR UPDATE`;
    const ids: string[] = [];
    for (const { value } of requests) {
      expect(value.owner_boot_id).toBe(owner.bootId); expect(baseline.model_capacity_requests.some(row => row.request_id === value.request_id)).toBe(false);
      expect(['fixture', 'local-direct', 'abcllm']).toContain(value.provider); ids.push(String(value.request_id));
    }
    // No fixture transport invokes inference. Exact private request teardown is
    // not a claim that any operational dispatched provider has terminated.
    await tx`LOCK TABLE model_capacity_events IN ACCESS EXCLUSIVE MODE`;
    expect(await tx`SELECT tgenabled FROM pg_trigger WHERE tgrelid='model_capacity_events'::regclass
      AND tgname='model_capacity_events_no_change'`).toEqual([{ tgenabled: 'A' }]);
    const events = await tx`SELECT id::text,request_id FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`;
    if (events.length) {
      await tx`ALTER TABLE model_capacity_events DISABLE TRIGGER model_capacity_events_no_change`;
      for (const event of events) await tx`DELETE FROM model_capacity_events WHERE id=${event.id}::bigint AND request_id=${event.request_id}::uuid`;
      await tx`ALTER TABLE model_capacity_events ENABLE ALWAYS TRIGGER model_capacity_events_no_change`;
    }
    await tx`DELETE FROM model_capacity_requests WHERE request_id=ANY(${ids}::uuid[]) AND owner_instance_id=${owner.instanceId}`;
    const candidateIds = [...candidates.keys()];
    expect(await tx`SELECT work_key FROM pipeline_item_leases WHERE stage='ai2' AND binding->>'candidateId'=ANY(${candidateIds.map(String)}) AND token IS NOT NULL`).toEqual([]);
    await tx`DELETE FROM pipeline_item_leases WHERE stage='ai2' AND binding->>'candidateId'=ANY(${candidateIds.map(String)})`;
    for (const [id, repo] of candidates) {
      await tx`DELETE FROM second_reviews WHERE candidate_id=${id} AND repo=${repo}`;
      await tx`DELETE FROM crawl_review_attempts WHERE candidate_id=${id}`;
      await tx`DELETE FROM crawl_candidates WHERE id=${id} AND repo=${repo}`;
    }
    for (const [id, repo] of documents) await tx`DELETE FROM crawl_documents WHERE id=${id} AND repo=${repo}`;
    for (const table of Object.keys(managed) as (keyof typeof managed)[]) await restore(tx, table);
    for (const table of [...Object.keys(managed), 'model_capacity_requests', 'model_capacity_events',
      'second_reviews', 'crawl_candidates', 'crawl_documents', 'crawl_review_attempts', 'pipeline_item_leases'])
      expect(await rows(table, tx)).toEqual(baseline[table]);
  });
  candidates.clear(); documents.clear(); serving.contracts.clear();
}
beforeAll(async () => {
  ensureSchema();
  for (const table of [...Object.keys(managed), 'model_capacity_requests', 'model_capacity_events',
    'second_reviews', 'crawl_candidates', 'crawl_documents', 'crawl_review_attempts', 'pipeline_item_leases']) baseline[table] = await rows(table);
  // grant/expiry operates on the whole ledger: refuse to adopt unrelated work.
  expect(baseline.model_capacity_requests).toEqual([]);
  expect(baseline.jobs.filter(row => row.name === 'second-review' && row.lease_token !== null)).toEqual([]);
  initialized = true;
});
beforeEach(async () => {
  await cleanup(); contracts();
  await db.insert(crawlSettings).values({ id: 1, values: settings() }).onConflictDoUpdate({ target: crawlSettings.id, set: { values: settings() } });
  await admin`UPDATE pipeline_stage_modes SET mode='items',draining_from=NULL,writer_contract_version=1 WHERE stage='ai2'`;
  await admin`UPDATE model_capacity_control SET mode='open',policy=${JSON.stringify(policy)}::text::jsonb,
    policy_hash=${modelCapacityPolicyHash(policy)},cursor=0 WHERE id=1`;
});
afterEach(cleanup);
afterAll(async () => { try { await cleanup(); } finally { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); await admin.end(); } });

async function fixture(saturated = true, primary: PrimaryProvider = 'local-direct') {
  const repo = `${prefix}/app-${++serial}`, now = new Date(Date.now() - 2_000);
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://wait-${serial}.example`,
    state: 'approved', reason: 'passed', decidedBy: 'auto', judgedAt: now, decidedAt: now }).returning(); candidates.set(candidate.id, repo);
  const [document] = await db.insert(crawlDocuments).values({ repo, productUrl: candidate.productUrl, fetchedAt: now, pageStatus: 200,
    repoMeta: { description: 'A deployed task app' }, pageMeta: { title: 'Tasks', description: 'Create tasks', textSample: 'Manage projects online' } }).returning();
  documents.set(document.id, repo);
  const input = await loadReviewInput(candidate, document, settings(true, primary));
  const [first] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: 'automatic', state: 'succeeded',
    inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, snapshot: input.snapshot, source: input.source,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: 'abcllm', model: firstModel, attemptNumber: 1,
    validUntil: input.validUntil, completedAt: now, outcome: { decision: 'approve', confidence: .94, reason: 'A task app', evidenceIds: ['product'] } }).returning();
  const [row] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo, trigger: 'ai_approved', firstDecision: 'approve',
    firstConfidence: .94, firstModel, firstAttemptId: first.id, generationKey: secondReviewGeneration(first.id, input, 'ai_approved'),
    inputHash: input.inputHash, provider: primary, model: mainModel }).returning();
  let intent: SecondReviewModelReservationRequired | undefined;
  try { await claimConsumerItemSecondReview(row.id, owner, 90_000); } catch (error) {
    if (!(error instanceof SecondReviewModelReservationRequired)) throw error; intent = error;
  }
  if (!intent) throw new Error('fixture_intent_missing');
  const binding = intent.intent.binding;
  const identity: ModelCapacityRequestIdentity = { owner, class: 'second', pool: 'reviewer', routeId: 'second-review', provider: primary,
    model: mainModel, workKey: `ai2:${candidate.id}:${row.id}:${itemBindingHash(binding)}` };
  const target = { candidateId: candidate.id, vote: row.id }, requestId = randomUUID();
  const blocker = saturated ? await requestModelSlot({ owner, requestId: randomUUID(), class: 'first', pool: 'reviewer',
    routeId: 'wait-fixture', provider: 'fixture', model: 'blocker', workKey: randomUUID() }) : null;
  if (blocker) expect(blocker.kind).toBe('granted');
  const slot = await requestAi2ItemModelSlot({ ...identity, requestId }, target);
  expect(slot.kind).toBe(saturated ? 'deferred' : 'granted');
  return { row, candidate, document, intent, identity, target, requestId, slot, blocker };
}
const age = (id: string) => admin`UPDATE model_capacity_requests SET queued_at=clock_timestamp()-interval '16 seconds' WHERE request_id=${id}::uuid`;
async function snapshot(id: string) {
  return { requests: (await admin`SELECT to_jsonb(r) AS value FROM model_capacity_requests r WHERE request_id=${id}::uuid`).map(row => row.value),
    events: (await admin`SELECT to_jsonb(e) AS value FROM model_capacity_events e WHERE request_id=${id}::uuid ORDER BY id`).map(row => row.value),
    votes: await rows('second_reviews'), jobs: await rows('jobs') };
}
async function expectHandoff(value: Awaited<ReturnType<typeof fixture>>, reason: string) {
  const [root] = await db.select().from(secondReviews).where(eq(secondReviews.id, value.row.id));
  expect(root).toMatchObject({ status: 'resolved', resolution: 'fallback', errorCode: reason, reviewedAt: null,
    failureCount: value.row.failureCount, secondDecision: null, secondConfidence: null, secondReason: null });
  const [backup] = await admin`SELECT * FROM second_reviews WHERE fallback_for_id=${root.id}`;
  expect(backup).toMatchObject({ provider: 'abcllm', model: backupModel, status: 'pending', reviewed_at: null,
    failure_count: value.row.failureCount, first_attempt_id: root.firstAttemptId, generation_key: root.generationKey, input_hash: root.inputHash });
  expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${value.requestId}::uuid AND kind='dispatch_started'`).toEqual([]);
  expect(await admin`SELECT state FROM model_capacity_requests WHERE request_id=${value.requestId}::uuid`).toEqual([{ state: 'withdrawn' }]);
}
it('waits at least 15 seconds, then atomically switches to fallback without recording a model failure', async () => {
  const value = await fixture(), before = await snapshot(value.requestId);
  expect(await fallbackWaitingSecondReview(value.intent, value.requestId)).toBe(false); expect(await snapshot(value.requestId)).toEqual(before);
  await age(value.requestId); expect(await fallbackWaitingSecondReview(value.intent, value.requestId)).toBe(true);
  await expectHandoff(value, 'capacity_wait_timeout');
  expect(await admin`SELECT kind FROM model_capacity_events WHERE request_id=${value.requestId}::uuid ORDER BY id`).toEqual([{ kind: 'queued' }, { kind: 'wait_cancelled' }]);
  expect(await fallbackWaitingSecondReview(value.intent, value.requestId)).toBe(false);
});
it.each(['policy', 'candidate', 'document', 'failure_count', 'stage', 'fallback_contract', 'fallback_mapping'] as const)(
  'rolls back the withdrawal and event when %s changes', async change => {
    const value = await fixture(); await age(value.requestId);
    if (change === 'policy') { const changed = settings(); changed.secondReview.agreeAt = .89; await db.update(crawlSettings).set({ values: changed }).where(eq(crawlSettings.id, 1)); }
    if (change === 'candidate') await admin`UPDATE crawl_candidates SET decided_by='admin' WHERE id=${value.candidate.id}`;
    if (change === 'document') await admin`UPDATE crawl_documents SET page_meta='{"title":"Changed evidence"}'::jsonb WHERE id=${value.document.id}`;
    if (change === 'failure_count') await admin`UPDATE second_reviews SET failure_count=1 WHERE id=${value.row.id}`;
    if (change === 'stage') await admin`UPDATE pipeline_stage_modes SET mode='draining',draining_from='items' WHERE stage='ai2'`;
    if (change === 'fallback_contract') serving.contracts.delete(`abcllm:${backupModel}`);
    if (change === 'fallback_mapping') { const changed = { ...policy, routes: policy.routes.filter(route => route.provider !== 'abcllm') };
      await admin`UPDATE model_capacity_control SET policy=${JSON.stringify(changed)}::text::jsonb,policy_hash=${modelCapacityPolicyHash(changed)} WHERE id=1`;
      await admin`UPDATE model_capacity_requests SET policy_hash=${modelCapacityPolicyHash(changed)} WHERE request_id=${value.requestId}::uuid`; }
    const before = await snapshot(value.requestId);
    expect(await fallbackWaitingSecondReview(value.intent, value.requestId)).toBe(false); expect(await snapshot(value.requestId)).toEqual(before);
  });
it('refuses a busy item chain and retains its waiting request', async () => {
  const value = await fixture(); await age(value.requestId);
  const lease = await db.transaction(async tx => {
    const stages = await lockPipelineInputStages(tx); await lockSecondReviewDomain(tx, value.row.id);
    return claimItemLease(tx, stages.ai2, value.intent.intent.binding, owner, 90_000);
  });
  if (!lease) throw new Error('fixture_lease_missing'); leases.push(lease);
  const before = await snapshot(value.requestId);
  expect(await fallbackWaitingSecondReview(value.intent, value.requestId)).toBe(false); expect(await snapshot(value.requestId)).toEqual(before);
});
it('preserves an already reserved slot during a capacity timeout', async () => {
  const value = await fixture(false); await age(value.requestId); const before = await snapshot(value.requestId);
  expect(await fallbackWaitingSecondReview(value.intent, value.requestId)).toBe(false); expect(await snapshot(value.requestId)).toEqual(before);
});
it.each(['dispatched', 'indeterminate'] as const)('never switches an actual %s item dispatch', async state => {
  const value = await fixture(false); if (value.slot.kind !== 'granted') throw new Error('fixture_reservation_missing');
  const contract = serving.contracts.get(`local-direct:${mainModel}`)!;
  const claim = await claimSecondReviewItemWithModelReservation({ secondReviewId: value.row.id, owner, expected: value.intent.intent,
    reservation: value.slot.reservation, identity: value.identity, call: { kind: 'prepared', model: mainModel,
      inputHash: value.intent.intent.input.inputHash, totalTokenBound: contract.totalTokenBound, wireHash: 'a'.repeat(64), servingContractHash: ai2GatewayServingContractHash(contract) } });
  if (claim.kind !== 'claimed' || !claim.dispatch || claim.receipt.ownership.kind !== 'item') throw new Error('fixture_dispatch_missing');
  leases.push(claim.receipt.ownership.lease);
  if (state === 'indeterminate') await markModelDispatchIndeterminate(claim.dispatch, 'transport_unknown');
  const before = await snapshot(value.requestId);
  for (const reason of ['capacity_wait_timeout', 'primary_preflight_failed'] as const)
    expect(await fallbackWaitingSecondReview(value.intent, value.requestId, reason)).toBe(false);
  expect(await snapshot(value.requestId)).toEqual(before);
});
it('no longer keeps the historical unbound AI2 unknown fence across the fallback handoff (2026-10-30)', async () => {
  const value = await fixture(); await age(value.requestId);
  await admin`INSERT INTO model_capacity_requests(request_id,work_key,owner_instance_id,owner_boot_id,class,pool,route_id,provider,model,
    provider_budget_id,group_id,epoch,revision,policy_hash,state,token,reserved_until,queue_until)
    SELECT ${randomUUID()}::uuid,${randomUUID()},${owner.instanceId},${owner.bootId}::uuid,'second','reviewer','second-review','abcllm',${backupModel},
      'abc','abc',epoch,revision,policy_hash,'indeterminate',${randomUUID()}::uuid,clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 minute'
    FROM model_capacity_control WHERE id=1`;
  const before = await snapshot(value.requestId);
  // 2026-10-30: 미결 legacy 미확인 행은 fence 가 아니다 — fallback 이 진행되고 그 미확인 행은 그대로 남는다.
  expect(await fallbackWaitingSecondReview(value.intent, value.requestId)).toBe(true); expect((await snapshot(value.requestId)).requests).toHaveLength(before.requests.length);
});
it('rolls back request cancellation, event and fallback when the final job signal fails', async () => {
  const value = await fixture(); await age(value.requestId);
  await admin`INSERT INTO jobs(name,requested_version) VALUES('second-review',9007199254740991)
    ON CONFLICT(name) DO UPDATE SET requested_version=9007199254740991`;
  const before = await snapshot(value.requestId);
  await expect(fallbackWaitingSecondReview(value.intent, value.requestId)).rejects.toThrow('job_version_exhausted');
  expect(await snapshot(value.requestId)).toEqual(before);
});
/*
 * abcllm 이름표 정리 2단계(3단계 전 확인 — second-review-model-capacity.ts 의 줄 대기 대체): 줄에서 15초 넘게 기다린 표를 같은 칸의 다음 순위로 넘기는 것은
 * 장비 칸이 있는 엔진 직접 계약(direct-openai-chat-v1)의 표뿐이다. 오늘 운영 2차 표는 모두 abcllm 계약이라 기다린다 — 그 계약을 이름표만 local-direct 로 바꾼
 * 새 모양(openai-chat-total-bound-v1)도 기다려야 3단계 전환이 「누가 그 표를 받는가」를 바꾸지 않는다. 조건을 예전 꼴(provider 가 local-direct)로 되돌리면
 * 새 모양의 표가 다음 순위로 넘어가 이 시험이 실패한다. 실제 준비(prepareAi2GatewayCall)·장부 대기 행·소비자 경로를 그대로 탄다.
 */
it.each([
  ['the device-named direct contract (direct-openai-chat-v1) hands the vote to its slot fallback', 'direct'],
  ['the relabelled total-bound contract (openai-chat-total-bound-v1) keeps waiting like an abcllm vote', 'total-bound'],
  // 오늘 운영 꼴: 2차 순위 1·2 가 abcllm 계약이다 — 그 표는 15초가 지나도 줄에서 기다린다(PR #1014 리뷰). 다르게 하려면 소유자 결정이 먼저다
  ["today's abcllm contract (abcllm-raw-total-bound-v1) keeps waiting", 'abcllm'],
] as const)('a vote waiting over 15 seconds on a full device: %s', async (_name, shape) => {
  const tokenizer = createServer((request, response) => {
    request.resume(); response.end(JSON.stringify({ count: 10, tokens: Array.from({ length: 10 }, (_, index) => index + 1), max_model_len: 40_960 }));
  });
  await new Promise<void>(resolve => tokenizer.listen(0, '127.0.0.1', resolve));
  try {
    const address = tokenizer.address(); if (!address || typeof address === 'string') throw new Error('fixture_address_missing');
    const origin = `http://127.0.0.1:${address.port}`;
    contracts(origin);
    if (shape === 'total-bound') serving.contracts.set(`local-direct:${mainModel}`, { version: 1, protocol: 'openai-chat-total-bound-v1', routeId: 'second-review',
      provider: 'local-direct', model: mainModel, responseModel: mainModel, deploymentRevision: 'fixture', endpoint: `${origin}/v1/chat/completions`, totalTokenBound: 40_960 });
    const primary: PrimaryProvider = shape === 'abcllm' ? 'abcllm' : 'local-direct';
    if (shape === 'abcllm') {
      // abcllm 계약은 엔진 직접 연결 행(transport direct)이 있어야 열린다 — 키 없는 엔진
      serving.contracts.set(`abcllm:${mainModel}`, { version: 1, protocol: 'abcllm-raw-total-bound-v1', routeId: 'second-review', provider: 'abcllm',
        model: mainModel, responseModel: mainModel, deploymentRevision: 'fixture', endpoint: `${origin}/v1/chat/completions`, totalTokenBound: 40_960 });
      setServingContractSnapshotForTest([directContractRow('second-review', mainModel)]);
      await db.update(crawlSettings).set({ values: settings(true, 'abcllm') }).where(eq(crawlSettings.id, 1));
    }
    const value = await fixture(true, primary); await age(value.requestId);
    expect(value.row.provider).toBe(primary);
    if (shape === 'direct') {
      expect(await executeSecondReviewConsumerItem({ secondReviewId: value.row.id, owner })).toEqual({ state: 'rerouted' });
      await expectHandoff(value, 'capacity_wait_timeout');
      return;
    }
    const before = await snapshot(value.requestId);
    await expect(executeSecondReviewConsumerItem({ secondReviewId: value.row.id, owner })).rejects.toMatchObject({ reason: 'capacity' });
    // 표는 그대로 기다린다: 대기 행·사건·2차 행·잡 모두 그대로, 대체 표 없음
    expect(await snapshot(value.requestId)).toEqual(before);
    expect(await admin`SELECT state FROM model_capacity_requests WHERE request_id=${value.requestId}::uuid`).toEqual([{ state: 'waiting' }]);
    expect(await admin`SELECT id FROM second_reviews WHERE fallback_for_id=${value.row.id}`).toEqual([]);
  } finally {
    setServingContractSnapshotForTest(null);
    tokenizer.closeAllConnections(); await new Promise<void>((resolve, reject) => tokenizer.close(error => error ? reject(error) : resolve()));
  }
});

it.each([true, false])('switches a failed tokenizer to fallback before inference (saturated=%s)', async saturated => {
  const paths: string[] = [], server = createServer((request, response) => {
    paths.push(request.url ?? ''); request.resume(); response.writeHead(503); response.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture_address_missing');
    contracts(`http://127.0.0.1:${address.port}`); const value = await fixture(saturated);
    expect(await executeSecondReviewConsumerItem({ secondReviewId: value.row.id, owner })).toEqual({ state: 'rerouted' });
    await expectHandoff(value, 'primary_preflight_failed'); expect(paths).toEqual(['/tokenize']);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
