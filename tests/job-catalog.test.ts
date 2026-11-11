import { describe, expect, it } from 'vitest';
import { JOB_CATALOG, JOB_ROLES, jobsForRole, lanesForRole, type JobRole } from '@/lib/jobs/catalog';
import { batchLanesForRole } from '@/lib/jobs/batches';
import { dbPoolConfig } from '@/lib/db/pool';
import { hostDbBudgetCatalog } from '@/lib/db/host-budget';
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
  expect(new Set(jobsForRole('maintenance'))).toEqual(new Set(['uptime-ping', 'click-rollup', 'ranking-refresh', 'news-refresh', 'product-automated-action-audit', 'product-thumbnail-refresh', 'product-search-refresh', 'product-search-health', 'product-spam-rescan', 'github-integration-reconcile', 'email-outbox-send', 'email-weekly-digest', 'notification-delisted', 'notification-category-digest', 'notification-prune', 'model-capacity-reclaim']));
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
 * 감사는 1차 심사와 같은 reviewer 역할(같은 역할 lease·프로세스)에 둔다. 2026-10-29 부터 1차 심사는 전용 줄(ai1)이라 줄은 다르다 —
 * 공유 모델의 동시 호출은 공통 장부의 물리 한도가 막고, 게이트웨이 감사는 새 후보가 기다리면 양보한다(product-audit.ts).
 */
it('발행분 감사는 1차 심사와 같은 reviewer 역할에서 돈다', () => {
  expect(JOB_CATALOG.find(job => job.name === 'product-audit')).toEqual({
    name: 'product-audit', role: 'reviewer', intervalMs: 60_000, lane: 'audit',
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
    expect(crawler).toHaveLength(7);
    expect(crawler[0]).not.toContain('crawl-seed');
    expect(crawler[0]).not.toContain('crawl-fetch');
    expect(crawler[1]).toEqual(['crawl-ko-apply', 'crawl-seed']);
    expect(crawler[2]).toEqual(['crawl-fetch']);
    expect(crawler.slice(3)).toEqual([['product-evidence-refresh'], ['agent-evidence-refresh'], ['ai-level-refresh'], ['product-star-observation']]);
    expect(crawler[0]).not.toContain('product-evidence-refresh');
    expect(crawler.flat().sort()).toEqual(jobsForRole('crawler').sort());
    for (const role of ['publisher', 'maintenance'] as const) expect(lanesForRole(role)).toEqual([jobsForRole(role)]);
    // text 는 기본 줄이 없다 — 모델 잡마다 자기 줄(2026-10-31), 기존 전용 줄 둘은 그대로 뒤에 선다
    expect(lanesForRole('text')).toEqual([['reason-translate'], ['crawl-tagline'], ['product-search-profile'], ['product-search-verify'],
      ['product-embedding'], ['product-repo-review'], ['product-tagline-ko'], ['product-translate']]);
  });

  it('화면 판별은 reviewer 의 따로 도는 줄(screen)에서 150초 틱으로 돈다 — 기본 줄의 심사·감사를 막지 않는다', () => {
    expect(JOB_CATALOG.find(job => job.name === 'audit-screen-review')).toEqual({ name: 'audit-screen-review', role: 'reviewer', intervalMs: 60_000, lane: 'screen' });
    const reviewer = lanesForRole('reviewer');
    // 기본 줄에는 모델을 부르지 않는 crawl-judge·published-recheck 만 남는다. 그 뒤는 줄이 카탈로그에 처음 나온 차례
    expect(reviewer).toEqual([['crawl-judge', 'published-recheck'], ['crawl-agent-review'], ['second-review'], ['split-tiebreak'], ['human-deepseek-review'], ['held-qwen-retry'], ['split-confirm'],
      ['product-audit'], ['audit-qwen'], ['audit-second-opinion'], ['audit-screen-review'], ['product-intro-check'], ['product-llm-assist-review'],
      ['product-llm-assist-audit-review'], ['grok-session-check']]);
    expect(jobRunOptions('product-llm-assist-review', { requestedOnly: true }).budgetMs).toBe(105_000);
    expect(reviewer[0]).not.toContain('product-audit');
    expect(jobRunOptions('audit-screen-review', { requestedOnly: true })).toEqual({ requestedOnly: true, budgetMs: 150_000 });
  });

  it('AI1 은 reviewer 의 전용 줄(ai1)에서 혼자 돈다 — 2차 심사·사람 큐 위임 뒤에 줄 서지 않고, 틱 예산은 그대로다', () => {
    expect(JOB_CATALOG.find(job => job.name === 'crawl-agent-review')).toEqual({ name: 'crawl-agent-review', role: 'reviewer', intervalMs: 60_000, lane: 'ai1' });
    const reviewer = lanesForRole('reviewer');
    expect(reviewer.filter(lane => lane.includes('crawl-agent-review'))).toEqual([['crawl-agent-review']]);
    expect(reviewer[0]).toEqual(['crawl-judge', 'published-recheck']);
    expect(reviewer[0]).not.toContain('crawl-agent-review');
    expect(jobRunOptions('crawl-agent-review', { requestedOnly: true })).toEqual({ requestedOnly: true, budgetMs: 110_000 });
    // product-translate: 클라이언트 300초 + 기록 2초 + 입장·DB 대기 여유(lib/llm/deadline-ladder.ts PRODUCT_TRANSLATION_JOB_BUDGET_MS)
    expect(jobRunOptions('product-translate', { requestedOnly: true })).toEqual({ requestedOnly: true, budgetMs: 315_000 });
  });

  /**
   * 2026-10-31(PR 3a-A): 모델을 부르는 잡은 잡 하나에 줄 하나. 한 줄 안의 잡은 차례로 돌고 틱이 예산까지 가므로, 기본 줄에 모델 잡 여럿을 두면
   * 한 잡의 느림·오류가 다른 단계를 수 분 미뤘다. 큐는 단계마다 자기 표에 있다 — 줄만 나누면 한 프로세스 안에서 동시에 돈다.
   */
  it('모델을 부르는 잡은 reviewer·text 에서 잡 하나에 줄 하나다 — 기본 줄에는 모델 잡이 남지 않는다', () => {
    const modelJobs = {
      reviewer: ['second-review', 'split-tiebreak', 'human-deepseek-review', 'held-qwen-retry', 'split-confirm', 'product-audit', 'audit-qwen', 'audit-second-opinion',
        'product-intro-check', 'grok-session-check'],
      text: ['reason-translate', 'crawl-tagline', 'product-search-profile', 'product-search-verify', 'product-embedding', 'product-repo-review'],
    } as const;
    for (const [role, names] of Object.entries(modelJobs) as [JobRole, readonly string[]][]) {
      const lanes = lanesForRole(role);
      for (const name of names) {
        expect(JOB_CATALOG.find(job => job.name === name)?.lane, name).toBeDefined();
        expect(lanes.filter(lane => lane.includes(name)), name).toEqual([[name]]);
      }
    }
    // 전·후: reviewer 5줄 → 10줄(3a-A) → 15줄(3a-C 합성 잡 분해), text 3줄 → 8줄. heartbeat 파서(parseRuntimeLanes)의 줄 수 상한 16 안이다
    expect(lanesForRole('reviewer')).toHaveLength(15);
    expect(lanesForRole('text')).toHaveLength(8);
    for (const role of JOB_ROLES) expect(lanesForRole(role).length, role).toBeLessThanOrEqual(16);
    // 모델을 부르지 않는 crawl-judge 와 공개분 변경 재판정의 견주기(published-recheck, 2026-11-09 — DB 쓸기뿐, 묻기는 product-audit 줄)만 reviewer 기본 줄에 남는다
    expect(lanesForRole('reviewer')[0]).toEqual(['crawl-judge', 'published-recheck']);
    expect(JOB_CATALOG.find(job => job.name === 'published-recheck')).toEqual({ name: 'published-recheck', role: 'reviewer', intervalMs: 60_000 });
    expect(JOB_CATALOG.find(job => job.name === 'crawl-judge')?.lane).toBeUndefined();
    // 기존 전용 줄은 그대로다
    for (const [name, lane] of [['crawl-agent-review', 'ai1'], ['audit-screen-review', 'screen'], ['product-llm-assist-review', 'assist'],
      ['product-llm-assist-audit-review', 'assist-audit'], ['product-tagline-ko', 'korean-translation'], ['product-translate', 'product-translation']]) {
      expect(JOB_CATALOG.find(job => job.name === name)?.lane, name).toBe(lane);
    }
  });

  /**
   * 줄을 나누는 비용은 DB 연결이다: 역할 프로세스 DB_POOL_MAX = 동시에 틱을 도는 모델 줄 수 + 역할 lease heartbeat 1 + 여유 1(catalog.ts 줄 설명).
   * text 4 줄 → 6. reviewer 4 줄(3a-A) → 합성 잡 분해(3a-C)로 9 줄(second·human·audit·intro + held·confirm·tiebreak·audit-qwen·audit-opinion) → 11
   */
  it('reviewer 11·text 6 — 기본 풀은 줄 규칙대로이고 코드 기본값·host 선언이 같다', () => {
    for (const [role, max] of [['reviewer', 11], ['text', 6]] as const) {
      expect(dbPoolConfig({ WORKER_ROLE: role }).max, role).toBe(max);
      const policy = { version: 1 as const, host: 'm3' as const, release: 'lanes', roles: [role], schedulerReplicas: 0, webReplicas: 0, webReadReplica: false,
        monitor: false, connectAgent: false, preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 as const };
      expect(hostDbBudgetCatalog(policy).processes.find(row => row.kind === 'worker' && row.role === role)).toMatchObject({ primaryMax: max });
    }
    // 건 단위 consumer(ai1·ai2)의 자식 풀은 등록부대로 3 그대로다 — 줄 분리는 역할 프로세스의 연결만 늘린다
    expect(dbPoolConfig({ WORKER_ROLE: 'reviewer', DB_POOL_MAX: '3' }).max).toBe(3);
    expect(dbPoolConfig({ WORKER_ROLE: 'publisher' }).max).toBe(3);
    expect(dbPoolConfig({ WORKER_ROLE: 'maintenance' }).max).toBe(3);
  });

  it('모든 역할에서 줄은 잡을 나눌 뿐 겹치지 않는다 — 한 잡이 두 줄에서 동시에 돌 수 없다', () => {
    for (const role of JOB_ROLES) {
      const lanes = lanesForRole(role), flat = lanes.flat();
      expect(new Set(flat).size, role).toBe(flat.length);
      expect([...flat].sort(), role).toEqual([...jobsForRole(role)].sort());
      for (const mode of ['legacy', 'versioned'] as const) {
        const batch = batchLanesForRole(role, mode).flat();
        expect(new Set(batch).size, `${role}:${mode}`).toBe(batch.length);
      }
    }
  });
});

it('Show GN은 Show HN과 같은 crawler 줄에서 30분 주기로 등록된다', () => {
  expect(JOB_CATALOG.find(job => job.name === 'gn-show-seed')).toEqual({ name: 'gn-show-seed', role: 'crawler', intervalMs: 30 * 60_000 });
  expect(lanesForRole('crawler').find(lane => lane.includes('hn-show-seed'))).toContain('gn-show-seed');
});
