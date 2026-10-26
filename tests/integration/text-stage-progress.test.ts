import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { db } from '@/lib/db';
import * as schema from '@/lib/db/schema';
import { crawlCandidates, crawlDocuments, crawlTaglines, jobs, operationsObservations, products, productIntroChecks,
  productKoreanTaglines, productTranslations, secondReviews, textTranslations } from '@/lib/db/schema';
import { textHash } from '@/lib/crawl/translate';
import { productTranslationSourceHash } from '@/lib/domain/products/translation-policy';
import { readWorkerProgress } from '@/lib/operations/worker-progress-query';
import { readModelCapacityControlObservation } from '@/lib/llm/capacity-repository';
import { progressNeedsKoreanSql, progressReasonNeedsKoreanSql, readTextStageProgress, textStageProgressSql } from '@/lib/operations/text-stage-progress';
import { TRANSLATION_NEEDS_KOREAN_SQL } from '@/lib/crawl/translations';
import { NEEDS_KOREAN } from '@/lib/domain/products/korean-tagline';
import { clearAllMemos } from '@/lib/cache/memo';
import { pendingTaglines, recordTaglineResult } from '@/lib/crawl/taglines';
import { pendingIntroChecks, recordIntroCheck } from '@/lib/domain/products/intro-checks';
import { runJob } from '@/lib/jobs/runner';
import { ensureSchema, resetTables, TEST_DATABASE_URL } from './setup';

beforeAll(ensureSchema);
beforeEach(async () => {
  await resetTables();
  await db.delete(secondReviews); await db.delete(textTranslations);
  await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlTaglines);
  await db.delete(jobs);
  await db.delete(operationsObservations);
  await db.insert(operationsObservations).values(['scheduler', 'crawler', 'reviewer', 'publisher', 'maintenance', 'text']
    .map(role => ({ key: `service:${role}:fixture`, value: { status: 'running' }, observedAt: new Date() })));
  vi.stubEnv('KOREAN_TRANSLATION_QWEN_ENABLED', 'false'); vi.stubEnv('KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED', 'false');
});
afterEach(() => vi.unstubAllEnvs());

async function product(slug: string) {
  const [row] = await db.insert(products).values({ slug, name: slug, url: `https://${slug}.test`, tagline: 'A tool to organize team projects',
    description: 'Manage team projects', category: 'Dev', status: 'seeded', source: 'crawler', taglineSource: 'ai_page',
    verifyToken: 'v', editTokenHash: 'e', createdAt: sql`now() - interval '2 hours'` as unknown as Date,
  }).returning();
  return row;
}
async function demand(row: Awaited<ReturnType<typeof product>>, extra: Partial<typeof productTranslations.$inferInsert> = {}) {
  await db.insert(productTranslations).values({ productId: row.id, locale: 'en', field: 'tagline', status: 'pending',
    sourceHash: productTranslationSourceHash(row, 'tagline'), model: '', attempts: 0,
    provenance: { kind: 'machine', source: 'ai_page', policy: 'product-translation-v1' },
    updatedAt: sql`now() - interval '2 hours'` as unknown as Date, ...extra,
  });
}
const stage = async (key: string) => (await readWorkerProgress()).stages.find(row => row.stage === key);

it('preserves the canonical Korean word ratio across scalar regex and whitespace boundaries', async () => {
  const lines: Array<string | null> = [null, '', ' ', '\t', '\n', '\r\n', '한글', 'english', '한글 English', '한글 English words'];
  for (const left of ['', '한글', 'English', '한글English', '中文', '🛠️', 'a한글b'])
    for (const right of ['', '도구', 'project', '한글English', '日本語', '2', 'b한글c'])
      for (const gap of [' ', '  ', '\t', '\n', '\r\n', '\u00a0', '\v', '\f', '\\s', '\u200b'])
        for (const edge of ['', ' ', '\t', '\n', '\u00a0']) lines.push(edge + left + gap + right + edge);
  const [row] = await db.execute<{ cases: number; mismatches: number }>(sql`
    WITH products AS (SELECT unnest(ARRAY[${sql.join(lines.map(line => sql`${line}`), sql`, `)}]::text[]) AS tagline),
    compared AS (SELECT ${NEEDS_KOREAN} AS canonical, ${progressNeedsKoreanSql()} AS scalar FROM products)
    SELECT count(*)::int AS cases, count(*) FILTER (WHERE canonical IS DISTINCT FROM scalar)::int AS mismatches FROM compared`);
  expect(row).toEqual({ cases: lines.length, mismatches: 0 });
});

it('groups repeated reason sources before hashing while retaining the newest source age and retry policy', async () => {
  const body = 'An English reason shared by multiple independent review records';
  const sources = [{ body, minutes: 120 }, { body, minutes: 60 }, { body: '한국어로 충분히 작성한 심사 설명입니다', minutes: 180 }];
  for (const [index, source] of sources.entries()) {
    const [candidate] = await db.insert(crawlCandidates).values({ repo: `fixture/reason-${index}`, state: 'approved' }).returning();
    await db.insert(secondReviews).values({ candidateId: candidate.id, repo: candidate.repo, trigger: 'sample',
      firstDecision: 'approve', inputHash: 'a'.repeat(64), provider: 'abcllm', model: 'fixture', secondReason: source.body,
      reviewedAt: new Date(Date.now() - source.minutes * 60_000) });
  }
  const first = await stage('reason-translate');
  expect(first).toMatchObject({ waiting: 1, deferred: 0, completed5m: 0 });
  expect(first!.oldestMinutes).toBeGreaterThanOrEqual(59);
  expect(first!.oldestMinutes).toBeLessThan(62);
  await db.insert(textTranslations).values({ sourceHash: textHash(body), targetLang: 'ko', status: 'failed', attempts: 2,
    errorCode: 'timeout', retryAt: new Date('2100-01-01'), updatedAt: new Date() });
  expect(await stage('reason-translate')).toMatchObject({ waiting: 0, deferred: 1, providerErrors: 1 });
});

it('preserves the canonical reason character ratio at Korean, ASCII, Unicode and 30 percent boundaries', async () => {
  const bodies: Array<string | null> = [null, '', ' ', '\t', '한국어', 'English', '中文', 'éÖİıßΑβЖ', '한글 中文éÖİıßΑβЖ\n🛠️'];
  for (const korean of [0, 1, 2, 3, 4, 7, 10, 29, 30, 31, 70])
    for (const ascii of [0, 1, 2, 3, 7, 9, 10, 11, 23, 70, 71, 100])
      for (const extra of ['', '中文\n\t🛠️', 'éÖİıßΑβЖ']) bodies.push('한'.repeat(korean) + 'a'.repeat(ascii) + extra);
  const [row] = await db.execute<{ cases: number; mismatches: number }>(sql`
    WITH source_rows AS (SELECT unnest(ARRAY[${sql.join(bodies.map(body => sql`${body}`), sql`, `)}]::text[]) AS body),
    compared AS (SELECT ${TRANSLATION_NEEDS_KOREAN_SQL} AS canonical, ${progressReasonNeedsKoreanSql()} AS scalar FROM source_rows)
    SELECT count(*)::int AS cases, count(*) FILTER (WHERE canonical IS DISTINCT FROM scalar)::int AS mismatches FROM compared`);
  expect(row).toEqual({ cases: bodies.length, mismatches: 0 });
});

it('sees a stalled product translation independently of recent Korean tagline output', async () => {
  const row = await product('independent-output');
  await demand(row);
  await db.insert(productKoreanTaglines).values({ productId: row.id, sourceTagline: row.tagline,
    taglineKo: '팀 프로젝트를 관리하는 도구', model: 'fixture', attempts: 1 });
  expect(await stage('product-translate')).toMatchObject({ role: 'text', job: 'product-translate', reason: 'no_progress',
    waiting: 1, alarm: true, restartEligible: false });
  expect(await stage('tagline-ko')).toMatchObject({ waiting: 0, alarm: false });
});

it('preserves scheduled retry, exhausted attempts and current intro editor holds', async () => {
  const future = await product('retry-future'), exhausted = await product('retry-exhausted'), held = await product('intro-held');
  await demand(future, { status: 'failed', attempts: 1, errorCode: 'timeout', retryAt: new Date('2100-01-01'), updatedAt: new Date() });
  await demand(exhausted, { status: 'failed', attempts: 4, errorCode: 'invalid_output' });
  await demand(held);
  await db.insert(productIntroChecks).values({ productId: held.id, checkedTagline: held.tagline, outcome: 'needs_editor', model: 'fixture' });
  expect(await stage('product-translate')).toMatchObject({ waiting: 0, deferred: 1, manualAttention: 1,
    alarm: false, restartEligible: false });
  await db.insert(jobs).values({ name: 'product-intro-check', notBefore: new Date('2100-01-01') });
  expect(await stage('intro-check')).toMatchObject({ reason: 'paused', alarm: false, restartEligible: false });
});

it('alerts on persisted aged provider failures without restarting or rewriting attempts', async () => {
  const row = await product('provider-failed');
  await demand(row, { status: 'failed', attempts: 2, errorCode: 'timeout', retryAt: sql`now() - interval '40 minutes'` as unknown as Date });
  expect(await stage('product-translate')).toMatchObject({ reason: 'upstream_stalled', alarm: true, restartEligible: false });
  expect((await db.select().from(productTranslations).where(eq(productTranslations.productId, row.id)))[0])
    .toMatchObject({ attempts: 2, status: 'failed', errorCode: 'timeout' });
});

it('does not carry an old document retry or failure into fresh crawl-tagline work', async () => {
  const repo = 'fixture/changed-document';
  await db.insert(crawlCandidates).values({ repo, state: 'needs_review', reason: 'no_description', decidedBy: 'auto',
    updatedAt: sql`now() - interval '2 hours'` as unknown as Date });
  await db.insert(crawlDocuments).values({ repo, repoMeta: {}, fetchedAt: new Date() });
  await db.insert(crawlTaglines).values({ repo, tagline: '', source: 'page', model: 'fixture', sourceHash: 'x',
    documentAt: sql`now() - interval '2 hours'` as unknown as Date, errorCode: 'timeout', attempts: 1,
    updatedAt: sql`now() - interval '2 hours'` as unknown as Date, retryAt: new Date('2100-01-01') });
  expect(await stage('crawl-tagline')).toMatchObject({ waiting: 1, deferred: 0, errors5m: 0, providerErrors: 0,
    reason: 'warming_up', alarm: false, restartEligible: false });
});

it('uses the same extra home rejection allowance as the Korean translation worker', async () => {
  const home = await product('home-allowance'), ordinary = await product('ordinary-exhausted');
  await db.update(products).set({ stars: 5_000 }).where(eq(products.id, home.id));
  await db.update(products).set({ repoUrl: 'https://github.com/fixture/ordinary-exhausted', repoStatus: null })
    .where(eq(products.id, ordinary.id));
  await db.insert(productKoreanTaglines).values([
    { productId: home.id, sourceTagline: home.tagline, model: 'fixture', errorCode: 'rejected:empty', qualityRejections: 5, attempts: 5 },
    { productId: ordinary.id, sourceTagline: ordinary.tagline, model: 'fixture', errorCode: 'rejected:empty', qualityRejections: 4, attempts: 4 },
  ]);
  expect(await stage('tagline-ko')).toMatchObject({ waiting: 1, manualAttention: 1, restartEligible: false });
});

it('counts a real crawl-tagline success after the writer releases its candidate from the eligible queue', async () => {
  for (const repo of ['fixture/completed-line', 'fixture/old-line-backlog']) {
    await db.insert(crawlCandidates).values({ repo, state: 'needs_review', reason: 'no_description', decidedBy: 'auto',
      updatedAt: sql`now() - interval '2 hours'` as unknown as Date });
    await db.insert(crawlDocuments).values({ repo, repoMeta: {}, fetchedAt: sql`now() - interval '2 hours'` as unknown as Date });
  }
  expect(await stage('crawl-tagline')).toMatchObject({ waiting: 2, reason: 'no_progress' });
  const task = (await pendingTaglines(10)).find(row => row.candidate.repo === 'fixture/completed-line')!;
  expect(await runJob<null>('crawl-tagline', async ctx => {
    expect(await recordTaglineResult(task, ctx.lease!, { kind: 'success', tagline: 'Manage project tasks', source: 'page', model: 'fixture' }))
      .toMatchObject({ stored: true, released: true });
    return { done: true };
  })).toMatchObject({ status: 'completed' });
  expect((await db.select().from(crawlCandidates).where(eq(crawlCandidates.repo, task.candidate.repo)))[0]).toMatchObject({ state: 'approved' });
  expect(await stage('crawl-tagline')).toMatchObject({ waiting: 1, completed5m: 1, reason: 'progressing', alarm: false });
  await db.update(crawlDocuments).set({ fetchedAt: new Date() }).where(eq(crawlDocuments.repo, task.candidate.repo));
  expect(await stage('crawl-tagline')).toMatchObject({ waiting: 1, completed5m: 0, reason: 'no_progress', alarm: true });
});

it('counts a real intro correction after ai_fixed leaves the eligibility predicate', async () => {
  const completed = await product('corrected-intro'), pending = await product('old-intro-backlog');
  for (const id of [completed.id, pending.id])
    await db.update(products).set({ updatedAt: sql`now() - interval '2 hours'` as unknown as Date }).where(eq(products.id, id));
  expect(await stage('intro-check')).toMatchObject({ waiting: 2, reason: 'no_progress' });
  const task = (await pendingIntroChecks(10)).find(row => row.product.id === completed.id)!;
  expect(await runJob<null>('product-intro-check', async ctx => {
    expect(await recordIntroCheck(task, ctx.lease!, { kind: 'success', judgement: { verdict: 'wrong', problem: 'fixture correction',
      corrected: 'Organize project tasks and team schedules' }, model: 'fixture' })).toBe('replaced');
    return { done: true };
  })).toMatchObject({ status: 'completed' });
  expect((await db.select().from(products).where(eq(products.id, completed.id)))[0]).toMatchObject({ taglineSource: 'ai_fixed' });
  expect(await stage('intro-check')).toMatchObject({ waiting: 1, completed5m: 1, reason: 'progressing', alarm: false });
});

it('runs the canonical reader with SELECT-only monitor grants and refuses writes', async () => {
  await product('readonly-proof');
  const role = 'text_stage_monitor_fixture';
  const tables = ['role_leases', 'operations_observations', 'crawl_settings', 'jobs', 'job_batch_control', 'agent_scan_control',
    'uptime_split_control', 'crawl_documents', 'crawl_frontier', 'crawl_candidates', 'crawl_review_attempts', 'second_reviews',
    'crawl_publication_changes', 'category_decisions', 'pipeline_item_leases', 'products', 'product_links', 'product_evidence_sources',
    'agent_repository_scans', 'repository_ai_levels', 'agent_repository_claims', 'uptime_control', 'uptime_claims', 'product_health',
    'uptime_host_breakers', 'text_translations', 'crawl_taglines', 'product_translations', 'product_korean_taglines',
    'product_intro_checks', 'product_maker_members', 'product_search_profiles', 'takedown_requests', 'model_capacity_control',
    'uptime_gates', 'uptime_observations', 'pipeline_stage_modes', 'dr_writer_fence'];
  await db.execute(sql.raw(`CREATE ROLE ${role} LOGIN PASSWORD 'local-fixture-only' NOSUPERUSER NOCREATEDB NOCREATEROLE`));
  await db.execute(sql.raw(`GRANT USAGE ON SCHEMA public TO ${role}`));
  await db.execute(sql.raw(`GRANT SELECT ON ${tables.join(', ')} TO ${role}`));
  const url = new URL(TEST_DATABASE_URL); url.username = role; url.password = 'local-fixture-only';
  const client = postgres(url.href, { max: 1, onnotice: () => {} });
  const globals = globalThis as unknown as { db: typeof db };
  const original = globals.db;
  try {
    globals.db = drizzle(client, { schema });
    clearAllMemos();
    vi.stubEnv('KOREAN_TRANSLATION_QWEN_ENABLED', 'true'); vi.stubEnv('KOREAN_TRANSLATION_QWEN_RECOVERY_ENABLED', 'true');
    expect(await readTextStageProgress()).toHaveLength(7);
    expect(await readModelCapacityControlObservation()).toMatchObject({ epoch: expect.any(Number), revision: expect.any(Number) });
    expect((await readWorkerProgress()).stages.filter(stage => ['product-translate', 'tagline-ko', 'intro-check'].includes(stage.stage))).toHaveLength(3);
    await expect(client`SELECT 1 FROM dr_writer_fence FOR SHARE`).rejects.toMatchObject({ code: '42501' });
    await expect(client`SELECT 1 FROM model_capacity_control FOR SHARE`).rejects.toMatchObject({ code: '42501' });
    await expect(client`UPDATE jobs SET runs=runs`).rejects.toMatchObject({ code: '42501' });
    const [plan] = await db.execute<{ 'QUERY PLAN': Array<{ 'Execution Time': number }> }>(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${textStageProgressSql([])}`);
    expect(plan['QUERY PLAN'][0]['Execution Time']).toBeLessThan(3_000);
    console.info(JSON.stringify({ event: 'text_stage_progress.fixture_plan', executionMs: plan['QUERY PLAN'][0]['Execution Time'] }));
  } finally {
    globals.db = original; vi.unstubAllEnvs(); clearAllMemos();
    await client.end({ timeout: 5 });
    await db.execute(sql.raw(`REVOKE ALL ON ${tables.join(', ')} FROM ${role}`));
    await db.execute(sql.raw(`REVOKE USAGE ON SCHEMA public FROM ${role}`));
    await db.execute(sql.raw(`DROP ROLE ${role}`));
  }
});
