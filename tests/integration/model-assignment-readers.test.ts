import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, modelHelperAssignments, secondReviews } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { chooseFirstReviewForCandidate, loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { firstReviewerKey, firstReviewers } from '@/lib/crawl/first-reviewers';
import { secondReviewFallbacks, secondReviewVoters } from '@/lib/crawl/second-review-voters';
import { loadSecondReviewInput } from '@/lib/crawl/second-review-input';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { assignmentFlag, setAssignmentTableEnabledForTest } from '@/lib/llm/assignment-flag';
import { assignmentSource, ensureStageAssignments, requireStageAssignments, setStageAssignmentsForTest } from '@/lib/llm/stage-assignment-snapshot';
import { saveRuntimeSettings } from '@/lib/operations/runtime-settings';
import { ensureRuntimeSettings } from '@/lib/operations/runtime-settings-store';
import { readModelCapacityDevice, saveModelCapacityDevice } from '@/lib/llm/capacity-devices-repository';
import type { AssignmentTransport } from '@/lib/llm/capacity-helpers';
import { ensureSchema } from './setup';
import { pinReviewRanks } from '../review-task-ranks-fixture';
import { closeSettledSecondReviewsFixture as closeSettledSecondReviews, enqueueSecondReviewsFixture as enqueueSecondReviews,
  recordSecondReviewFixture } from './second-review-receipt-fixtures';

/**
 * PR 3b-B — 배정 표 읽기를 켜고 DB 에 심은 배정 표(role 'primary', mode 'live')로 1차 고르기와 2차 올리기·기록·대체·정리가 같이 바뀌었다.
 * PR C1(2026-11-02 소유자 결정)부터 1차(ai1)·2차(ai2)는 「작업 ↔ 모델」 순위만 읽는다 — 이 파일은 거꾸로, 표 읽기가 켜져 있고 쓸 수 있는 ai1·ai2 행이
 * DB 에 있어도 1차 고르기·2차 올리기·기록·대체·정리가 순위만 따르는가를 본다. 스냅숏은 고정하지 않고 실제 DB 에서 읽는다(ensureStageAssignments).
 * 순위(RANKED)는 표·예전 설정(crawl_settings)의 1차·2차 모델과 일부러 모두 다르게 둔다.
 * 계약·route 저장(saveModelAssignment)은 model-assignments 가 본다 — 여기서는 행을 SQL 로 심는다.
 * PR 3b-E — 마지막 시험은 env 강제 없이 runtime_settings 토글(assignments.tableReads)만 저장해도 1차·2차 심사자가 바뀌지 않는가를 본다(토글은 다른 단계의 것이다).
 */
const DEVICE = 'rdr-dev', PREFIX = 'rdr-';
const tableAi1 = [
  { id: 'rdr-ai1-01', model: '[supa] Qwen3.8-27B-NVFP4', provider: 'abcllm', key: 'supa:review', transport: 'gateway', rank: 1 },
  { id: 'rdr-ai1-02', model: '[MLX] gpt-oss-120b', provider: 'abcllm', key: 'mlx:text', transport: 'gateway', rank: 1 },
  { id: 'rdr-ai1-03', model: 'sonnet', provider: 'claude-cli', key: 'connect:sonnet', transport: 'cli', rank: 2 },
] as const;
const tableAi2 = [
  { id: 'rdr-ai2-01', model: '[MLX] gpt-oss-120b', provider: 'abcllm', key: 'mlx:text', transport: 'gateway', rank: 1, vote: true },
  { id: 'rdr-ai2-02', model: '[m1] mlx-community--gemma-4-26b-a4b-it-4bit', provider: 'abcllm', key: 'm1:translation', transport: 'gateway', rank: 2, vote: false },
] as const;
/** 「작업 ↔ 모델」 순위(묶기가 끝난 심사자) — 1차 1·2순위, 2차 투표자 칸 1 의 1·2순위. 표·예전 설정과 겹치지 않는다. */
const RANKED = {
  first: [{ provider: 'abcllm', model: 'ranked-first' }, { provider: 'claude-cli', model: 'sonnet' }],
  second: [[{ provider: 'abcllm', model: 'ranked-voter' }, { provider: 'abcllm', model: 'ranked-backup' }]],
} as const;
const rankedFirst = RANKED.first.map(row => ({ ...row })), rankedVoter = { ...RANKED.second[0][0] }, rankedBackup = { ...RANKED.second[0][1] };

async function seed(rows: readonly { id: string; model: string; provider: string; key: string; transport: AssignmentTransport; rank: number; vote?: boolean }[],
  stage: 'ai1' | 'ai2', mode: 'live' | 'off' = 'live') {
  for (const row of rows) await db.insert(modelHelperAssignments).values({ assignmentId: row.id, stage, deviceId: DEVICE, model: row.model,
    shadowRouteId: `primary:${stage}`, liveRouteId: stage === 'ai1' ? 'crawl-agent-review' : 'second-review', liveProvider: row.provider,
    mode, evidenceKey: 'e'.repeat(64), updatedBy: 'fixture', registryKey: row.key, transport: row.transport, rank: row.rank, role: 'primary',
    vote: row.vote ?? false });
}
async function clean() {
  await db.delete(secondReviews);
  await db.delete(jobs);
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await db.delete(modelHelperAssignments).where(like(modelHelperAssignments.assignmentId, `${PREFIX}%`));
}
async function held(repo: string) {
  await crawl.putDocument({ repo, productUrl: `https://${repo.replace('/', '-')}.test`, pageStatus: 200,
    repoMeta: { description: '배포한 서비스', stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: 'User' } },
    pageMeta: { title: '제품', textSample: '쓸 수 있는 앱' } });
  await crawl.recordJudgement({ repo, productUrl: `https://${repo.replace('/', '-')}.test`, state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto' });
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  return candidate;
}
async function context(repo: string) {
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  const document = (await crawl.getDocument(repo))!, settings = await getSettings();
  return { candidate, document, settings, input: await loadReviewInput(candidate, document, settings) };
}
async function firstAttempt(repo: string, reviewer: { provider: string; model: string }, decision: 'approve' | 'reject' = 'reject') {
  const { candidate, input } = await context(repo);
  const [attempt] = await db.insert(crawlReviewAttempts).values({ candidateId: candidate.id, kind: 'automatic', state: 'succeeded', attemptNumber: 1,
    inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash, snapshot: input.snapshot, source: input.source,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, provider: reviewer.provider, model: reviewer.model,
    startedAt: new Date(), completedAt: new Date(), validUntil: input.validUntil,
    outcome: { decision, reason: '사유', evidenceIds: ['product'], confidence: 0.92 } }).returning();
  return attempt;
}

beforeAll(async () => {
  ensureSchema();
  const current = await readModelCapacityDevice(DEVICE);
  await db.transaction(tx => saveModelCapacityDevice(tx, { deviceId: DEVICE, limitSlots: 4, secondaryCap: 4, idleMs: 0, reserveSlots: 0, roles: [],
    physicalLimit: null, note: null }, current?.version ?? null, 'rdr-fixture'));
});
beforeEach(async () => {
  await clean();
  await saveSettings({ enabled: true, firstReview: { provider: 'abcllm', model: 'legacy-first' }, firstReviewAdditional: [],
    secondReview: { enabled: true, voters: [{ provider: 'claude-cli', model: 'opus' }], fallbacks: [{ provider: 'abcllm', model: 'legacy-backup' }],
      sampleRate: 0, agreeAt: 0.85 } }, 'fixture');
  await seed(tableAi1, 'ai1');
  await seed(tableAi2, 'ai2');
  await seed([{ id: 'rdr-ai1-off', model: 'off-model', provider: 'abcllm', key: 'supa:review', transport: 'direct', rank: 1 }], 'ai1', 'off');
  setStageAssignmentsForTest(null);
  setAssignmentTableEnabledForTest(true);
  await ensureStageAssignments(0);
  pinReviewRanks({ first: RANKED.first, second: RANKED.second });
});
afterEach(() => { setAssignmentTableEnabledForTest(null); setStageAssignmentsForTest(null); pinReviewRanks(null); });
afterAll(async () => {
  // 공유 runtime_settings 행의 토글을 기본값으로 되돌린다(다른 파일이 같은 행을 본다)
  await saveRuntimeSettings({ tableReads: null }, 'rdr-fixture', { group: 'assignments' });
  await clean();
  await db.execute(sql`DELETE FROM model_capacity_devices WHERE device_id = ${DEVICE}`);
});

it('loads the live primary rows from the DB but serves the task ranks — not the table — as the AI1 pool and AI2 voters (PR C1)', async () => {
  // 표 읽기는 켜져 있고 쓸 수 있는 ai1·ai2 행이 있지만, 1차·2차는 그 행을 쓸 수 있는 행으로 세지 않는다
  expect(assignmentSource('ai1')).toBe('legacy_empty_table');
  expect(assignmentSource('ai2')).toBe('legacy_empty_table');
  expect(assignmentSource('tagline')).toBe('legacy_empty_table');
  const settings = await getSettings();
  expect(firstReviewers(settings)).toEqual(rankedFirst);                                  // no table row, no off row, no legacy-first
  expect(secondReviewVoters(settings)).toEqual([rankedVoter]);                            // not the table's '[MLX] gpt-oss-120b', not settings' opus
  expect(secondReviewFallbacks(settings)).toEqual([rankedBackup]);                        // not the table's rank 2, not settings' legacy-backup
  // the switch is per process and changes nothing for AI1/AI2
  setAssignmentTableEnabledForTest(false);
  expect(assignmentSource('ai1')).toBe('legacy');
  expect(firstReviewers(settings)).toEqual(rankedFirst);
  expect(secondReviewVoters(settings)).toEqual([rankedVoter]);
});

it('chooses AI1 reviewers by rank — rank 1 for every candidate, rank 2 only when rank 1 is blocked — and never a table row', async () => {
  const repos = ['rdr/one', 'rdr/two', 'rdr/three', 'rdr/four'];
  for (const repo of repos) await held(repo);
  // 예전 표의 (id − 1) mod n 나눔은 없다 — 모든 후보가 쓸 수 있는 가장 높은 순위로 간다
  for (const repo of repos) expect((await chooseFirstReviewForCandidate(await context(repo)))?.model).toBe('ranked-first');
  const blocked = new Set([firstReviewerKey(rankedFirst[0])]);
  expect((await chooseFirstReviewForCandidate(await context('rdr/one'), undefined, blocked))?.model).toBe('sonnet');
  // a finished attempt does not pin the candidate to its model: the open top rank serves it
  await firstAttempt('rdr/two', { provider: 'claude-cli', model: 'sonnet' });
  expect((await chooseFirstReviewForCandidate(await context('rdr/two')))?.model).toBe('ranked-first');
  // a settled attempt of a table model (never a current first reviewer) takes the top rank; a running one stays protected
  await db.update(crawlReviewAttempts).set({ provider: 'abcllm', model: tableAi1[0].model }).where(sql`true`);
  expect((await chooseFirstReviewForCandidate(await context('rdr/two')))?.model).toBe('ranked-first');
  await db.update(crawlReviewAttempts).set({ state: 'running', completedAt: null }).where(sql`true`);
  expect(await chooseFirstReviewForCandidate(await context('rdr/two'))).toBeNull();
  // a running call of a ranked model keeps its model even while a higher rank is open
  await db.update(crawlReviewAttempts).set({ provider: 'claude-cli', model: 'sonnet' }).where(sql`true`);
  expect((await chooseFirstReviewForCandidate(await context('rdr/two')))?.model).toBe('sonnet');
});

it('enqueues, validates, records and replaces AI2 votes from the ranks while the table holds other AI2 rows', async () => {
  await held('rdr/held');
  await firstAttempt('rdr/held', rankedFirst[0]);
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  const [vote] = await db.select().from(secondReviews);
  expect(vote).toMatchObject({ ...rankedVoter, status: 'pending', trigger: 'ai_decided' });
  expect(await loadSecondReviewInput(vote)).not.toBeNull();
  // a transient failure moves the vote to the same slot's rank 2 (not the table's rank-2 row, not the settings fallback)
  await recordSecondReviewFixture(vote.id, { ok: false, error: 'timeout', ...rankedVoter });
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
  expect(rows.map(row => [row.model, row.status, row.resolution, row.fallbackForId])).toEqual([
    ['ranked-voter', 'resolved', 'fallback', null], ['ranked-backup', 'pending', null, vote.id]]);
  expect(await loadSecondReviewInput(rows[1])).not.toBeNull();
  // the cleanup controller keeps rank votes …
  await closeSettledSecondReviews();
  expect((await db.select().from(secondReviews).orderBy(secondReviews.id)).map(row => row.status)).toEqual(['resolved', 'pending']);
  // … and the fallback records like any vote
  await recordSecondReviewFixture(rows[1].id, { ok: true, decision: 'reject', confidence: 0.9, reason: '두 번째 판단', ...rankedBackup, status: 'agreed' });
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, rows[1].id)))[0].status).toBe('agreed');
  // the table switch does not touch AI2: with it off the same rows are still current voters
  setAssignmentTableEnabledForTest(false);
  expect(await loadSecondReviewInput(vote)).not.toBeNull();
});

it('does not defer AI2 work on an unread assignment table — AI2 no longer reads the table, the ranks decide', async () => {
  await held('rdr/unread');
  await firstAttempt('rdr/unread', rankedFirst[0]);
  setStageAssignmentsForTest(null);
  const url = process.env.DATABASE_URL;
  process.env.DATABASE_URL = '';
  try {
    expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  } finally { process.env.DATABASE_URL = url; }
  expect((await db.select().from(secondReviews)).map(row => [row.provider, row.model])).toEqual([[rankedVoter.provider, rankedVoter.model]]);
});

it('keeps the AI1 selection and the AI2 voters on the ranks whichever way the saved runtime_settings toggle points — no env, no restart (PR 3b-E, PR C1)', async () => {
  setAssignmentTableEnabledForTest(null);
  process.env.MODEL_ASSIGNMENT_TABLE = '';
  // 토글 꺼짐(기본): 순위로 고른다
  expect(await saveRuntimeSettings({ tableReads: 'off' }, 'rdr-fixture', { group: 'assignments' })).toMatchObject({ ok: true });
  await ensureStageAssignments(0);
  expect(assignmentFlag()).toEqual({ enabled: false, source: 'runtime', override: null });
  expect(assignmentSource('ai1')).toBe('legacy');
  const settings = await getSettings();
  expect(firstReviewers(settings)).toEqual(rankedFirst);
  await held('rdr/toggle');
  expect((await chooseFirstReviewForCandidate(await context('rdr/toggle')))?.model).toBe('ranked-first');
  // 관리자가 켠다 → 다음 30초 스냅숏(여기서는 maxAge 0)부터 표를 읽는 단계는 바뀌지만, 1차·2차는 그 단계가 아니다
  expect(await saveRuntimeSettings({ tableReads: 'on' }, 'rdr-fixture', { group: 'assignments' })).toMatchObject({ ok: true });
  expect(assignmentSource('ai1')).toBe('legacy');                                   // 아직 이 프로세스의 스냅숏은 옛 판
  await ensureStageAssignments(0);
  expect(assignmentFlag()).toEqual({ enabled: true, source: 'runtime', override: null });
  expect(assignmentSource('ai1')).toBe('legacy_empty_table');
  expect(assignmentSource('ai2')).toBe('legacy_empty_table');
  expect(firstReviewers(settings)).toEqual(rankedFirst);
  expect(secondReviewVoters(settings)).toEqual([rankedVoter]);
  expect((await chooseFirstReviewForCandidate(await context('rdr/toggle')))?.model).toBe('ranked-first');
  await expect(requireStageAssignments()).resolves.toBeUndefined();
  // 끄면 같은 길로 돌아가고 1차는 여전히 순위다
  expect(await saveRuntimeSettings({ tableReads: 'off' }, 'rdr-fixture', { group: 'assignments' })).toMatchObject({ ok: true });
  await ensureRuntimeSettings(0);
  expect(assignmentFlag().enabled).toBe(false);
  expect(firstReviewers(settings)).toEqual(rankedFirst);
  expect((await chooseFirstReviewForCandidate(await context('rdr/toggle')))?.model).toBe('ranked-first');
});
