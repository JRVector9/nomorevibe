import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { eq, like } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db';
import { agentRepositoryScans, cdnPurges, crawlCandidates, crawlDocuments, crawlFrontier, crawlReviewAttempts, crawlSettings, jobs, products,
  secondReviews } from '@/lib/db/schema';
import * as crawl from '@/lib/crawl/repository';
import { getSettings, saveSettings } from '@/lib/crawl/settings';
import { publishedInputHash, reconcileStaleSecondReviews } from '@/lib/crawl/second-review';
import { STALE_REVIEW_OWNER } from '@/lib/crawl/second-review-stale';
import { requestDueJobs } from '@/lib/jobs/control';
import { logger } from '@/lib/observability/logger';
import { ensureSchema, TEST_DATABASE_URL } from './setup';
import { withLegacySecondReviewJob } from './second-review-receipt-fixtures';

/**
 * 2026-10-29 운영 교착(40P01, 약 한 시간에 한 번) 재현.
 *
 * reviewer 의 second-review 컨트롤러는 후보 TX 안에서 agent-evidence-refresh(카탈로그 뒤쪽)를 요청한 뒤 자기 잡 행
 * second-review(앞쪽)를 FOR SHARE 로 다시 봤다. scheduler 의 requestDueJobs 는 한 TX 에서 카탈로그 순서로 due 잡 행을
 * 잠근다 — second-review 를 쥔 채 agent-evidence-refresh 의 INSERT … ON CONFLICT 에서 컨트롤러를 기다린다. 147→37 과
 * 37→147 이 엇갈려 컨트롤러가 매번 졌다. 여기서는 진짜 requestDueJobs 와 진짜 컨트롤러를 그 순간에 세운다.
 */
const PREFIX = 'sr-lock-order-';
const REPO_PREFIX = 'sr-lock-order/';
const hours = (count: number) => new Date(Date.now() - count * 3_600_000);
const RISKY = 'the quick way to plan all of your week with friends';
const holder = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: 'sr-lock-order-holder', statement_timeout: 15_000 } });
const observer = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {},
  connection: { application_name: 'sr-lock-order-observer', statement_timeout: 15_000 } });

async function clean() {
  await db.delete(agentRepositoryScans).where(like(agentRepositoryScans.repositoryKey, `${REPO_PREFIX}%`));
  await db.delete(crawlFrontier).where(like(crawlFrontier.repo, `${REPO_PREFIX}%`));
  await db.delete(products).where(like(products.slug, `${PREFIX}%`));
  await db.delete(cdnPurges).where(like(cdnPurges.slug, `${PREFIX}%`));
}
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await clean();
  for (const table of [secondReviews, jobs, crawlReviewAttempts, crawlCandidates, crawlDocuments, crawlSettings]) await db.delete(table);
  await saveSettings({ enabled: true, secondReview: { enabled: true, voters: [{ provider: 'claude-cli', model: 'opus' }], sampleRate: 0, agreeAt: 0.85 } }, 'fixture');
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await clean();
  await Promise.all([holder.end({ timeout: 3 }), observer.end({ timeout: 3 })]);
});

/**
 * 원본은 신선하고 탐지 스캔만 오래된 공개분. 낡은 세대 표가 하나 남았다.
 * scanNextAttemptAt 이 미래면 컨트롤러가 스캔 due 를 당기고(실제 변경) 수집 잡을 깨운다.
 */
async function staleScanFixture(name: string, scanNextAttemptAt: Date) {
  const repo = `${REPO_PREFIX}${name}`, slug = `${PREFIX}${name}`, url = `https://${slug}.test`;
  await crawl.putDocument({ repo, productUrl: url, pageStatus: 200,
    repoMeta: { description: '배포한 서비스', stargazers_count: 3, pushed_at: new Date().toISOString(), owner: { type: 'User' } },
    pageMeta: { title: RISKY, textSample: '쓸 수 있는 앱' } });
  await db.insert(products).values({ slug, url, repoUrl: `https://github.com/${repo}`, name: RISKY, tagline: '제품',
    description: '배포된 제품', category: 'Dev', status: 'seeded', source: 'crawler', verifyToken: randomUUID(),
    editTokenHash: 'a'.repeat(64), createdAt: hours(120) });
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl: url, state: 'published', reason: 'passed', decidedBy: 'auto',
    publishedSlug: slug, judgedAt: hours(30), signals: {}, decidedAt: null }).returning();
  const settings = await getSettings();
  const [scan] = await db.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(200_000_000 + candidate.id),
    repositoryKey: repo, commitSha: 'a'.repeat(40), detectorVersion: settings.agentEvidence.detectorVersion,
    scope: '', scopeHash: 'a'.repeat(64), state: 'complete', startedAt: hours(48), completedAt: hours(48),
    nextAttemptAt: scanNextAttemptAt }).returning();
  const [vote] = await db.insert(secondReviews).values({ candidateId: candidate.id, repo, publishedSlug: slug, trigger: 'risk',
    firstDecision: 'approve', firstAttemptId: null, provider: 'claude-cli', model: 'opus', generationKey: 'pre-refresh-generation',
    inputHash: publishedInputHash(slug) }).returning();
  return { candidate, scan, vote };
}

async function jobRow(name: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.name, name));
  return row;
}
/** 스캔 수집 잡 행 — scheduler 기준으로는 아직 due 가 아니다(그 요청이 아니라 컨트롤러의 깨움만 센다) */
async function seedScanJob() {
  await db.insert(jobs).values({ name: 'agent-evidence-refresh', requestedVersion: 5, processedVersion: 5,
    nextScheduledAt: new Date(Date.now() + 3_600_000) });
}
async function blockedBehind(pid: number): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await observer`SELECT pid FROM pg_stat_activity
      WHERE ${pid} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock' ORDER BY pid`;
    if (rows.length) return Number(rows[0].pid);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`no backend entered an actual lock wait behind ${pid}`);
}
/** 실패 이유와 드라이버 SQLSTATE(drizzle 이 감싼 message 에는 없다) */
const reasonOf = (result: PromiseSettledResult<unknown>) => result.status === 'fulfilled' ? 'fulfilled'
  : `${String(result.reason)} [${(result.reason as { cause?: { code?: string } })?.cause?.code ?? 'no-sqlstate'}]`;
const retryWarnings = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(call => call[0] === 'crawl.second_review_controller_retry');

it('scheduler holding the due second-review row never waits on a controller-held later job row', async () => {
  const { vote, scan } = await staleScanFixture('cycle', new Date(Date.now() + 23 * 3_600_000));
  await seedScanJob();
  // due(다음 일정 없음)인 사이 잡 — scheduler 의 UPDATE 가 이 행에서 holder 를 기다린다
  await db.insert(jobs).values({ name: 'crawl-publish' });
  const before = await jobRow('agent-evidence-refresh');
  const warn = vi.spyOn(logger, 'warn');
  let scheduler: Promise<number> | undefined, controller: Promise<number> | undefined;
  let probe: string | undefined;
  await withLegacySecondReviewJob(async lease => {
    try {
      await holder.begin(async tx => {
        const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
        // crawl-publish 는 카탈로그에서 second-review 와 agent-evidence-refresh 사이다. scheduler 를 여기서 세운다
        expect(await tx`SELECT name FROM jobs WHERE name = 'crawl-publish' FOR UPDATE`).toHaveLength(1);
        scheduler = requestDueJobs();
        void scheduler.catch(() => {});
        // 진짜 scheduler TX 가 due second-review 를 이미 갱신해 쥐고 crawl-publish 앞에서 기다린다
        const schedulerPid = await blockedBehind(pid);
        controller = reconcileStaleSecondReviews(undefined, lease);
        void controller.catch(() => {});
        // 컨트롤러는 자기 잡 행(second-review)을 scheduler 뒤에서 기다린다
        await blockedBehind(schedulerPid);
        // 기다리는 동안 컨트롤러가 뒤쪽 잡 행을 쥐고 있으면 scheduler 가 거기서 막혀 원을 이룬다
        probe = await observer.begin(async check => {
          await check`SELECT name FROM jobs WHERE name = 'agent-evidence-refresh' FOR UPDATE NOWAIT`;
          return 'free';
        }).catch((error: { code?: string }) => error.code ?? 'error');
      });
    } finally {
      const [due, reconciled] = await Promise.allSettled([scheduler!, controller!]);
      expect.soft(probe).toBe('free');
      expect(due.status, reasonOf(due)).toBe('fulfilled');
      expect(reconciled.status, reasonOf(reconciled)).toBe('fulfilled');
    }
  });
  expect(retryWarnings(warn)).toEqual([]);
  expect(await db.select().from(secondReviews).where(eq(secondReviews.id, vote.id)))
    .toMatchObject([{ status: 'resolved', resolution: 'superseded', resolvedBy: STALE_REVIEW_OWNER }]);
  const [pulled] = await db.select().from(agentRepositoryScans).where(eq(agentRepositoryScans.id, scan.id));
  expect(pulled.nextAttemptAt.getTime()).toBeLessThan(scan.nextAttemptAt.getTime());
  // 컨트롤러 TX 가 commit 된 뒤 따로 한 번 깨운다
  expect((await jobRow('agent-evidence-refresh')).requestedVersion).toBe(before.requestedVersion + 1);
});

it('retries a controller candidate once when PostgreSQL picks it as the deadlock victim', async () => {
  const { candidate, vote } = await staleScanFixture('victim', new Date(Date.now() + 23 * 3_600_000));
  await seedScanJob();
  const before = await jobRow('agent-evidence-refresh');
  const warn = vi.spyOn(logger, 'warn');
  let controller: Promise<number> | undefined;
  let acquiredAfterVictim = false;
  await withLegacySecondReviewJob(async lease => {
    try {
      await holder.begin(async tx => {
        const [{ pid }] = await tx`SELECT pg_backend_pid() AS pid`;
        await tx`SET LOCAL lock_timeout = '10s'`;
        // scheduler 처럼 second-review 행을 갱신해 쥔다
        await tx`UPDATE jobs SET updated_at = now() WHERE name = 'second-review'`;
        controller = reconcileStaleSecondReviews(undefined, lease);
        void controller.catch(() => {});
        await blockedBehind(pid);
        // 컨트롤러가 쥔 후보 행을 요구해 원을 만든다. 먼저 기다린 컨트롤러가 deadlock_timeout 뒤 희생된다
        await tx`SELECT id FROM crawl_candidates WHERE id = ${candidate.id} FOR UPDATE`;
        acquiredAfterVictim = true;
      });
    } finally {
      const [reconciled] = await Promise.allSettled([controller!]);
      expect(reconciled.status, reasonOf(reconciled)).toBe('fulfilled');
    }
  });
  expect(acquiredAfterVictim).toBe(true);
  expect(retryWarnings(warn)).toHaveLength(1);
  expect(retryWarnings(warn)[0][1]).toMatchObject({ candidateId: candidate.id, code: '40P01' });
  expect(await db.select().from(secondReviews).where(eq(secondReviews.id, vote.id)))
    .toMatchObject([{ status: 'resolved', resolution: 'superseded', resolvedBy: STALE_REVIEW_OWNER }]);
  expect((await jobRow('agent-evidence-refresh')).requestedVersion).toBe(before.requestedVersion + 1);
});

it('does not re-request the scan job each tick for a scan that is already due', async () => {
  const { vote } = await staleScanFixture('already-due', hours(0.1));
  await seedScanJob();
  const before = await jobRow('agent-evidence-refresh');
  const reconcile = () => withLegacySecondReviewJob(lease => reconcileStaleSecondReviews(undefined, lease));
  expect(await reconcile()).toBe(1);
  expect(await db.select().from(secondReviews).where(eq(secondReviews.id, vote.id)))
    .toMatchObject([{ status: 'resolved', resolution: 'superseded', resolvedBy: STALE_REVIEW_OWNER }]);
  // 남은 수요는 다음 틱에도 다시 검사하지만, 이미 due 인 스캔을 위해 잡 행을 또 올리지 않는다
  expect(await reconcile()).toBe(0);
  expect(await reconcile()).toBe(0);
  expect((await jobRow('agent-evidence-refresh')).requestedVersion).toBe(before.requestedVersion);
});

it('wakes the scan job once per pass for scans it actually pulled forward, then not again', async () => {
  const later = new Date(Date.now() + 23 * 3_600_000);
  const first = await staleScanFixture('pulled-a', later), second = await staleScanFixture('pulled-b', later);
  await seedScanJob();
  const before = await jobRow('agent-evidence-refresh');
  const reconcile = () => withLegacySecondReviewJob(lease => reconcileStaleSecondReviews(undefined, lease));
  expect(await reconcile()).toBe(4);
  for (const { scan } of [first, second]) {
    const [row] = await db.select().from(agentRepositoryScans).where(eq(agentRepositoryScans.id, scan.id));
    expect(row.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
  }
  expect((await jobRow('agent-evidence-refresh')).requestedVersion).toBe(before.requestedVersion + 1);
  expect(await reconcile()).toBe(0);
  expect((await jobRow('agent-evidence-refresh')).requestedVersion).toBe(before.requestedVersion + 1);
});
