import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, secondReviews, jobs, agentRepositoryScans, products, cdnPurges } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { closeSettledSecondReviews, enqueueSecondReviews, pendingSecondReviews, publishedInputHash, publishedSecondReviews, recentSecondReviewFailures,
  recordSecondReview, reopenOrphanedGateHolds, resolveSecondReviews, retryFailedSecondReviews, secondReviewSummary, secondReviewsFor, TRANSIENT_RETRY_MS } from '@/lib/crawl/second-review';
import { REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from '@/lib/crawl/agent-review-contract';
import { ensureSchema } from './setup';
import { randomUUID } from 'node:crypto';
import { withLegacySecondReviewJob, admitSecondReviewFixture, recordSecondReviewFixture } from './second-review-receipt-fixtures';

const productSlug = (name: string) => `pr04b-second-${name}`;
async function cleanFixtureProducts() {
  await db.delete(products).where(like(products.slug, 'pr04b-second-%'));
  await db.delete(cdnPurges).where(like(cdnPurges.slug, 'pr04b-second-%'));
}
beforeAll(() => ensureSchema());
afterAll(cleanFixtureProducts);
beforeEach(async () => {
  await cleanFixtureProducts();
  await db.delete(secondReviews);
  await db.delete(jobs);
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  // 표본은 0 — 무작위로 뽑힌 것이 결과를 흔들지 않게 한다
  await saveSettings({ enabled: true, secondReview: { enabled: true, voters: [{ provider: 'claude-cli', model: 'opus' }], sampleRate: 0, agreeAt: 0.85 } }, 'fixture');
});

async function held(repo: string, title = '제품') {
  await crawl.putDocument({
    repo, productUrl: `https://pr04b-second-${repo.split('/')[1]}.test`, pageStatus: 200,
    repoMeta: { description: '배포한 서비스', stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: 'User' } },
    pageMeta: { title, textSample: '쓸 수 있는 앱' },
  });
  await crawl.recordJudgement({ repo, productUrl: `https://pr04b-second-${repo.split('/')[1]}.test`, state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto' });
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  return candidate;
}

/** 1차 AI 판단 하나 */
/** confidence 가 null 이면 확신을 내지 않던 옛 프롬프트의 판단이다 */
async function firstReview(repo: string, decision: 'approve' | 'reject' | 'needs_review', confidence: number | null = 0.9, inputHash?: string) {
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  const input = await loadReviewInput(candidate, (await crawl.getDocument(repo))!, await getSettings());
  const [attempt] = await db.insert(crawlReviewAttempts).values({
    candidateId: candidate.id, kind: 'automatic', state: 'succeeded', attemptNumber: 1,
    inputHash: inputHash ?? input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash,
    snapshot: input.snapshot, source: input.source, promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION,
    provider: 'claude-cli', model: 'sonnet', startedAt: new Date(), completedAt: new Date(), validUntil: input.validUntil,
    outcome: confidence === null ? { decision, reason: '사유', evidenceIds: ['product'] } : { decision, reason: '사유', evidenceIds: ['product'], confidence },
  }).returning();
  return attempt;
}

/** 규칙만 통과해 방금 공개된 제품 */
async function published(repo: string, title: string) {
  const candidate = await held(repo, title);
  const slug = productSlug(repo.split('/')[1]);
  await db.insert(products).values({ slug, url: candidate.productUrl!, repoUrl: `https://github.com/${repo}`,
    name: title, tagline: '제품', description: '배포된 제품', category: 'Dev', status: 'seeded', source: 'crawler',
    verifyToken: randomUUID(), editTokenHash: 'a'.repeat(64) });
  await db.update(crawlCandidates).set({ state: 'published', publishedSlug: slug, decidedAt: new Date() })
    .where(eq(crawlCandidates.id, candidate.id));
  return candidate;
}

it('AI 1차가 가른 보류 후보와 위험 신호가 있는 공개분을 올린다 — 한 번씩만', async () => {
  await held('pr04b-second/rejected');
  await held('pr04b-second/unsure');
  await held('pr04b-second/untouched');
  await firstReview('pr04b-second/rejected', 'reject', 0.92);
  await firstReview('pr04b-second/unsure', 'needs_review');
  await published('pr04b-second/sentence', 'the quick way to plan all of your week with friends');
  await published('pr04b-second/plain', 'Plain');

  expect(await enqueueSecondReviews(await getSettings())).toBe(2);
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.repo);
  expect(rows.map((row) => [row.repo, row.trigger, row.firstDecision, row.status])).toEqual([
    ['pr04b-second/rejected', 'ai_decided', 'reject', 'pending'],
    ['pr04b-second/sentence', 'risk', 'approve', 'pending'],
  ]);
  expect(rows[0].firstConfidence).toBeCloseTo(0.92);
  expect(rows[1].signals).toEqual(['sentence_name']);
  expect(rows[1].publishedSlug).toBe(productSlug('sentence'));
  expect(rows[1].inputHash).toBe(publishedInputHash(productSlug('sentence')));

  // 같은 입력은 다시 올리지 않는다
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);
});

it('accepts a current Grok first judgement for a held candidate without losing upstream agreement', async () => {
  await saveSettings({ firstReview: { provider: 'grok-cli', model: 'grok-fixture' } }, 'test');
  await held('pr04b-second/grok-held');
  await firstReview('pr04b-second/grok-held', 'reject');
  await db.update(crawlReviewAttempts).set({ provider: 'grok-cli', model: 'grok-fixture' });
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  const [vote] = await pendingSecondReviews(10);
  const { loadSecondReviewInput } = await import('@/lib/crawl/second-review-input');
  expect(await loadSecondReviewInput(vote)).not.toBeNull();
  await db.update(crawlReviewAttempts).set({ sourceRevisionHash: 'stale' });
  expect(await loadSecondReviewInput(vote)).toBeNull();
});

it('사람이 이미 결정했거나 공개분이 내려가면 닫는다 — 지우지 않는다', async () => {
  const decided = await held('pr04b-second/decided');
  await firstReview('pr04b-second/decided', 'reject');
  const gone = await published('pr04b-second/gone', 'the quick way to plan all of your week with friends');
  await held('pr04b-second/open');
  await firstReview('pr04b-second/open', 'approve');
  await enqueueSecondReviews(await getSettings());

  await db.update(crawlCandidates).set({ state: 'rejected', decidedBy: 'admin' }).where(eq(crawlCandidates.id, decided.id));
  await db.update(crawlCandidates).set({ state: 'rejected' }).where(eq(crawlCandidates.id, gone.id));

  expect(await closeSettledSecondReviews()).toBe(2);
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.repo);
  expect(rows.map((row) => [row.repo, row.status, row.resolution])).toEqual([
    ['pr04b-second/decided', 'resolved', 'decided_elsewhere'],
    ['pr04b-second/gone', 'resolved', 'decided_elsewhere'],
    ['pr04b-second/open', 'pending', null],
  ]);
});

it('사람을 기다리는 열린 행이 1,000건을 넘어도 그 뒤에서 결정된 관문 행을 닫는다', async () => {
  // 갈림 보류로 사람을 기다리는 후보 — 행이 오래 열려 있어야 한다
  const waiting = await held('pr04b-second/waiting');
  await db.update(crawlCandidates).set({ reason: 'second_review_split' }).where(eq(crawlCandidates.id, waiting.id));
  const gate = { trigger: 'ai_approved' as const, firstDecision: 'approve', firstConfidence: 0.9, provider: 'claude-cli' as const, model: 'opus' };
  await db.insert(secondReviews).values(Array.from({ length: 1_000 }, (_, index) => ({ ...gate,
    candidateId: waiting.id, repo: waiting.repo, inputHash: `waiting-${index}`, generationKey: `g-${index}`,
    status: 'needs_human' as const, secondDecision: 'reject' })));
  // 그 뒤에 올라와 두 표가 일치했고, 이미 발행된 후보
  const done = await published('pr04b-second/done', '제품');
  await db.insert(secondReviews).values({ ...gate, candidateId: done.id, repo: done.repo, inputHash: 'done',
    generationKey: 'g-done', status: 'agreed', secondDecision: 'approve' });

  expect(await closeSettledSecondReviews()).toBe(1);
  const [closed] = await db.select().from(secondReviews).where(eq(secondReviews.candidateId, done.id));
  expect(closed).toMatchObject({ status: 'resolved', resolution: 'decided_elsewhere' });
  expect((await secondReviewSummary(0.85)).ids.agreed_approve).toEqual([]);
});

it('does not reopen failed votes after the reviewer job token is revoked', async () => {
  await held('pr04b-second/late-vote');
  await firstReview('pr04b-second/late-vote', 'approve');
  await enqueueSecondReviews(await getSettings());
  await db.update(secondReviews).set({ status: 'failed', reviewedAt: new Date('2026-01-01'),
    errorCode: 'timeout', failureCount: 1 });
  const lease = { name: 'second-review', token: 'old-reviewer', requestedVersion: 1 };
  await db.insert(jobs).values({ name: lease.name, lockedAt: sql`now()`, requestedVersion: 1 });
  await expect(retryFailedSecondReviews(new Date(), lease)).rejects.toThrow('job_lease_lost');
  expect((await db.select().from(secondReviews))[0].status).toBe('failed');
});

it('일치·엇갈림·공개분을 따로 세고, 심사 화면이 후보 id 로 거른다', async () => {
  const agreedReject = await held('pr04b-second/agreed-reject');
  const agreedApprove = await held('pr04b-second/agreed-approve');
  const split = await held('pr04b-second/split');
  await firstReview('pr04b-second/agreed-reject', 'reject');
  await firstReview('pr04b-second/agreed-approve', 'approve');
  await firstReview('pr04b-second/split', 'reject');
  await published('pr04b-second/sentence', 'the quick way to plan all of your week with friends');
  await enqueueSecondReviews(await getSettings());

  const byRepo = new Map((await pendingSecondReviews(10)).map((row) => [row.repo, row.id]));
  const ok = (decision: string, status: 'agreed' | 'needs_human') => ({ ok: true as const, decision, confidence: 0.9, reason: '두 번째 판단', model: 'opus', provider: 'claude-cli' as const, status });
  await recordSecondReviewFixture(byRepo.get('pr04b-second/agreed-reject')!, ok('reject', 'agreed'));
  await recordSecondReviewFixture(byRepo.get('pr04b-second/agreed-approve')!, ok('approve', 'agreed'));
  await recordSecondReviewFixture(byRepo.get('pr04b-second/split')!, ok('approve', 'needs_human'));
  await recordSecondReviewFixture(byRepo.get('pr04b-second/sentence')!, ok('reject', 'needs_human'));

  const { counts, ids } = await secondReviewSummary(0.85);
  expect(counts).toEqual({ unanimousReject: 0, unanimousApprove: 0, agreedReject: 1, agreedApprove: 1, needsHuman: 1, published: 1, pending: 0 });
  expect(ids).toEqual({ unanimous_reject: [], unanimous_approve: [], agreed_reject: [agreedReject.id], agreed_approve: [agreedApprove.id], needs_human: [split.id] });

  // 심사 상세에는 1차와 나란히 2차가 보인다
  const [detail] = await secondReviewsFor([split.id]);
  expect(detail).toMatchObject({ secondDecision: 'approve', model: 'opus', status: 'needs_human' });
});

it('80자 slug 도 올라간다', async () => {
  const slug = 'x'.repeat(80);
  const candidate = await published('pr04b-second/long', 'the quick way to plan all of your week with friends');
  await db.update(crawlCandidates).set({ publishedSlug: slug }).where(eq(crawlCandidates.id, candidate.id));
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
});

it('공개분을 2차도 제품이라 보면 끝난 기록으로 남고 닫는 대상에 들지 않는다', async () => {
  await published('pr04b-second/sentence', 'the quick way to plan all of your week with friends');
  await enqueueSecondReviews(await getSettings());
  const [pending] = await pendingSecondReviews(1);
  await recordSecondReviewFixture(pending.id, { ok: true, decision: 'approve', confidence: 0.9, reason: '쓸 수 있는 앱', model: 'opus', provider: 'claude-cli', status: 'agreed' });

  expect(await closeSettledSecondReviews()).toBe(0);
  expect((await secondReviewSummary(0.85)).counts).toMatchObject({ published: 0, agreedApprove: 0 });
  expect((await db.select().from(secondReviews))[0].status).toBe('agreed');
});

it('공개분은 사람이 내리거나 유지하기로 정할 때까지 남는다', async () => {
  await published('pr04b-second/sentence', 'the quick way to plan all of your week with friends');
  await enqueueSecondReviews(await getSettings());
  const [pending] = await pendingSecondReviews(1);
  await recordSecondReviewFixture(pending.id, { ok: true, decision: 'reject', confidence: 0.9, reason: '문장이 이름이 됐다', model: 'opus', provider: 'claude-cli', status: 'needs_human' });

  const rows = await publishedSecondReviews();
  expect(rows.map((row) => [row.publishedSlug, row.secondReason])).toEqual([[productSlug('sentence'), '문장이 이름이 됐다']]);

  expect(await resolveSecondReviews([pending.id], 'kept', 'admin@test')).toBe(1);
  // 이미 끝낸 것을 다시 끝내지 않는다
  expect(await resolveSecondReviews([pending.id], 'banned', 'admin@test')).toBe(0);
  const [row] = await db.select().from(secondReviews);
  expect(row).toMatchObject({ status: 'resolved', resolution: 'kept', resolvedBy: 'admin@test' });
  expect(await publishedSecondReviews()).toEqual([]);
});

it('실패한 호출은 기록만 남기고 판단을 지어내지 않는다', async () => {
  await held('pr04b-second/flaky');
  await firstReview('pr04b-second/flaky', 'reject');
  await enqueueSecondReviews(await getSettings());
  const [pending] = await pendingSecondReviews(1);
  await recordSecondReviewFixture(pending.id, { ok: false, error: 'rate_limited', model: 'opus', provider: 'claude-cli' });

  const [row] = await db.select().from(secondReviews);
  expect(row).toMatchObject({ status: 'failed', errorCode: 'rate_limited', secondDecision: null });
  // 실패는 아직 끝나지 않은 표다 — 한 시간 뒤 다시 보므로 확정 칩이 아니라 대기로 센다
  expect((await secondReviewSummary(0.85)).counts).toEqual({ unanimousReject: 0, unanimousApprove: 0, agreedReject: 0, agreedApprove: 0, needsHuman: 0, published: 0, pending: 1 });
});

it('실패한 것은 때가 되어야 다시 대기로 돌린다', async () => {
  await held('pr04b-second/old-fail');
  await held('pr04b-second/new-fail');
  await firstReview('pr04b-second/old-fail', 'reject');
  await firstReview('pr04b-second/new-fail', 'reject');
  await enqueueSecondReviews(await getSettings());
  const byRepo = new Map((await pendingSecondReviews(10)).map((row) => [row.repo, row.id]));
  const now = new Date();
  await recordSecondReviewFixture(byRepo.get('pr04b-second/old-fail')!, { ok: false, error: 'timeout', model: 'opus', provider: 'claude-cli' }, new Date(now.getTime() - 2 * 3600_000));
  // 시간 초과는 5분이면 다시 보므로, 아직 때가 안 된 것은 2분 전 것으로 둔다
  await recordSecondReviewFixture(byRepo.get('pr04b-second/new-fail')!, { ok: false, error: 'timeout', model: 'opus', provider: 'claude-cli' }, new Date(now.getTime() - 2 * 60_000));

  // 2026-09-11 프로드: 이 쿼리가 Date 를 문자열로 넘겨 매 틱 실패했다
  await retryFailedSecondReviews(now);

  const rows = await db.select().from(secondReviews).orderBy(secondReviews.repo);
  expect(rows.map((row) => [row.repo, row.status])).toEqual([['pr04b-second/new-fail', 'failed'], ['pr04b-second/old-fail', 'pending']]);
});

it('확신을 내지 않던 옛 1차 판단은 올리지 않고, 이미 올린 것은 닫는다 — 2차 의견은 상세에 남는다', async () => {
  const legacy = await held('pr04b-second/legacy');
  await held('pr04b-second/fresh');
  await firstReview('pr04b-second/legacy', 'reject', null);
  await firstReview('pr04b-second/fresh', 'reject', 0.9);

  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  expect((await db.select().from(secondReviews)).map((row) => row.repo)).toEqual(['pr04b-second/fresh']);

  // 배포 직후 프로드처럼, 옛 1차로 이미 올라가 2차까지 받은 것
  await db.insert(secondReviews).values({ candidateId: legacy.id, repo: 'pr04b-second/legacy', trigger: 'ai_decided', firstDecision: 'reject',
    firstConfidence: null, inputHash: 'legacy', status: 'needs_human', secondDecision: 'reject', secondConfidence: 0.88, model: 'opus' });
  expect(await closeSettledSecondReviews()).toBe(1);
  const [closed] = await db.select().from(secondReviews).where(eq(secondReviews.repo, 'pr04b-second/legacy'));
  expect(closed).toMatchObject({ status: 'resolved', resolution: 'no_first_confidence' });
  expect((await secondReviewSummary(0.85)).counts.needsHuman).toBe(0);
  expect(await secondReviewsFor([legacy.id])).toEqual([expect.objectContaining({ secondDecision: 'reject', status: 'resolved' })]);
});

it('같은 후보에 새 1차 판단이 오면 앞의 것을 닫는다 — 두 칩에 겹쳐 세지 않는다', async () => {
  await held('pr04b-second/changing');
  const firstAttempt = await firstReview('pr04b-second/changing', 'reject');
  await enqueueSecondReviews(await getSettings());
  const [first] = await pendingSecondReviews(1);
  await recordSecondReviewFixture(first.id, { ok: true, decision: 'approve', confidence: 0.9, reason: '엇갈림', model: 'opus', provider: 'claude-cli', status: 'needs_human' });

  // 원본이 바뀌어 1차가 다시 봤다
  await db.update(crawlDocuments).set({ pageMeta: { title: '새 원본', textSample: '새로운 제품' } }).where(eq(crawlDocuments.repo, 'pr04b-second/changing'));
  const secondAttempt = await firstReview('pr04b-second/changing', 'approve', 0.92);
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);

  const rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
  expect(rows.map((row) => [row.inputHash, row.status, row.resolution])).toEqual([
    [firstAttempt.inputHash, 'resolved', 'superseded'],
    [secondAttempt.inputHash, 'pending', null],
  ]);
  expect((await secondReviewSummary(0.85)).counts).toMatchObject({ needsHuman: 0, pending: 1 });
});

it('누가 볼지를 올릴 때 적고, 같은 모델로는 다시 올리지 않는다', async () => {
  await held('pr04b-second/voter');
  await firstReview('pr04b-second/voter', 'reject');
  await saveSettings({ secondReview: { enabled: true, voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }], sampleRate: 0, agreeAt: 0.85 } }, 'fixture');

  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);
  expect(await pendingSecondReviews(10)).toMatchObject([{ provider: 'abcllm', model: '[MLX] gemma4-26b' }]);
});

it('모델을 바꾸면 기존 후보와 새 후보 모두 새 모델의 표를 받는다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }] } }, 'fixture');
  await held('pr04b-second/before-swap');
  await firstReview('pr04b-second/before-swap', 'reject');
  await enqueueSecondReviews(await getSettings());

  // 모델을 갈아 끼운다 — 표 수는 그대로 하나다
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gpt-oss-120b' }] } }, 'fixture');
  await held('pr04b-second/after-swap');
  await firstReview('pr04b-second/after-swap', 'reject');
  expect(await enqueueSecondReviews(await getSettings())).toBe(2);

  const rows = await db.select().from(secondReviews);
  expect(rows.map((row) => [row.repo, row.model]).sort())
    .toEqual([['pr04b-second/after-swap', '[MLX] gpt-oss-120b'], ['pr04b-second/before-swap', '[MLX] gemma4-26b'], ['pr04b-second/before-swap', '[MLX] gpt-oss-120b']]);
});

it('실패는 모델·까닭별로 세어 운영 화면에 드러난다', async () => {
  await held('pr04b-second/gone-a');
  await held('pr04b-second/gone-b');
  await firstReview('pr04b-second/gone-a', 'reject');
  await firstReview('pr04b-second/gone-b', 'approve');
  await saveSettings({ secondReview: { enabled: true, voters: [{ provider: 'abcllm', model: '[MLX] 사라진모델' }], sampleRate: 0, agreeAt: 0.85 } }, 'fixture');
  await enqueueSecondReviews(await getSettings());
  const ids = (await pendingSecondReviews(10)).map((row) => row.id);
  for (const id of ids) await recordSecondReviewFixture(id, { ok: false, error: 'model_unavailable', model: '[MLX] 사라진모델', provider: 'abcllm' });

  expect(await recentSecondReviewFailures()).toEqual([
    { provider: 'abcllm', model: '[MLX] 사라진모델', errorCode: 'model_unavailable', count: 2 },
  ]);
  // 하루가 지난 실패는 지금 문제가 아니다
  expect(await recentSecondReviewFailures(new Date(Date.now() + 25 * 3600_000))).toEqual([]);
});

it('표 여럿을 세우면 후보마다 모델 수만큼 올라가고, 모두 같으면 만장일치로 묶인다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }, { provider: 'abcllm', model: '[MLX] gpt-oss-120b' }] } }, 'fixture');
  const unanimous = await held('pr04b-second/unanimous');
  const split = await held('pr04b-second/split-votes');
  await firstReview('pr04b-second/unanimous', 'reject');
  await firstReview('pr04b-second/split-votes', 'reject');

  expect(await enqueueSecondReviews(await getSettings())).toBe(4);
  const rows = await pendingSecondReviews(10);
  const record = (repo: string, model: string, decision: string) => {
    const row = rows.find((item) => item.repo === repo && item.model === model)!;
    return recordSecondReviewFixture(row.id, { ok: true, decision, confidence: 0.9, reason: '두 번째 판단', model, provider: 'abcllm',
      status: decision === 'reject' ? 'agreed' : 'needs_human' });
  };
  await record('pr04b-second/unanimous', '[MLX] gemma4-26b', 'reject');
  await record('pr04b-second/unanimous', '[MLX] gpt-oss-120b', 'reject');
  await record('pr04b-second/split-votes', '[MLX] gemma4-26b', 'reject');
  await record('pr04b-second/split-votes', '[MLX] gpt-oss-120b', 'approve');

  const { counts, ids } = await secondReviewSummary(0.85);
  // 1차 + 두 표가 모두 거부 → 만장일치. 한 표라도 엇갈리면 사람에게
  expect(ids.unanimous_reject).toEqual([unanimous.id]);
  expect(ids.needs_human).toEqual([split.id]);
  expect(counts).toMatchObject({ unanimousReject: 1, agreedReject: 0, needsHuman: 1, pending: 0 });

  // 상세에는 모델마다 한 줄로 남는다
  expect((await secondReviewsFor([unanimous.id])).map((row) => row.model).sort())
    .toEqual(['[MLX] gemma4-26b', '[MLX] gpt-oss-120b']);
});

it('한 표만 보고 나머지가 남았으면 아직 기다린다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }, { provider: 'abcllm', model: '[MLX] gpt-oss-120b' }] } }, 'fixture');
  await held('pr04b-second/half');
  await firstReview('pr04b-second/half', 'reject');
  await enqueueSecondReviews(await getSettings());
  const [first] = await pendingSecondReviews(10);
  await recordSecondReviewFixture(first.id, { ok: true, decision: 'reject', confidence: 0.9, reason: '두 번째 판단',
    model: first.model!, provider: 'abcllm', status: 'agreed' });

  const { counts } = await secondReviewSummary(0.85);
  expect(counts).toMatchObject({ pending: 1, unanimousReject: 0, agreedReject: 0, needsHuman: 0 });
});

it('모델을 하나 더 세워도 먼저 세운 모델의 표가 닫히지 않는다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }] } }, 'fixture');
  await held('pr04b-second/added-voter');
  await firstReview('pr04b-second/added-voter', 'reject');
  await enqueueSecondReviews(await getSettings());

  // 두 번째 모델을 더한다 — 같은 입력이라 먼저 올린 표는 그대로 있어야 한다
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }, { provider: 'abcllm', model: '[MLX] gemma4-31b' }] } }, 'fixture');
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);

  const rows = await db.select().from(secondReviews).where(eq(secondReviews.repo, 'pr04b-second/added-voter'));
  expect(rows.map((row) => [row.model, row.status]).sort())
    .toEqual([['[MLX] gemma4-26b', 'pending'], ['[MLX] gemma4-31b', 'pending']]);
  expect(rows.some((row) => row.resolution === 'superseded')).toBe(false);
});

it('1차 판단이 새로 오면(입력이 바뀌면) 앞선 표는 닫는다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }] } }, 'fixture');
  await held('pr04b-second/new-input');
  await firstReview('pr04b-second/new-input', 'reject');
  await enqueueSecondReviews(await getSettings());
  // 입력이 달라진 새 1차 판단
  await firstReview('pr04b-second/new-input', 'approve', 0.95, 'b'.repeat(64));
  await enqueueSecondReviews(await getSettings());

  const rows = await db.select().from(secondReviews).where(eq(secondReviews.repo, 'pr04b-second/new-input'));
  expect(rows).toHaveLength(2);
  expect(rows.filter((row) => row.resolution === 'superseded')).toHaveLength(1);
  expect((await pendingSecondReviews(10)).map((row) => row.firstDecision)).toEqual(['approve']);
});

it('실패한 표가 남아 있으면 확정 칩에 올리지 않는다 — 한 시간 뒤 다시 보고 뒤집을 수 있다', async () => {
  const voters = [{ provider: 'abcllm' as const, model: '[MLX] gemma4-26b' }, { provider: 'abcllm' as const, model: '[MLX] gemma4-31b' }];
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85, voters } }, 'fixture');
  await held('pr04b-second/one-failed');
  await firstReview('pr04b-second/one-failed', 'reject');
  await enqueueSecondReviews(await getSettings());
  const rows = await pendingSecondReviews(10);
  await recordSecondReviewFixture(rows[0].id, { ok: true, decision: 'reject', confidence: 0.9, reason: '문서', model: rows[0].model!, provider: 'abcllm', status: 'agreed' });
  await recordSecondReviewFixture(rows[1].id, { ok: false, error: 'model_unavailable', model: rows[1].model!, provider: 'abcllm' });

  const { counts } = await secondReviewSummary(0.85);
  expect(counts).toMatchObject({ pending: 1, agreedReject: 0, unanimousReject: 0, needsHuman: 0 });
});

it('표가 모두 실패해도 집계에서 사라지지 않는다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] 사라진모델' }] } }, 'fixture');
  await held('pr04b-second/all-failed');
  await firstReview('pr04b-second/all-failed', 'reject');
  await enqueueSecondReviews(await getSettings());
  const [row] = await pendingSecondReviews(10);
  await recordSecondReviewFixture(row.id, { ok: false, error: 'model_unavailable', model: row.model!, provider: 'abcllm' });

  expect((await secondReviewSummary(0.85)).counts).toMatchObject({ pending: 1 });
});

it('모델을 여럿 세워도 공개분 표본이 대기 후보에 밀리지 않는다', async () => {
  const voters = [{ provider: 'abcllm' as const, model: '[MLX] a' }, { provider: 'abcllm' as const, model: '[MLX] b' }];
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85, voters } }, 'fixture');
  // 대기 후보를 상한 넘게 쌓아 둔다
  for (let index = 0; index < 55; index += 1) {
    await held(`pr04b-second/queued-${index}`);
    await firstReview(`pr04b-second/queued-${index}`, 'reject');
  }
  // 위험 신호가 있는 공개분 — 문장을 이름으로 가져온 것
  await published('pr04b-second/fresh-publish', 'the quick way to plan all of your week with friends');

  await enqueueSecondReviews(await getSettings());
  const rows = await db.select().from(secondReviews).where(eq(secondReviews.repo, 'pr04b-second/fresh-publish'));
  expect(rows).toHaveLength(2);
});

it('1차가 보류한 것은 설정을 켤 때만 올라가고, 확신이 없다고 닫히지 않는다', async () => {
  const voters = [{ provider: 'abcllm' as const, model: '[MLX] gemma4-26b' }, { provider: 'abcllm' as const, model: '[MLX] gemma4-31b' }];
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85, voters, includeAiHeld: false } }, 'fixture');
  const candidate = await held('pr04b-second/ai-held');
  await firstReview('pr04b-second/ai-held', 'needs_review', null);

  // 꺼 두면 올리지 않는다 — 1차가 가른 것만 본다
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);

  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85, voters, includeAiHeld: true } }, 'fixture');
  expect(await enqueueSecondReviews(await getSettings())).toBe(2);
  // 확신 없는 옛 1차를 닫는 규칙에 걸리면 안 된다 — 이 갈래는 애초에 확신을 재지 않는다
  await closeSettledSecondReviews();
  const rows = await pendingSecondReviews(10);
  expect(rows.map((row) => row.trigger)).toEqual(['ai_held', 'ai_held']);

  // 1차의 명시적 보류는 다른 두 모델이 같아도 사람 확인으로 남긴다
  for (const row of rows) {
    await recordSecondReviewFixture(row.id, { ok: true, decision: 'reject', confidence: 0.9, reason: '문서 사이트',
      model: row.model!, provider: 'abcllm', status: 'needs_human' });
  }
  const { ids } = await secondReviewSummary(0.85);
  expect(ids.needs_human).toEqual([candidate.id]);
  expect(ids.agreed_reject).toEqual([]);
});

it('잠깐 막힌 실패는 5분 뒤 다시 보고, 그렇지 않은 실패는 한 시간을 기다린다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }] } }, 'fixture');
  await held('pr04b-second/timed-out');
  await held('pr04b-second/bad-json');
  await firstReview('pr04b-second/timed-out', 'reject');
  await firstReview('pr04b-second/bad-json', 'reject');
  await enqueueSecondReviews(await getSettings());
  const rows = await pendingSecondReviews(10);
  const byRepo = new Map(rows.map((row) => [row.repo, row]));
  await recordSecondReviewFixture(byRepo.get('pr04b-second/timed-out')!.id, { ok: false, error: 'timeout', model: '[MLX] gemma4-26b', provider: 'abcllm' });
  await recordSecondReviewFixture(byRepo.get('pr04b-second/bad-json')!.id, { ok: false, error: 'invalid_output', model: '[MLX] gemma4-26b', provider: 'abcllm' });

  // 5분 뒤 — 시간 초과만 돌아온다
  await retryFailedSecondReviews(new Date(Date.now() + TRANSIENT_RETRY_MS + 1_000));
  expect((await pendingSecondReviews(10)).map((row) => row.repo)).toEqual(['pr04b-second/timed-out']);

  // 한 시간 뒤 — 나머지도 돌아온다
  await retryFailedSecondReviews(new Date(Date.now() + 61 * 60_000));
  expect((await pendingSecondReviews(10)).map((row) => row.repo).sort()).toEqual(['pr04b-second/bad-json', 'pr04b-second/timed-out']);
});

it('올린 것을 건너뛰고 다음 것을 올린다 — 앞부분이 남아 있어도 뒤가 밀리지 않는다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }] } }, 'fixture');
  // 한 번에 올리는 상한(50)보다 많이 쌓아 둔다
  for (let index = 0; index < 55; index += 1) {
    await held(`pr04b-second/wave-${String(index).padStart(2, '0')}`);
    await firstReview(`pr04b-second/wave-${String(index).padStart(2, '0')}`, 'reject');
  }

  expect(await enqueueSecondReviews(await getSettings())).toBe(50);
  // 앞의 50건은 아직 아무도 보지 않았지만, 다음 틱은 그 뒤를 올린다
  expect(await enqueueSecondReviews(await getSettings())).toBe(5);
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);

  const rows = await db.select({ repo: secondReviews.repo }).from(secondReviews);
  expect(new Set(rows.map((row) => row.repo)).size).toBe(55);
});

it('1차가 다시 보면 그 판단으로만 올린다 — 지나간 입력으로 되돌아가지 않는다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }] } }, 'fixture');
  await held('pr04b-second/rewound');
  // 입력이 다른 1차 판단이 둘 — 뒤의 것이 지금 판단이다
  const previous = await firstReview('pr04b-second/rewound', 'reject');
  await db.update(crawlDocuments).set({ pageMeta: { title: '새 제품', textSample: '새로운 입력' } }).where(eq(crawlDocuments.repo, 'pr04b-second/rewound'));
  const current = await firstReview('pr04b-second/rewound', 'approve', 0.95);
  expect(current.inputHash).not.toBe(previous.inputHash);

  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  const [first] = await pendingSecondReviews(10);
  expect(first).toMatchObject({ inputHash: current.inputHash, firstDecision: 'approve' });

  // 그 표를 받은 뒤에도 앞선 입력으로 되돌아가지 않는다
  await recordSecondReviewFixture(first.id, { ok: true, decision: 'approve', confidence: 0.9, reason: '쓸 수 있는 앱',
    model: '[MLX] gemma4-26b', provider: 'abcllm', status: 'agreed' });
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);

  const rows = await db.select().from(secondReviews).where(eq(secondReviews.repo, 'pr04b-second/rewound'));
  expect(rows.map((row) => row.inputHash)).toEqual([current.inputHash]);
});

it('1차를 본 모델을 적어 두고, 2차에 같은 모델이 서면 그 표는 셈에서 뺀다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: 'sonnet' }, { provider: 'abcllm', model: '[MLX] gemma4-31b' }] } }, 'fixture');
  const candidate = await held('pr04b-second/echo');
  // firstReview 헬퍼는 1차를 sonnet 으로 적는다 — 2차 첫 표와 같은 모델이다
  await firstReview('pr04b-second/echo', 'reject');
  await enqueueSecondReviews(await getSettings());

  const rows = await pendingSecondReviews(10);
  expect(rows.every((row) => row.firstModel === 'sonnet')).toBe(true);

  for (const row of rows) {
    await recordSecondReviewFixture(row.id, { ok: true, decision: 'reject', confidence: 0.9, reason: '문서 사이트',
      model: row.model!, provider: 'abcllm', status: 'needs_human' });
  }
  // 1차(sonnet) + 메아리(sonnet) + 다른 모델 하나 → 셈에 드는 표는 둘이다
  const { ids } = await secondReviewSummary(0.85);
  expect(ids.agreed_reject).toEqual([candidate.id]);
  expect(ids.unanimous_reject).toEqual([]);
});

it('binds a new first attempt even when the semantic input is unchanged', async () => {
  await held('pr04b-second/new-attempt'); await firstReview('pr04b-second/new-attempt', 'reject');
  await enqueueSecondReviews(await getSettings());
  const [old] = await pendingSecondReviews(1);
  await firstReview('pr04b-second/new-attempt', 'approve');
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  const rows = await db.select().from(secondReviews).where(eq(secondReviews.repo, 'pr04b-second/new-attempt')).orderBy(secondReviews.id);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({id: old.id, status: 'resolved', resolution: 'superseded'});
  expect(rows[1]).toMatchObject({status: 'pending', firstDecision: 'approve'});
});
it('does not overwrite a resolved row with a late model response', async () => {
  await held('pr04b-second/late'); await firstReview('pr04b-second/late', 'reject'); await enqueueSecondReviews(await getSettings());
  const [row] = await pendingSecondReviews(1);
  await withLegacySecondReviewJob(async lease => {
    const receipt = await admitSecondReviewFixture(row.id, lease);
    await db.update(secondReviews).set({status: 'resolved', resolution: 'kept'}).where(eq(secondReviews.id, row.id));
    expect(await recordSecondReview({ receipt, result: {ok: true, decision: 'approve', confidence: 1, reason: 'late', model: 'opus', provider: 'claude-cli', status: 'agreed'} })).toEqual({ state: 'not_pending' });
  });
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, row.id)))[0]).toMatchObject({status: 'resolved', resolution: 'kept', secondDecision: null});
});
it('discards results if the underlying document changed while the model was running', async () => {
  await held('pr04b-second/source-change'); await firstReview('pr04b-second/source-change', 'reject'); await enqueueSecondReviews(await getSettings());
  const [row] = await pendingSecondReviews(1);
  await withLegacySecondReviewJob(async lease => {
    const receipt = await admitSecondReviewFixture(row.id, lease);
    await db.update(crawlDocuments).set({pageMeta: {title: 'changed'}}).where(eq(crawlDocuments.repo, row.repo));
    await recordSecondReview({ receipt, result: {ok: true, decision: 'reject', confidence: 1, reason: 'old source', model: 'opus', provider: 'claude-cli', status: 'agreed'} });
  });
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, row.id)))[0]).toMatchObject({status: 'resolved', resolution: 'superseded', secondDecision: null});
});
it('does not enqueue an alias of the first model as an independent second voter', async () => {
  await held('pr04b-second/alias'); await firstReview('pr04b-second/alias', 'approve');
  await db.update(crawlReviewAttempts).set({provider: 'abcllm', model: '[MLX] gpt-oss-120b'});
  await saveSettings({secondReview: {enabled: true, sampleRate: 0, voters: [{provider: 'abcllm', model: 'gpt-oss-120b'}, {provider: 'abcllm', model: '[MLX] gemma4-31b'}]}}, 'fixture');
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  expect((await pendingSecondReviews(10)).map(row => row.model)).toEqual(['[MLX] gemma4-31b']);
});

it('rejects stale input before starting a second model call', async () => {
  const {loadSecondReviewInput} = await import('@/lib/crawl/second-review-input');
  await held('pr04b-second/before-call'); await firstReview('pr04b-second/before-call', 'reject'); await enqueueSecondReviews(await getSettings());
  const [row] = await pendingSecondReviews(1);
  expect(await loadSecondReviewInput(row)).not.toBeNull();
  await db.update(crawlDocuments).set({pageMeta: {title: 'another source'}}).where(eq(crawlDocuments.repo, row.repo));
  expect(await loadSecondReviewInput(row)).toBeNull();
});

it('keeps legacy published reviews out of unpublished approval chips', async () => {
  await published('pr04b-second/legacy-published', 'the quick way to plan all of your week with friends');
  await enqueueSecondReviews(await getSettings());
  await db.update(secondReviews).set({generationKey: 'legacy'});
  const summary = await secondReviewSummary(0.85);
  expect(summary.counts.published).toBe(1);
  expect(summary.ids.needs_human).toEqual([]);
});
it('rejects a late response after the first verdict changes without another enqueue', async () => {
  await held('pr04b-second/late-first'); await firstReview('pr04b-second/late-first', 'reject');
  await enqueueSecondReviews(await getSettings()); const [row] = await pendingSecondReviews(1);
  await withLegacySecondReviewJob(async lease => {
    const receipt = await admitSecondReviewFixture(row.id, lease);
    await firstReview(row.repo, 'approve');
    await recordSecondReview({ receipt, result: {ok: true, decision: 'reject', confidence: 1, reason: 'stale', model: 'opus', provider: 'claude-cli', status: 'agreed'} });
  });
  expect((await secondReviewsFor([row.candidateId]))).toEqual([]);
});
it('does not let first-model-only candidates consume the enqueue limit', async () => {
  await saveSettings({secondReview: {voters: [{provider: 'abcllm', model: '[MLX] sonnet'}]}}, 'fixture');
  for (let i = 0; i < 55; i++) {await held(`pr04b-second/echo-${i}`); await firstReview(`pr04b-second/echo-${i}`, 'reject');}
  const eligible = await held('pr04b-second/independent'); await firstReview(eligible.repo, 'reject');
  await db.update(crawlReviewAttempts).set({model: 'another'}).where(eq(crawlReviewAttempts.candidateId, eligible.id));
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  expect((await pendingSecondReviews(10)).map(row => row.repo)).toEqual([eligible.repo]);
});
it('does not starve published samples beyond the first batch', async () => {
  for (let i = 0; i < 27; i++) await published(`pr04b-second/public-${i}`, 'the quick way to plan all of your week with friends');
  expect(await enqueueSecondReviews(await getSettings())).toBe(25);
  expect(await enqueueSecondReviews(await getSettings())).toBe(2);
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);
});

it('rejects a second-review result after the worker lease is replaced', async () => {
  await held('pr04b-second/lost-lease'); await firstReview('pr04b-second/lost-lease', 'reject'); await enqueueSecondReviews(await getSettings());
  const [row] = await pendingSecondReviews(1);
  await expect(withLegacySecondReviewJob(async lease => {
    const receipt = await admitSecondReviewFixture(row.id, lease);
    await db.update(jobs).set({ leaseToken: 'new-owner' }).where(eq(jobs.name, 'second-review'));
    await expect(recordSecondReview({ receipt, result: {ok: true, decision: 'reject', confidence: 1, reason: 'old worker', model: 'opus', provider: 'claude-cli', status: 'agreed'} })).rejects.toThrow('job_lease_lost');
  })).rejects.toThrow('job_lease_lost');
  expect((await pendingSecondReviews(1))[0]).toMatchObject({id: row.id, secondDecision: null});
});
it('waits for a concurrent evidence writer then discards the stale second verdict', async () => {
  const {lockRepositoryAgentEvidence} = await import('@/lib/domain/evidence/agents/lock');
  const {saveRepositoryAgentScan} = await import('@/lib/domain/evidence/agents/repository');
  const repo = 'pr04b-second/second-scan-race';
  const scan = (await saveRepositoryAgentScan({repositoryKey: repo, repositoryId: '987654322', commitSha: 'a'.repeat(40),
    scope: '', state: 'complete', cursor: null, observations: [], requestCount: 1, fileCount: 0, errorCode: null, retryAt: null}))!;
  await held(repo); await firstReview(repo, 'reject'); await enqueueSecondReviews(await getSettings());
  const [row] = await pendingSecondReviews(1);
  await withLegacySecondReviewJob(async lease => {
    const receipt = await admitSecondReviewFixture(row.id, lease);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => {entered = resolve;});
    const gate = new Promise<void>(resolve => {release = resolve;});
    const writer = db.transaction(async tx => {
      await lockRepositoryAgentEvidence(tx, repo); entered(); await gate;
      await tx.update(agentRepositoryScans).set({startedAt: new Date(Date.now()+1)}).where(eq(agentRepositoryScans.id, scan.id));
  });
  await ready;
  const recording = recordSecondReview({ receipt, result: {ok: true, decision: 'reject', confidence: 1, reason: 'old scan', model: 'opus', provider: 'claude-cli', status: 'agreed'} });
  try {
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      const result = await db.execute(sql`select exists(select 1 from pg_locks where locktype='advisory' and not granted) as waiting`);
      if (result[0].waiting) {waiting = true; break;}
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(waiting).toBe(true);
  } finally {release(); await writer; await recording;}
  const [saved] = await db.select().from(secondReviews).where(eq(secondReviews.id, row.id));
  expect(saved).toMatchObject({status: 'resolved', resolution: 'superseded', secondDecision: null});
  });
});

it('does not enqueue retired first-review prompts after an upgrade', async () => {
  const candidate = await held('pr04b-second/retired-prompt'); await firstReview(candidate.repo, 'approve');
  await db.update(crawlReviewAttempts).set({promptVersion: 'retired'}).where(eq(crawlReviewAttempts.candidateId,candidate.id));
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);
});
it('closes unbound and retired pending generations before they block new work', async () => {
  await held('pr04b-second/retired-queue'); await firstReview('pr04b-second/retired-queue', 'approve'); await enqueueSecondReviews(await getSettings());
  await held('pr04b-second/legacy-queue'); await firstReview('pr04b-second/legacy-queue', 'approve'); await enqueueSecondReviews(await getSettings());
  const rows=await pendingSecondReviews(10);
  const retired=rows.find(row=>row.repo==='pr04b-second/retired-queue')!,legacy=rows.find(row=>row.repo==='pr04b-second/legacy-queue')!;
  await db.update(crawlReviewAttempts).set({promptVersion:'retired'}).where(eq(crawlReviewAttempts.candidateId,retired.candidateId));
  await db.update(secondReviews).set({generationKey:'legacy',firstAttemptId:null}).where(eq(secondReviews.id,legacy.id));
  expect(await closeSettledSecondReviews()).toBe(2);
  expect(await pendingSecondReviews(10)).toEqual([]);
  expect((await db.select().from(secondReviews)).every(row=>row.resolution==='superseded')).toBe(true);
});

it('세 번 실패한 표는 사람 확인으로 끝내고 다시 호출하거나 찬성표로 세지 않는다', async () => {
  await held('pr04b-second/exhausted');
  await firstReview('pr04b-second/exhausted', 'approve');
  await enqueueSecondReviews(await getSettings());
  const [row] = await pendingSecondReviews(10);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const at = new Date(Date.now() + attempt * 3600_000);
    await recordSecondReviewFixture(row.id, { ok: false, error: 'invalid_output', model: 'opus', provider: 'claude-cli' }, at);
    await retryFailedSecondReviews(new Date(at.getTime() + 3600_001));
  }
  const [saved] = await db.select().from(secondReviews);
  expect(saved).toMatchObject({ status: 'needs_human', failureCount: 3, secondDecision: null, errorCode: 'invalid_output' });
  expect(await pendingSecondReviews(10)).toHaveLength(0);
  expect((await secondReviewSummary(.85)).counts).toMatchObject({ pending: 0, needsHuman: 1, agreedApprove: 0 });
});

it('종료된 과거 실패는 현재 실패 경고에서 제외한다', async () => {
  await held('pr04b-second/history');
  await firstReview('pr04b-second/history', 'reject');
  await enqueueSecondReviews(await getSettings());
  const [row] = await pendingSecondReviews(10);
  await recordSecondReviewFixture(row.id, { ok: false, error: 'timeout', model: 'opus', provider: 'claude-cli' });
  await db.update(secondReviews).set({ status: 'resolved', resolution: 'superseded' }).where(eq(secondReviews.id, row.id));
  expect(await recentSecondReviewFailures()).toEqual([]);
});

it('모델을 바꾼 기존 후보에도 새 모델을 올리고 제거한 모델의 미완료 표는 닫는다', async () => {
  await held('pr04b-second/swap-existing');
  await firstReview('pr04b-second/swap-existing', 'approve');
  await enqueueSecondReviews(await getSettings());
  const [old] = await pendingSecondReviews(10);
  await withLegacySecondReviewJob(async lease => {
    const receipt = await admitSecondReviewFixture(old.id, lease);
    await saveSettings({ secondReview: { voters: [{ provider: 'abcllm', model: '[MLX] qwen3.8-27b' }] } }, 'fixture');
    await closeSettledSecondReviews();
    expect(await enqueueSecondReviews(await getSettings())).toBe(1);
    const rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
    expect(rows[0]).toMatchObject({ id: old.id, status: 'resolved', resolution: 'model_removed' });
    expect(rows[1]).toMatchObject({ model: '[MLX] qwen3.8-27b', status: 'pending' });
    // In-flight results from the removed model cannot rejoin consensus.
    await recordSecondReview({ receipt, result: { ok: true, decision: 'approve', confidence: 1, reason: 'late', provider: 'claude-cli', model: 'opus', status: 'agreed' } });
    expect((await db.select().from(secondReviews).where(eq(secondReviews.id, old.id)))[0].status).toBe('resolved');
  });
});

it('설정에서 제거한 모델은 정리 회차 전에도 늦은 응답을 기록할 수 없다', async () => {
  await held('pr04b-second/removed-flight');
  await firstReview('pr04b-second/removed-flight', 'approve');
  await enqueueSecondReviews(await getSettings());
  const [old] = await pendingSecondReviews(10);
  await withLegacySecondReviewJob(async lease => {
    const receipt = await admitSecondReviewFixture(old.id, lease);
    await saveSettings({ secondReview: { voters: [{ provider: 'abcllm', model: '[MLX] qwen3.8-27b' }] } }, 'fixture');
    await recordSecondReview({ receipt, result: { ok: true, decision: 'approve', confidence: 1, reason: 'late', model: 'opus', provider: 'claude-cli', status: 'agreed' } });
    expect((await db.select().from(secondReviews).where(eq(secondReviews.id, old.id)))[0])
      .toMatchObject({ status: 'resolved', resolution: 'superseded', secondDecision: null });
  });
});

it('제거한 모델의 완료된 표도 현행 합의와 상세에서 제외하되 이력은 보존한다', async () => {
  await held('pr04b-second/removed-opinion');
  await firstReview('pr04b-second/removed-opinion', 'approve');
  await enqueueSecondReviews(await getSettings());
  const [old] = await pendingSecondReviews(10);
  await recordSecondReviewFixture(old.id, { ok: true, decision: 'approve', confidence: 1, reason: 'old', model: 'opus', provider: 'claude-cli', status: 'agreed' });
  await saveSettings({ secondReview: { voters: [{ provider: 'abcllm', model: '[MLX] qwen3.8-27b' }] } }, 'fixture');
  await closeSettledSecondReviews();
  await enqueueSecondReviews(await getSettings());
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, old.id)))[0])
    .toMatchObject({ status: 'resolved', resolution: 'model_removed', secondDecision: 'approve' });
  expect((await secondReviewSummary(.85)).counts).toMatchObject({ pending: 1, agreedApprove: 0 });
  expect(await secondReviewsFor([old.candidateId])).toHaveLength(1);
});

it('실패한 기본 표를 실제 대체 모델의 새 표로 연결하고 먼저 처리한다', async () => {
  await saveSettings({ secondReview: { fallbacks: [{ provider: 'abcllm', model: 'backup-a' }] } }, 'fixture');
  await held('pr04b-second/fallback'); await firstReview('pr04b-second/fallback', 'approve');
  await held('pr04b-second/other'); await firstReview('pr04b-second/other', 'approve');
  await enqueueSecondReviews(await getSettings());
  const [primary] = await pendingSecondReviews(10);
  await recordSecondReviewFixture(primary.id, { ok: false, error: 'gateway_error', provider: 'claude-cli', model: 'opus' });
  const [fallback] = await pendingSecondReviews(1);
  expect(fallback).toMatchObject({ model: 'backup-a', fallbackForId: primary.id, failureCount: 1, status: 'pending' });
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id, primary.id)))[0])
    .toMatchObject({ status: 'resolved', resolution: 'fallback', errorCode: 'gateway_error' });
  await recordSecondReviewFixture(fallback.id, { ok: true, decision: 'approve', confidence: .9, reason: 'usable', model: 'backup-a', provider: 'abcllm', status: 'agreed' });
  expect((await secondReviewSummary(.85)).counts.agreedApprove).toBe(1);
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);
});

it('대체 모델에도 실패 횟수를 이어받아 세 번째 실패에서 사람 확인으로 끝낸다', async () => {
  await saveSettings({ secondReview: { fallbacks: [{ provider: 'abcllm', model: 'backup-a' }, { provider: 'abcllm', model: 'backup-b' }] } }, 'fixture');
  await held('pr04b-second/chain'); await firstReview('pr04b-second/chain', 'approve'); await enqueueSecondReviews(await getSettings());
  const [root] = await pendingSecondReviews(1);
  for (let i = 0; i < 3; i++) {
    const [row] = await pendingSecondReviews(1);
    expect(row).toBeDefined();
    await recordSecondReviewFixture(row.id, { ok: false, error: 'timeout', model: row.model!, provider: row.provider! });
  }
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
  expect(rows.map(r => r.model)).toEqual(['opus','backup-a','backup-b']);
  expect(rows[2]).toMatchObject({ status: 'needs_human', failureCount: 3, fallbackForId: root.id, secondDecision: null });
  await retryFailedSecondReviews(new Date(Date.now()+3600_001));
  expect(await pendingSecondReviews(10)).toHaveLength(0);
  expect((await secondReviewSummary(.85)).counts).toMatchObject({ needsHuman: 1, pending: 0, agreedApprove: 0 });
});

it('첫 모델·다른 기본 표·이미 배정된 대체 모델을 중복 투표에 쓰지 않는다', async () => {
  await saveSettings({ secondReview: { voters: [{ provider: 'abcllm', model: 'primary-a' },{ provider: 'abcllm', model: 'primary-b' }],
    fallbacks: [{ provider: 'claude-cli', model: 'sonnet' },{ provider: 'abcllm', model: 'backup' }] } }, 'fixture');
  await held('pr04b-second/independent'); await firstReview('pr04b-second/independent', 'approve'); await enqueueSecondReviews(await getSettings());
  const roots = await pendingSecondReviews(10);
  await withLegacySecondReviewJob(async lease => {
    const receipts = await Promise.all(roots.map(row => admitSecondReviewFixture(row.id, lease)));
    await Promise.all(roots.map((row, index) => recordSecondReview({ receipt: receipts[index], result: { ok:false,error:'timeout',provider:'abcllm',model:row.model! } })));
  });
  const rows = await db.select().from(secondReviews);
  expect(rows.filter(r=>r.model==='backup')).toHaveLength(1);
  expect(rows.filter(r=>r.model==='sonnet')).toHaveLength(1);
  expect(rows.filter(r=>r.model==='backup')[0].fallbackForId).not.toBe(rows.filter(r=>r.model==='sonnet')[0].fallbackForId);
});

it.each(['reject', 'needs_review'])('정상 %s 판단은 대체 모델로 다시 묻지 않는다', async decision => {
  await saveSettings({ secondReview: { fallbacks: [{ provider: 'abcllm', model: 'backup' }] } }, 'fixture');
  await held('pr04b-second/no-answer-shopping'); await firstReview('pr04b-second/no-answer-shopping', 'approve'); await enqueueSecondReviews(await getSettings());
  const [row] = await pendingSecondReviews(1);
  await recordSecondReviewFixture(row.id, {ok:true,decision,confidence:.9,reason:'observed',provider:'claude-cli',model:'opus',status:'needs_human'});
  expect(await db.select().from(secondReviews)).toHaveLength(1);
  expect((await secondReviewSummary(.85)).counts.needsHuman).toBe(1);
});

it.each(['primary','fallback'])('%s 모델을 제거하면 완료된 대체 의견도 합의에서 제외한다', async removed => {
  await saveSettings({ secondReview: { fallbacks: [{ provider: 'abcllm', model: 'backup' }] } }, 'fixture');
  await held('pr04b-second/retired-fallback'); await firstReview('pr04b-second/retired-fallback', 'approve'); await enqueueSecondReviews(await getSettings());
  const [root] = await pendingSecondReviews(1);
  await recordSecondReviewFixture(root.id, {ok:false,error:'timeout',provider:'claude-cli',model:'opus'});
  const [row] = await pendingSecondReviews(1);
  await recordSecondReviewFixture(row.id, {ok:true,decision:'approve',confidence:.9,reason:'observed',provider:'abcllm',model:'backup',status:'agreed'});
  expect(await closeSettledSecondReviews()).toBe(0);
  await saveSettings({secondReview: removed==='primary' ? {voters:[{provider:'abcllm',model:'replacement'}]} : {fallbacks:[]}}, 'fixture');
  await closeSettledSecondReviews();
  expect((await db.select().from(secondReviews).where(eq(secondReviews.id,row.id)))[0]).toMatchObject({status:'resolved',resolution:'model_removed',secondDecision:'approve'});
  expect(await secondReviewsFor([row.candidateId])).toHaveLength(removed==='primary'?0:1);
  if(removed==='fallback') expect((await secondReviewSummary(.85)).counts.needsHuman).toBe(1);
});

it.each(['settings','source'])('대체 심사 도중 %s 변경은 늦은 결과와 추가 대체 배정을 막는다', async changed => {
  await saveSettings({ secondReview: { fallbacks: [{ provider: 'abcllm', model: 'backup' },{provider:'abcllm',model:'backup2'}] } }, 'fixture');
  await held('pr04b-second/stale-backup'); await firstReview('pr04b-second/stale-backup', 'approve'); await enqueueSecondReviews(await getSettings());
  const [root] = await pendingSecondReviews(1);
  await recordSecondReviewFixture(root.id, {ok:false,error:'timeout',provider:'claude-cli',model:'opus'});
  const [row] = await pendingSecondReviews(1);
  await withLegacySecondReviewJob(async lease => {
    const receipt = await admitSecondReviewFixture(row.id, lease);
    if (changed==='settings') await saveSettings({secondReview:{voters:[{provider:'abcllm',model:'replacement'}]}},'fixture');
    else await db.update(crawlDocuments).set({pageMeta:{title:'changed'}}).where(eq(crawlDocuments.repo,row.repo));
    await recordSecondReview({ receipt, result: {ok:false,error:'timeout',provider:'abcllm',model:'backup'} });
    expect(await db.select().from(secondReviews)).toHaveLength(2);
    expect((await db.select().from(secondReviews).where(eq(secondReviews.id,row.id)))[0]).toMatchObject({status:'resolved',resolution:'superseded',failureCount:1});
  });
});

it.each(['cancelled','input_too_large'])('%s 는 다른 모델을 소비하지 않는다', async error => {
  await saveSettings({secondReview:{fallbacks:[{provider:'abcllm',model:'backup'}]}},'fixture');
  await held('pr04b-second/no-fallback'); await firstReview('pr04b-second/no-fallback','approve'); await enqueueSecondReviews(await getSettings());
  const [row] = await pendingSecondReviews(1);
  await recordSecondReviewFixture(row.id,{ok:false,error,provider:'claude-cli',model:'opus'});
  const rows = await db.select().from(secondReviews);
  expect(rows).toHaveLength(1);
  expect(rows[0].failureCount).toBe(error==='cancelled'?0:1);
});

it('다른 기본 모델의 MLX 별칭을 fallback 표로 배정하지 않는다', async () => {
  await saveSettings({secondReview:{voters:[{provider:'claude-cli',model:'opus'},{provider:'abcllm',model:'[MLX] primary'}],
    fallbacks:[{provider:'abcllm',model:'primary'},{provider:'abcllm',model:'backup'}]}},'fixture');
  await held('pr04b-second/alias-backup'); await firstReview('pr04b-second/alias-backup','approve'); await enqueueSecondReviews(await getSettings());
  const root=(await pendingSecondReviews(10)).find(r=>r.model==='opus')!;
  await recordSecondReviewFixture(root.id,{ok:false,error:'timeout',provider:'claude-cli',model:'opus'});
  const [row]=await pendingSecondReviews(1);
  expect(row).toMatchObject({model:'backup',fallbackForId:root.id});
});

it('Sonnet 대체가 1차와 같으면 참고 의견만 남기고 독립 합의 대신 사람 확인으로 보낸다', async () => {
  await saveSettings({secondReview:{fallbacks:[{provider:'claude-cli',model:'sonnet'}]}},'fixture');
  await held('pr04b-second/sonnet-fallback');await firstReview('pr04b-second/sonnet-fallback','approve');await enqueueSecondReviews(await getSettings());
  const [root]=await pendingSecondReviews(1);
  await recordSecondReviewFixture(root.id,{ok:false,error:'timeout',provider:'claude-cli',model:'opus'});
  const [backup]=await pendingSecondReviews(1);
  expect(backup).toMatchObject({provider:'claude-cli',model:'sonnet',fallbackForId:root.id});
  expect((await secondReviewSummary(.85)).counts.pending).toBe(1);
  await recordSecondReviewFixture(backup.id,{ok:true,decision:'approve',confidence:.99,reason:'usable',provider:'claude-cli',model:'sonnet',status:'agreed'});
  expect((await secondReviewSummary(.85)).counts).toMatchObject({needsHuman:1,agreedApprove:0,pending:0});
  expect((await secondReviewsFor([root.candidateId]))[0]).toMatchObject({model:'sonnet',status:'needs_human',secondDecision:'approve'});
});

it('다른 독립 표가 일치해도 Sonnet 중복 대체를 완료한 후보는 사람 확인을 생략하지 않는다', async () => {
  await saveSettings({secondReview:{voters:[{provider:'abcllm',model:'a'},{provider:'abcllm',model:'b'}],fallbacks:[{provider:'claude-cli',model:'sonnet'}]}},'fixture');
  await held('pr04b-second/reference-only');await firstReview('pr04b-second/reference-only','approve');await enqueueSecondReviews(await getSettings());
  const [a,b]=await pendingSecondReviews(2);
  await recordSecondReviewFixture(a.id,{ok:true,decision:'approve',confidence:1,reason:'usable',provider:'abcllm',model:'a',status:'agreed'});
  await recordSecondReviewFixture(b.id,{ok:false,error:'timeout',provider:'abcllm',model:'b'});
  const [backup]=await pendingSecondReviews(1);
  expect((await secondReviewSummary(.85)).counts).toMatchObject({pending:1,agreedApprove:0});
  await recordSecondReviewFixture(backup.id,{ok:true,decision:'approve',confidence:1,reason:'usable',provider:'claude-cli',model:'sonnet',status:'agreed'});
  expect((await secondReviewSummary(.85)).counts).toMatchObject({needsHuman:1,agreedApprove:0,unanimousApprove:0,pending:0});
});

it('지금 세우지 않은 투표자가 막은 갈림 보류만 승인으로 되돌린다 — 지금 투표자가 반대한 것과 관문 표가 없던 것은 그대로', async () => {
  const split = async (repo: string) => {
    const candidate = await held(repo);
    await db.update(crawlCandidates).set({ state: 'needs_review', reason: 'second_review_split',
      signals: { stoppedAt: { rule: '2차 심사', detail: 'qwen reject' } } }).where(eq(crawlCandidates.id, candidate.id));
    return candidate;
  };
  const gate = (candidateId: number, repo: string, row: Partial<typeof secondReviews.$inferInsert>) => db.insert(secondReviews).values({
    candidateId, repo, trigger: 'ai_approved', firstDecision: 'approve', firstConfidence: 0.9, inputHash: 'h', generationKey: `g-${repo}-${row.model}`,
    provider: 'abcllm', model: '[MLX] qwen3.6-35b-heretic', secondDecision: 'reject', status: 'resolved', resolution: 'model_removed', ...row,
  });
  const orphan = await split('pr04b-second/orphan');
  await gate(orphan.id, orphan.repo, {});
  const opposed = await split('pr04b-second/opposed');
  await gate(opposed.id, opposed.repo, {});
  await gate(opposed.id, opposed.repo, { provider: 'grok-cli', model: 'grok-4.7', status: 'needs_human', resolution: null });
  const lone = await split('pr04b-second/lone');

  const settings = await getSettings();
  expect(await reopenOrphanedGateHolds({ ...settings, reviewMode: 'observe' })).toBe(0);
  const now = new Date();
  expect(await reopenOrphanedGateHolds({ ...settings, reviewMode: 'enforce' }, now)).toBe(1);

  const rows = new Map((await db.select().from(crawlCandidates)).map((row) => [row.id, row]));
  expect(rows.get(orphan.id)).toMatchObject({ state: 'approved', reason: 'passed', decidedBy: 'auto' });
  expect(rows.get(orphan.id)!.signals).toMatchObject({ gateReopenedAt: now.toISOString() });
  expect(rows.get(orphan.id)!.signals).not.toHaveProperty('stoppedAt');
  expect(rows.get(opposed.id)).toMatchObject({ state: 'needs_review', reason: 'second_review_split' });
  expect(rows.get(lone.id)).toMatchObject({ state: 'needs_review', reason: 'second_review_split' });
  // 옛 표는 지우지 않는다 — 누가 왜 막았는지는 남는다
  expect(await db.select().from(secondReviews).where(eq(secondReviews.candidateId, orphan.id))).toHaveLength(1);
  expect(await reopenOrphanedGateHolds({ ...settings, reviewMode: 'enforce' })).toBe(0);
});
