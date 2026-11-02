import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { and, eq, gt, like, max } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryScans, aiConnections, aiTaskModels, crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs,
  modelServingContracts, operationsAudit, secondReviews } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { applyStaleSecondReviews, previewStaleSecondReviews, reconcileStaleSecondReviews, STALE_RECONCILE_AUDIT_ACTION } from '@/lib/crawl/second-review';
import { STALE_REVIEW_OWNER } from '@/lib/crawl/second-review-stale';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { ensureSchema } from './setup';
import { TEST_DATABASE_URL } from './test-database-url';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { cliDbContract } from '@/lib/llm/cli-db-contracts';
import { cliContractRouteId, cliServingContractHash } from '@/lib/llm/cli-serving-contract';
import { closeSettledSecondReviewsFixture as closeSettled, enqueueSecondReviewsFixture as enqueue, withLegacySecondReviewJob } from './second-review-receipt-fixtures';

/**
 * 오래된 AI2 대기 정리(2026-10-29) — 운영 138985/357316 모양: 관문 표(ai_approved)가 남은 채 후보가 갈림 보류가 아닌
 * needs_review 로 내려갔다. 예전에는 stale 힌트(승인만)와 closeSettled(needs_review 는 사람 대기) 어느 쪽도 집지 않았다.
 */
const PREFIX = 'ai2-stale/';
const hours = (count: number) => new Date(Date.now() - count * 3_600_000);

beforeAll(() => ensureSchema());
async function clean() {
  await db.delete(agentRepositoryScans).where(like(agentRepositoryScans.repositoryKey, `${PREFIX}%`));
  await db.delete(crawlFrontier).where(like(crawlFrontier.repo, `${PREFIX}%`));
}
afterAll(clean);
beforeEach(async () => {
  await clean();
  for (const table of [secondReviews, jobs, crawlReviewAttempts, crawlCandidates, crawlDocuments, crawlSettings]) await db.delete(table);
  await saveSettings({ enabled: true, reviewMode: 'enforce', firstReview: { provider: 'claude-cli', model: 'sonnet' },
    secondReview: { enabled: true, voters: [{ provider: 'claude-cli', model: 'opus' }], includeAiHeld: false, sampleRate: 0, agreeAt: 0.85 } }, 'fixture');
  // 심사 방식은 설정 저장이 바꾸지 않는다 — 다른 관문 시험처럼 저장된 값에 직접 둔다
  const [saved] = await db.select().from(crawlSettings).where(eq(crawlSettings.id, 1));
  await db.update(crawlSettings).set({ values: { ...(saved.values as object), reviewMode: 'enforce' } }).where(eq(crawlSettings.id, 1));
});

/** 1차 AI 가 승인한 자동 후보, 신선한 원본·스캔, 관문 대기 표 하나 */
async function gateFixture(name: string, voters = 1) {
  const repo = `${PREFIX}${name}`, productUrl = `https://ai2-stale-${name}.test`;
  await crawl.putDocument({ repo, productUrl, pageStatus: 200,
    repoMeta: { description: '배포한 서비스', stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: 'User' } },
    pageMeta: { title: 'Taskly', textSample: '쓸 수 있는 앱' } });
  await crawl.recordJudgement({ repo, productUrl, state: 'approved', reason: 'passed', decidedBy: 'auto' });
  const settings = await getSettings();
  expect(settings.reviewMode).toBe('enforce');
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  const [scan] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(200_000_000 + candidate.id),
    repositoryKey: repo, commitSha: 'a'.repeat(40), detectorVersion: settings.agentEvidence.detectorVersion,
    scope: '', scopeHash: 'a'.repeat(64), state: 'complete', startedAt: hours(1), completedAt: hours(1), nextAttemptAt: hours(-23) }).returning();
  const first = await firstReview(candidate.id, 'approve', 0.9);
  expect(await enqueue(settings)).toBe(voters);
  const [vote] = await db.select().from(secondReviews).where(eq(secondReviews.candidateId, candidate.id)).orderBy(secondReviews.id);
  expect(vote).toMatchObject({ trigger: 'ai_approved', status: 'pending', firstAttemptId: first.id });
  return { candidate, scan, first, vote };
}

async function firstReview(candidateId: number, decision: 'approve' | 'reject' | 'needs_review', confidence: number | null) {
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.id, candidateId));
  const input = await loadReviewInput(candidate, (await crawl.getDocument(candidate.repo))!, await getSettings());
  const [attempt] = await db.insert(crawlReviewAttempts).values({
    candidateId, kind: 'automatic', state: 'succeeded', attemptNumber: 1,
    inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: 'claude-cli', model: 'sonnet', startedAt: new Date(), completedAt: new Date(), validUntil: input.validUntil,
    outcome: confidence === null ? { decision, reason: '사유', evidenceIds: ['product'] } : { decision, reason: '사유', evidenceIds: ['product'], confidence },
  }).returning();
  return attempt;
}

const reconcile = () => withLegacySecondReviewJob(lease => reconcileStaleSecondReviews(undefined, lease));

/**
 * 운영자 도구(scripts/reconcile-ai2-stale.ts)는 자식 프로세스라 이 시험 프로세스의 순위 고정(tests/integration/env.ts)을 받지 않는다 — 실행 쪽처럼
 * DB 의 「작업 ↔ 모델」 순위를 읽는다(PR C1). 그래서 CLI 연결 하나와 1차 1순위(sonnet)·2차 투표자 칸 1 의 1순위(opus), 순위 저장이 만드는
 * DB CLI 계약(cli:claude-cli:<route>)을 실제 행으로 둔다. 도구는 CLI 버전을 확인하지 않는 프로세스라 계약이 있으면 쓸 수 있는 순위로 본다.
 * 되돌리기 함수를 돌려준다.
 */
async function seedReviewRanksForChild(): Promise<() => Promise<void>> {
  const connectionId = randomUUID(), actor = `${PREFIX}fixture`;
  await db.insert(aiConnections).values({ id: connectionId, label: `${PREFIX}claude`, kind: 'cli', cliTool: 'claude', cliModels: ['sonnet', 'opus'],
    deviceId: 'claude-sub', updatedBy: actor });
  const ranks = [{ task: 'first-review', routeId: 'crawl-agent-review', model: 'sonnet' }, { task: 'second-review', routeId: 'second-review', model: 'opus' }];
  for (const { task, routeId, model } of ranks) {
    await db.insert(aiTaskModels).values({ task, slot: 1, rank: 1, connectionId, model, updatedBy: actor });
    const contract = cliDbContract(routeId, 'claude-cli', model, 'fixture-claude 1.0.0')!;
    const stored = cliContractRouteId('claude-cli', routeId);
    await db.insert(modelServingContracts).values({ routeId: stored, model, contract: { ...contract, routeId: stored },
      contractHash: cliServingContractHash(contract), auth: 'none', transport: 'direct', enabled: true, updatedBy: actor });
  }
  return async () => {
    await db.delete(aiTaskModels).where(eq(aiTaskModels.connectionId, connectionId));
    await db.delete(aiConnections).where(eq(aiConnections.id, connectionId));
    await db.delete(modelServingContracts).where(eq(modelServingContracts.updatedBy, actor));
  };
}
const votes = (candidateId: number) => db.select().from(secondReviews).where(eq(secondReviews.candidateId, candidateId)).orderBy(secondReviews.id);
const demote = (candidateId: number, reason: 'ambiguous' | 'second_review_split' = 'ambiguous') =>
  db.update(crawlCandidates).set({ state: 'needs_review', reason }).where(eq(crawlCandidates.id, candidateId));

it('closes a gate vote stranded on a non-split hold and re-enqueues the current first verdict exactly once', async () => {
  const { candidate, vote, first } = await gateFixture('requeue');
  await demote(candidate.id);
  expect(await reconcile()).toBeGreaterThan(0);
  const rows = await votes(candidate.id);
  expect(rows.map(row => [row.trigger, row.status, row.resolution, row.resolvedBy])).toEqual([
    ['ai_approved', 'resolved', 'superseded', STALE_REVIEW_OWNER],
    ['ai_decided', 'pending', null, null],
  ]);
  expect(rows[1]).toMatchObject({ firstAttemptId: first.id, model: 'opus', firstDecision: 'approve' });
  expect(rows[1].generationKey).not.toBe(vote.generationKey);
  // 다시 돌아도 같은 항목을 또 넣지 않는다
  expect(await reconcile()).toBe(0);
  expect(await votes(candidate.id)).toEqual(rows);
});

it('retires the stranded gate demand when the current first verdict no longer calls for AI2', async () => {
  const { candidate } = await gateFixture('retire');
  await demote(candidate.id);
  await firstReview(candidate.id, 'needs_review', null);
  expect(await reconcile()).toBeGreaterThan(0);
  const rows = await votes(candidate.id);
  expect(rows.map(row => [row.status, row.resolution, row.resolvedBy])).toEqual([['resolved', 'not_required', STALE_REVIEW_OWNER]]);
  expect(await reconcile()).toBe(0);
});

it('leaves a gate vote on a human split hold untouched', async () => {
  const { candidate, vote } = await gateFixture('split');
  await demote(candidate.id, 'second_review_split');
  expect(await reconcile()).toBe(0);
  expect(await votes(candidate.id)).toEqual([vote]);
});

it('keeps demand and requests a source refresh when the new input is not yet available', async () => {
  const { candidate } = await gateFixture('refresh');
  await demote(candidate.id);
  await db.update(crawlDocuments).set({ fetchedAt: hours(48) }).where(eq(crawlDocuments.repo, candidate.repo));
  expect(await reconcile()).toBeGreaterThan(0);
  const rows = await votes(candidate.id);
  expect(rows.map(row => [row.status, row.resolution])).toEqual([['resolved', 'superseded']]);
  expect((await db.select().from(crawlFrontier).where(eq(crawlFrontier.repo, candidate.repo)))[0].state).toBe('pending');
  // 갱신을 기다리는 동안은 아무것도 바꾸지 않는다(쿨다운·이미 대기 중인 frontier)
  expect(await reconcile()).toBe(0);
  expect(await votes(candidate.id)).toEqual(rows);
});

/** operations_audit 는 지우기를 거부한다(0056) — 앞선 실행이 남긴 줄을 빼고 이 시험이 쓴 줄만 본다 */
let auditFloor = 0;
beforeEach(async () => {
  const [row] = await db.select({ id: max(operationsAudit.id) }).from(operationsAudit);
  auditFloor = row?.id ?? 0;
});
const auditRows = () => db.select().from(operationsAudit)
  .where(and(eq(operationsAudit.action, STALE_RECONCILE_AUDIT_ACTION), gt(operationsAudit.id, auditFloor)));
const snapshot = async () => ({
  votes: await db.select().from(secondReviews).orderBy(secondReviews.id),
  frontier: await db.select().from(crawlFrontier).orderBy(crawlFrontier.id),
  candidates: await db.select().from(crawlCandidates).orderBy(crawlCandidates.id),
  jobs: await db.select().from(jobs).orderBy(jobs.name),
  audit: await auditRows(),
});

it('dry-run reports the exact plan without writing, and apply carries it out once with an audit row per candidate', async () => {
  const requeue = await gateFixture('tool-requeue');
  const retire = await gateFixture('tool-retire');
  const split = await gateFixture('tool-split');
  await demote(requeue.candidate.id);
  await demote(retire.candidate.id);
  await firstReview(retire.candidate.id, 'needs_review', null);
  await demote(split.candidate.id, 'second_review_split');
  const before = await snapshot();
  const preview = await previewStaleSecondReviews({ limit: 25 });
  expect(await snapshot()).toEqual(before);
  const byId = new Map(preview.entries.map(entry => [entry.candidateId, entry]));
  expect(byId.get(requeue.candidate.id)).toMatchObject({ blocked: null, close: [requeue.vote.id], retire: [],
    reinsert: [{ model: 'opus', trigger: 'ai_decided' }] });
  expect(byId.get(requeue.candidate.id)!.votes).toEqual([expect.objectContaining({ id: requeue.vote.id, verdict: 'stale',
    reasons: ['candidate_state_changed'] })]);
  expect(byId.get(retire.candidate.id)).toMatchObject({ close: [retire.vote.id], retire: [retire.vote.id], reinsert: [] });
  // 사람 갈림 보류는 힌트에도 들지 않는다
  expect(byId.has(split.candidate.id)).toBe(false);
  expect(preview.summary).toMatchObject({ candidatesWithChanges: 2, close: 2, retire: 1, reinsert: 1, blocked: 0 });

  const applied = await withLegacySecondReviewJob(lease => applyStaleSecondReviews({ lease, actor: 'fixture-operator', limit: 25 }));
  expect(applied.entries.map(entry => entry.candidateId).sort()).toEqual([requeue.candidate.id, retire.candidate.id].sort());
  const requeued = await votes(requeue.candidate.id);
  expect(requeued.map(row => [row.trigger, row.status])).toEqual([['ai_approved', 'resolved'], ['ai_decided', 'pending']]);
  expect(applied.entries.find(entry => entry.candidateId === requeue.candidate.id)).toMatchObject({
    closedIds: [requeue.vote.id], insertedIds: [requeued[1].id], retiredIds: [], reasons: { candidate_state_changed: 1 } });
  expect((await votes(retire.candidate.id)).map(row => row.resolution)).toEqual(['not_required']);
  expect(await votes(split.candidate.id)).toEqual([split.vote]);
  const audit = await auditRows();
  expect(audit.map(row => [row.actor, row.target]).sort()).toEqual([
    ['fixture-operator', `candidate:${requeue.candidate.id}`], ['fixture-operator', `candidate:${retire.candidate.id}`]].sort());

  // 같은 도구를 다시 돌려도 바꿀 것이 없고 감사 기록도 늘지 않는다
  const again = await previewStaleSecondReviews({ limit: 25 });
  expect(again.summary).toMatchObject({ candidatesWithChanges: 0, close: 0, retire: 0, reinsert: 0 });
  const second = await withLegacySecondReviewJob(lease => applyStaleSecondReviews({ lease, actor: 'fixture-operator', limit: 25 }));
  expect(second.changed).toBe(0);
  expect(await auditRows()).toHaveLength(2);
});

it('bounds each batch by --limit and walks the backlog with the returned cursor', async () => {
  const fixtures = [];
  for (const name of ['page-a', 'page-b', 'page-c']) {
    const value = await gateFixture(name);
    await demote(value.candidate.id);
    fixtures.push(value);
  }
  const ids = fixtures.map(value => value.candidate.id).sort((a, b) => a - b);
  const first = await previewStaleSecondReviews({ limit: 2 });
  expect(first.entries.map(entry => entry.candidateId)).toEqual(ids.slice(0, 2));
  expect(first.nextAfterCandidateId).toBe(ids[1]);
  const applied = await withLegacySecondReviewJob(lease => applyStaleSecondReviews({ lease, actor: 'fixture-operator', limit: 2 }));
  expect(applied.examined).toBe(2);
  expect(applied.nextAfterCandidateId).toBe(ids[1]);
  // 아직 안 본 셋째 후보는 그대로다
  expect((await votes(ids[2])).map(row => row.status)).toEqual(['pending']);
  const rest = await withLegacySecondReviewJob(lease => applyStaleSecondReviews({ lease, actor: 'fixture-operator', limit: 2,
    afterCandidateId: applied.nextAfterCandidateId }));
  expect(rest.entries.map(entry => entry.candidateId)).toEqual([ids[2]]);
  expect(rest.nextAfterCandidateId).toBe(0);
  await expect(previewStaleSecondReviews({ limit: 201 })).rejects.toThrow('invalid_stale_reconcile_limit');
});

it('runs the operator script: dry-run writes nothing, --apply writes through the second-review job lease', async () => {
  const { candidate, vote } = await gateFixture('script');
  await demote(candidate.id);
  const run = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/reconcile-ai2-stale.ts', ...args],
    { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, LOG_LEVEL: 'error' }, timeout: 60_000 });
  // 순위 표가 비어 있으면 도구는 투표자를 모른다 — 오래된 관문 표는 닫지만 옛 설정의 투표자(opus)로 다시 올리지 않는다
  expect(JSON.parse((await run('--limit', '5')).stdout)).toMatchObject({ mode: 'dry-run', limit: 5, summary: { close: 1, reinsert: 0 } });
  const unseed = await seedReviewRanksForChild();
  try {
    const before = await snapshot();
    const dry = JSON.parse((await run('--limit', '5')).stdout);
    expect(dry).toMatchObject({ mode: 'dry-run', limit: 5, summary: { close: 1, reinsert: 1 } });
    expect(await snapshot()).toEqual(before);
    await expect(run('--apply')).rejects.toMatchObject({ stderr: expect.stringContaining('actor_required_for_apply') });
    const applied = JSON.parse((await run('--apply', '--actor', 'script-operator', '--limit', '5')).stdout);
    expect(applied).toMatchObject({ mode: 'apply', changed: 2, job: { status: 'completed' } });
    expect((await votes(candidate.id)).map(row => [row.id === vote.id, row.status, row.model])).toEqual([[true, 'resolved', 'opus'], [false, 'pending', 'opus']]);
    const [job] = await db.select().from(jobs).where(eq(jobs.name, 'second-review'));
    // 실제 잡이 다음 틱에 원래 일을 이어 하도록 요청을 남긴다
    expect(job.requestedVersion).toBeGreaterThan(job.processedVersion);
  } finally { await unseed(); }
}, 120_000);

it('re-enqueues one row per configured model and stays single across enqueue, cleanup and repeated reconcile ticks', async () => {
  await saveSettings({ secondReview: { voters: [{ provider: 'claude-cli', model: 'opus' }, { provider: 'claude-cli', model: 'haiku' }] } }, 'fixture');
  const { candidate } = await gateFixture('two-voters', 2);
  await demote(candidate.id);
  expect(await reconcile()).toBeGreaterThan(0);
  const active = async () => (await votes(candidate.id)).filter(row => row.status === 'pending');
  const first = await active();
  expect(first.map(row => [row.trigger, row.model]).sort()).toEqual([['ai_decided', 'haiku'], ['ai_decided', 'opus']]);
  for (let tick = 0; tick < 2; tick++) {
    expect(await enqueue(await getSettings())).toBe(0);
    await closeSettled();
    expect(await reconcile()).toBe(0);
  }
  expect(await active()).toEqual(first);
});

it('cannot apply while the real second-review job holds its lease — the tool exits without writing', async () => {
  const { candidate } = await gateFixture('lease');
  await demote(candidate.id);
  const before = await snapshot();
  const failure = await withLegacySecondReviewJob(async () => promisify(execFile)(process.execPath,
    ['--import', 'tsx', 'scripts/reconcile-ai2-stale.ts', '--apply', '--actor', 'script-operator'],
    { env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, LOG_LEVEL: 'error' }, timeout: 60_000 }).then(() => null, (error: unknown) => error));
  expect(failure).toMatchObject({ code: 3 });
  const after = await snapshot();
  expect(after.votes).toEqual(before.votes);
  expect(after.audit).toEqual([]);
}, 120_000);
