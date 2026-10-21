import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { cdnPurges, crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, jobs, productEvidenceAudit, products, secondReviews,
  type ProductStatus } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { inSample, pendingSecondReviews, publishedSecondReviews, secondReviewSummary } from '@/lib/crawl/second-review';
import { humanQueueOverview } from '@/lib/crawl/review-overview';
import { decidePublishedSecondReview } from '@/lib/crawl/published-second-review';
import { banReasonLabel } from '@/app/(operator)/admin/products/ban-reasons';
import { ensureSchema } from './setup';
import { enqueueSecondReviewsFixture as enqueue, recordSecondReviewFixture } from './second-review-receipt-fixtures';

/**
 * 공개분 2차 표본 — 프로드의 실제 모양으로 심는다.
 *
 * 규칙·AI 1차(auto)가 올린 후보는 decided_at 이 비어 있고, DeepSeek 이 정한 것은 정한 때가 적힌다.
 * 공개 시각은 제품 행이 생긴 때다. 2026-10-21 프로드에서 decided_at 으로 재던 선택이 한 행도 만들지 않았다.
 */
const PREFIX = 'pub-second-';
const hours = (count: number) => new Date(Date.now() - count * 3_600_000);
const RISKY = 'the quick way to plan all of your week with friends';

beforeAll(() => ensureSchema());
async function clean() {
  await db.delete(products).where(like(products.slug, `${PREFIX}%`));
  await db.delete(cdnPurges).where(like(cdnPurges.slug, `${PREFIX}%`));
  await db.delete(productEvidenceAudit).where(like(productEvidenceAudit.slug, `${PREFIX}%`));
}
afterAll(clean);
beforeEach(async () => {
  await clean();
  for (const table of [secondReviews, jobs, crawlReviewAttempts, crawlCandidates, crawlDocuments, crawlSettings]) await db.delete(table);
  await saveSettings({ enabled: true, secondReview: { enabled: true, voters: [{ provider: 'claude-cli', model: 'opus' }], sampleRate: 0, agreeAt: 0.85 } }, 'fixture');
});

async function published(name: string, options: { title?: string; decidedBy?: 'auto' | 'deepseek' | 'admin'; decidedAt?: Date | null;
  createdAt?: Date; status?: ProductStatus } = {}) {
  const repo = `pub-second/${name}`, slug = `${PREFIX}${name}`, url = `https://${slug}.test`;
  const decidedBy = options.decidedBy ?? 'auto';
  await crawl.putDocument({ repo, productUrl: url, pageStatus: 200,
    repoMeta: { description: '배포한 서비스', stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: 'User' } },
    pageMeta: { title: options.title ?? RISKY, textSample: '쓸 수 있는 앱' } });
  await db.insert(products).values({ slug, url, repoUrl: `https://github.com/${repo}`, name: options.title ?? RISKY, tagline: '제품',
    description: '배포된 제품', category: 'Dev', status: options.status ?? 'seeded', source: 'crawler', verifyToken: randomUUID(),
    editTokenHash: 'a'.repeat(64), createdAt: options.createdAt ?? hours(1) });
  // 발행은 상태·slug 만 바꾼다(publication-guard.ts). decided_at 은 결정한 쪽이 적은 그대로다
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: url, state: 'published', reason: 'passed', decidedBy,
    publishedSlug: slug, judgedAt: hours(30), signals: {},
    decidedAt: options.decidedAt !== undefined ? options.decidedAt : decidedBy === 'auto' ? null : hours(2) }).returning();
  return candidate;
}

/** 표본률에 드는(또는 들지 않는) 이름 — 레포 이름으로 정해지므로 찾아서 쓴다 */
function sampleName(rate: number, wanted: boolean, tag: string) {
  for (let index = 0; ; index++) if (inSample(`pub-second/${tag}-${index}`, rate) === wanted) return `${tag}-${index}`;
}

it('자동·DeepSeek 이 최근 공개한 것 중 위험 신호나 표본에 든 것만 올린다 — 사람 승인·오래된 것·내려간 것은 뺀다', async () => {
  await saveSettings({ secondReview: { enabled: true, voters: [{ provider: 'claude-cli', model: 'opus' }], sampleRate: 0.5, agreeAt: 0.85 } }, 'fixture');
  const sampled = sampleName(0.5, true, 'sampled'), skipped = sampleName(0.5, false, 'skipped');
  await published('auto-risk');
  // 닷새 전에 정했어도 공개가 한 시간 전이면 최근 공개분이다
  await published('deepseek-risk', { decidedBy: 'deepseek', decidedAt: hours(120) });
  await published(sampled, { title: 'Plain' });
  await published(skipped, { title: 'Plain' });
  await published('admin-risk', { decidedBy: 'admin' });
  await published('auto-old', { createdAt: hours(72) });
  await published('deepseek-banned', { decidedBy: 'deepseek', status: 'banned' });

  expect(await enqueue(await getSettings())).toBe(3);
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.repo);
  expect(rows.map(row => [row.repo, row.trigger, row.publishedSlug, row.model, row.status])).toEqual([
    ['pub-second/auto-risk', 'risk', `${PREFIX}auto-risk`, 'opus', 'pending'],
    ['pub-second/deepseek-risk', 'risk', `${PREFIX}deepseek-risk`, 'opus', 'pending'],
    [`pub-second/${sampled}`, 'sample', `${PREFIX}${sampled}`, 'opus', 'pending'],
  ]);
  expect(rows.every(row => row.firstDecision === 'approve' && row.firstAttemptId === null && row.firstConfidence === null)).toBe(true);
  expect(rows[0].signals).toEqual(['sentence_name']);
});

it('공개분은 제품·모델마다 한 번만 본다 — 다시 돌거나 원본이 바뀌어도 다시 뽑지 않고, 사람을 기다리는 표를 닫지 않는다', async () => {
  const candidate = await published('once');
  expect(await enqueue(await getSettings())).toBe(1);
  expect(await enqueue(await getSettings())).toBe(0);
  const [pending] = await pendingSecondReviews(5);
  await recordSecondReviewFixture(pending.id, { ok: true, decision: 'reject', confidence: 0.9, reason: 'The page only shows a sign-in form.',
    model: 'opus', provider: 'claude-cli', status: 'needs_human' });

  // 원본이 바뀌면 입력 세대가 바뀐다 — 세대로 가르면 같은 제품을 다시 뽑고 위의 표를 닫는다
  await db.update(crawlDocuments).set({ pageMeta: { title: RISKY, textSample: '바뀐 본문' }, fetchedAt: new Date() })
    .where(eq(crawlDocuments.repo, candidate.repo));
  expect(await enqueue(await getSettings())).toBe(0);
  expect((await db.select().from(secondReviews)).map(row => [row.id, row.status])).toEqual([[pending.id, 'needs_human']]);
});

it('표를 내기 전에 입력이 바뀌어 닫힌 공개분은 이틀 안이면 다시 올린다', async () => {
  const candidate = await published('expired');
  expect(await enqueue(await getSettings())).toBe(1);
  const [first] = await db.select().from(secondReviews);
  // 원본이 바뀌어 대기 중이던 표를 부르지 못하고 닫았다(recordSecondReview 의 input_changed)
  await db.update(crawlDocuments).set({ pageMeta: { title: RISKY, textSample: '바뀐 본문' }, fetchedAt: new Date() })
    .where(eq(crawlDocuments.repo, candidate.repo));
  await db.update(secondReviews).set({ status: 'resolved', resolution: 'superseded', resolvedAt: new Date() }).where(eq(secondReviews.id, first.id));
  expect(await enqueue(await getSettings())).toBe(1);
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
  expect(rows.map(row => row.status)).toEqual(['resolved', 'pending']);
  expect(rows[1].generationKey).not.toBe(first.generationKey);
  expect(await enqueue(await getSettings())).toBe(0);
});

it('2차가 제품이 아니라고 본 공개분은 심사 화면의 공개분 확인에 뜨고, 내리면 누가·왜를 남긴다', async () => {
  await published('to-ban', { decidedBy: 'deepseek' });
  expect(await enqueue(await getSettings())).toBe(1);
  const [pending] = await pendingSecondReviews(5);
  await recordSecondReviewFixture(pending.id, { ok: true, decision: 'reject', confidence: 0.92, reason: 'The page only shows a sign-in form.',
    model: 'opus', provider: 'claude-cli', status: 'needs_human' });

  // /admin/review?second=published 의 목록과 탭의 수
  expect((await publishedSecondReviews()).map(row => [row.publishedSlug, row.secondDecision, row.trigger]))
    .toEqual([[`${PREFIX}to-ban`, 'reject', 'risk']]);
  expect((await humanQueueOverview(await getSettings())).secondPublished).toBe(1);
  expect((await secondReviewSummary(0.85)).counts.published).toBe(1);

  expect(await decidePublishedSecondReview({ id: pending.id, slug: `${PREFIX}to-ban`, decision: 'ban', actor: 'reviewer' })).toBe(true);
  const [audit] = await db.select().from(productEvidenceAudit).where(eq(productEvidenceAudit.slug, `${PREFIX}to-ban`));
  expect(audit).toMatchObject({ actor: 'reviewer', action: 'admin.product.ban', reason: 'second_review:login',
    metadata: { source: 'second-review', secondReviewId: pending.id, trigger: 'risk', status: 'banned' } });
  expect(banReasonLabel(audit.reason!)).toBe('2차 심사: 로그인 화면만');
  expect(await publishedSecondReviews()).toEqual([]);
});
