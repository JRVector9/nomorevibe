import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryScans, crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, productEvidenceSources, productLinks, products, jobs, operationsObservations } from '@/lib/db/schema';
import { saveRepositoryAgentScan, getLatestRepositoryAgentScan } from '@/lib/domain/evidence/agents/repository';
import { AGENT_DETECTOR_VERSION } from '@/lib/domain/evidence/agents/types';
import { ARTIFACT_RULES } from '@/lib/domain/evidence/agents/catalog';
import { changeReviewMode, getSettings, saveSettings } from '@/lib/crawl/settings';
import { listReviewCandidates } from '@/lib/crawl/agent-review-repository';
import { refreshAgentEvidenceJob, REVIEW_SCAN_SHARE, type AgentEvidenceRefreshCursor } from '@/lib/jobs/products/agent-evidence-refresh';
import type { GitHubHttpResult } from '@/lib/crawl/github';
import { ensureSchema, resetTables } from './setup';
import { runJob } from '@/lib/jobs/runner';
import { readWorkerProgress } from '@/lib/operations/worker-progress-query';
import { observeService } from '@/lib/operations/observations';
import { roleHasUnexplainedStall } from '@/scripts/role-worker';
import { agentRefreshDueAtSql } from '@/lib/domain/evidence/agents/refresh-policy';
const spies = vi.hoisted(() => ({ refresh: vi.fn() }));
/** 실제 refresh 를 그대로 부르되 몇 번 불렸는지 센다 — 틱이 일반 슬롯을 어디에 썼는지의 척도다 */
vi.mock('@/lib/domain/evidence/agents/repository', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/domain/evidence/agents/repository')>();
  spies.refresh.mockImplementation(original.refreshRepositoryAgentEvidence);
  return { ...original, refreshRepositoryAgentEvidence: spies.refresh };
});
beforeAll(() => ensureSchema());
beforeEach(async () => { await resetTables(); await db.delete(crawlReviewAttempts); await db.delete(crawlCandidates); await db.delete(crawlDocuments); await db.delete(crawlSettings); spies.refresh.mockClear(); });
/** 막 완료된 과거 시각을 명시한다. 앱/DB의 now() 경계에서 테스트가 간헐적으로 보류되지 않게 한다. */
const completeScan = (repositoryKey: string, repositoryId: string) => saveRepositoryAgentScan({ repositoryId, repositoryKey,
  commitSha: 'c'.repeat(40), scope: '', state: 'complete', observations: [], requestCount: 1, fileCount: 0, errorCode: null, retryAt: null, cursor: null }, new Date(Date.now() - 1000));
/** 파일이 없는 공개 레포 하나를 그리는 GitHub. 불린 경로를 남긴다 */
const emptyRepository = (paths: string[]) => async <T>(path: string): Promise<GitHubHttpResult<T>> => {
  paths.push(path);
  const value = path.includes('/git/trees/') ? { tree: [], truncated: false } : path.includes('/commits/') ? { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } } : { private: false, id: 999, default_branch: 'main', full_name: path.slice(7) };
  return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
};
const listProduct = async (slug: string, repositoryKey: string) => {
  await db.insert(products).values({ slug, url: `https://${slug}.example`, name: slug, tagline: 'test', description: 'test', category: 'Dev', verifyToken: `token-${slug}`, editTokenHash: 'a'.repeat(64), repoUrl: `https://github.com/${repositoryKey}` });
  await db.insert(productLinks).values({ slug, kind: 'repository', declarationSource: 'maker', url: `https://github.com/${repositoryKey}`, normalizedKey: repositoryKey });
  await db.insert(productEvidenceSources).values({ slug, kind: 'repository', provider: 'github', sourceKey: repositoryKey, normalizedFacts: { type: 'github_repository' } });
};
const context = () => ({ cursor: null, save: async () => {}, hasBudget: () => true, log: () => {} });

it.each([25 / 24, 89, 90])('uses the configured public background interval at scan age %s days without changing confirmation stamps', async ageDays => {
  await saveSettings({ enabled: false, agentEvidence: { enabled: true, backgroundRefreshDays: 90 } }, 'test');
  await db.delete(jobs);
  await listProduct('background', 'acme/background');
  await db.update(products).set({ status: 'seeded', createdAt: new Date(Date.now() - 200 * 86400_000) });
  const old = new Date(Date.now() - ageDays * 86400_000 - 1000);
  const scan = (await saveRepositoryAgentScan({ repositoryId: '81', repositoryKey: 'acme/background',
    commitSha: 'c'.repeat(40), scope: '', state: 'complete', observations: [], requestCount: 2,
    fileCount: 0, errorCode: null, retryAt: null, cursor: null }, old))!;
  const before = (await readWorkerProgress()).stages.find(stage => stage.stage === 'agent-evidence');
  expect(before).toMatchObject({ waiting: ageDays >= 90 ? 1 : 0, providerErrors: 0 });
  const paths: string[] = [];
  await refreshAgentEvidenceJob(context(), { request: emptyRepository(paths) });
  expect(spies.refresh.mock.calls.map(([input]) => input.repositoryKey)).toEqual(ageDays >= 90 ? ['acme/background'] : []);
  if (ageDays < 90) {
    expect(paths).toEqual([]);
    expect(await getLatestRepositoryAgentScan('acme/background')).toMatchObject({
      id: scan.id, completedAt: scan.completedAt, nextAttemptAt: scan.nextAttemptAt,
    });
  }
});

it('keeps missing, incomplete, failed, limited and future confirmations on their original retry clock', async () => {
  const at = new Date('2026-10-14T12:00:00Z');
  const due = new Date(at.getTime() - 3600_000).toISOString();
  const complete = new Date(at.getTime() - 2 * 86400_000).toISOString();
  const defaults = { state: 'complete', last_error_code: null as string | null, cursor: null as unknown,
    coverage: { limited: false } as unknown, completed_at: complete as string | null, next_attempt_at: due, requires_daily: false };
  const cases = [
    { name: 'ordinary', patch: {}, delayed: true },
    { name: 'candidate', patch: { requires_daily: true } },
    { name: 'missing', patch: { state: null, completed_at: null, next_attempt_at: null } },
    ...['pending', 'partial', 'failed'].map(state => ({ name: state, patch: { state } })),
    ...['timeout', 'unavailable', 'alias_recheck_required'].map(last_error_code => ({ name: last_error_code, patch: { last_error_code } })),
    { name: 'empty-cursor', patch: { cursor: {} } },
    { name: 'queued-complete', patch: { cursor: { pendingCommits: [{ sha: 'a'.repeat(40) }] } } },
    { name: 'limited', patch: { coverage: { limited: true } } },
    { name: 'malformed-limited', patch: { coverage: { limited: 'false' } } },
    { name: 'missing-confirmation', patch: { completed_at: null } },
    { name: 'future-confirmation', patch: { completed_at: new Date(at.getTime() + 3600_000).toISOString() } },
    { name: 'later-retry', patch: { next_attempt_at: new Date(at.getTime() + 120 * 86400_000).toISOString() } },
  ];
  const inputs = cases.map(({ name, patch }) => ({ name, ...defaults, ...patch }));
  const rows = await db.execute<{ name: string; next_attempt_at: string | null; due_at: string | null; default_due_at: string | null }>(sql`
    WITH input AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(inputs)}::jsonb) AS row(
      name text, state text, last_error_code text, cursor jsonb, coverage jsonb,
      completed_at timestamp, next_attempt_at timestamp, requires_daily boolean))
    SELECT name, next_attempt_at::text,
      (${agentRefreshDueAtSql(sql`input`, sql`requires_daily`, 90, sql`${at.toISOString()}::timestamp`)})::text AS due_at,
      (${agentRefreshDueAtSql(sql`input`, sql`requires_daily`, 1, sql`${at.toISOString()}::timestamp`)})::text AS default_due_at
    FROM input
  `);
  for (const row of rows) {
    expect(row.default_due_at, row.name).toBe(row.next_attempt_at);
    if (row.name === 'ordinary') expect(Date.parse(row.due_at!)).toBe(Date.parse(complete) + 90 * 86400_000);
    else expect(row.due_at, row.name).toBe(row.next_attempt_at);
  }
});

it.each(['new', 'needs_review', 'approved', 'nonpublic', 'missing', 'partial', 'error', 'cursor', 'limited', 'old-detector', 'other-scope'] as const)
  ('retains daily or unfinished demand for %s while deferring clean public background work', async kind => {
    await saveSettings({ enabled: false, agentEvidence: { enabled: true, backgroundRefreshDays: 90 } }, 'test');
    await db.delete(jobs);
    await listProduct('background', 'acme/background');
    await db.update(products).set({ status: 'verified', createdAt: new Date(Date.now() - 200 * 86400_000) });
    if (kind !== 'missing') {
      const old = new Date(Date.now() - 2 * 86400_000);
      const scan = (await saveRepositoryAgentScan({ repositoryId: '81', repositoryKey: 'acme/background',
        commitSha: 'c'.repeat(40), scope: '', state: 'complete', observations: [], requestCount: 2,
        fileCount: 0, errorCode: null, retryAt: null, cursor: null }, old))!;
      const patch: Partial<typeof agentRepositoryScans.$inferInsert> = kind === 'partial' ? { state: 'partial' }
        : kind === 'error' ? { lastErrorCode: 'timeout' }
        : kind === 'cursor' ? { cursor: { repositoryId: '81', repositoryKey: 'acme/background', commitSha: 'c'.repeat(40),
          detectorVersion: AGENT_DETECTOR_VERSION, scope: '', pendingTrees: [], pendingBlobs: [], pendingCommits: [] } }
        : kind === 'limited' ? { coverage: { limited: true } }
        : kind === 'old-detector' ? { detectorVersion: 'old' }
        : kind === 'other-scope' ? { scope: 'src', scopeHash: 'other' } : {};
      if (Object.keys(patch).length) await db.update(agentRepositoryScans).set(patch).where(eq(agentRepositoryScans.id, scan.id));
    }
    if (kind === 'new' || kind === 'needs_review' || kind === 'approved')
      await db.insert(crawlCandidates).values({ repo: 'acme/background', state: kind });
    if (kind === 'nonpublic') await listProduct('private-demand', 'acme/background');
    expect((await readWorkerProgress()).stages.find(stage => stage.stage === 'agent-evidence'))
      .toMatchObject({ waiting: 1, providerErrors: kind === 'error' ? 1 : 0 });
    await refreshAgentEvidenceJob(context(), { request: emptyRepository([]) });
    expect(spies.refresh.mock.calls.map(([input]) => input.repositoryKey)).toEqual(['acme/background']);
  });

it('honors persisted failure backoff with active demand and a long background interval', async () => {
  await saveSettings({ enabled: false, agentEvidence: { enabled: true, backgroundRefreshDays: 90 } }, 'test');
  await db.delete(jobs);
  await listProduct('background', 'acme/background');
  await db.update(products).set({ status: 'seeded' });
  await db.insert(crawlCandidates).values({ repo: 'acme/background', state: 'approved' });
  const scan = (await completeScan('acme/background', '81'))!;
  const retryAt = new Date(Date.now() + 3600_000);
  await db.update(agentRepositoryScans).set({ lastErrorCode: 'timeout', nextAttemptAt: retryAt }).where(eq(agentRepositoryScans.id, scan.id));
  expect((await readWorkerProgress()).stages.find(stage => stage.stage === 'agent-evidence'))
    .toMatchObject({ waiting: 0, deferred: 1, providerErrors: 1 });
  await refreshAgentEvidenceJob(context(), { request: emptyRepository([]) });
  expect(spies.refresh).not.toHaveBeenCalled();
  expect((await getLatestRepositoryAgentScan('acme/background'))?.nextAttemptAt).toEqual(retryAt);
});

it.each(['http503', 'auth'] as const)('retains pre-scan %s failure across fenced job completion and normal retry ticks', async kind => {
  await saveSettings({ enabled: false, agentEvidence: { enabled: true } }, 'test');
  await db.delete(jobs).where(eq(jobs.name, 'agent-evidence-refresh'));
  await db.delete(operationsObservations);
  await listProduct('metadata-failure', 'acme/metadata');
  const now = new Date(), since = new Date(now.getTime() - 40 * 60_000).toISOString();
  await db.update(products).set({ createdAt: new Date(now.getTime() - 120 * 60_000) });
  await db.insert(jobs).values({ name: 'agent-evidence-refresh', nextScheduledAt: now,
    cursor: { providerFailure: { repositoryKey: 'acme/metadata', code: 'unavailable', firstFailureAt: since, lastFailureAt: since, failures: 3 } } });
  const request = vi.fn(async (): Promise<Extract<GitHubHttpResult<never>, { ok: false }>> => kind === 'auth'
    ? { ok: false, error: { kind: 'auth_unavailable', reason: 'expired', resetAt: new Date(Date.now() + 60 * 60_000) } }
    : { ok: false, error: { kind: 'http', status: 503 } });
  const run = () => runJob<AgentEvidenceRefreshCursor>('agent-evidence-refresh', ctx => refreshAgentEvidenceJob(ctx, { request }));
  expect(await run()).toMatchObject({ status: 'completed' });
  const [job] = await db.select().from(jobs).where(eq(jobs.name, 'agent-evidence-refresh'));
  expect(job.cursor).toMatchObject({ providerFailure: { repositoryKey: 'acme/metadata', code: 'unavailable', firstFailureAt: since, failures: 4 } });
  expect(await db.select().from(agentRepositoryScans)).toHaveLength(0);
  for (const role of ['scheduler','crawler','reviewer','publisher','maintenance','text'] as const) await observeService(role, { status: 'running' });
  const report = await readWorkerProgress();
  expect(report.stages.find(stage => stage.stage === 'agent-evidence')).toMatchObject({ reason: 'upstream_stalled', alarm: true, restartEligible: false });
  expect(roleHasUnexplainedStall(report, 'crawler')).toBe(false);
  const calls = request.mock.calls.length;
  expect(await run()).toMatchObject({ status: 'completed' });
  const [retry] = await db.select().from(jobs).where(eq(jobs.name, 'agent-evidence-refresh'));
  expect(retry.cursor).toMatchObject({ providerFailure: { firstFailureAt: since, failures: kind === 'auth' ? 4 : 5 } });
  if (kind === 'auth') expect(request).toHaveBeenCalledTimes(calls);
  else {
    const successful = emptyRepository([]);
    expect(await runJob<AgentEvidenceRefreshCursor>('agent-evidence-refresh', ctx => refreshAgentEvidenceJob(ctx, { request: successful }))).toMatchObject({ status: 'completed' });
    const [recovered] = await db.select().from(jobs).where(eq(jobs.name, 'agent-evidence-refresh'));
    expect(recovered.cursor).toBeNull();
  }
});

it.each([
  ['rejected', 'http503'], ['rejected', 'auth'],
  ['banned', 'http503'], ['banned', 'auth'],
  ['newer-scan', 'http503'], ['newer-scan', 'auth'],
] as const)('replaces a %s pre-scan failure with the next repository\'s %s failure', async (stale, kind) => {
  await saveSettings({ enabled: false, agentEvidence: { enabled: true } }, 'test');
  await db.delete(jobs).where(eq(jobs.name, 'agent-evidence-refresh'));
  await db.delete(operationsObservations);
  if (stale === 'rejected') {
    await db.insert(crawlCandidates).values({ repo: 'acme/old', state: 'rejected' });
  } else {
    await listProduct('old-provider-failure', 'acme/old');
    if (stale === 'banned') await db.update(products).set({ status: 'banned' }).where(eq(products.slug, 'old-provider-failure'));
    else await completeScan('acme/old', '998');
  }
  await listProduct('next-provider-failure', 'acme/next');
  await db.update(products).set({ createdAt: new Date(Date.now() - 120 * 60_000) });
  const oldAt = new Date(Date.now() - 40 * 60_000).toISOString();
  await db.insert(jobs).values({ name: 'agent-evidence-refresh', nextScheduledAt: new Date(), cursor: {
    providerFailure: { repositoryKey: 'acme/old', code: 'unavailable', firstFailureAt: oldAt, lastFailureAt: oldAt, failures: 3 },
  } });
  const request = vi.fn(async (): Promise<Extract<GitHubHttpResult<never>, { ok: false }>> => kind === 'auth'
    ? { ok: false, error: { kind: 'auth_unavailable', reason: 'expired', resetAt: new Date(Date.now() + 60 * 60_000) } }
    : { ok: false, error: { kind: 'http', status: 503 } });
  const run = () => runJob<AgentEvidenceRefreshCursor>('agent-evidence-refresh', ctx => refreshAgentEvidenceJob(ctx, { request }));
  const startedAt = Date.now();
  expect(await run()).toMatchObject({ status: 'completed' });
  const [first] = await db.select().from(jobs).where(eq(jobs.name, 'agent-evidence-refresh'));
  const firstCursor = first.cursor as AgentEvidenceRefreshCursor;
  expect(firstCursor.providerFailure).toMatchObject({ repositoryKey: 'acme/next', code: 'unavailable', failures: 1 });
  expect(Date.parse(firstCursor.providerFailure!.firstFailureAt)).toBeGreaterThanOrEqual(startedAt);
  expect(firstCursor.providerFailure!.lastFailureAt).toBe(firstCursor.providerFailure!.firstFailureAt);
  expect(Date.parse(firstCursor.providerFailure!.lastFailureAt)).toBeLessThanOrEqual(Date.now());
  // Expire only the fixture's retry clock so a second actual provider call occurs.
  if (kind === 'auth') await db.update(jobs).set({ cursor: { ...firstCursor, retryAfter: new Date(Date.now() - 1000).toISOString() } })
    .where(eq(jobs.name, 'agent-evidence-refresh'));
  expect(await run()).toMatchObject({ status: 'completed' });
  const [second] = await db.select().from(jobs).where(eq(jobs.name, 'agent-evidence-refresh'));
  const secondCursor = second.cursor as AgentEvidenceRefreshCursor;
  expect(secondCursor.providerFailure).toMatchObject({ repositoryKey: 'acme/next',
    firstFailureAt: firstCursor.providerFailure!.firstFailureAt, failures: 2 });
  expect(request).toHaveBeenCalledTimes(2);
  const measuredAt = new Date(Date.parse(firstCursor.providerFailure!.firstFailureAt) + 31 * 60_000);
  for (const role of ['scheduler','crawler','reviewer','publisher','maintenance','text'] as const) await observeService(role, { status: 'running' });
  await db.update(operationsObservations).set({ observedAt: measuredAt });
  const report = await readWorkerProgress(measuredAt);
  expect(report.stages.find(stage => stage.stage === 'agent-evidence')).toMatchObject({
    reason: 'upstream_stalled', alarm: true, restartEligible: false, providerErrors: 1, completed5m: 0, progress5m: 0,
  });
  if (kind === 'auth') await db.update(jobs).set({ cursor: { ...secondCursor, retryAfter: new Date(Date.now() - 1000).toISOString() } })
    .where(eq(jobs.name, 'agent-evidence-refresh'));
  expect(await runJob<AgentEvidenceRefreshCursor>('agent-evidence-refresh', ctx => refreshAgentEvidenceJob(ctx, { request: emptyRepository([]) })))
    .toMatchObject({ status: 'completed' });
  const [recovered] = await db.select().from(jobs).where(eq(jobs.name, 'agent-evidence-refresh'));
  expect(recovered.cursor).toBeNull();
  expect((await readWorkerProgress()).stages.find(stage => stage.stage === 'agent-evidence'))
    .toMatchObject({ providerErrors: 0, alarm: false, restartEligible: false });
});

it('rechecks an alias conflict behind the normal cursor even when no queued files remain', async () => {
  await saveSettings({ agentEvidence: { enabled: true } }, 'test');
  await db.insert(crawlCandidates).values({ repo: 'acme/early', state: 'needs_review', reason: 'ai_evidence_pending', decidedBy: 'auto' });
  const scan = (await completeScan('acme/early', '999'))!;
  await db.update(agentRepositoryScans).set({ lastErrorCode: 'alias_recheck_required', nextAttemptAt: new Date('2026-09-01') })
    .where(eq(agentRepositoryScans.id, scan.id));
  const paths: string[] = [];
  await refreshAgentEvidenceJob({ ...context(), cursor: { afterRepository: 'zzz/last' } }, { request: emptyRepository(paths) });
  expect(spies.refresh.mock.calls.map(([input]) => input.repositoryKey)).toEqual(['acme/early']);
  expect(paths[0]).toBe('/repos/acme/early');
  expect((await getLatestRepositoryAgentScan('acme/early'))?.lastErrorCode).toBeNull();
  expect((await db.select().from(crawlCandidates))[0].state).toBe('new');
});

it('spends no general slot on fresh repositories and reaches a due one behind them in the same tick', async () => {
  await saveSettings({ agentEvidence: { enabled: true } }, 'test');
  const fresh = Array.from({ length: 10 }, (_, i) => `aaa/r${i}`);
  await db.insert(crawlCandidates).values([...fresh, 'zzz/due'].map(repo => ({ repo })));
  for (const [i, repositoryKey] of fresh.entries()) await completeScan(repositoryKey, String(i + 1));
  await refreshAgentEvidenceJob(context(), { request: emptyRepository([]) });
  // 신선한 10개는 캐시 확인·근거 로딩도 하지 않는다. 슬롯은 다시 볼 때가 된 레포에만 간다
  expect(spies.refresh.mock.calls.map(([input]) => input.repositoryKey)).toEqual(['zzz/due']);
  expect((await getLatestRepositoryAgentScan('zzz/due'))?.state).toBe('complete');
});

it('attaches a completed scan to its products without re-entering the refresh path', async () => {
  await saveSettings({ agentEvidence: { enabled: true } }, 'test');
  await listProduct('app', 'acme/app');
  await refreshAgentEvidenceJob(context(), { request: emptyRepository([]) });
  const scan = await getLatestRepositoryAgentScan('acme/app');
  expect(scan?.state).toBe('complete');
  expect((await db.select().from(productEvidenceSources))[0].normalizedFacts).toMatchObject({ agentScanId: scan!.id });
  // 스캔 한 번이면 된다. 제품을 붙이려고 refresh(캐시 확인 → 붙이기 → 근거 다시 읽기)를 또 타지 않는다
  expect(spies.refresh).toHaveBeenCalledTimes(1);
});

it('attaches existing fresh evidence to a newly listed product as separate work, without a scan', async () => {
  await saveSettings({ agentEvidence: { enabled: true } }, 'test');
  const scan = await completeScan('acme/app', '1');
  // 근거가 이미 있는 레포를 가리키는 제품이 나중에 올라왔다
  await listProduct('app', 'acme/app');
  const paths: string[] = [];
  await refreshAgentEvidenceJob(context(), { request: emptyRepository(paths) });
  expect((await db.select().from(productEvidenceSources))[0].normalizedFacts).toMatchObject({ agentScanId: scan!.id });
  expect(spies.refresh).not.toHaveBeenCalled();
  expect(paths).toEqual([]);
});
it('merges product and pending candidate demand, preserves admin decisions and reuses due cache', async () => {
  await saveSettings({ agentEvidence: { enabled: true } }, 'test');
  await db.insert(products).values({ slug: 'test', url: 'https://app.example', name: 'Test', tagline: 'test', description: 'test', category: 'Dev', verifyToken: 'token', editTokenHash: 'a'.repeat(64), repoUrl: 'https://github.com/acme/app' });
  await db.insert(crawlCandidates).values([{ repo: 'acme/app', state: 'needs_review', reason: 'ai_evidence_pending', decidedBy: 'auto' }, { repo: 'acme/other', state: 'needs_review', reason: 'ai_evidence_pending', decidedBy: 'admin' }]);
  const paths: string[] = [];
  const request = async <T>(path: string): Promise<GitHubHttpResult<T>> => {
    paths.push(path);
    const value = path.includes('/git/trees/') ? { tree: [], truncated: false } : path.includes('/commits/') ? { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } } : { private: false, id: path.includes('/other') ? 2 : 1, default_branch: 'main', full_name: path.slice(7) };
    return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
  };
  const ctx = { cursor: null, save: async () => {}, hasBudget: () => true, log: () => {} };
  await refreshAgentEvidenceJob(ctx, { request });
  expect(await db.select().from(agentRepositoryScans)).toHaveLength(2);
  expect((await db.select().from(crawlCandidates)).find(row => row.repo === 'acme/app')?.state).toBe('new');
  expect((await db.select().from(crawlCandidates)).find(row => row.repo === 'acme/other')?.state).toBe('needs_review');
  const count = paths.length;
  await refreshAgentEvidenceJob(ctx, { request });
  expect(paths).toHaveLength(count);
});

it.each(['partial', 'complete'] as const)('resumes an overdue %s scan with pending work behind the normal cursor', async state => {
  await saveSettings({ agentEvidence: { enabled: true } }, 'test');
  await db.insert(crawlCandidates).values({ repo: 'acme/early', state: 'needs_review', reason: 'ai_evidence_pending', decidedBy: 'auto' });
  const commitSha = 'a'.repeat(40), blobSha = 'b'.repeat(40);
  await saveRepositoryAgentScan({ repositoryId: '1', repositoryKey: 'acme/early', commitSha, scope: '', state: 'partial', observations: [], requestCount: 3, fileCount: 0, errorCode: null, retryAt: null, cursor: { repositoryId: '1', repositoryKey: 'acme/early', commitSha, detectorVersion: AGENT_DETECTOR_VERSION, scope: '', pendingTrees: [], pendingBlobs: [{ path: 'AGENTS.md', sha: blobSha, size: 7, ruleId: ARTIFACT_RULES.find(rule => rule.id.startsWith('shared.agents'))!.id }] } }, new Date('2026-01-01'));
  if (state === 'complete') await db.update(agentRepositoryScans).set({ state, completedAt: new Date('2026-01-01') })
    .where(eq(agentRepositoryScans.repositoryKey, 'acme/early'));
  const paths: string[] = [];
  const saved: string[] = [];
  const request = async <T>(path: string): Promise<GitHubHttpResult<T>> => {
    paths.push(path);
    const value = path.includes('/git/blobs/') ? { encoding: 'base64', size: 7, content: Buffer.from('# Rules').toString('base64') } : { id: 1, private: false };
    return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
  };
  await refreshAgentEvidenceJob({ cursor: { afterRepository: 'zzz/last' }, save: async cursor => { saved.push(cursor.afterRepository ?? ''); }, hasBudget: () => true, log: () => {} }, { request });
  expect(paths[0]).toBe('/repos/acme/early');
  expect(paths.some(path => path.includes('/git/blobs/'))).toBe(true);
  expect((await getLatestRepositoryAgentScan('acme/early'))?.state).toBe('complete');
  expect(saved).toEqual(['zzz/last']);
});

/**
 * codex 재현: 스캔이 끝나 저장된 직후 후보를 되돌리는 update가 일시 오류로 실패하면 catch가
 * 삼킨다. 스캔의 다음 시도는 하루 뒤라 due 선별이 그 레포를 다시 고르지 않아, 후보가 하루 동안
 * "근거 대기"로 멈췄다. 멈춘 원인과 상관없이 매 틱 쓸어 풀어야 한다.
 */
it('releases a candidate stuck on evidence-pending even though its repository is not due', async () => {
  await saveSettings({ agentEvidence: { enabled: true } }, 'test');
  await completeScan('acme/stuck', '1'); // 방금 끝났다 — 하루 뒤에야 다시 due
  await db.insert(crawlCandidates).values({ repo: 'acme/stuck', state: 'needs_review', reason: 'ai_evidence_pending', decidedBy: 'auto' });

  await refreshAgentEvidenceJob(context(), { request: emptyRepository([]) });

  expect(spies.refresh).not.toHaveBeenCalled(); // 레포는 due가 아니다 — 쓸기가 풀어야 한다
  expect(await db.select().from(crawlCandidates)).toMatchObject([{ repo: 'acme/stuck', state: 'new' }]);
});

it('leaves an evidence-pending candidate alone when the scan is too old for the judge', async () => {
  await saveSettings({ agentEvidence: { enabled: true } }, 'test');
  await completeScan('acme/stale', '1');
  // 판정은 24시간 안에 끝난 스캔만 근거로 본다. 이걸 풀면 판정이 다시 보류하고 매 틱 돈다
  await db.update(agentRepositoryScans).set({ completedAt: new Date(Date.now() - 25 * 3600_000), nextAttemptAt: new Date(Date.now() + 3600_000) })
    .where(eq(agentRepositoryScans.repositoryKey, 'acme/stale'));
  await db.insert(crawlCandidates).values({ repo: 'acme/stale', state: 'needs_review', reason: 'ai_evidence_pending', decidedBy: 'auto' });

  await refreshAgentEvidenceJob(context(), { request: emptyRepository([]) });

  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: 'needs_review', reason: 'ai_evidence_pending' }]);
});

it('never releases an administrator decision', async () => {
  await saveSettings({ agentEvidence: { enabled: true } }, 'test');
  await completeScan('acme/admin', '1');
  await db.insert(crawlCandidates).values({ repo: 'acme/admin', state: 'needs_review', reason: 'ai_evidence_pending', decidedBy: 'admin' });

  await refreshAgentEvidenceJob(context(), { request: emptyRepository([]) });

  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: 'needs_review', decidedBy: 'admin' }]);
});

/**
 * codex 재리뷰: 서브쿼리가 고른 행을 UPDATE가 잠그려고 기다리는 사이 관리자가 거부하면, 잠금을
 * 푼 뒤 UPDATE가 상태 조건을 다시 보지 않아 거부를 new로 되돌렸다. 판정은 admin+new를 재판정
 * 요청으로 읽어 거부를 자동 승인으로 뒤집을 수 있었다. 잠긴 행은 건너뛰어야 한다.
 */
it('does not overwrite an administrator decision taken while the candidate is locked', async () => {
  await saveSettings({ agentEvidence: { enabled: true } }, 'test');
  await completeScan('acme/race', '1');
  await db.insert(crawlCandidates).values({ repo: 'acme/race', state: 'needs_review', reason: 'ai_evidence_pending', decidedBy: 'auto' });

  await db.transaction(async (tx) => {
    // 관리자가 이 후보를 잠그고 결정하는 중이다
    await tx.execute(sql`SELECT id FROM crawl_candidates WHERE repo = 'acme/race' FOR UPDATE`);
    // 쓸기는 다른 연결에서 돈다. 잠긴 행을 기다리면 이 트랜잭션과 서로를 기다려 테스트가 멈춘다
    await refreshAgentEvidenceJob(context(), { request: emptyRepository([]) });
    await tx.update(crawlCandidates).set({ state: 'rejected', reason: 'not_a_product', decidedBy: 'admin' })
      .where(eq(crawlCandidates.repo, 'acme/race'));
  });

  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: 'rejected', decidedBy: 'admin' }]);
});

it('does not release candidates when the configured detector differs from the one scans are collected with', async () => {
  // 판정은 수집 버전의 스캔만 고르고 그 버전이 설정과 같을 때만 근거로 본다 — 다르면 풀어도 다시 보류된다
  await saveSettings({ agentEvidence: { enabled: true, detectorVersion: 'another.1' } }, 'test');
  await completeScan('acme/version', '1');
  await db.insert(crawlCandidates).values({ repo: 'acme/version', state: 'needs_review', reason: 'ai_evidence_pending', decidedBy: 'auto' });

  await refreshAgentEvidenceJob(context(), { request: emptyRepository([]) });

  expect(await db.select().from(crawlCandidates)).toMatchObject([{ state: 'needs_review', reason: 'ai_evidence_pending' }]);
});

/** 레포마다 다른 GitHub id 를 주는 GitHub. 머리 커밋이 completeScan 과 같아 트리를 다시 읽지 않는다(프로드에서 흔한 경우) */
const unchangedRepositories = (ids: Record<string, number>) => async <T>(path: string): Promise<GitHubHttpResult<T>> => {
  const key = path.split('/').slice(2, 4).join('/');
  const value = path.includes('/commits/') ? { sha: 'c'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } } : { private: false, id: ids[key], default_branch: 'main', full_name: key };
  return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
};
async function enableReview() {
  await saveSettings({ enabled: true, agentEvidence: { enabled: true } }, 'test');
  vi.stubEnv('CRAWL_REVIEW_READY', 'true');
  expect(await changeReviewMode({ mode: 'enforce', expectedMode: 'off', actor: 'test', reason: 'parked review scans' })).toMatchObject({ ok: true });
  vi.unstubAllEnvs();
  return getSettings();
}
/** 원본은 방금 받았고 스캔은 하루도 더 전에 끝난 1차 심사 대기 후보 — 2026-10-08 프로드에서 550건이 이 모양으로 멈춰 있었다 */
async function waitingOnReview(repo: string, githubId: number, options: { scanAgeHours?: number; candidate?: Partial<typeof crawlCandidates.$inferInsert> } = {}) {
  const productUrl = `https://${githubId}.example`, fetchedAt = new Date(Date.now() - 2000);
  await db.insert(crawlDocuments).values({ repo, productUrl, pageStatus: 200, fetchedAt,
    repoMeta: { description: 'A deployed service' }, pageMeta: { title: 'App', description: 'A deployed service' } });
  const [candidate] = await db.insert(crawlCandidates).values({ repo, productUrl, state: 'approved', reason: 'passed', decidedBy: 'auto',
    judgedAt: fetchedAt, ...options.candidate }).returning();
  const scan = (await completeScan(repo, String(githubId)))!;
  const old = new Date(Date.now() - (options.scanAgeHours ?? 30) * 3600_000);
  // 다시 볼 때(완료 + 하루)는 이미 지났다 — 일반 대기의 이름순 차례만 기다리던 상태
  await db.update(agentRepositoryScans).set({ startedAt: old, completedAt: old, nextAttemptAt: new Date(old.getTime() + 24 * 3600_000) })
    .where(eq(agentRepositoryScans.id, scan.id));
  return candidate;
}

it('rescans a repository whose candidate waits on first review ahead of the alphabetical sweep', async () => {
  const settings = await enableReview();
  const candidate = await waitingOnReview('acme/waiting', 11);
  // 스캔이 24시간을 넘겨 1차 심사가 고르지 못한다
  expect(await listReviewCandidates(settings)).toEqual([]);
  const previousScan = (await getLatestRepositoryAgentScan('acme/waiting'))!;
  const saved: string[] = [];

  // 스캔은 앱 시각으로 저장되고 selector는 DB now()를 쓴다. 같은 DB 시각으로 완료 fixture를 만든다.
  const [clock] = await db.execute<{ now_ms: string }>(sql`SELECT extract(epoch FROM now()) * 1000 AS now_ms`);
  const scanAt = new Date(Math.floor(Number(clock.now_ms)));
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(scanAt);
  try {
    await refreshAgentEvidenceJob({ ...context(), cursor: { afterRepository: 'zzz/last' }, save: async cursor => { saved.push(cursor.afterRepository ?? ''); } },
      { request: unchangedRepositories({ 'acme/waiting': 11 }) });
  } finally {
    vi.useRealTimers();
  }

  expect(spies.refresh.mock.calls.map(([input]) => input.repositoryKey)).toEqual(['acme/waiting']);
  // 일반 대기의 자리는 그대로다
  expect(saved.every(after => after === 'zzz/last')).toBe(true);
  const refreshed = (await getLatestRepositoryAgentScan('acme/waiting'))!;
  expect(refreshed).toMatchObject({ state: 'complete', detectorVersion: AGENT_DETECTOR_VERSION,
    lastErrorCode: null, startedAt: scanAt, completedAt: scanAt });
  expect(refreshed.completedAt!.getTime()).toBeGreaterThan(previousScan.completedAt!.getTime());
  expect((await listReviewCandidates(settings)).map(row => row.id)).toEqual([candidate.id]);
});

it('takes at most its per-tick share of review rescans, longest-unscanned first', async () => {
  await enableReview();
  await waitingOnReview('acme/a', 21, { scanAgeHours: 30 });
  await waitingOnReview('acme/b', 22, { scanAgeHours: 50 });
  await waitingOnReview('acme/c', 23, { scanAgeHours: 40 });

  await refreshAgentEvidenceJob({ ...context(), cursor: { afterRepository: 'zzz/last' } },
    { request: unchangedRepositories({ 'acme/a': 21, 'acme/b': 22, 'acme/c': 23 }) });

  expect(spies.refresh.mock.calls.map(([input]) => input.repositoryKey)).toEqual(['acme/b', 'acme/c'].slice(0, REVIEW_SCAN_SHARE));
});

it('leaves repositories alone that first review is not waiting on', async () => {
  await enableReview();
  await waitingOnReview('acme/admin', 31, { candidate: { decidedBy: 'admin' } });
  await waitingOnReview('acme/rejected', 32, { candidate: { state: 'rejected', reason: 'not_a_product' } });
  await waitingOnReview('acme/human', 33, { candidate: { state: 'needs_review', reason: 'ai_review_exhausted' } });
  // 원본도 낡았다 — 원본을 먼저 다시 받아야 심사할 수 있다(requeueStaleReviewSources 몫)
  await waitingOnReview('acme/stale-source', 34);
  await db.update(crawlDocuments).set({ fetchedAt: new Date(Date.now() - 25 * 3600_000) }).where(eq(crawlDocuments.repo, 'acme/stale-source'));
  // 실패한 스캔이 저장된 재시도 시각을 기다린다
  await waitingOnReview('acme/retrying', 35);
  await db.update(agentRepositoryScans).set({ nextAttemptAt: new Date(Date.now() + 15 * 60_000) }).where(eq(agentRepositoryScans.repositoryKey, 'acme/retrying'));
  // 견줄 것 하나 — 이것만 골라야 한다
  await waitingOnReview('acme/waiting', 36);

  await refreshAgentEvidenceJob({ ...context(), cursor: { afterRepository: 'zzz/last' } }, { request: unchangedRepositories({ 'acme/waiting': 36 }) });

  expect(spies.refresh.mock.calls.map(([input]) => input.repositoryKey)).toEqual(['acme/waiting']);
});
