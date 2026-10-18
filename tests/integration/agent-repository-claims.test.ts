import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import * as schema from '@/lib/db/schema';
import { db } from '@/lib/db';
import { agentRepositoryClaims, agentRepositoryScans, agentScanControl, crawlCandidates, crawlDocuments, crawlFrontier, crawlSettings,
  jobBatchControl, products } from '@/lib/db/schema';
import { abandonAgentRepositoryClaim, AGENT_SCAN_PRIORITY, claimAgentRepository, fillAgentScanQueue, recordAgentRepositoryScan,
  type AgentScanLease } from '@/lib/domain/evidence/agents/claims';
import { beginAgentScanDrain, bumpAgentScanContract, completeAgentScanTransition } from '@/lib/domain/evidence/agents/claim-control';
import { getLatestRepositoryAgentScan, saveRepositoryAgentScan } from '@/lib/domain/evidence/agents/repository';
import { AGENT_DETECTOR_VERSION } from '@/lib/domain/evidence/agents/types';
import type { CollectCursor, CollectResult } from '@/lib/domain/evidence/agents/collect';
import { lockPipelineInputStages } from '@/lib/crawl/pipeline-stage-context';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { getCandidate, putDocument, recordJudgement } from '@/lib/crawl/repository';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { candidateRevisionHash, requestCandidateEvidence } from '@/lib/crawl/admin-review';
import { completeJobBatchTransitionIn } from '@/lib/jobs/batch-repository';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import * as fence from '@/lib/operations/dr/epoch';
import { sealRestoredDatabase } from '@/lib/operations/dr/repository';
import type { PromotionPlan } from '@/lib/operations/dr/promotion';
import { ensureSchema, resetTables, TEST_DATABASE_URL } from './setup';

/*
 * E2(PR2) 실제 PostgreSQL. 공유 test DB 의 agent_scan_control 은 파일 끝에 처음 값으로 되돌린다(다른 파일의 legacy 쓰기가 막히지 않게).
 * 연결: 테스트 풀(db, 여러 연결) + 행을 잡고 있는 blocker + 대기 그래프를 보는 observer.
 */
const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: 'e2-agent-claims-blocker', statement_timeout: 15_000 } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: 'e2-agent-claims-observer', statement_timeout: 15_000 } });
let originalControl: typeof agentScanControl.$inferSelect | undefined;
let originalSettings: (typeof crawlSettings.$inferSelect)[] = [];

beforeAll(async () => {
  ensureSchema();
  [originalControl] = await db.select().from(agentScanControl);
  originalSettings = await db.select().from(crawlSettings);
});
beforeEach(async () => {
  await resetTables();
  await db.delete(agentRepositoryClaims); await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await saveSettings({ enabled: false, agentEvidence: { enabled: true } }, 'e2-test');
  await db.execute(sql`UPDATE agent_scan_control SET mode = 'legacy', draining_from = NULL, epoch = 1, writer_contract_version = 0 WHERE id = 1`);
});
afterAll(async () => {
  try {
    await db.delete(agentRepositoryClaims);
    if (originalControl) await db.update(agentScanControl).set({ mode: originalControl.mode, drainingFrom: originalControl.drainingFrom,
      epoch: originalControl.epoch, writerContractVersion: originalControl.writerContractVersion }).where(eq(agentScanControl.id, 1));
    await db.delete(crawlSettings);
    if (originalSettings.length) await db.insert(crawlSettings).values(originalSettings);
  } finally { await Promise.all([blocker.end({ timeout: 3 }), observer.end({ timeout: 3 })]); }
});

const owner = (name: string) => ({ instanceId: `agent-scan-consumer-${name}`, bootId: randomUUID() });
const inTx = <T>(load: (tx: ProductTransaction) => Promise<T>) => db.transaction(load);
const control = async () => (await db.select().from(agentScanControl))[0];
const row = async (key: string) => (await db.select().from(agentRepositoryClaims).where(eq(agentRepositoryClaims.repositoryKey, key)))[0];
async function toItems() {
  await inTx(tx => bumpAgentScanContract(tx));
  await inTx(tx => beginAgentScanDrain(tx));
  return inTx(tx => completeAgentScanTransition(tx, 'items'));
}
/** 큐 채우기 대신 행을 바로 넣는다. 기한은 DB 시계 기준(UTC)이다 — 로컬 시계와 Docker 시계의 차가 끼지 않게 */
async function queue(rows: { key: string; priority?: number; due?: string; requiresDaily?: boolean }[]) {
  for (const value of rows) await db.execute(sql`INSERT INTO agent_repository_claims (repository_key, priority, requires_daily, due_at)
    VALUES (${value.key}, ${value.priority ?? AGENT_SCAN_PRIORITY.regular}, ${value.requiresDaily ?? true},
      (clock_timestamp() AT TIME ZONE 'UTC') + ${value.due ?? '-1 minute'}::interval)`);
}
async function claimed(name: string | ReturnType<typeof owner>, order?: 'priority' | 'due'): Promise<AgentScanLease> {
  const result = await claimAgentRepository({ owner: typeof name === 'string' ? owner(name) : name, order });
  if (result.kind !== 'claimed') throw new Error(`expected a claim, got ${result.reason}`);
  return result.lease;
}
/** TTL 이 지난 것으로 만든다(시계를 기다리지 않는다) */
const expire = (key: string) => db.execute(sql`UPDATE agent_repository_claims SET claimed_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '200 seconds',
  lease_until = (clock_timestamp() AT TIME ZONE 'UTC') - interval '80 seconds' WHERE repository_key = ${key}`);
const scanCount = async () => (await db.select().from(agentRepositoryScans)).length;
async function waitFor<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) { const value = await read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error(`timeout:${label}`);
}
/** pid 가 막고 있는(실제 lock 대기 중인) backend */
const waitingOn = (pid: number, query: string) => waitFor(async () => {
  const [waiting] = await observer<{ pid: number; query: string }[]>`SELECT pid, query FROM pg_stat_activity
    WHERE wait_event_type = 'Lock' AND ${pid} = ANY(pg_blocking_pids(pid)) AND query ILIKE ${`%${query}%`}`;
  return waiting;
}, `waiting_on_${pid}_${query}`);

const HEAD = 'c'.repeat(40);
const cursorFor = (repositoryKey: string, repositoryId: string, patch: Partial<CollectCursor> = {}): CollectCursor => ({ repositoryId, repositoryKey,
  commitSha: HEAD, detectorVersion: AGENT_DETECTOR_VERSION, scope: '', pendingTrees: [], pendingBlobs: [], pendingCommits: [], ...patch });
const scanOf = (repositoryKey: string, repositoryId: string, patch: Partial<CollectResult> = {}): CollectResult => ({ repositoryId, repositoryKey,
  commitSha: HEAD, scope: '', state: 'partial', observations: [], requestCount: 4, fileCount: 0, errorCode: null, retryAt: null,
  cursor: cursorFor(repositoryKey, repositoryId), ...patch });
const complete = (key: string, id = '101') => scanOf(key, id, { state: 'complete', cursor: null });
const pending = (key: string, id = '101') => scanOf(key, id, { cursor: cursorFor(key, id, { pendingTrees: [{ path: 'src', sha: 'd'.repeat(40) }] }) });
/** 처음 보는 저장소의 metadata 요청 실패 — 스캔 행을 만들 수 없다 */
const missing = (key: string, patch: Partial<CollectResult> = {}): CollectResult => ({ repositoryId: null, repositoryKey: key, commitSha: null, scope: '',
  state: 'failed', cursor: null, observations: [], requestCount: 1, fileCount: 0, errorCode: 'unavailable', retryAt: null, ...patch });
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const publicProduct = async (slug: string, repositoryKey: string, patch: Partial<typeof products.$inferInsert> = {}) => (await db.insert(products).values({
  slug, url: `https://${slug}.example`, name: slug, tagline: 'test', description: 'test', category: 'Dev', verifyToken: `token-${slug}`,
  editTokenHash: 'a'.repeat(64), repoUrl: `https://github.com/${repositoryKey}`, status: 'seeded', createdAt: daysAgo(200), ...patch }).returning())[0];
/** 자동 판정이 보류한 후보와 원본. 돌려준 함수가 관리자 추가 수집 요청이다(admin-review.ts) */
async function adminCandidate(repo: string, githubId: number) {
  const productUrl = `https://${repo.replace('/', '-')}.test`;
  await putDocument({ repo, repoMeta: { id: githubId, full_name: repo, private: false, fork: false, archived: false, stargazers_count: 3,
    pushed_at: '2026-10-01T00:00:00.000Z', owner: { type: 'User' }, homepage: productUrl, description: 'A deployed task tracker' },
  productUrl, pageStatus: 200, pageMeta: { title: 'Task tracker', description: 'Create and manage projects' } });
  await recordJudgement({ repo, productUrl, state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto' });
  await db.insert(crawlFrontier).values({ repo, signal: 'e2-test', state: 'done' });
  await db.update(crawlDocuments).set({ fetchedAt: sql`clock_timestamp() - interval '1 hour'` }).where(eq(crawlDocuments.repo, repo));
  const candidate = (await getCandidate(repo))!;
  const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, repo));
  const input = await loadReviewInput(candidate, document, await getSettings());
  return () => requestCandidateEvidence({ repo, actor: 'e2-test', reason: 'Refresh public evidence', inputHash: input.inputHash,
    sourceRevisionHash: input.sourceRevisionHash, candidateRevisionHash: candidateRevisionHash(candidate) });
}

it('starts in legacy and hands out nothing until items with a contract, enabled settings and the same detector version', async () => {
  expect(await control()).toMatchObject({ mode: 'legacy', drainingFrom: null, epoch: 1, writerContractVersion: 0 });
  await queue([{ key: 'acme/one' }]);
  const idle = (reason: string) => ({ kind: 'idle', reason });
  expect(await claimAgentRepository({ owner: owner('m3') })).toEqual(idle('mode'));
  // contract 없이는 전환하지 않는다. contract 는 legacy 에서만 한 칸씩 오른다
  await expect(inTx(tx => beginAgentScanDrain(tx))).rejects.toThrow('agent_scan_contract_required');
  expect(await inTx(tx => bumpAgentScanContract(tx))).toMatchObject({ mode: 'legacy', writerContractVersion: 1 });
  expect(await claimAgentRepository({ owner: owner('m3') })).toEqual(idle('mode'));
  expect(await inTx(tx => beginAgentScanDrain(tx))).toMatchObject({ mode: 'draining', drainingFrom: 'legacy', epoch: 1 });
  await expect(inTx(tx => beginAgentScanDrain(tx))).rejects.toThrow('agent_scan_transition_invalid');
  await expect(inTx(tx => bumpAgentScanContract(tx))).rejects.toThrow('agent_scan_transition_invalid');
  expect(await claimAgentRepository({ owner: owner('m3') })).toEqual(idle('mode'));
  expect(await inTx(tx => completeAgentScanTransition(tx, 'items'))).toMatchObject({ mode: 'items', drainingFrom: null, epoch: 2, writerContractVersion: 1 });
  await saveSettings({ agentEvidence: { enabled: false } }, 'e2-test');
  expect(await claimAgentRepository({ owner: owner('m3') })).toEqual(idle('disabled'));
  await saveSettings({ agentEvidence: { enabled: true, detectorVersion: '2099-01-01.1' } }, 'e2-test');
  expect(await claimAgentRepository({ owner: owner('m3') })).toEqual(idle('detector'));
  await saveSettings({ agentEvidence: { enabled: true, detectorVersion: AGENT_DETECTOR_VERSION } }, 'e2-test');
  const m3 = owner('m3');
  const lease = await claimed(m3);
  expect(lease).toMatchObject({ repositoryKey: 'acme/one', owner: m3, epoch: 1, controlEpoch: 2, priority: AGENT_SCAN_PRIORITY.regular, requiresDaily: true,
    binding: { v: 1, repositoryKey: 'acme/one', detectorVersion: AGENT_DETECTOR_VERSION, scope: '' } });
  expect(Date.parse(lease.leaseUntil) - Date.parse(lease.claimedAt)).toBe(120_000);
  expect(await claimAgentRepository({ owner: owner('m3') })).toEqual(idle('empty'));
  // 전환은 control 행이 첫 lock 이어야 한다 — stage SHARE 를 잡은 TX 에서는 거절한다
  await expect(inTx(async tx => { await lockPipelineInputStages(tx); return beginAgentScanDrain(tx); })).rejects.toThrow('agent_scan_lock_order');
});

it('gives concurrent consumers different repositories, in priority order, and skips a row another transaction holds', async () => {
  await toItems();
  await queue([{ key: 'acme/p5', priority: 5 }, { key: 'acme/p0', priority: 0 }, { key: 'acme/p6', priority: 6 }, { key: 'acme/p2', priority: 2 },
    { key: 'acme/p4', priority: 4 }, { key: 'acme/p1', priority: 1 }, { key: 'acme/later', priority: 0, due: '1 hour' }, { key: 'acme/gone', priority: 0 }]);
  await db.update(agentRepositoryClaims).set({ state: 'gone' }).where(eq(agentRepositoryClaims.repositoryKey, 'acme/gone'));
  await db.execute(sql`UPDATE agent_repository_claims SET retry_after = (clock_timestamp() AT TIME ZONE 'UTC') + interval '1 hour',
    failure_streak = 1, first_failure_at = (clock_timestamp() AT TIME ZONE 'UTC'), last_error_code = 'unavailable' WHERE repository_key = 'acme/p6'`);
  // 연결 8개가 동시에 맡는다: 맡을 수 있는 다섯 개를 하나씩, 나머지는 빈 큐
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => claimAgentRepository({ owner: owner(`c${index}`) })));
  const keys = results.flatMap(result => result.kind === 'claimed' ? [result.lease.repositoryKey] : []);
  expect(keys.toSorted()).toEqual(['acme/p0', 'acme/p1', 'acme/p2', 'acme/p4', 'acme/p5']);
  expect(results.filter(result => result.kind === 'idle').map(result => result.kind === 'idle' && result.reason)).toEqual(['empty', 'empty', 'empty']);
  for (const result of results) if (result.kind === 'claimed') expect(await abandonAgentRepositoryClaim(result.lease)).toBe(true);

  // 하나씩이면 priority → due 순이다. 'due' 순서는 priority 를 무시하고 오래 기다린 것부터 고른다(굶김 방지)
  await db.execute(sql`UPDATE agent_repository_claims SET due_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 day' WHERE repository_key = 'acme/p5'`);
  expect((await claimed('due', 'due')).repositoryKey).toBe('acme/p5');
  const sequential = [];
  for (let index = 0; index < 4; index++) sequential.push((await claimed(`s${index}`)).repositoryKey);
  expect(sequential).toEqual(['acme/p0', 'acme/p1', 'acme/p2', 'acme/p4']);
  for (const key of ['acme/p0', 'acme/p1', 'acme/p2', 'acme/p4', 'acme/p5']) await db.execute(sql`UPDATE agent_repository_claims SET token = NULL,
    instance_id = NULL, boot_id = NULL, claimed_at = NULL, lease_until = NULL, control_epoch = NULL, binding_hash = NULL WHERE repository_key = ${key}`);

  // SKIP LOCKED: 다른 TX 가 맨 앞 행을 잡고 있으면 기다리지 않고 다음 행을 맡는다
  await blocker.begin(async tx => {
    await tx`SELECT 1 FROM agent_repository_claims WHERE repository_key = 'acme/p0' FOR UPDATE`;
    const started = Date.now();
    expect((await claimed('skip')).repositoryKey).toBe('acme/p1');
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

it('lets anyone take over an expired claim with epoch+1 and refuses the late owner', async () => {
  await toItems();
  await queue([{ key: 'acme/slow' }]);
  const first = await claimed('first');
  expect(await claimAgentRepository({ owner: owner('early') })).toEqual({ kind: 'idle', reason: 'empty' });
  await expire('acme/slow');
  // 만료됐지만 아무도 맡지 않았으면 원래 owner 의 기록은 거절되고(권한 없음) 포기는 받는다
  await expect(recordAgentRepositoryScan(first, complete('acme/slow'))).rejects.toThrow('agent_scan_lease_lost');
  const second = await claimed('second');
  expect(second).toMatchObject({ repositoryKey: 'acme/slow', epoch: 2 });
  expect(second.token).not.toBe(first.token);
  await expect(recordAgentRepositoryScan(first, complete('acme/slow'))).rejects.toThrow('agent_scan_lease_lost');
  expect(await abandonAgentRepositoryClaim(first)).toBe(false);
  expect(await scanCount()).toBe(0);
  expect(await row('acme/slow')).toMatchObject({ token: second.token, epoch: 2 });
  expect(await recordAgentRepositoryScan(second, complete('acme/slow'))).toMatchObject({ outcome: 'complete', failureStreak: 0, retryAfter: null });
  expect(await row('acme/slow')).toMatchObject({ token: null, instanceId: null, leaseUntil: null, epoch: 2, lastOutcome: 'complete' });
  // 포기는 만료 뒤에도(다른 owner 가 없으면) 받는다
  await db.execute(sql`UPDATE agent_repository_claims SET due_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 minute' WHERE repository_key = 'acme/slow'`);
  const third = await claimed('third');
  await expire('acme/slow');
  expect(await abandonAgentRepositoryClaim(third)).toBe(true);
  expect(await row('acme/slow')).toMatchObject({ token: null, epoch: 3, lastOutcome: 'abandoned' });
});

it('refuses a record with an old token, epoch, owner, binding or control epoch and writes nothing', async () => {
  await toItems();
  await queue([{ key: 'acme/cas' }]);
  const lease = await claimed('cas');
  const before = await row('acme/cas');
  for (const stale of [{ ...lease, token: randomUUID() }, { ...lease, epoch: lease.epoch + 1 }, { ...lease, controlEpoch: lease.controlEpoch - 1 },
    { ...lease, owner: { ...lease.owner, bootId: randomUUID() } }, { ...lease, owner: { ...lease.owner, instanceId: 'agent-scan-consumer-other' } }]) {
    await expect(recordAgentRepositoryScan(stale, complete('acme/cas'))).rejects.toThrow('agent_scan_lease_lost');
    expect(await abandonAgentRepositoryClaim(stale)).toBe(false);
  }
  // binding 이 hash 와 맞지 않으면 쓰기 전에 거절한다
  await expect(recordAgentRepositoryScan({ ...lease, binding: { ...lease.binding, repositoryKey: 'acme/other' } }, complete('acme/cas')))
    .rejects.toThrow('invalid_agent_scan_lease');
  // 다른 저장소의 결과·예산 소진은 기록이 아니다
  await expect(recordAgentRepositoryScan(lease, complete('acme/other'))).rejects.toThrow('agent_scan_record_invalid');
  await expect(recordAgentRepositoryScan(lease, { ...complete('acme/cas'), errorCode: 'budget_exhausted' })).rejects.toThrow('agent_scan_record_invalid');
  // 전환을 거치지 않고 control epoch 만 오른 상태(옛 epoch 의 claim) — 기록 관문이 거절한다
  await db.execute(sql`UPDATE agent_scan_control SET epoch = epoch + 1 WHERE id = 1`);
  await expect(recordAgentRepositoryScan(lease, complete('acme/cas'))).rejects.toThrow('agent_scan_lease_lost');
  expect(await scanCount()).toBe(0);
  expect(await row('acme/cas')).toEqual(before);
});

it('finishes in-flight records while draining from items, refuses to complete while a claim is live, then refuses the old epoch', async () => {
  await toItems();
  await queue([{ key: 'acme/inflight' }, { key: 'acme/next' }, { key: 'acme/late' }]);
  const inflight = await claimed('inflight');
  const late = await claimed('late');
  expect(await inTx(tx => beginAgentScanDrain(tx))).toMatchObject({ mode: 'draining', drainingFrom: 'items', epoch: 2 });
  expect(await claimAgentRepository({ owner: owner('drain') })).toEqual({ kind: 'idle', reason: 'mode' });
  await expect(inTx(tx => completeAgentScanTransition(tx, 'legacy'))).rejects.toThrow('agent_scan_not_drained');
  // 진행 중이던 기록은 같은 control epoch 라 받는다
  expect(await recordAgentRepositoryScan(inflight, complete(inflight.repositoryKey))).toMatchObject({ outcome: 'complete' });
  await expect(inTx(tx => completeAgentScanTransition(tx, 'legacy'))).rejects.toThrow('agent_scan_not_drained');
  // 끝나지 않은 claim 은 TTL 이 지나야 live 가 아니다(강제 회수 없음)
  await expire(late.repositoryKey);
  // items 로 되돌아가도(draining → items) epoch 이 오른다
  expect(await inTx(tx => completeAgentScanTransition(tx, 'items'))).toMatchObject({ mode: 'items', drainingFrom: null, epoch: 3 });
  // 늦게 깨어난 owner 의 기록은 control epoch 이 달라 거절된다(TTL 을 되돌려도)
  await db.execute(sql`UPDATE agent_repository_claims SET lease_until = (clock_timestamp() AT TIME ZONE 'UTC') + interval '60 seconds' WHERE repository_key = ${late.repositoryKey}`);
  await expect(recordAgentRepositoryScan(late, complete(late.repositoryKey))).rejects.toThrow('agent_scan_lease_lost');
  expect(await getLatestRepositoryAgentScan(late.repositoryKey)).toBeNull();
});

it('refuses legacy scan writes in items and while draining from items, and keeps them while draining from legacy', async () => {
  expect(await saveRepositoryAgentScan(complete('acme/legacy', '201'))).toMatchObject({ state: 'complete' });
  await inTx(tx => bumpAgentScanContract(tx));
  await inTx(tx => beginAgentScanDrain(tx));
  // draining(from legacy): 진행 중이던 legacy 쓰기는 받는다
  expect(await saveRepositoryAgentScan(complete('acme/drain', '202'))).toMatchObject({ state: 'complete' });
  await inTx(tx => completeAgentScanTransition(tx, 'items'));
  const before = await scanCount();
  await expect(saveRepositoryAgentScan(complete('acme/items', '203'))).rejects.toThrow('agent_scan_mode_blocked');
  await inTx(tx => beginAgentScanDrain(tx));
  await expect(saveRepositoryAgentScan(complete('acme/items', '203'))).rejects.toThrow('agent_scan_mode_blocked');
  expect(await scanCount()).toBe(before);
  await inTx(tx => completeAgentScanTransition(tx, 'legacy'));
  expect(await saveRepositoryAgentScan(complete('acme/items', '203'))).toMatchObject({ state: 'complete' });
});

it('records outcomes on the scan clock, backs off scan-less failures per repository and keeps provider waits', async () => {
  await toItems();
  await queue([{ key: 'acme/new' }]);
  const at = (value: Date | null) => value!.getTime();
  // 처음 보는 저장소의 metadata 실패: 스캔 행이 없어 claim 행의 retry_after 가 15분 → 30분으로 늘어난다
  for (const [streak, minutes] of [[1, 15], [2, 30], [3, 60]]) {
    const lease = await claimed(`new-${streak}`);
    expect(lease.repositoryKey).toBe('acme/new');
    expect(await recordAgentRepositoryScan(lease, missing('acme/new'))).toMatchObject({ outcome: 'failed', scanId: null, failureStreak: streak });
    const state = await row('acme/new');
    expect(state).toMatchObject({ failureStreak: streak, lastErrorCode: 'unavailable', lastOutcome: 'failed', token: null });
    expect(at(state.retryAfter) - at(state.lastFinishedAt)).toBe(minutes * 60_000);
    // retry_after 가 지나기 전에는 아무도 다시 맡지 않는다. 시계를 기다리지 않고 지난 것으로 만든다
    expect(await claimAgentRepository({ owner: owner('wait') })).toEqual({ kind: 'idle', reason: 'empty' });
    await db.execute(sql`UPDATE agent_repository_claims SET retry_after = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE repository_key = 'acme/new'`);
  }
  // 공급자 한도는 실패로 세지 않고 그 시각을 따른다
  const limited = await claimed('limited');
  expect(limited.repositoryKey).toBe('acme/new');
  const resetAt = new Date(Date.now() + 7 * 60_000);
  expect(await recordAgentRepositoryScan(limited, missing('acme/new', { errorCode: 'rate_limited', retryAt: resetAt }))).toMatchObject({ outcome: 'failed', failureStreak: 3 });
  expect(await row('acme/new')).toMatchObject({ failureStreak: 3, lastErrorCode: 'unavailable', retryAfter: resetAt });
  await db.execute(sql`UPDATE agent_repository_claims SET retry_after = NULL WHERE repository_key = 'acme/new'`);
  // 성공하면 실패 기록을 비우고 기한은 방금 쓴 스캔(후보는 매일: 이어 하기 1분)을 따른다. started_at 은 claim 시각이다
  const resumed = await claimed('resumed');
  const record = await recordAgentRepositoryScan(resumed, pending('acme/new', '301'));
  expect(record).toMatchObject({ outcome: 'partial', failureStreak: 0, retryAfter: null });
  expect(Date.parse(record.dueAt) - Date.parse(resumed.claimedAt)).toBe(60_000);
  expect(await row('acme/new')).toMatchObject({ failureStreak: 0, firstFailureAt: null, lastErrorCode: null, retryAfter: null, lastOutcome: 'partial' });
  const scan = (await getLatestRepositoryAgentScan('acme/new'))!;
  expect(scan.startedAt.toISOString()).toBe(resumed.claimedAt);
  // 스캔이 있는 저장소의 metadata 실패는 최신 행을 failed 로 묶고 스캔 시계(15분 backoff)를 따른다
  await db.execute(sql`UPDATE agent_repository_claims SET due_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE repository_key = 'acme/new'`);
  await db.update(agentRepositoryScans).set({ nextAttemptAt: daysAgo(1) }).where(eq(agentRepositoryScans.id, scan.id));
  const recheck = await claimed('recheck');
  const failed = await recordAgentRepositoryScan(recheck, missing('acme/new'));
  expect(failed).toMatchObject({ outcome: 'failed', scanId: scan.id, failureStreak: 1, retryAfter: null });
  expect(await getLatestRepositoryAgentScan('acme/new')).toMatchObject({ id: scan.id, state: 'failed', lastErrorCode: 'unavailable' });
  expect(Date.parse(failed.dueAt) - Date.parse(recheck.claimedAt)).toBe(15 * 60_000);
  // 캐시(아직 다시 볼 때가 아님): 스캔은 쓰지 않고 기한만 다시 잰다
  await db.execute(sql`UPDATE agent_repository_claims SET due_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE repository_key = 'acme/new'`);
  const cached = await claimed('cached');
  expect(await recordAgentRepositoryScan(cached, null)).toMatchObject({ outcome: 'cached', scanId: null, failureStreak: 1, dueAt: failed.dueAt });
  expect(await scanCount()).toBe(1);
});

it('fills the queue from product and candidate demand, marks dropped keys gone and never rewrites a live claim', async () => {
  await saveSettings({ agentEvidence: { enabled: true, backgroundRefreshDays: 90 } }, 'e2-test');
  const fresh = await publicProduct('fresh', 'acme/fresh');
  await publicProduct('complete', 'acme/complete', { status: 'verified' });
  await saveRepositoryAgentScan(complete('acme/complete', '401'), daysAgo(2));
  await publicProduct('pending', 'acme/pending');
  await saveRepositoryAgentScan(pending('acme/pending', '402'), daysAgo(2));
  await publicProduct('broken', 'acme/broken');
  await saveRepositoryAgentScan({ ...pending('acme/broken', '403'), errorCode: 'unavailable' }, daysAgo(2));
  await publicProduct('private', 'acme/private', { status: 'unverified' });
  await saveRepositoryAgentScan(complete('acme/private', '404'), daysAgo(2));
  await publicProduct('banned', 'acme/banned', { status: 'banned' });
  // 수집기가 받지 않는 모양의 키는 큐에 넣지 않는다
  await publicProduct('odd', 'bad%25owner/repo');
  await db.insert(crawlCandidates).values({ repo: 'Acme/Upper' });
  const filled = await fillAgentScanQueue({ settings: await getSettings() });
  expect(filled).toEqual({ upserted: 6, gone: 0 });
  const rows = new Map((await db.select().from(agentRepositoryClaims)).map(value => [value.repositoryKey, value]));
  expect([...rows.keys()].sort()).toEqual(['acme/broken', 'acme/complete', 'acme/fresh', 'acme/pending', 'acme/private', 'acme/upper']);
  const scanFor = async (key: string) => (await getLatestRepositoryAgentScan(key))!;
  expect(rows.get('acme/fresh')).toMatchObject({ priority: AGENT_SCAN_PRIORITY.newProduct, requiresDaily: false, dueAt: fresh.createdAt, state: 'active' });
  expect(rows.get('acme/upper')).toMatchObject({ priority: AGENT_SCAN_PRIORITY.newCandidate, requiresDaily: true });
  // 깨끗한 공개 complete 는 배경 주기(90일), 비공개(매일 보는 수요)는 저장된 시계(하루)
  const completeScan = await scanFor('acme/complete');
  expect(rows.get('acme/complete')).toMatchObject({ priority: AGENT_SCAN_PRIORITY.regular, requiresDaily: false,
    dueAt: new Date(completeScan.completedAt!.getTime() + 90 * 86_400_000) });
  expect(rows.get('acme/private')).toMatchObject({ priority: AGENT_SCAN_PRIORITY.regular, requiresDaily: true, dueAt: (await scanFor('acme/private')).nextAttemptAt });
  expect(rows.get('acme/pending')).toMatchObject({ priority: AGENT_SCAN_PRIORITY.resume, dueAt: (await scanFor('acme/pending')).nextAttemptAt });
  expect(rows.get('acme/broken')).toMatchObject({ priority: AGENT_SCAN_PRIORITY.failing, dueAt: (await scanFor('acme/broken')).nextAttemptAt });
  // 바뀐 것이 없으면 아무 행도 쓰지 않는다(잠그지 않는다)
  expect(await fillAgentScanQueue({ settings: await getSettings() })).toEqual({ upserted: 0, gone: 0 });

  // 살아 있는 claim 은 수요가 바뀌어도(제품 내림) 덮지 않는다. 풀린 뒤 다음 채우기에서 gone 이 된다
  await toItems();
  const lease = await claimed('fill');
  expect(lease.repositoryKey).toBe('acme/fresh');
  await db.update(products).set({ status: 'banned' }).where(eq(products.id, fresh.id));
  await db.insert(crawlCandidates).values({ repo: 'acme/pending' });
  const live = await row('acme/fresh');
  expect(await fillAgentScanQueue({ settings: await getSettings() })).toEqual({ upserted: 1, gone: 0 });
  expect(await row('acme/fresh')).toEqual(live);
  // 후보가 생긴 저장소는 매일 보는 수요가 된다
  expect(await row('acme/pending')).toMatchObject({ requiresDaily: true, priority: AGENT_SCAN_PRIORITY.resume });
  expect(await abandonAgentRepositoryClaim(lease)).toBe(true);
  expect(await fillAgentScanQueue({ settings: await getSettings() })).toEqual({ upserted: 0, gone: 1 });
  expect(await row('acme/fresh')).toMatchObject({ state: 'gone', token: null });
  expect(await claimAgentRepository({ owner: owner('gone') })).toMatchObject({ kind: 'claimed', lease: { repositoryKey: 'acme/upper' } });
  // 수요가 돌아오면 다시 active
  await db.update(products).set({ status: 'seeded' }).where(eq(products.id, fresh.id));
  expect(await fillAgentScanQueue({ settings: await getSettings() })).toEqual({ upserted: 1, gone: 0 });
  expect(await row('acme/fresh')).toMatchObject({ state: 'active', priority: AGENT_SCAN_PRIORITY.newProduct });
});

it('puts an unconsumed admin evidence request first', async () => {
  await saveSettings({ enabled: true, agentEvidence: { enabled: true } }, 'e2-test');
  const request = await adminCandidate('acme/admin', 905001);
  await adminCandidate('acme/plain', 905002);
  await fillAgentScanQueue({ settings: await getSettings() });
  expect(await row('acme/admin')).toMatchObject({ priority: AGENT_SCAN_PRIORITY.newCandidate });
  expect(await request()).toMatchObject({ ok: true });
  expect(await fillAgentScanQueue({ settings: await getSettings() })).toEqual({ upserted: 1, gone: 0 });
  expect(await row('acme/admin')).toMatchObject({ priority: AGENT_SCAN_PRIORITY.admin });
  expect(await row('acme/plain')).toMatchObject({ priority: AGENT_SCAN_PRIORITY.newCandidate });
});

it('runs a record, a queue fill and an admin evidence request together without a lock cycle', async () => {
  await saveSettings({ enabled: true, agentEvidence: { enabled: true } }, 'e2-test');
  await toItems();
  const request = await adminCandidate('acme/race', 906001);
  await queue([{ key: 'acme/race' }]);
  const lease = await claimed('race');
  // 고정 순서: blocker 가 claim 행을 잡는다 → 기록은 identity 를 잡은 채 claim 행에서 기다린다 → 관리자 요청은 identity 에서 기록을 기다린다
  // → 큐 채우기는 live 행을 건드리지 않아 기다리지 않고 끝난다. blocker 를 풀면 기록 → 관리자 요청 순으로 끝난다(순환 없음)
  const held = await blocker.reserve();
  let record: Promise<unknown> | undefined, admin: Promise<unknown> | undefined;
  try {
    await held`BEGIN`;
    const [{ pid }] = await held<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    await held`SELECT 1 FROM agent_repository_claims WHERE repository_key = 'acme/race' FOR UPDATE`;
    record = recordAgentRepositoryScan(lease, complete('acme/race', '501')).then(value => ({ value }), error => ({ error }));
    const recordWait = await waitingOn(pid, 'agent_repository_claims');
    admin = request().then(value => ({ value }), error => ({ error }));
    const adminWait = await waitingOn(recordWait.pid, 'pg_advisory_xact_lock');
    expect(adminWait.pid).not.toBe(recordWait.pid);
    expect(await fillAgentScanQueue({ settings: await getSettings() })).toMatchObject({ gone: 0 });
    await held`COMMIT`;
    expect(await record).toMatchObject({ value: { outcome: 'complete' } });
    // 기록이 먼저 commit 됐으므로 관리자 요청은 바뀐 근거를 보고 정상 거절한다(교착·오류가 아니다)
    expect(await admin).toMatchObject({ value: { ok: false, message: '후보 또는 근거가 변경되었습니다. 새로고침해주세요.' } });
  } finally {
    await held`ROLLBACK`.catch(() => {});
    held.release();
    await Promise.allSettled([record, admin]);
  }
  // 섞어서 여러 번: 같은 저장소에 기록·채우기·관리자 요청·legacy 쓰기·다른 claim 을 한꺼번에 — 교착(40P01) 없이 끝난다
  const errors: unknown[] = [];
  for (let round = 0; round < 8; round++) {
    const repo = `acme/round-${round}`;
    const ask = await adminCandidate(repo, 907000 + round);
    await queue([{ key: repo, priority: AGENT_SCAN_PRIORITY.admin, due: '-1 hour' }]);
    const mine = await claimed(`round-${round}`);
    expect(mine.repositoryKey).toBe(repo);
    const settled = await Promise.allSettled([
      recordAgentRepositoryScan(mine, complete(repo, String(600 + round))),
      fillAgentScanQueue({ settings: await getSettings() }),
      ask(),
      saveRepositoryAgentScan(complete(repo, String(600 + round))),
      claimAgentRepository({ owner: owner(`other-${round}`) }),
    ]);
    const [recorded, fill, asked, legacy, other] = settled;
    expect(recorded).toMatchObject({ status: 'fulfilled', value: { outcome: 'complete' } });
    expect(fill.status).toBe('fulfilled');
    // 어느 쪽이 먼저 commit 되느냐에 따라 접수(ok)이거나 근거가 바뀌었다는 거절이다 — 둘 다 정상 끝남이다
    expect(asked.status).toBe('fulfilled');
    expect(legacy).toMatchObject({ status: 'rejected', reason: { message: 'agent_scan_mode_blocked' } });
    if (other.status === 'fulfilled' && other.value.kind === 'claimed') await abandonAgentRepositoryClaim(other.value.lease);
    errors.push(...settled.flatMap((result, index) => result.status === 'rejected' && index !== 3 ? [result.reason] : []));
  }
  expect(errors).toEqual([]);
}, 60_000);

it('revokes live agent scan claims in a DR seal (dry-run readback)', async () => {
  await toItems();
  await queue([{ key: 'acme/sealed' }]);
  const lease = await claimed('seal');
  const here = await db.transaction(tx => fence.readDatabaseIdentity(tx));
  const active = await db.transaction(tx => fence.lockWriterFence(tx, 'share'));
  const [now] = await db.execute<{ now: string }>(sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`);
  const plan: PromotionPlan = { version: 1, promotionId: randomUUID(), lineageId: active.lineageId, fromEpoch: active.writerEpoch,
    knownActiveEpoch: active.writerEpoch, restoredDb: here, oldDbs: [{ systemIdentifier: '7000000000000000001', databaseOid: '16384', databaseName: 'e2_former_primary' }],
    oldInstances: ['e2-declared'], snapshotAt: now.now, operator: 'e2-test' };
  // dry-run 은 seal TX 를 그대로 실행하고 ROLLBACK 한다 — 스냅숏은 "commit 했다면"의 readback 이다
  const sealed = await sealRestoredDatabase(plan, false);
  expect(sealed.sealSnapshot.revoked).toMatchObject({ agentClaims: 1 });
  expect(sealed.sealSnapshot.instances).toContain(lease.owner.instanceId);
  expect(await row('acme/sealed')).toMatchObject({ token: lease.token });
  expect(await recordAgentRepositoryScan(lease, complete('acme/sealed'))).toMatchObject({ outcome: 'complete' });
});

it('keeps a job batch transition from completing while an agent scan claim is live', async () => {
  await toItems();
  await queue([{ key: 'acme/batch' }]);
  const lease = await claimed('batch');
  class Rollback extends Error {}
  // 같은 TX 에서 다른 소유(작업·역할·item·출처)를 비워 이 표만의 효과를 본다. 모두 ROLLBACK 한다
  const attempt = async () => {
    try {
      await db.transaction(async tx => {
        await tx.execute(sql`UPDATE jobs SET lease_token = NULL, locked_at = NULL WHERE lease_token IS NOT NULL`);
        await tx.execute(sql`UPDATE role_leases SET owner_instance_id = NULL, owner_boot_id = NULL, owner_kind = NULL, lease_until = clock_timestamp()
          WHERE owner_instance_id IS NOT NULL`);
        await tx.execute(sql`UPDATE pipeline_item_leases SET owner_instance_id = NULL, owner_boot_id = NULL, token = NULL, lease_until = NULL WHERE token IS NOT NULL`);
        await tx.execute(sql`UPDATE evidence_source_claims SET token = NULL, instance_id = NULL, boot_id = NULL, lease_until = NULL, job = NULL WHERE token IS NOT NULL`);
        await tx.update(jobBatchControl).set({ mode: 'draining', drainingFrom: 'versioned', writerContractVersion: 1 }).where(eq(jobBatchControl.id, 1));
        await completeJobBatchTransitionIn(tx, 'legacy');
        throw new Rollback();
      });
    } catch (error) { if (error instanceof Rollback) return 'completed'; throw error; }
    return 'committed';
  };
  await expect(attempt()).rejects.toThrow('job_batch_not_drained');
  expect(await abandonAgentRepositoryClaim(lease)).toBe(true);
  expect(await attempt()).toBe('completed');
  // 만료된 claim(token 이 남아 있어도)은 막지 않는다
  await claimed('batch-expired');
  await expire('acme/batch');
  expect(await attempt()).toBe('completed');
  expect((await db.select().from(jobBatchControl))[0]).toMatchObject({ mode: 'legacy' });
});

it('claims, records and fills on the UTC clock in a non-UTC session', async () => {
  const kst = postgres(TEST_DATABASE_URL, { max: 4, prepare: false, onnotice: () => {}, connection: { TimeZone: 'Asia/Seoul' } });
  const bound = globalThis as unknown as { db?: unknown; pgClient?: unknown };
  const saved = { db: bound.db, pgClient: bound.pgClient };
  try {
    bound.pgClient = kst; bound.db = drizzle(kst, { schema });
    expect((await db.execute<{ TimeZone: string }>(sql`SHOW TimeZone`))[0].TimeZone).toBe('Asia/Seoul');
    await toItems();
    // 세션 시간대(+9h)로 비교하면 한 시간 뒤 기한도 지난 것으로 보인다
    await queue([{ key: 'acme/due' }, { key: 'acme/later', due: '1 hour' }]);
    const lease = await claimed('kst');
    expect(lease.repositoryKey).toBe('acme/due');
    expect(Math.abs(Date.parse(lease.claimedAt) - Date.now())).toBeLessThan(60_000);
    expect(await claimAgentRepository({ owner: owner('kst-2') })).toEqual({ kind: 'idle', reason: 'empty' });
    const record = await recordAgentRepositoryScan(lease, complete('acme/due', '701'));
    expect(record.outcome).toBe('complete');
    expect(Date.parse(record.dueAt) - Date.parse(lease.claimedAt)).toBe(86_400_000);
    expect((await getLatestRepositoryAgentScan('acme/due'))!.startedAt.toISOString()).toBe(lease.claimedAt);
    // 스캔 없는 실패의 backoff 도 UTC 시계 위에 있다
    await db.execute(sql`UPDATE agent_repository_claims SET due_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second' WHERE repository_key = 'acme/later'`);
    const later = await claimed('kst-3');
    expect((await recordAgentRepositoryScan(later, missing('acme/later'))).retryAfter).not.toBeNull();
    const state = await row('acme/later');
    expect(Math.abs(state.retryAfter!.getTime() - (Date.now() + 15 * 60_000))).toBeLessThan(60_000);
    // 큐 채우기: 스캔 없는 공개 제품의 기한은 제품 created_at 그대로다
    const product = await publicProduct('kst', 'acme/kst');
    await fillAgentScanQueue({ settings: await getSettings() });
    expect(await row('acme/kst')).toMatchObject({ dueAt: product.createdAt, priority: AGENT_SCAN_PRIORITY.newProduct });
    expect(Math.abs((await control()).updatedAt.getTime() - Date.now())).toBeLessThan(60_000);
  } finally {
    bound.db = saved.db; bound.pgClient = saved.pgClient;
    await kst.end({ timeout: 3 });
  }
});
