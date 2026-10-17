import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import { ai1DispatchBindingHash, ai1GatewayTerminalEvidenceSchema, modelDispatchReleaseEvidenceSchema, type Ai1DispatchBinding } from '@/lib/llm/capacity';
import { buildPipelineCompletions, pipelineCompletionsSql, readPipelineCompletions } from '@/lib/operations/pipeline-completions';
import { AI1_BACKOFF, AI1_CASES, AI1_EXPECTED, AI2_CASES, AI2_EXPECTED, AI2_NOW } from '../pipeline-completions-fixture';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// PR13c 실제 PostgreSQL: 고정 사례를 한 트랜잭션에 넣고 같은 트랜잭션에서 집계한 뒤 되돌린다(기존 행·불변 장부 무수정).
const work = new Set<Promise<unknown>>();
const admin = postgres(TEST_DATABASE_URL, { max: 2, prepare: false, onnotice: () => {}, connection: { application_name: 'pr13c-completions' } });
const track = <T>(body: () => Promise<T>) => { const pending = body(); work.add(pending); return pending; };
const TABLES = ['crawl_review_attempts', 'second_reviews', 'crawl_candidates', 'crawl_frontier', 'crawl_publication_changes',
  'model_capacity_requests', 'model_capacity_events'] as const;
const hash = 'a'.repeat(64);
class Rollback extends Error {}
type Windows = Record<'1h' | '24h', Record<string, number>>;
type Aged = string | null;
type Snapshot = { at: string; ai1: { windows: Windows; backoff: number; human: number; humanOldestAt: Aged };
  ai2: { windows: Windows; ready: number; readyOldestAt: Aged; backoff: number; human: number; humanCandidates: number; humanOldestAt: Aged };
  publish: { windows: Windows; approved: number };
  fetch: { ready: number; readyOldestAt: Aged; backoff: number; inFlight: number; human: number; humanOldestAt: Aged };
  ledger: Record<'first' | 'second' | 'background', { windows: Windows; waiting: number; waitingOldestAt: Aged; active: number }> };
beforeAll(() => { ensureSchema(); });
afterAll(async () => {
  const pending = [...work];
  const results = await Promise.allSettled(pending);
  pending.forEach(promise => work.delete(promise));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  for (const close of [() => admin.end(), async () => {
    const client = (globalThis as unknown as { pgClient?: postgres.Sql }).pgClient;
    await client?.end();
  }]) try { await close(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'completions_cleanup_failed');
});

const query = () => new PgDialect().sqlToQuery(pipelineCompletionsSql());
async function run(tx: postgres.Sql | postgres.TransactionSql): Promise<Snapshot> {
  const { sql, params } = query();
  const [row] = await tx.unsafe(sql, params as postgres.ParameterOrJSON<never>[]);
  return row.snapshot as Snapshot;
}
/** 읽는 표의 전체 행 hash 와 관리 행. 조회 전후로 같아야 한다 */
async function tables() {
  const result: Record<string, unknown> = {};
  for (const table of [...TABLES, 'model_capacity_control']) {
    const [row] = await admin.unsafe(`SELECT count(*)::int AS rows, md5(coalesce(string_agg(to_jsonb(t)::text, '|' ORDER BY to_jsonb(t)::text), '')) AS digest FROM ${table} t`);
    result[table] = row;
  }
  return result;
}
const minutesSince = (at: string, since: string | null) => since === null ? null : (Date.parse(at) - Date.parse(since)) / 60_000;
const delta = (after: Record<string, number>, before: Record<string, number>) =>
  Object.fromEntries(Object.keys(after).map(key => [key, after[key] - before[key]]));

/** 운영처럼 시작·생성 시각 순서대로 넣는다. 시간대 없는 열은 UTC 벽시계, 장부는 timestamptz */
async function seed(tx: postgres.TransactionSql, prefix: string) {
  const wall = (minutes: number) => tx`(clock_timestamp() AT TIME ZONE 'UTC') - ${minutes} * interval '1 minute'`;
  const zoned = (minutes: number) => tx`clock_timestamp() - ${minutes} * interval '1 minute'`;
  const candidates = new Map<string, number>();
  const candidate = async (key: string, state = 'new', reason: string | null = null, updatedAgo = 0) => {
    const [row] = await tx`INSERT INTO crawl_candidates (repo, state, reason, decided_by, updated_at)
      VALUES (${`${prefix}/${key}`}, ${state}, ${reason}, 'auto', ${wall(updatedAgo)}) RETURNING id`;
    candidates.set(key, row.id);
    return row.id as number;
  };
  for (const key of new Set([...AI1_CASES.map(row => row.candidate), ...AI2_CASES.map(row => row.candidate)])) await candidate(key);
  await candidate('approved', 'approved');
  await candidate('hold-source', 'needs_review', 'source_refresh_failed', 180);
  await candidate('hold-ai1', 'needs_review', 'ai_review_exhausted', 120);

  let first: number | null = null;
  for (const row of AI1_CASES) {
    const outcome = row.decision ? { decision: row.decision, reason: 'pr13c fixture', evidenceIds: ['product'], confidence: 0.9 } : null;
    const [attempt]: { id: number }[] = await tx`INSERT INTO crawl_review_attempts (candidate_id, kind, state, input_hash, policy_hash, source_revision_hash,
        snapshot, source, prompt_version, rules_version, provider, model, attempt_number, reused_from_attempt_id, outcome, error_code,
        started_at, completed_at, retry_after, valid_until)
      VALUES (${candidates.get(row.candidate)!}, ${row.kind}, ${row.state}, ${hash}, ${hash}, ${hash}, '{}'::jsonb, '{}'::jsonb, 'pr13c', 'pr13c',
        ${row.provider}, 'first', 1, ${row.reused ? first : null}, ${outcome === null ? null : tx.json(outcome)}, ${row.errorCode},
        ${wall(row.startedAgo)}, ${row.completedAgo === null ? null : wall(row.completedAgo)},
        ${row.retryAfterAgo === undefined ? null : wall(row.retryAfterAgo)}, ${wall(-1440)}) RETURNING id`;
    first ??= attempt.id;
  }
  const votes = new Map<string, number>();
  for (const row of AI2_CASES) {
    const [vote] = await tx`INSERT INTO second_reviews (candidate_id, repo, trigger, first_decision, input_hash, provider, model,
        second_decision, error_code, fallback_for_id, failure_count, status, created_at, reviewed_at)
      VALUES (${candidates.get(row.candidate)!}, ${`${prefix}/${row.candidate}`}, 'ai_approved', 'approve', ${hash}, 'abcllm', ${`m-${row.key}`},
        ${row.decision}, ${row.errorCode ?? null}, ${row.fallbackOf ? votes.get(row.fallbackOf)! : null}, ${row.failureCount}, ${row.status},
        ${wall(row.createdAgo)}, ${row.reviewedAgo === null ? null : wall(row.reviewedAgo)}) RETURNING id`;
    votes.set(row.key, vote.id);
  }
  for (const [repo, value, agoMinutes] of [['pub-a', 1, 10], ['pub-a', -1, 8], ['pub-a', 1, 5], ['pub-b', 1, 300], ['pub-c', 1, 1500]] as const)
    await tx`INSERT INTO crawl_publication_changes (repo, delta, occurred_at) VALUES (${`${prefix}/${repo}`}, ${value}, ${wall(agoMinutes)})`;
  for (const [key, state, nextAgo] of [['f-ready', 'pending', 50], ['f-backoff', 'pending', -30], ['f-busy', 'fetching', 5]] as const)
    await tx`INSERT INTO crawl_frontier (repo, signal, state, next_attempt_at) VALUES (${`${prefix}/${key}`}, 'pr13c', ${state}, ${wall(nextAgo)})`;

  const owner = { instanceId: `${prefix}-owner`, bootId: randomUUID() };
  const request = async (klass: 'first' | 'second' | 'background', state: 'waiting' | 'reserved' | 'withdrawn', workKey: string, queuedAgo = 0) => {
    const id = randomUUID(), reserved = state === 'reserved';
    await tx`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
        provider_budget_id, group_id, epoch, revision, policy_hash, state, token, reserved_until, queued_at, queue_until)
      VALUES (${id}, ${workKey}, ${owner.instanceId}, ${owner.bootId}, ${klass}, ${klass === 'background' ? 'text' : 'reviewer'}, 'pr13c-route',
        'pr13c-provider', 'pr13c-model', 'pr13c-budget', 'pr13c-group', 1, 1, ${hash}, ${state}, ${reserved ? randomUUID() : null},
        ${reserved ? zoned(-60) : null}, ${zoned(queuedAgo)}, ${zoned(-60)})`;
    return id;
  };
  const settled = (requestId: string) => {
    const binding: Ai1DispatchBinding = { kind: 'ai1_legacy_gateway', version: 1, logicalWorkKey: `ai1:${candidates.get('c1')}`,
      candidateId: candidates.get('c1')!, attemptId: first!, inputHash: hash, sourceRevisionHash: hash, reviewPolicyHash: hash, promptVersion: 'pr13c',
      rulesVersion: 'pr13c', provider: 'abcllm', model: 'pr13c-model', routeId: 'crawl-agent-review', stageEpoch: 1, wireHash: hash,
      servingContractHash: hash, totalTokenBound: 8000, chargedTokens: 8000, job: { name: 'crawl-agent-review', token: randomUUID(), requestedVersion: 1 } };
    return ai1GatewayTerminalEvidenceSchema.parse({ version: 1, kind: 'ai1_gateway_terminal', finishReason: 'stop', responseHash: hash,
      actualUsage: null, provenance: 'unknown', dispatch: { requestId, owner, token: randomUUID(), epoch: 1, revision: 1, policyHash: hash,
        binding, bindingHash: ai1DispatchBindingHash(binding) } });
  };
  const released = (requestId: string) => modelDispatchReleaseEvidenceSchema.parse({ version: 1, kind: 'dr_call_drain', requestId, owner,
    fromState: 'dispatched', dispatchAt: null, bindingHash: null, notBefore: '2026-10-17T00:00:00.000Z', evaluatedAt: '2026-10-17T00:00:01.000Z',
    operator: 'pr13c-fixture', promotionId: randomUUID(), writerEpoch: 2, scope: 'model:pr13c-budget' });
  const event = (requestId: string, kind: string, from: string, to: string, agoMinutes: number, evidence: unknown = null, reason: string | null = null) =>
    tx`INSERT INTO model_capacity_events (request_id, kind, epoch, revision, policy_hash, from_state, to_state, reason, evidence, created_at)
      VALUES (${requestId}, ${kind}, 1, 1, ${hash}, ${from}, ${to}, ${reason}, ${evidence === null ? null : tx.json(evidence as postgres.JSONValue)}, ${zoned(agoMinutes)})`;
  await request('first', 'waiting', `${prefix}-wait-first`, 7);
  await request('background', 'waiting', `${prefix}-wait-background`, 3);
  await request('second', 'reserved', `${prefix}-reserved-second`, 1);
  const [ra, rb, rc, rd, re] = [await request('first', 'withdrawn', `${prefix}-ra`), await request('first', 'withdrawn', `${prefix}-rb`),
    await request('second', 'withdrawn', `${prefix}-rc`), await request('background', 'withdrawn', `${prefix}-unit`),
    await request('background', 'withdrawn', `${prefix}-unit`)];
  await event(rb, 'dispatch_started', 'reserved', 'dispatched', 1380);
  await event(rb, 'dispatch_indeterminate', 'dispatched', 'indeterminate', 1320, null, 'transport_unknown');
  await event(rd, 'dispatch_started', 'reserved', 'dispatched', 50);
  await event(re, 'dispatch_started', 'reserved', 'dispatched', 48);
  await event(rd, 'dispatch_settled', 'dispatched', 'settled', 45, settled(rd));
  await event(re, 'dispatch_settled', 'dispatched', 'settled', 44, settled(re));
  await event(ra, 'dispatch_started', 'reserved', 'dispatched', 30);
  await event(ra, 'dispatch_settled', 'dispatched', 'settled', 29, settled(ra));
  await event(rc, 'dispatch_started', 'reserved', 'dispatched', 10);
  await event(rc, 'dispatch_released', 'dispatched', 'withdrawn', 5, released(rc));
}

it('applies the migrated schema this reader depends on', () => track(async () => {
  const journal = JSON.parse(readFileSync(path.join(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8')) as { entries: { tag: string }[] };
  expect(journal.entries.map(entry => entry.tag)).toContain('0096_model_capacity_dispatch_release');
  const [applied] = await admin<{ count: number }[]>`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
  expect(applied.count).toBe(journal.entries.length);
}));

it('counts the fixture by the documented definitions through the real driver and leaves no rows behind', () => track(async () => {
  const before = await tables(), prefix = `pr13c-${randomUUID().slice(0, 8)}`;
  await admin.begin(async tx => {
    const base = await run(tx);
    await seed(tx, prefix);
    const after = await run(tx);
    for (const window of ['1h', '24h'] as const) {
      expect(delta(after.ai1.windows[window], base.ai1.windows[window])).toEqual(AI1_EXPECTED[window]);
      expect(delta(after.ai2.windows[window], base.ai2.windows[window])).toEqual(AI2_EXPECTED[window]);
    }
    expect(delta(after.publish.windows['1h'], base.publish.windows['1h'])).toEqual({ published: 1, transitions: 2, withdrawn: 1 });
    expect(delta(after.publish.windows['24h'], base.publish.windows['24h'])).toEqual({ published: 2, transitions: 3, withdrawn: 1 });
    expect(after.publish.approved - base.publish.approved).toBe(1);
    expect([after.ai1.backoff - base.ai1.backoff, after.ai1.human - base.ai1.human]).toEqual([AI1_BACKOFF, 1]);
    const ai2Now = { ready: after.ai2.ready - base.ai2.ready, backoff: after.ai2.backoff - base.ai2.backoff,
      human: after.ai2.human - base.ai2.human, humanCandidates: after.ai2.humanCandidates - base.ai2.humanCandidates };
    expect(ai2Now).toEqual(AI2_NOW);
    expect(delta({ ready: after.fetch.ready, backoff: after.fetch.backoff, inFlight: after.fetch.inFlight, human: after.fetch.human },
      { ready: base.fetch.ready, backoff: base.fetch.backoff, inFlight: base.fetch.inFlight, human: base.fetch.human }))
      .toEqual({ ready: 1, backoff: 1, inFlight: 1, human: 1 });
    // 최장 나이는 기존 행이 더 오래됐을 수 있어 하한만 본다(DB 시계 기준)
    expect(minutesSince(after.at, after.fetch.readyOldestAt)).toBeGreaterThanOrEqual(50);
    expect(minutesSince(after.at, after.fetch.humanOldestAt)).toBeGreaterThanOrEqual(180);
    expect(minutesSince(after.at, after.ai1.humanOldestAt)).toBeGreaterThanOrEqual(120);
    expect(minutesSince(after.at, after.ai2.readyOldestAt)).toBeGreaterThanOrEqual(100);
    expect(minutesSince(after.at, after.ai2.humanOldestAt)).toBeGreaterThanOrEqual(90);
    expect(minutesSince(after.at, after.ledger.first.waitingOldestAt)).toBeGreaterThanOrEqual(7);
    const ledger = { first: { '1h': { dispatched: 1, settled: 1, indeterminate: 0, released: 0, settledUnits: 1 },
        '24h': { dispatched: 2, settled: 1, indeterminate: 1, released: 0, settledUnits: 1 } },
      second: { '1h': { dispatched: 1, settled: 0, indeterminate: 0, released: 1, settledUnits: 0 },
        '24h': { dispatched: 1, settled: 0, indeterminate: 0, released: 1, settledUnits: 0 } },
      background: { '1h': { dispatched: 2, settled: 2, indeterminate: 0, released: 0, settledUnits: 1 },
        '24h': { dispatched: 2, settled: 2, indeterminate: 0, released: 0, settledUnits: 1 } } };
    for (const klass of ['first', 'second', 'background'] as const) {
      for (const window of ['1h', '24h'] as const)
        expect(delta(after.ledger[klass].windows[window], base.ledger[klass].windows[window])).toEqual(ledger[klass][window]);
      expect([after.ledger[klass].waiting - base.ledger[klass].waiting, after.ledger[klass].active - base.ledger[klass].active])
        .toEqual({ first: [1, 0], second: [0, 1], background: [1, 0] }[klass]);
    }
    const status = buildPipelineCompletions(after);
    expect(status.observedAt).not.toBeNull();
    expect(status.stages.flatMap(row => [...row.metrics, ...row.queue]).filter(row => row.state === 'unknown')).toEqual([]);
    throw new Rollback();
  }).catch(error => { if (!(error instanceof Rollback)) throw error; });
  expect(await tables()).toEqual(before);
}));

it('reads only rows after the last one started before 24h+margin and keeps chains begun earlier unattributed', () => track(async () => {
  const before = await tables(), prefix = `pr13c-${randomUUID().slice(0, 8)}`;
  await admin.begin(async tx => {
    const wall = (minutes: number) => tx`(clock_timestamp() AT TIME ZONE 'UTC') - ${minutes} * interval '1 minute'`;
    const [candidate] = await tx`INSERT INTO crawl_candidates (repo, state, decided_by) VALUES (${`${prefix}/floor`}, 'new', 'auto') RETURNING id`;
    const attempt = (startedAgo: number, completedAgo: number) => tx`INSERT INTO crawl_review_attempts (candidate_id, state, input_hash, policy_hash,
        source_revision_hash, snapshot, source, prompt_version, rules_version, provider, model, attempt_number, outcome, started_at, completed_at, valid_until)
      VALUES (${candidate.id}, 'succeeded', ${hash}, ${hash}, ${hash}, '{}'::jsonb, '{}'::jsonb, 'pr13c', 'pr13c', 'abcllm', 'first', 1,
        ${tx.json({ decision: 'approve', reason: 'pr13c floor', evidenceIds: ['product'], confidence: 0.9 })}, ${wall(startedAgo)}, ${wall(completedAgo)}, ${wall(-1440)})`;
    // 경계 행: 25시간 넘게 전에 시작했다. 끝이 창 안이어도 이 id 까지는 읽지 않는다(시작→종료 1시간 초과는 세지 않는 문서화된 한계)
    await attempt(1520, 10);
    await attempt(5, 2);
    const vote = (createdAgo: number, fallbackFor: number | null, decision: string | null, model: string) => tx`INSERT INTO second_reviews (candidate_id,
        repo, trigger, first_decision, input_hash, provider, model, second_decision, fallback_for_id, failure_count, status, created_at, reviewed_at)
      VALUES (${candidate.id}, ${`${prefix}/floor`}, 'ai_approved', 'approve', ${hash}, 'abcllm', ${model}, ${decision}, ${fallbackFor},
        ${decision ? 0 : 1}, ${decision ? 'agreed' : 'failed'}, ${wall(createdAgo)}, ${wall(createdAgo - 1)}) RETURNING id`;
    const [root] = await vote(1530, null, null, 'm-root');
    await vote(10, root.id, 'approve', 'm-fallback');
    const requestId = randomUUID();
    await tx`INSERT INTO model_capacity_requests (request_id, work_key, owner_instance_id, owner_boot_id, class, pool, route_id, provider, model,
        provider_budget_id, group_id, epoch, revision, policy_hash, state, queue_until)
      VALUES (${requestId}, ${`${prefix}-floor`}, ${`${prefix}-owner`}, ${randomUUID()}, 'first', 'reviewer', 'pr13c-route', 'pr13c-provider',
        'pr13c-model', 'pr13c-budget', 'pr13c-group', 1, 1, ${hash}, 'withdrawn', clock_timestamp())`;
    for (const agoMinutes of [1530, 10]) await tx`INSERT INTO model_capacity_events (request_id, kind, epoch, revision, policy_hash, from_state, to_state, created_at)
      VALUES (${requestId}, 'dispatch_started', 1, 1, ${hash}, 'reserved', 'dispatched', clock_timestamp() - ${agoMinutes} * interval '1 minute')`;
    const after = await run(tx);
    // 경계 뒤에는 이 사례의 행만 있으므로 기존 행과 무관하게 정확한 값이다
    for (const window of ['1h', '24h'] as const) {
      expect(after.ai1.windows[window]).toEqual({ calls: 1, failed: 0, cancelled: 0, rules: 0, reuse: 0, superseded: 0, succeeded: 1, handoff: 0,
        unique: 1, uniqueNew: 0 });
      expect(after.ai2.windows[window]).toEqual({ chains: 0, calls: 0, failed: 0, votes: 0, votedCandidates: 0, unattributed: 1 });
      expect(after.ledger.first.windows[window]).toEqual({ dispatched: 1, settled: 0, indeterminate: 0, released: 0, settledUnits: 0 });
      expect(after.ledger.background.windows[window]).toEqual({ dispatched: 0, settled: 0, indeterminate: 0, released: 0, settledUnits: 0 });
    }
    throw new Rollback();
  }).catch(error => { if (!(error instanceof Rollback)) throw error; });
  expect(await tables()).toEqual(before);
}));

it('reads through the app pool while writers hold row locks, with no writes', () => track(async () => {
  const before = await tables();
  const status = await admin.begin(async tx => {
    await tx.unsafe(`LOCK TABLE ${TABLES.join(', ')} IN ROW EXCLUSIVE MODE`);
    for (const [table, key] of [['crawl_review_attempts', 'id'], ['second_reviews', 'id'], ['crawl_candidates', 'id'], ['crawl_frontier', 'id'],
      ['crawl_publication_changes', 'id'], ['model_capacity_requests', 'request_id']] as const)
      await tx.unsafe(`SELECT ${key} FROM ${table} ORDER BY ${key} DESC LIMIT 50 FOR UPDATE`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([readPipelineCompletions(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('reader_blocked_by_lock')), 8_000); })]);
    } finally { clearTimeout(timer); }
  });
  // 읽기 실패는 미확인으로 돌아오므로 실제로 읽었는지 따로 본다
  expect(status.observedAt).not.toBeNull();
  const direct = buildPipelineCompletions(await run(admin));
  const counts = (value: typeof status) => value.stages.map(row => [row.key, row.metrics.map(item => [item.key, item.state, item.values]),
    row.queue.map(item => [item.key, item.state, item.count])]);
  expect(counts(status)).toEqual(counts(direct));
  expect(await tables()).toEqual(before);
}));

it('has an index path for every table access (no sequential scan even when forced off)', () => track(async () => {
  const { sql, params } = query();
  const plan = await admin.begin(async tx => {
    await tx`SET LOCAL enable_seqscan = off`;
    return tx.unsafe(`EXPLAIN (COSTS OFF) ${sql}`, params as postgres.ParameterOrJSON<never>[]);
  });
  const lines = plan.map(row => String(row['QUERY PLAN']));
  expect(lines.filter(line => /Seq Scan on/.test(line))).toEqual([]);
  for (const table of TABLES) expect(lines.some(line => line.includes(` on ${table} `) || line.endsWith(` on ${table}`))).toBe(true);
}));
