import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryScans, crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, githubCollectorAccounts, githubCollectorApps, jobs, operationsObservations } from '@/lib/db/schema';
import { saveSettings } from '@/lib/crawl/settings';
import { refreshAgentEvidenceJob, type AgentEvidenceRefreshCursor } from '@/lib/jobs/products/agent-evidence-refresh';
import type { GitHubHttpResult } from '@/lib/crawl/github';
import { runJob } from '@/lib/jobs/runner';
import { ensureSchema, resetTables } from './setup';

const spies = vi.hoisted(() => ({ refresh: vi.fn() }));
/** 실제 refresh 를 그대로 부르되 어느 저장소를 봤는지 센다 */
vi.mock('@/lib/domain/evidence/agents/repository', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/domain/evidence/agents/repository')>();
  spies.refresh.mockImplementation(original.refreshRepositoryAgentEvidence);
  return { ...original, refreshRepositoryAgentEvidence: spies.refresh };
});
const clearCollectors = async () => { await db.delete(githubCollectorApps); await db.delete(githubCollectorAccounts); };
beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables(); await db.delete(crawlReviewAttempts); await db.delete(crawlCandidates); await db.delete(crawlDocuments);
  await db.delete(crawlSettings); await db.delete(jobs); await db.delete(operationsObservations); await clearCollectors();
  spies.refresh.mockClear();
  await saveSettings({ enabled: false, agentEvidence: { enabled: true } }, 'test');
});
afterAll(clearCollectors);

/** 저장소마다 다른 GitHub id 를 주고 파일이 없는 공개 저장소를 그리는 GitHub. 불린 경로를 남긴다 */
function repositories(paths: string[] = []) {
  const ids = new Map<string, number>();
  return async <T>(path: string): Promise<GitHubHttpResult<T>> => {
    paths.push(path);
    const key = path.split('/').slice(2, 4).join('/');
    if (!ids.has(key)) ids.set(key, 1_000 + ids.size);
    const value = path.includes('/git/trees/') ? { tree: [], truncated: false }
      : path.includes('/commits/') ? { sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } }
        : { private: false, id: ids.get(key), default_branch: 'main', full_name: key };
    return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
  };
}
const candidates = (count: number) => db.insert(crawlCandidates).values(Array.from({ length: count }, (_, i) => ({ repo: `acme/r${String(i).padStart(2, '0')}` })));
const job = async () => (await db.select().from(jobs).where(eq(jobs.name, 'agent-evidence-refresh')))[0];
const tick = (request = repositories(), requestedOnly = false) =>
  runJob<AgentEvidenceRefreshCursor>('agent-evidence-refresh', ctx => refreshAgentEvidenceJob(ctx, { request }), { budgetMs: 55_000, requestedOnly });
const scannedKeys = () => spies.refresh.mock.calls.map(([input]) => input.repositoryKey);

it('scans a whole page in one tick and requests the next tick in the same acknowledgement only while work remains', async () => {
  await candidates(12);
  expect(await tick()).toMatchObject({ status: 'completed', done: false });
  expect(scannedKeys()).toHaveLength(10);
  expect(await db.select().from(agentRepositoryScans)).toHaveLength(10);
  const continued = await job();
  // 이어 하기: ACK 가 처리 판을 올리면서 요청 판도 하나 올렸다 — worker 는 다음 정기 요청을 기다리지 않는다
  expect(continued.requestedVersion).toBe(continued.processedVersion + 1);
  expect(continued.cursor).toEqual({ afterRepository: 'acme/r09' });

  spies.refresh.mockClear();
  expect(await tick(repositories(), true)).toMatchObject({ status: 'completed', done: true });
  expect(scannedKeys()).toEqual(['acme/r10', 'acme/r11']);
  const finished = await job();
  expect(finished.requestedVersion).toBe(finished.processedVersion);
  expect(finished.cursor).toBeNull();
});

it('does not request another tick for an empty queue', async () => {
  expect(await tick()).toMatchObject({ status: 'completed', done: true });
  const state = await job();
  expect(state.requestedVersion).toBe(state.processedVersion);
});

it('does not request another tick while a provider retry time is pending', async () => {
  await candidates(12);
  const retryAfter = new Date(Date.now() + 10 * 60_000).toISOString();
  await db.insert(jobs).values({ name: 'agent-evidence-refresh', cursor: { afterRepository: '', retryAfter } });
  expect(await tick()).toMatchObject({ status: 'completed', done: false });
  expect(spies.refresh).not.toHaveBeenCalled();
  const state = await job();
  expect(state.requestedVersion).toBe(state.processedVersion);
  expect(state.cursor).toMatchObject({ retryAfter });
});

it('starts no scan while total GitHub core headroom is below a quarter, then resumes after the reset', async () => {
  await candidates(3);
  const resetIn = (minutes: number) => Math.floor(Date.now() / 1_000) + minutes * 60;
  await db.insert(githubCollectorApps).values({ installationId: 1, appId: 1, appSlug: 'collector', accountLogin: 'acme',
    encryptedPrivateKey: 'sealed', coreQuota: { limit: 5_000, used: 4_600, remaining: 400, reset: resetIn(30) }, quotaObservedAt: new Date() });
  await db.insert(githubCollectorAccounts).values({ userId: 1, login: 'acme', encryptedToken: 'sealed',
    coreQuota: { limit: 5_000, used: 3_900, remaining: 1_100, reset: resetIn(40) }, quotaObservedAt: new Date() });
  // 꺼진 자격은 셈에 들지 않는다
  await db.insert(githubCollectorAccounts).values({ userId: 2, login: 'off', encryptedToken: 'sealed', enabled: false,
    coreQuota: { limit: 5_000, used: 0, remaining: 5_000, reset: resetIn(40) }, quotaObservedAt: new Date() });
  const paths: string[] = [];

  expect(await tick(repositories(paths))).toMatchObject({ status: 'completed', done: false });
  expect(spies.refresh).not.toHaveBeenCalled();
  expect(paths).toEqual([]);
  const deferred = await job();
  expect(deferred.requestedVersion).toBe(deferred.processedVersion);
  // 운영 관측에 미룬 이유와 그때의 합계가 남는다
  const [observation] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, 'job:agent-evidence-refresh'));
  expect((observation.value as { events: unknown[] }).events).toContainEqual(
    { event: 'agent_evidence.github_headroom_low', counts: { remaining: 1_500, limit: 10_000 } });

  // 앱 설치의 창이 새로 열리면(reset 지남) 가득 찬 것으로 보고 다시 스캔한다
  await db.update(githubCollectorApps).set({ coreQuota: { limit: 5_000, used: 4_600, remaining: 400, reset: resetIn(-1) } });
  expect(await tick(repositories(paths))).toMatchObject({ status: 'completed', done: true });
  expect(scannedKeys()).toEqual(['acme/r00', 'acme/r01', 'acme/r02']);
});
