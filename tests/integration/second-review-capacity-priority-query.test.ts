import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { db } from '@/lib/db';
import { crawlCandidates, modelCapacityRequests, secondReviews } from '@/lib/db/schema';
import { runSecondReviewConsumer } from '@/lib/crawl/consumers/second';
import { ensureSchema, TEST_DATABASE_URL } from './setup';
import { pinReviewRanks } from '../review-task-ranks-fixture';

// Query-only fixtures: admission/dispatch authority is exercised by the separate
// capacity-wait-fallback integration suite. Every hint SELECT here is real PG.
const lifecycle = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/lib/crawl/second-review-item-lifecycle', () => ({ executeSecondReviewConsumerItem: lifecycle.execute }));
const prefix = `ai2-priority-${randomUUID()}`, owner = { instanceId: prefix, bootId: randomUUID() };
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: 'ai2-priority-query-fixture' } });
const candidates = new Map<number, string>(), votes = new Set<number>(), requests = new Set<string>();
let baseline: unknown, serial = 0;
async function ledger() {
  return (await admin`SELECT to_jsonb(r) AS value FROM model_capacity_requests r ORDER BY queue_ordinal`).map(row => row.value);
}
beforeAll(async () => {
  ensureSchema(); baseline = await ledger();
  // The global pending scan must never claim unrelated fixture work.
  expect(await admin`SELECT id FROM second_reviews WHERE status='pending'`).toEqual([]);
});
afterEach(async () => {
  await admin.begin(async tx => {
    const ids = [...requests];
    expect(await tx`SELECT id FROM model_capacity_events WHERE request_id=ANY(${ids}::uuid[])`).toEqual([]);
    for (const requestId of ids) await tx`DELETE FROM model_capacity_requests WHERE request_id=${requestId}::uuid`;
    for (const id of votes) await tx`DELETE FROM second_reviews WHERE id=${id} AND candidate_id=ANY(${[...candidates.keys()]})`;
    for (const [id, repo] of candidates) await tx`DELETE FROM crawl_candidates WHERE id=${id} AND repo=${repo}`;
  });
  requests.clear(); votes.clear(); candidates.clear(); lifecycle.execute.mockReset();
  expect(await ledger()).toEqual(baseline);
});
// PR C1: 2차 소비자는 「작업 ↔ 모델」 투표자 순위가 없으면 쉰다 — 이 시험의 투표자(query-direct, 대체 query-backup)를 칸 1 의 1·2순위로 고정한다
beforeEach(() => { pinReviewRanks({ second: [[{ provider: 'local-direct', model: 'query-direct' }, { provider: 'local-direct', model: 'query-backup' }]] }); });
afterAll(async () => { await (globalThis as { pgClient?: postgres.Sql }).pgClient?.end(); await admin.end(); });
async function vote(fallback = false) {
  const repo = `${prefix}/app-${++serial}`;
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: `https://priority-${serial}.example`,
    state: 'approved', decidedBy: 'auto' }).returning(); candidates.set(candidate.id, repo);
  const base = { candidateId: candidate.id, repo, trigger: 'ai_held' as const, firstDecision: 'needs_review',
    inputHash: 'a'.repeat(64), generationKey: 'b'.repeat(64), provider: 'local-direct' as const, model: 'query-direct' };
  const [root] = await db.insert(secondReviews).values({ ...base, ...(fallback ? { status: 'resolved' as const, resolution: 'fallback' } : {}) }).returning();
  votes.add(root.id);
  if (!fallback) return root;
  const [child] = await db.insert(secondReviews).values({ ...base, model: 'query-backup', fallbackForId: root.id }).returning(); votes.add(child.id);
  return child;
}
async function request(row: Awaited<ReturnType<typeof vote>>, options: {
  state?: 'waiting' | 'reserved'; ageMs?: number; ttlMs?: number; instanceId?: string; bootId?: string;
  provider?: string; model?: string; routeId?: string; logicalVote?: number; logicalWorkKey?: null;
} = {}) {
  const requestId = randomUUID(), state = options.state ?? 'waiting', logical = `ai2:${row.candidateId}:${options.logicalVote ?? row.fallbackForId ?? row.id}`;
  await db.insert(modelCapacityRequests).values({ requestId, ownerInstanceId: options.instanceId ?? owner.instanceId,
    ownerBootId: options.bootId ?? owner.bootId, workKey: `${logical}:${'c'.repeat(64)}`, class: 'second', pool: 'reviewer',
    routeId: options.routeId ?? 'second-review', provider: options.provider ?? row.provider!, model: options.model ?? row.model!,
    providerBudgetId: 'query', groupId: 'query', epoch: 1, revision: 1, policyHash: 'd'.repeat(64), state,
    logicalWorkKey: options.logicalWorkKey === null ? null : logical, queuedAt: new Date(Date.now() - (options.ageMs ?? 16_000)),
    queueUntil: new Date(Date.now() + (options.ttlMs ?? 60_000)), token: state === 'reserved' ? randomUUID() : null,
    reservedUntil: state === 'reserved' ? new Date(Date.now() + (options.ttlMs ?? 60_000)) : null });
  requests.add(requestId);
}
function run() {
  lifecycle.execute.mockResolvedValue({ state: 'skipped', reason: 'running' });
  return runSecondReviewConsumer({ owner, once: true });
}
const calls = () => lifecycle.execute.mock.calls.map(([input]) => input.secondReviewId as number);
it('selects only live owned root engine-direct waiters aged 15 seconds and runs a reservation first', async () => {
  // Every negative has an earlier queue ordinal than the eligible waiters. PR C1: abcllm-shaped engine-direct votes (made by a rank save)
  // can hand a long wait to the same voter slot's next rank too, so the aged abcllm root waiter is eligible and comes before `waiting`.
  const young = await vote(); await request(young, { ageMs: 1_000 });
  const expired = await vote(); await request(expired, { ttlMs: -1_000 });
  const otherOwner = await vote(); await request(otherOwner, { instanceId: `${owner.instanceId}-other` });
  const otherBoot = await vote(); await request(otherBoot, { bootId: randomUUID() });
  const abc = await vote(); await db.update(secondReviews).set({ provider: 'abcllm' }).where(eq(secondReviews.id, abc.id));
  await request({ ...abc, provider: 'abcllm' });
  const fallback = await vote(true); await request(fallback);
  const wrongModel = await vote(); await request(wrongModel, { model: 'another-engine' });
  const wrongVote = await vote(); await request(wrongVote, { logicalVote: wrongVote.id + 100_000 });
  // AI2 logical keys are constrained to second-review; a foreign route is unbound.
  const wrongRoute = await vote(); await request(wrongRoute, { routeId: 'another-route', logicalWorkKey: null });
  const deadReservation = await vote(); await request(deadReservation, { state: 'reserved', ttlMs: -1_000 });
  const waiting = await vote(); await request(waiting);
  const reserved = await vote(); await request(reserved, { state: 'reserved' });
  const before = await ledger();
  expect(await run()).toMatchObject({ attempted: 12, deferred: 0 });
  expect(calls().slice(0, 3)).toEqual([reserved.id, abc.id, fallback.id]);
  expect(new Set(calls()).size).toBe(12); expect(await ledger()).toEqual(before);
});
it('rotates multiple aged waiters behind the normal cursor while reservations keep arriving first', async () => {
  const first = await vote(), second = await vote(); await request(first); await request(second);
  const normal = [];
  for (let index = 0; index < 52; index++) normal.push(await vote());
  const reserved = await vote(); await request(reserved, { state: 'reserved' });
  const before = await ledger(); await run();
  expect(calls().slice(0, 2)).toEqual([reserved.id, first.id]);
  const later = calls().lastIndexOf(second.id);
  expect(later).toBeGreaterThan(calls().indexOf(normal[21].id));
  expect(calls()[later - 1]).toBe(reserved.id);
  expect(calls()).toContain(normal[45].id); expect(await ledger()).toEqual(before);
});
it('keeps a real-query once pass with both priorities below 101 attempts', async () => {
  const waiting = await vote(); await request(waiting);
  const reserved = await vote(); await request(reserved, { state: 'reserved' });
  for (let index = 0; index < 108; index++) await vote();
  const before = await ledger();
  expect(await run()).toEqual({ attempted: 100, recorded: 0, skipped: 100, deferred: 0 });
  expect(calls()).toHaveLength(100); expect(await ledger()).toEqual(before);
});
it('executes a newly routed fallback before the next aged waiter with real keyset queries', async () => {
  const first = await vote(), second = await vote(), normal: Awaited<ReturnType<typeof vote>>[] = [];
  for (let index = 0; index < 52; index++) normal.push(await vote());
  const reserved = await vote(); await request(reserved, { state: 'reserved' });
  let waitingCreated = false, fallbackId: number | undefined;
  lifecycle.execute.mockImplementation(async ({ secondReviewId }: { secondReviewId: number }) => {
    if (secondReviewId === normal[0].id && !waitingCreated) {
      await request(first); await request(second); waitingCreated = true;
    }
    if (secondReviewId === first.id && waitingCreated && !fallbackId) {
      await db.update(secondReviews).set({ status: 'resolved', resolution: 'fallback' }).where(eq(secondReviews.id, first.id));
      const [fallback] = await db.insert(secondReviews).values({ candidateId: first.candidateId, repo: first.repo,
        trigger: 'ai_held', firstDecision: 'needs_review', inputHash: first.inputHash, generationKey: first.generationKey,
        provider: 'abcllm', model: 'query-backup', fallbackForId: first.id }).returning();
      votes.add(fallback.id); fallbackId = fallback.id;
      return { state: 'rerouted' };
    }
    return secondReviewId === fallbackId ? { state: 'recorded' } : { state: 'skipped', reason: 'running' };
  });
  expect(await runSecondReviewConsumer({ owner, once: true })).toMatchObject({ recorded: 1 });
  const routedAt = calls().lastIndexOf(first.id);
  expect(calls().slice(routedAt, routedAt + 3)).toEqual([first.id, reserved.id, fallbackId]);
  expect(calls().lastIndexOf(second.id)).toBeGreaterThan(calls().indexOf(fallbackId!));
  expect(await admin`SELECT id FROM model_capacity_events WHERE request_id=ANY(${[...requests]}::uuid[])`).toEqual([]);
});
