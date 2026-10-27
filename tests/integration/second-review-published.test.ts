import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { agentRepositoryScans, cdnPurges, crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, modelCapacityRequests, productEvidenceAudit, products, secondReviews,
  type ProductStatus } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { inSample, pendingSecondReviews, publishedInputHash, publishedSecondReviews, reconcileStaleSecondReviews, secondReviewSummary } from '@/lib/crawl/second-review';
import { loadReviewInput } from '@/lib/crawl/agent-review-repository';
import { secondReviewGeneration } from '@/lib/crawl/second-review-input';
import { capacityBlocksStaleReconcile, protectingCapacityExistsSql, staleReviewCapacityProbeSql, staleSecondReviewHintSql,
  staleSecondReviewScanDemand, STALE_REVIEW_OWNER } from '@/lib/crawl/second-review-stale';
import { humanQueueOverview } from '@/lib/crawl/review-overview';
import { decidePublishedSecondReview } from '@/lib/crawl/published-second-review';
import { banReasonLabel } from '@/app/(operator)/admin/products/ban-reasons';
import { ensureSchema } from './setup';
import { enqueueSecondReviewsFixture as enqueue, recordSecondReviewFixture, withLegacySecondReviewJob } from './second-review-receipt-fixtures';

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
  await db.delete(agentRepositoryScans).where(like(agentRepositoryScans.repositoryKey, 'pub-second/%'));
  await db.delete(crawlFrontier).where(like(crawlFrontier.repo, 'pub-second/%'));
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

async function stalePublishedFixture(name: string) {
  const candidate = await published(name, { createdAt: hours(120) });
  const settings = await getSettings();
  await db.update(crawlDocuments).set({ fetchedAt: hours(1) }).where(eq(crawlDocuments.repo, candidate.repo));
  const [document] = await db.select().from(crawlDocuments).where(eq(crawlDocuments.repo, candidate.repo));
  const [scan] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(100_000_000 + candidate.id),
    repositoryKey: candidate.repo, commitSha: 'a'.repeat(40), detectorVersion: settings.agentEvidence.detectorVersion,
    scope: '', scopeHash: 'a'.repeat(64), state: 'complete', startedAt: hours(1), completedAt: hours(1),
    nextAttemptAt: hours(-23) }).returning();
  const input = await loadReviewInput(candidate, document, settings);
  const [vote] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo: candidate.repo,
    publishedSlug: candidate.publishedSlug, trigger: 'risk', firstDecision: 'approve', firstAttemptId: null,
    provider: 'claude-cli', model: 'opus', generationKey: secondReviewGeneration(null, input),
    inputHash: publishedInputHash(candidate.publishedSlug!), errorCode: 'input_changed', errorDetail: 'historical failure', failureCount: 1 }).returning();
  return { candidate, document, scan, vote };
}
const reconcileStale = () => withLegacySecondReviewJob(lease => reconcileStaleSecondReviews(undefined, lease));

it('finds policy-only changes and explicitly retires demand when fresh evidence no longer requires a sample', async () => {
  const value = await stalePublishedFixture('stale-policy');
  await saveSettings({ agentEvidence: { policyVersion: 'ai2-stale-policy-v2' } }, 'fixture');
  await reconcileStale();
  expect((await db.select().from(secondReviews).orderBy(secondReviews.id)).map(row => row.status)).toEqual(['resolved', 'pending']);
  await db.update(crawlDocuments).set({ fetchedAt: new Date(), pageMeta: { title: 'Taskly', textSample: 'Create projects in the application' } })
    .where(eq(crawlDocuments.id, value.document.id));
  await reconcileStale();
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
  expect(rows.every(row => row.status === 'resolved' && row.resolution === 'not_required' && row.resolvedBy === STALE_REVIEW_OWNER)).toBe(true);
  expect(await reconcileStale()).toBe(0);
});

it('leaves a stale vote and its live capacity reservation unchanged', async () => {
  const value = await stalePublishedFixture('stale-reserved');
  await db.update(crawlDocuments).set({ fetchedAt: new Date() }).where(eq(crawlDocuments.id, value.document.id));
  const [request] = await db.insert(modelCapacityRequests).values({ requestId: randomUUID(),
    ownerInstanceId: 'ai2-stale-fixture', ownerBootId: randomUUID(), class: 'second', pool: 'reviewer',
    routeId: 'second-review', provider: 'claude-cli', model: 'opus', providerBudgetId: 'fixture', groupId: 'fixture',
    epoch: 1, revision: 1, policyHash: 'a'.repeat(64), state: 'reserved', token: randomUUID(), reservedUntil: hours(-1),
    queueUntil: hours(-1), logicalWorkKey: `ai2:${value.candidate.id}:${value.vote.id}`,
    workKey: `ai2:${value.candidate.id}:${value.vote.id}:${'b'.repeat(64)}` }).returning();
  try {
    let saves = 0;
    expect(await withLegacySecondReviewJob(lease => reconcileStaleSecondReviews(undefined, lease, {
      afterCandidateId: 0, save: async () => { saves++; },
    }))).toBe(0);
    expect(saves).toBe(0);
    expect(await db.select().from(secondReviews)).toEqual([value.vote]);
    expect(await db.select().from(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, request.requestId))).toEqual([request]);
  } finally { await db.delete(modelCapacityRequests).where(eq(modelCapacityRequests.requestId, request.requestId)); }
});

it('fails closed on unbound active/unknown AI2 requests and null reservation times while excluding unrelated routes', async () => {
  for (const state of ['dispatched', 'indeterminate', 'unknown', 'reserved']) for (const route of ['second-review', 'unrelated-background']) {
    const [row] = await db.execute<{ busy: boolean; probe_busy: boolean }>(sql`WITH model_capacity_requests AS (
      SELECT ${state}::text state, ${route}::text route_id, NULL::text logical_work_key,
        'malformed'::text work_key, ${state === 'reserved' ? sql`NULL::timestamptz` : sql`clock_timestamp() - interval '1 day'`} reserved_until
    ) SELECT ${protectingCapacityExistsSql(sql`123`)} AS busy,
      EXISTS (SELECT 1 FROM (${staleReviewCapacityProbeSql(123)}) protected) AS probe_busy`);
    expect(row.busy).toBe(route === 'second-review');
    expect(row.probe_busy).toBe(row.busy);
  }
});

it('keeps reservations that expired after the callback tick for its original time check', async () => {
  const rows = await db.execute<{ state: string; reserved_until: Date | string }>(sql`WITH model_capacity_requests AS (
    SELECT 'reserved'::text state, 'second-review'::text route_id, 'ai2:123:456'::text logical_work_key,
      'ai2:123:456:binding'::text work_key, clock_timestamp() - interval '1 second' reserved_until
  ) ${staleReviewCapacityProbeSql(123)}`);
  expect(rows).toHaveLength(1);
  const reservation = { state: rows[0].state, reservedUntil: rows[0].reserved_until };
  const expiry = new Date(rows[0].reserved_until).getTime();
  expect(capacityBlocksStaleReconcile(reservation, new Date(expiry - 1))).toBe(true);
  expect(capacityBlocksStaleReconcile(reservation, new Date(expiry + 1))).toBe(false);
});

it('plans one capacity-history scan outside candidate-correlated hint and protection probes', async () => {
  const value = await stalePublishedFixture('stale-capacity-plan');
  type Plan = { 'Node Type': string; 'Relation Name'?: string; 'CTE Name'?: string; Plans?: Plan[] };
  const flatten = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(flatten)];
  for (const query of [staleSecondReviewHintSql(0, 25), staleReviewCapacityProbeSql(value.candidate.id)]) {
    const rows = await db.execute<{ 'QUERY PLAN': { Plan: Plan }[] }>(sql`EXPLAIN (FORMAT JSON) ${query}`);
    const nodes = flatten(rows[0]['QUERY PLAN'][0].Plan);
    expect(nodes.filter(node => node['Relation Name'] === 'model_capacity_requests')).toHaveLength(1);
    expect(nodes.some(node => node['Node Type'] === 'CTE Scan' && node['CTE Name'] === 'stale_review_protecting_capacity')).toBe(true);
  }
});

it('keeps old published demand beyond a week and creates the fresh generation only once', async () => {
  const value = await stalePublishedFixture('stale-demand');
  await db.update(crawlDocuments).set({ fetchedAt: hours(48) }).where(eq(crawlDocuments.id, value.document.id));
  await db.update(agentRepositoryScans).set({ completedAt: hours(48) }).where(eq(agentRepositoryScans.id, value.scan.id));
  expect(await reconcileStale()).toBeGreaterThan(0);
  let rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ status: 'resolved', resolution: 'superseded', resolvedBy: STALE_REVIEW_OWNER,
    errorCode: 'input_changed', errorDetail: 'historical failure', failureCount: 1 });
  expect((await db.select().from(crawlFrontier).where(eq(crawlFrontier.repo, value.candidate.repo)))[0].state).toBe('pending');
  await db.update(secondReviews).set({ resolvedAt: hours(24 * 9) }).where(eq(secondReviews.id, value.vote.id));
  const settings = await getSettings();
  const demand = () => db.execute<{ repository_key: string }>(sql`SELECT repository_key
    FROM ${staleSecondReviewScanDemand(settings.agentEvidence.detectorVersion)} demand`);
  expect((await demand()).map(row => row.repository_key)).toContain(value.candidate.repo);
  expect(await db.execute(sql`SELECT repository_key FROM ${staleSecondReviewScanDemand(settings.agentEvidence.detectorVersion, false)} demand`)).toEqual([]);
  await db.update(crawlDocuments).set({ fetchedAt: new Date() }).where(eq(crawlDocuments.id, value.document.id));
  await db.update(agentRepositoryScans).set({ completedAt: new Date() }).where(eq(agentRepositoryScans.id, value.scan.id));
  expect(await reconcileStale()).toBeGreaterThan(0);
  rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
  expect(rows.map(row => row.status)).toEqual(['resolved', 'pending']);
  expect(rows[1].generationKey).not.toBe(value.vote.generationKey);
  expect(await reconcileStale()).toBe(0);
  expect(await db.select().from(secondReviews).orderBy(secondReviews.id)).toEqual(rows);
  await db.update(secondReviews).set({ status: 'needs_human' }).where(eq(secondReviews.id, rows[1].id));
  await db.update(agentRepositoryScans).set({ completedAt: hours(48) }).where(eq(agentRepositoryScans.id, value.scan.id));
  expect(await demand()).toEqual([]);
});

it('restores a stale fallback chain to one fresh primary and preserves its failed calls', async () => {
  await saveSettings({ secondReview: { fallbacks: [{ provider: 'claude-cli', model: 'backup' }] } }, 'fixture');
  const value = await stalePublishedFixture('stale-fallback');
  await db.update(secondReviews).set({ status: 'resolved', resolution: 'fallback', errorCode: 'timeout', resolvedAt: new Date() })
    .where(eq(secondReviews.id, value.vote.id));
  await db.insert(secondReviews).values({ ...value.vote, id: undefined, model: 'backup', fallbackForId: value.vote.id });
  await db.update(crawlDocuments).set({ fetchedAt: new Date() }).where(eq(crawlDocuments.id, value.document.id));
  await reconcileStale();
  const rows = await db.select().from(secondReviews).orderBy(secondReviews.id);
  expect(rows.map(row => [row.model, row.status, row.resolution])).toEqual([
    ['opus', 'resolved', 'superseded'], ['backup', 'resolved', 'superseded'], ['opus', 'pending', null],
  ]);
  expect(rows[0]).toMatchObject({ errorCode: 'timeout', failureCount: 1, resolvedBy: STALE_REVIEW_OWNER });
  expect(rows[2].fallbackForId).toBeNull();
  expect(await reconcileStale()).toBe(0);
});

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
