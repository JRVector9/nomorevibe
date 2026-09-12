import { beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, secondReviews } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { closeSettledSecondReviews, enqueueSecondReviews, pendingSecondReviews, publishedInputHash, publishedSecondReviews, recentSecondReviewFailures,
  recordSecondReview, resolveSecondReviews, retryFailedSecondReviews, secondReviewSummary, secondReviewsFor } from '@/lib/crawl/second-review';
import { ensureSchema } from './setup';

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(secondReviews);
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
    repo, productUrl: `https://${repo.split('/')[1]}.test`, pageStatus: 200,
    repoMeta: { description: '배포한 서비스', stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: 'User' } },
    pageMeta: { title, textSample: '쓸 수 있는 앱' },
  });
  await crawl.recordJudgement({ repo, productUrl: `https://${repo.split('/')[1]}.test`, state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto' });
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  return candidate;
}

/** 1차 AI 판단 하나 */
/** confidence 가 null 이면 확신을 내지 않던 옛 프롬프트의 판단이다 */
async function firstReview(repo: string, decision: 'approve' | 'reject' | 'needs_review', confidence: number | null = 0.9, inputHash?: string) {
  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo));
  const input = await loadReviewInput(candidate, (await crawl.getDocument(repo))!, await getSettings());
  await db.insert(crawlReviewAttempts).values({
    candidateId: candidate.id, kind: 'automatic', state: 'succeeded', attemptNumber: 1,
    inputHash: inputHash ?? input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash,
    snapshot: input.snapshot, source: input.source, promptVersion: 'v', rulesVersion: 'v',
    provider: 'claude-cli', model: 'sonnet', startedAt: new Date(), completedAt: new Date(), validUntil: input.validUntil,
    outcome: confidence === null ? { decision, reason: '사유', evidenceIds: ['product'] } : { decision, reason: '사유', evidenceIds: ['product'], confidence },
  });
}

/** 규칙만 통과해 방금 공개된 제품 */
async function published(repo: string, title: string) {
  const candidate = await held(repo, title);
  await db.update(crawlCandidates).set({ state: 'published', publishedSlug: repo.split('/')[1], decidedAt: new Date() })
    .where(eq(crawlCandidates.id, candidate.id));
  return candidate;
}

it('AI 1차가 가른 보류 후보와 위험 신호가 있는 공개분을 올린다 — 한 번씩만', async () => {
  await held('acme/rejected');
  await held('acme/unsure');
  await held('acme/untouched');
  await firstReview('acme/rejected', 'reject', 0.92);
  await firstReview('acme/unsure', 'needs_review');
  await published('acme/sentence', 'the quick way to plan all of your week with friends');
  await published('acme/plain', 'Plain');

  expect(await enqueueSecondReviews(await getSettings())).toBe(2);
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.repo);
  expect(rows.map((row) => [row.repo, row.trigger, row.firstDecision, row.status])).toEqual([
    ['acme/rejected', 'ai_decided', 'reject', 'pending'],
    ['acme/sentence', 'risk', 'approve', 'pending'],
  ]);
  expect(rows[0].firstConfidence).toBeCloseTo(0.92);
  expect(rows[1].signals).toEqual(['sentence_name']);
  expect(rows[1].publishedSlug).toBe('sentence');
  expect(rows[1].inputHash).toBe(publishedInputHash('sentence'));

  // 같은 입력은 다시 올리지 않는다
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);
});

it('사람이 이미 결정했거나 공개분이 내려가면 닫는다 — 지우지 않는다', async () => {
  const decided = await held('acme/decided');
  await firstReview('acme/decided', 'reject');
  const gone = await published('acme/gone', 'the quick way to plan all of your week with friends');
  await held('acme/open');
  await firstReview('acme/open', 'approve');
  await enqueueSecondReviews(await getSettings());

  await db.update(crawlCandidates).set({ state: 'rejected', decidedBy: 'admin' }).where(eq(crawlCandidates.id, decided.id));
  await db.update(crawlCandidates).set({ state: 'rejected' }).where(eq(crawlCandidates.id, gone.id));

  expect(await closeSettledSecondReviews()).toBe(2);
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.repo);
  expect(rows.map((row) => [row.repo, row.status, row.resolution])).toEqual([
    ['acme/decided', 'resolved', 'decided_elsewhere'],
    ['acme/gone', 'resolved', 'decided_elsewhere'],
    ['acme/open', 'pending', null],
  ]);
});

it('일치·엇갈림·공개분을 따로 세고, 심사 화면이 후보 id 로 거른다', async () => {
  const agreedReject = await held('acme/agreed-reject');
  const agreedApprove = await held('acme/agreed-approve');
  const split = await held('acme/split');
  await firstReview('acme/agreed-reject', 'reject');
  await firstReview('acme/agreed-approve', 'approve');
  await firstReview('acme/split', 'reject');
  await published('acme/sentence', 'the quick way to plan all of your week with friends');
  await enqueueSecondReviews(await getSettings());

  const byRepo = new Map((await pendingSecondReviews(10)).map((row) => [row.repo, row.id]));
  const ok = (decision: string, status: 'agreed' | 'needs_human') => ({ ok: true as const, decision, confidence: 0.9, reason: '두 번째 판단', model: 'opus', provider: 'claude-cli' as const, status });
  await recordSecondReview(byRepo.get('acme/agreed-reject')!, ok('reject', 'agreed'));
  await recordSecondReview(byRepo.get('acme/agreed-approve')!, ok('approve', 'agreed'));
  await recordSecondReview(byRepo.get('acme/split')!, ok('approve', 'needs_human'));
  await recordSecondReview(byRepo.get('acme/sentence')!, ok('reject', 'needs_human'));

  const { counts, ids } = await secondReviewSummary(0.85);
  expect(counts).toEqual({ unanimousReject: 0, unanimousApprove: 0, agreedReject: 1, agreedApprove: 1, needsHuman: 1, published: 1, pending: 0 });
  expect(ids).toEqual({ unanimous_reject: [], unanimous_approve: [], agreed_reject: [agreedReject.id], agreed_approve: [agreedApprove.id], needs_human: [split.id] });

  // 심사 상세에는 1차와 나란히 2차가 보인다
  const [detail] = await secondReviewsFor([split.id]);
  expect(detail).toMatchObject({ secondDecision: 'approve', model: 'opus', status: 'needs_human' });
});

it('80자 slug 도 올라간다', async () => {
  const slug = 'x'.repeat(80);
  const candidate = await published('acme/long', 'the quick way to plan all of your week with friends');
  await db.update(crawlCandidates).set({ publishedSlug: slug }).where(eq(crawlCandidates.id, candidate.id));
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
});

it('공개분을 2차도 제품이라 보면 끝난 기록으로 남고 닫는 대상에 들지 않는다', async () => {
  await published('acme/sentence', 'the quick way to plan all of your week with friends');
  await enqueueSecondReviews(await getSettings());
  const [pending] = await pendingSecondReviews(1);
  await recordSecondReview(pending.id, { ok: true, decision: 'approve', confidence: 0.9, reason: '쓸 수 있는 앱', model: 'opus', provider: 'claude-cli', status: 'agreed' });

  expect(await closeSettledSecondReviews()).toBe(0);
  expect((await secondReviewSummary(0.85)).counts).toMatchObject({ published: 0, agreedApprove: 0 });
  expect((await db.select().from(secondReviews))[0].status).toBe('agreed');
});

it('공개분은 사람이 내리거나 유지하기로 정할 때까지 남는다', async () => {
  await published('acme/sentence', 'the quick way to plan all of your week with friends');
  await enqueueSecondReviews(await getSettings());
  const [pending] = await pendingSecondReviews(1);
  await recordSecondReview(pending.id, { ok: true, decision: 'reject', confidence: 0.9, reason: '문장이 이름이 됐다', model: 'opus', provider: 'claude-cli', status: 'needs_human' });

  const rows = await publishedSecondReviews();
  expect(rows.map((row) => [row.publishedSlug, row.secondReason])).toEqual([['sentence', '문장이 이름이 됐다']]);

  expect(await resolveSecondReviews([pending.id], 'kept', 'admin@test')).toBe(1);
  // 이미 끝낸 것을 다시 끝내지 않는다
  expect(await resolveSecondReviews([pending.id], 'banned', 'admin@test')).toBe(0);
  const [row] = await db.select().from(secondReviews);
  expect(row).toMatchObject({ status: 'resolved', resolution: 'kept', resolvedBy: 'admin@test' });
  expect(await publishedSecondReviews()).toEqual([]);
});

it('실패한 호출은 기록만 남기고 판단을 지어내지 않는다', async () => {
  await held('acme/flaky');
  await firstReview('acme/flaky', 'reject');
  await enqueueSecondReviews(await getSettings());
  const [pending] = await pendingSecondReviews(1);
  await recordSecondReview(pending.id, { ok: false, error: 'rate_limited', model: 'opus', provider: 'claude-cli' });

  const [row] = await db.select().from(secondReviews);
  expect(row).toMatchObject({ status: 'failed', errorCode: 'rate_limited', secondDecision: null });
  // 실패는 아직 끝나지 않은 표다 — 한 시간 뒤 다시 보므로 확정 칩이 아니라 대기로 센다
  expect((await secondReviewSummary(0.85)).counts).toEqual({ unanimousReject: 0, unanimousApprove: 0, agreedReject: 0, agreedApprove: 0, needsHuman: 0, published: 0, pending: 1 });
});

it('실패한 것은 한 시간이 지나야 다시 대기로 돌린다', async () => {
  await held('acme/old-fail');
  await held('acme/new-fail');
  await firstReview('acme/old-fail', 'reject');
  await firstReview('acme/new-fail', 'reject');
  await enqueueSecondReviews(await getSettings());
  const byRepo = new Map((await pendingSecondReviews(10)).map((row) => [row.repo, row.id]));
  const now = new Date();
  await recordSecondReview(byRepo.get('acme/old-fail')!, { ok: false, error: 'timeout', model: 'opus', provider: 'claude-cli' }, new Date(now.getTime() - 2 * 3600_000));
  await recordSecondReview(byRepo.get('acme/new-fail')!, { ok: false, error: 'timeout', model: 'opus', provider: 'claude-cli' }, new Date(now.getTime() - 10 * 60_000));

  // 2026-09-11 프로드: 이 쿼리가 Date 를 문자열로 넘겨 매 틱 실패했다
  await retryFailedSecondReviews(now);

  const rows = await db.select().from(secondReviews).orderBy(secondReviews.repo);
  expect(rows.map((row) => [row.repo, row.status])).toEqual([['acme/new-fail', 'failed'], ['acme/old-fail', 'pending']]);
});

it('확신을 내지 않던 옛 1차 판단은 올리지 않고, 이미 올린 것은 닫는다 — 2차 의견은 상세에 남는다', async () => {
  const legacy = await held('acme/legacy');
  await held('acme/fresh');
  await firstReview('acme/legacy', 'reject', null);
  await firstReview('acme/fresh', 'reject', 0.9);

  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  expect((await db.select().from(secondReviews)).map((row) => row.repo)).toEqual(['acme/fresh']);

  // 배포 직후 프로드처럼, 옛 1차로 이미 올라가 2차까지 받은 것
  await db.insert(secondReviews).values({ candidateId: legacy.id, repo: 'acme/legacy', trigger: 'ai_decided', firstDecision: 'reject',
    firstConfidence: null, inputHash: 'legacy', status: 'needs_human', secondDecision: 'reject', secondConfidence: 0.88, model: 'opus' });
  expect(await closeSettledSecondReviews()).toBe(1);
  const [closed] = await db.select().from(secondReviews).where(eq(secondReviews.repo, 'acme/legacy'));
  expect(closed).toMatchObject({ status: 'resolved', resolution: 'no_first_confidence' });
  expect((await secondReviewSummary(0.85)).counts.needsHuman).toBe(0);
  expect(await secondReviewsFor([legacy.id])).toEqual([expect.objectContaining({ secondDecision: 'reject', status: 'resolved' })]);
});

it('같은 후보에 새 1차 판단이 오면 앞의 것을 닫는다 — 두 칩에 겹쳐 세지 않는다', async () => {
  await held('acme/changing');
  await firstReview('acme/changing', 'reject', 0.9, 'first-input');
  await enqueueSecondReviews(await getSettings());
  const [first] = await pendingSecondReviews(1);
  await recordSecondReview(first.id, { ok: true, decision: 'approve', confidence: 0.9, reason: '엇갈림', model: 'opus', provider: 'claude-cli', status: 'needs_human' });

  // 원본이 바뀌어 1차가 다시 봤다
  await firstReview('acme/changing', 'approve', 0.92, 'second-input');
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);

  const rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
  expect(rows.map((row) => [row.inputHash, row.status, row.resolution])).toEqual([
    ['first-input', 'resolved', 'superseded'],
    ['second-input', 'pending', null],
  ]);
  expect((await secondReviewSummary(0.85)).counts).toMatchObject({ needsHuman: 0, pending: 1 });
});

it('누가 볼지를 올릴 때 적고, 같은 모델로는 다시 올리지 않는다', async () => {
  await held('acme/voter');
  await firstReview('acme/voter', 'reject');
  await saveSettings({ secondReview: { enabled: true, voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }], sampleRate: 0, agreeAt: 0.85 } }, 'fixture');

  expect(await enqueueSecondReviews(await getSettings())).toBe(1);
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);
  expect(await pendingSecondReviews(10)).toMatchObject([{ provider: 'abcllm', model: '[MLX] gemma4-26b' }]);
});

it('모델을 바꾸면 같은 후보를 새 모델이 따로 본다 — 표가 쌓인다', async () => {
  await held('acme/two-voters');
  await firstReview('acme/two-voters', 'reject');
  await saveSettings({ secondReview: { enabled: true, voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }], sampleRate: 0, agreeAt: 0.85 } }, 'fixture');
  await enqueueSecondReviews(await getSettings());
  await saveSettings({ secondReview: { enabled: true, voters: [{ provider: 'abcllm', model: '[MLX] gpt-oss-120b' }], sampleRate: 0, agreeAt: 0.85 } }, 'fixture');
  await enqueueSecondReviews(await getSettings());

  const rows = await db.select().from(secondReviews).where(eq(secondReviews.repo, 'acme/two-voters'));
  expect(rows.map((row) => row.model).sort()).toEqual(['[MLX] gemma4-26b', '[MLX] gpt-oss-120b']);
});

it('실패는 모델·까닭별로 세어 운영 화면에 드러난다', async () => {
  await held('acme/gone-a');
  await held('acme/gone-b');
  await firstReview('acme/gone-a', 'reject');
  await firstReview('acme/gone-b', 'approve');
  await saveSettings({ secondReview: { enabled: true, voters: [{ provider: 'abcllm', model: '[MLX] 사라진모델' }], sampleRate: 0, agreeAt: 0.85 } }, 'fixture');
  await enqueueSecondReviews(await getSettings());
  const ids = (await pendingSecondReviews(10)).map((row) => row.id);
  for (const id of ids) await recordSecondReview(id, { ok: false, error: 'model_unavailable', model: '[MLX] 사라진모델', provider: 'abcllm' });

  expect(await recentSecondReviewFailures()).toEqual([
    { provider: 'abcllm', model: '[MLX] 사라진모델', errorCode: 'model_unavailable', count: 2 },
  ]);
  // 하루가 지난 실패는 지금 문제가 아니다
  expect(await recentSecondReviewFailures(new Date(Date.now() + 25 * 3600_000))).toEqual([]);
});

it('표 여럿을 세우면 후보마다 모델 수만큼 올라가고, 모두 같으면 만장일치로 묶인다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }, { provider: 'abcllm', model: '[MLX] gpt-oss-120b' }] } }, 'fixture');
  const unanimous = await held('acme/unanimous');
  const split = await held('acme/split-votes');
  await firstReview('acme/unanimous', 'reject');
  await firstReview('acme/split-votes', 'reject');

  expect(await enqueueSecondReviews(await getSettings())).toBe(4);
  const rows = await pendingSecondReviews(10);
  const record = (repo: string, model: string, decision: string) => {
    const row = rows.find((item) => item.repo === repo && item.model === model)!;
    return recordSecondReview(row.id, { ok: true, decision, confidence: 0.9, reason: '두 번째 판단', model, provider: 'abcllm',
      status: decision === 'reject' ? 'agreed' : 'needs_human' });
  };
  await record('acme/unanimous', '[MLX] gemma4-26b', 'reject');
  await record('acme/unanimous', '[MLX] gpt-oss-120b', 'reject');
  await record('acme/split-votes', '[MLX] gemma4-26b', 'reject');
  await record('acme/split-votes', '[MLX] gpt-oss-120b', 'approve');

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
  await held('acme/half');
  await firstReview('acme/half', 'reject');
  await enqueueSecondReviews(await getSettings());
  const [first] = await pendingSecondReviews(10);
  await recordSecondReview(first.id, { ok: true, decision: 'reject', confidence: 0.9, reason: '두 번째 판단',
    model: first.model!, provider: 'abcllm', status: 'agreed' });

  const { counts } = await secondReviewSummary(0.85);
  expect(counts).toMatchObject({ pending: 1, unanimousReject: 0, agreedReject: 0, needsHuman: 0 });
});

it('모델을 하나 더 세워도 먼저 세운 모델의 표가 닫히지 않는다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }] } }, 'fixture');
  await held('acme/added-voter');
  await firstReview('acme/added-voter', 'reject');
  await enqueueSecondReviews(await getSettings());

  // 두 번째 모델을 더한다 — 같은 입력이라 먼저 올린 표는 그대로 있어야 한다
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }, { provider: 'abcllm', model: '[MLX] gemma4-31b' }] } }, 'fixture');
  expect(await enqueueSecondReviews(await getSettings())).toBe(1);

  const rows = await db.select().from(secondReviews).where(eq(secondReviews.repo, 'acme/added-voter'));
  expect(rows.map((row) => [row.model, row.status]).sort())
    .toEqual([['[MLX] gemma4-26b', 'pending'], ['[MLX] gemma4-31b', 'pending']]);
  expect(rows.some((row) => row.resolution === 'superseded')).toBe(false);
});

it('1차 판단이 새로 오면(입력이 바뀌면) 앞선 표는 닫는다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] gemma4-26b' }] } }, 'fixture');
  await held('acme/new-input');
  await firstReview('acme/new-input', 'reject');
  await enqueueSecondReviews(await getSettings());
  // 입력이 달라진 새 1차 판단
  await firstReview('acme/new-input', 'approve', 0.95, 'b'.repeat(64));
  await enqueueSecondReviews(await getSettings());

  const rows = await db.select().from(secondReviews).where(eq(secondReviews.repo, 'acme/new-input'));
  expect(rows).toHaveLength(2);
  expect(rows.filter((row) => row.resolution === 'superseded')).toHaveLength(1);
  expect((await pendingSecondReviews(10)).map((row) => row.firstDecision)).toEqual(['approve']);
});

it('실패한 표가 남아 있으면 확정 칩에 올리지 않는다 — 한 시간 뒤 다시 보고 뒤집을 수 있다', async () => {
  const voters = [{ provider: 'abcllm' as const, model: '[MLX] gemma4-26b' }, { provider: 'abcllm' as const, model: '[MLX] gemma4-31b' }];
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85, voters } }, 'fixture');
  await held('acme/one-failed');
  await firstReview('acme/one-failed', 'reject');
  await enqueueSecondReviews(await getSettings());
  const rows = await pendingSecondReviews(10);
  await recordSecondReview(rows[0].id, { ok: true, decision: 'reject', confidence: 0.9, reason: '문서', model: rows[0].model!, provider: 'abcllm', status: 'agreed' });
  await recordSecondReview(rows[1].id, { ok: false, error: 'model_unavailable', model: rows[1].model!, provider: 'abcllm' });

  const { counts } = await secondReviewSummary(0.85);
  expect(counts).toMatchObject({ pending: 1, agreedReject: 0, unanimousReject: 0, needsHuman: 0 });
});

it('표가 모두 실패해도 집계에서 사라지지 않는다', async () => {
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85,
    voters: [{ provider: 'abcllm', model: '[MLX] 사라진모델' }] } }, 'fixture');
  await held('acme/all-failed');
  await firstReview('acme/all-failed', 'reject');
  await enqueueSecondReviews(await getSettings());
  const [row] = await pendingSecondReviews(10);
  await recordSecondReview(row.id, { ok: false, error: 'model_unavailable', model: row.model!, provider: 'abcllm' });

  expect((await secondReviewSummary(0.85)).counts).toMatchObject({ pending: 1 });
});

it('모델을 여럿 세워도 공개분 표본이 대기 후보에 밀리지 않는다', async () => {
  const voters = [{ provider: 'abcllm' as const, model: '[MLX] a' }, { provider: 'abcllm' as const, model: '[MLX] b' }];
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85, voters } }, 'fixture');
  // 대기 후보를 상한 넘게 쌓아 둔다
  for (let index = 0; index < 55; index += 1) {
    await held(`acme/queued-${index}`);
    await firstReview(`acme/queued-${index}`, 'reject');
  }
  // 위험 신호가 있는 공개분 — 문장을 이름으로 가져온 것
  await published('acme/fresh-publish', 'the quick way to plan all of your week with friends');

  await enqueueSecondReviews(await getSettings());
  const rows = await db.select().from(secondReviews).where(eq(secondReviews.repo, 'acme/fresh-publish'));
  expect(rows).toHaveLength(2);
});

it('1차가 보류한 것은 설정을 켤 때만 올라가고, 확신이 없다고 닫히지 않는다', async () => {
  const voters = [{ provider: 'abcllm' as const, model: '[MLX] gemma4-26b' }, { provider: 'abcllm' as const, model: '[MLX] gemma4-31b' }];
  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85, voters, includeAiHeld: false } }, 'fixture');
  const candidate = await held('acme/ai-held');
  await firstReview('acme/ai-held', 'needs_review', null);

  // 꺼 두면 올리지 않는다 — 1차가 가른 것만 본다
  expect(await enqueueSecondReviews(await getSettings())).toBe(0);

  await saveSettings({ secondReview: { enabled: true, sampleRate: 0, agreeAt: 0.85, voters, includeAiHeld: true } }, 'fixture');
  expect(await enqueueSecondReviews(await getSettings())).toBe(2);
  // 확신 없는 옛 1차를 닫는 규칙에 걸리면 안 된다 — 이 갈래는 애초에 확신을 재지 않는다
  await closeSettledSecondReviews();
  const rows = await pendingSecondReviews(10);
  expect(rows.map((row) => row.trigger)).toEqual(['ai_held', 'ai_held']);

  // 1차가 표를 내지 않으므로 두 모델이 같아야 일치가 된다
  for (const row of rows) {
    await recordSecondReview(row.id, { ok: true, decision: 'reject', confidence: 0.9, reason: '문서 사이트',
      model: row.model!, provider: 'abcllm', status: 'needs_human' });
  }
  const { ids } = await secondReviewSummary(0.85);
  expect(ids.agreed_reject).toEqual([candidate.id]);
});
