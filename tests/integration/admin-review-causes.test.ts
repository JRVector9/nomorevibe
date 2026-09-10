import { beforeAll, beforeEach, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { listAdminReviewEntries, requeueResolvedCandidates, reviewQueueCauses } from '@/lib/crawl/admin-review';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { eq } from 'drizzle-orm';
import { ensureSchema } from './setup';

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(crawlReviewAttempts);
  await db.delete(crawlCandidates);
  await db.delete(crawlDocuments);
  await db.delete(crawlFrontier);
  await db.delete(crawlSettings);
  await saveSettings({ enabled: true }, 'fixture');
});

/** 보류로 남은 후보 하나 — 원본을 보관하므로 규칙을 다시 태울 수 있다 */
async function held(repo: string, productUrl: string, pageStatus: number | null, stars = 3) {
  await crawl.putDocument({
    repo, productUrl, pageStatus,
    repoMeta: { description: '배포한 서비스', stargazers_count: stars, pushed_at: new Date().toISOString(), owner: { type: 'User' } },
    pageMeta: { title: '제품' },
  });
  await crawl.recordJudgement({ repo, productUrl, state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto' });
}

it('저장된 사유는 모두 ambiguous 지만 갈래는 따로 센다', async () => {
  // owner.github.io/repo — 호스트는 제외 대상인데 배포물이 루트가 아니다
  await held('tmokmss/my-ambient-agents', 'https://tmokmss.github.io/my-ambient-agents', 200);
  await held('acme/tool', 'https://acme.github.io/tool', 200);
  // 아직 열어보지 못한 것
  await held('acme/pending', 'https://pending.test', null);

  const settings = await getSettings();
  const stored = await db.select().from(crawlCandidates);
  expect(new Set(stored.map((row) => row.reason))).toEqual(new Set(['ambiguous']));

  const causes = await reviewQueueCauses(settings);
  expect(causes.total).toBe(3);
  expect(causes.truncated).toBe(false);
  expect(causes.counts).toEqual([
    { cause: 'host_excluded_subpath', count: 2 },
    { cause: 'page_status_unknown', count: 1 },
  ]);
});

it('갈래로 거르면 그 갈래의 후보만 나온다', async () => {
  await held('tmokmss/my-ambient-agents', 'https://tmokmss.github.io/my-ambient-agents', 200);
  await held('acme/pending', 'https://pending.test', null);

  const settings = await getSettings();
  const causes = await reviewQueueCauses(settings);
  const { entries } = await listAdminReviewEntries(settings, {
    state: 'needs_review', ids: causes.ids.get('page_status_unknown'),
  });
  expect(entries.map((entry) => entry.candidate.repo)).toEqual(['acme/pending']);
});

it('심사 항목마다 어디까지 통과하고 어디서 멈췄는지가 실린다', async () => {
  await held('tmokmss/my-ambient-agents', 'https://tmokmss.github.io/my-ambient-agents', 200);

  const { entries } = await listAdminReviewEntries(await getSettings(), { state: 'needs_review' });
  const verdict = entries[0].verdict!;
  expect(verdict).toMatchObject({ state: 'needs_review', reason: 'ambiguous', cause: 'host_excluded_subpath', matchesStored: true });
  // 멈춘 지점이 마지막이고, 그 앞은 전부 통과다
  expect(verdict.trace.at(-1)!.passed).toBe(false);
  expect(verdict.trace.slice(0, -1).every((step) => step.passed)).toBe(true);
  // 근거에는 무엇이 걸렸는지가 그대로 적힌다
  expect(verdict.trace.at(-1)!.detail).toContain('*.github.io');
  expect(verdict.trace.at(-1)!.detail).toContain('/my-ambient-agents');
});

it('기준이 바뀌면 저장된 판정과 다르다고 알린다', async () => {
  await held('acme/big', 'https://big.test', 200);
  // 판정 뒤에 스타 상한을 0으로 낮추면 지금 기준으로는 거부다
  await saveSettings({ judge: { maxStars: 0 } }, 'fixture');

  const { entries } = await listAdminReviewEntries(await getSettings(), { state: 'needs_review' });
  expect(entries[0].verdict).toMatchObject({ state: 'rejected', reason: 'large_oss', matchesStored: false });
});

it('지금 기준으로는 보류가 아닌 것과 원본이 없어 못 되짚는 것을 가른다', async () => {
  await held('acme/stale', 'https://stale.test', 200);
  // 판정 뒤에 기준이 바뀌어 지금은 거부다 — 사람이 볼 필요가 없다
  await saveSettings({ judge: { maxStars: 0 } }, 'fixture');
  // 원본이 없어 규칙 자체를 되짚을 수 없는 후보
  await crawl.recordJudgement({ repo: 'acme/orphan', productUrl: 'https://orphan.test', state: 'needs_review', reason: 'ambiguous', decidedBy: 'auto' });

  const causes = await reviewQueueCauses(await getSettings());
  expect(causes.counts).toEqual([
    { cause: 'resolved', count: 1 },
    { cause: 'unknown', count: 1 },
  ]);
  const { entries } = await listAdminReviewEntries(await getSettings(), {
    state: 'needs_review', ids: causes.ids.get('unknown'),
  });
  expect(entries.map((entry) => entry.candidate.repo)).toEqual(['acme/orphan']);
  expect(entries[0].verdict).toBeNull();
});

it('지금 기준으로는 보류가 아닌 것만 판정 대기로 되돌린다 — 지우지 않는다', async () => {
  await held('acme/stale', 'https://stale.test', 200);
  // 스타 0이라 아래 maxStars:0 에 걸리지 않는다 — 규칙 순서상 스타가 호스트 패턴보다 앞이다
  await held('acme/still', 'https://still.github.io/still', 200, 0);
  await saveSettings({ judge: { maxStars: 0 } }, 'fixture'); // stale 은 이제 거부로 갈린다

  const result = await requeueResolvedCandidates('테스트');
  expect(result).toMatchObject({ requeued: 1, byReason: [{ reason: 'rejected:large_oss', count: 1 }] });

  const rows = await db.select().from(crawlCandidates);
  // 후보는 그대로 있고 상태만 판정 대기로 돌아간다
  expect(rows).toHaveLength(2);
  expect(rows.find((row) => row.repo === 'acme/stale')?.state).toBe('new');
  expect(rows.find((row) => row.repo === 'acme/still')?.state).toBe('needs_review');
});

it('사람이 결정한 후보는 되돌리지 않는다', async () => {
  await held('acme/decided', 'https://decided.test', 200);
  await db.update(crawlCandidates).set({ decidedBy: 'admin' });
  await saveSettings({ judge: { maxStars: 0 } }, 'fixture');

  expect(await requeueResolvedCandidates('테스트')).toMatchObject({ requeued: 0 });
  expect((await db.select().from(crawlCandidates))[0].state).toBe('needs_review');
});

it('AI가 거부로 판정한 것은 따로 센다 — 규칙이 못 가른 것을 AI가 갈랐다는 뜻이다', async () => {
  await held('acme/lib', 'https://acme.github.io/lib', 200);
  await held('acme/app', 'https://acme.github.io/app', 200);

  const [candidate] = await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, 'acme/lib'));
  const settings = await getSettings();
  const input = await loadReviewInput(candidate, (await crawl.getDocument('acme/lib'))!, settings);
  await db.insert(crawlReviewAttempts).values({
    candidateId: candidate.id, kind: 'automatic', state: 'succeeded', attemptNumber: 1,
    inputHash: input.inputHash, policyHash: input.policyHash, sourceRevisionHash: input.sourceRevisionHash,
    snapshot: input.snapshot, source: input.source, promptVersion: 'v', rulesVersion: 'v',
    provider: 'claude-cli', model: 'sonnet', startedAt: new Date(), completedAt: new Date(),
    validUntil: input.validUntil, outcome: { decision: 'reject', reason: '라이브러리 문서 사이트', evidenceIds: [] },
  });

  const causes = await reviewQueueCauses(settings);
  expect(causes.counts).toEqual([
    { cause: 'ai_reject', count: 1 },
    { cause: 'host_excluded_subpath', count: 1 },
  ]);
  const { entries } = await listAdminReviewEntries(settings, { state: 'needs_review', ids: causes.ids.get('ai_reject') });
  expect(entries.map((e) => e.candidate.repo)).toEqual(['acme/lib']);
  expect(entries[0].review).toMatchObject({ decision: 'reject', model: 'sonnet' });
});
