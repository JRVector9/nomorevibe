import { describe, expect, it } from 'vitest';
import { JOB_CATALOG, jobsForRole, lanesForRole } from '@/lib/jobs/catalog';
import { dbPoolConfig } from '@/lib/db/pool';
import { jobRunOptions, runWorker } from '@/scripts/worker';

it('registers canonical site refresh only as a sixty-second version-one site-evidence job', () => {
  expect(JOB_CATALOG.find(job => job.name === 'product-site-evidence-refresh')).toEqual({
    name: 'product-site-evidence-refresh', role: 'site-evidence', intervalMs: 60_000, batchVersion: 1,
  });
  for (const role of ['crawler', 'reviewer', 'publisher', 'text', 'maintenance'] as const) {
    expect(jobsForRole(role)).not.toContain('product-site-evidence-refresh');
    expect(lanesForRole(role).flat()).not.toContain('product-site-evidence-refresh');
  }
});

it('GitHub 연동 재조회는 maintenance에서 15분마다 실행한다', () => {
  expect(JOB_CATALOG.find(job => job.name === 'github-integration-reconcile')).toEqual({
    name: 'github-integration-reconcile', role: 'maintenance', intervalMs: 15 * 60_000,
  });
});

it('알림함 잡 셋은 maintenance에서 돈다 — 주간 묶음은 15분마다 깨어 월요일 09:00(KST)을 스스로 본다', () => {
  expect(JOB_CATALOG.filter(job => job.name.startsWith('notification-'))).toEqual([
    { name: 'notification-delisted', role: 'maintenance', intervalMs: 5 * 60_000 },
    { name: 'notification-category-digest', role: 'maintenance', intervalMs: 15 * 60_000 },
    { name: 'notification-prune', role: 'maintenance', intervalMs: 60 * 60_000 },
  ]);
});

it('GitHub 피드백 전송은 publisher에서 1분마다 기존 역할 lease를 따른다', () => {
  expect(JOB_CATALOG.find(job => job.name === 'github-feedback-delivery')).toEqual({
    name: 'github-feedback-delivery', role: 'publisher', intervalMs: 60_000,
  });
  expect(jobsForRole('publisher')).toContain('github-feedback-delivery');
});

/**
 * 생존 확인은 1분마다 maintenance가 돈다.
 *
 * 워커는 역할 안의 잡을 하나씩 차례로 돌린다. crawler는 이미 명목 수요가 한 프로세스를 넘어서
 * 1분 주기를 얹을 자리가 없다 — 한가한 maintenance로 옮긴다.
 */
it('생존 확인은 maintenance 역할에서 1분마다 돈다', () => {
  expect(JOB_CATALOG.find(job => job.name === 'uptime-ping')).toEqual({
    name: 'uptime-ping', role: 'maintenance', intervalMs: 60_000,
  });
  expect(new Set(jobsForRole('maintenance'))).toEqual(new Set(['uptime-ping', 'click-rollup', 'ranking-refresh', 'news-refresh', 'product-thumbnail-refresh', 'product-search-refresh', 'product-search-health', 'product-spam-rescan', 'github-integration-reconcile', 'email-outbox-send', 'email-weekly-digest', 'notification-delisted', 'notification-category-digest', 'notification-prune']));
  expect(jobsForRole('crawler')).not.toContain('uptime-ping');
});

it('재수집된 README만 기존 GitHub 인증이 있는 crawler에서 제한적으로 갱신한다', () => {
  expect(JOB_CATALOG.find(job => job.name === 'product-readme-refresh')).toEqual({
    name: 'product-readme-refresh', role: 'crawler', intervalMs: 5 * 60_000,
  });
});

it('Bluesky 화제 수집은 crawler 기본 줄에서 2시간마다, 요청 상한을 다 쓸 수 있는 40초 틱으로 돈다', () => {
  expect(JOB_CATALOG.find(job => job.name === 'bluesky-talk')).toEqual({ name: 'bluesky-talk', role: 'crawler', intervalMs: 2 * 60 * 60_000 });
  expect(jobsForRole('crawler')).toContain('bluesky-talk');
  expect(jobRunOptions('bluesky-talk', { requestedOnly: true })).toEqual({ requestedOnly: true, budgetMs: 40_000 });
});

/** 회사 발표는 하루 몇 건이다. 이미 시간을 넘겨 쓰는 crawler에 얹지 않는다 */
it('AI 소식 수집은 maintenance 역할에서 한 시간마다 돈다', () => {
  expect(JOB_CATALOG.find(job => job.name === 'news-refresh')).toEqual({
    name: 'news-refresh', role: 'maintenance', intervalMs: 60 * 60_000,
  });
  expect(jobsForRole('crawler')).not.toContain('news-refresh');
});

it('maintenance 워커가 생존 확인 요청을 소비하고 crawler 워커는 건드리지 않는다', async () => {
  const ran: string[] = [];
  const dependencies = {
    pending: async () => ['uptime-ping'],
    seen: async () => {},
    run: async (name: string) => { ran.push(name); return { status: 'completed' }; },
  };

  await runWorker({ role: 'crawler', once: true }, { ...dependencies, names: jobsForRole('crawler') });
  expect(ran).toEqual([]);

  await runWorker({ role: 'maintenance', once: true }, { ...dependencies, names: jobsForRole('maintenance') });
  expect(ran).toEqual(['uptime-ping']);
});

/**
 * 감사는 1차 심사와 같은 reviewer 워커에서 차례로 돈다 — 둘이 게이트웨이에 겹쳐 보내지 않는다.
 * 다른 역할에 두면 따로 도는 프로세스라 1차 심사와 겹쳐 동시 호출이 는다(실측 4 → 성공 94%, 6 → 87%).
 */
it('발행분 감사는 1차 심사와 같은 reviewer 역할에서 돈다', () => {
  expect(JOB_CATALOG.find(job => job.name === 'product-audit')).toEqual({
    name: 'product-audit', role: 'reviewer', intervalMs: 60_000,
  });
  expect(jobsForRole('reviewer')).toEqual(expect.arrayContaining(['crawl-agent-review', 'product-audit']));
});

it('maintenance 풀이 생존 확인이 동시에 쥐는 연결을 담는다', () => {
  // HTTP는 3곳을 동시에 열지만 기록은 한 번에 하나다 — 기록 1 + 러너 임대 갱신 1
  expect(dbPoolConfig({ WORKER_ROLE: 'maintenance' }).max).toBeGreaterThanOrEqual(2);
});

describe('lanesForRole', () => {
  it('isolates product sources, AI-level judging, repository scans, and stars while keeping every role unchanged', () => {
    const crawler = lanesForRole('crawler');
    expect(crawler).toHaveLength(5);
    expect(crawler.slice(1)).toEqual([['product-evidence-refresh'], ['agent-evidence-refresh'], ['ai-level-refresh'], ['product-star-observation']]);
    expect(crawler[0]).toContain('crawl-fetch');
    expect(crawler[0]).not.toContain('product-evidence-refresh');
    expect(crawler.flat().sort()).toEqual(jobsForRole('crawler').sort());
    for (const role of ['publisher', 'text', 'maintenance'] as const) expect(lanesForRole(role)).toEqual([jobsForRole(role)]);
  });

  it('화면 판별은 reviewer 의 따로 도는 줄(screen)에서 150초 틱으로 돈다 — 기본 줄의 심사·감사를 막지 않는다', () => {
    expect(JOB_CATALOG.find(job => job.name === 'audit-screen-review')).toEqual({ name: 'audit-screen-review', role: 'reviewer', intervalMs: 60_000, lane: 'screen' });
    const reviewer = lanesForRole('reviewer');
    expect(reviewer).toEqual([jobsForRole('reviewer').filter(name => name !== 'audit-screen-review'), ['audit-screen-review']]);
    expect(reviewer[0]).toContain('product-audit');
    expect(jobRunOptions('audit-screen-review', { requestedOnly: true })).toEqual({ requestedOnly: true, budgetMs: 150_000 });
  });
});
