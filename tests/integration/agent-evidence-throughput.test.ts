import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryScans, crawlCandidates, crawlDocuments, crawlReviewAttempts, crawlSettings, githubCollectorAccounts, githubCollectorApps, jobs, operationsObservations, products } from '@/lib/db/schema';
import { getLatestRepositoryAgentScan, saveRepositoryAgentScan } from '@/lib/domain/evidence/agents/repository';
import { AGENT_DETECTOR_VERSION } from '@/lib/domain/evidence/agents/types';
import type { CollectCursor, CollectResult } from '@/lib/domain/evidence/agents/collect';
import { readWorkerProgress } from '@/lib/operations/worker-progress-query';
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

/** 저장소마다 다른 GitHub id 를 주고 파일이 없는 공개 저장소를 그리는 GitHub. 불린 경로를 남긴다. gone 에 든 저장소는 404 다 */
function repositories(paths: string[] = [], fixed: Record<string, number> = {}, gone: string[] = []) {
  const ids = new Map<string, number>(Object.entries(fixed));
  return async <T>(path: string): Promise<GitHubHttpResult<T>> => {
    paths.push(path);
    const key = path.split('/').slice(2, 4).join('/');
    if (gone.includes(key)) return { ok: false, error: { kind: 'not_found' } };
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

it('counts only the credentials this process may use (G1 scope) in the headroom gate, like the consumer', async () => {
  await candidates(2);
  const reset = Math.floor(Date.now() / 1_000) + 50 * 60;
  // 이 서버(M3)가 쓰는 설치 111 은 12% 남았고, Oracle 전용으로 뺀 설치 222 는 거의 가득이다
  for (const [installationId, remaining] of [[111, 600], [222, 4_900]] as const) await db.insert(githubCollectorApps).values({ installationId,
    appId: installationId, appSlug: `app-${installationId}`, accountLogin: 'acme', encryptedPrivateKey: 'sealed',
    coreQuota: { limit: 5_000, used: 5_000 - remaining, remaining, reset }, quotaObservedAt: new Date() });
  vi.stubEnv('GITHUB_COLLECTOR_EXCLUDE_APP_INSTALLATIONS', '222');
  try {
    const paths: string[] = [];
    // 고치기 전: 범위 없이 두 설치를 합쳐(55%) 관문이 열려 M3 자기 자격을 25% 아래로 썼다
    expect(await tick(repositories(paths))).toMatchObject({ status: 'completed', done: false });
    expect(spies.refresh).not.toHaveBeenCalled();
    expect(paths).toEqual([]);
    const [observation] = await db.select().from(operationsObservations).where(eq(operationsObservations.key, 'job:agent-evidence-refresh'));
    expect((observation.value as { events: unknown[] }).events).toContainEqual(
      { event: 'agent_evidence.github_headroom_low', counts: { remaining: 600, limit: 5_000 } });
  } finally { vi.unstubAllEnvs(); }
});

const HEAD = 'c'.repeat(40);
const cursorFor = (repositoryKey: string, repositoryId: string, patch: Partial<CollectCursor> = {}): CollectCursor => ({ repositoryId, repositoryKey,
  commitSha: HEAD, detectorVersion: AGENT_DETECTOR_VERSION, scope: '', pendingTrees: [], pendingBlobs: [], pendingCommits: [], ...patch });
const scanOf = (repositoryKey: string, repositoryId: string, patch: Partial<CollectResult> = {}): CollectResult => ({ repositoryId, repositoryKey,
  commitSha: HEAD, scope: '', state: 'partial', observations: [], requestCount: 12, fileCount: 0, errorCode: null, retryAt: null,
  cursor: cursorFor(repositoryKey, repositoryId), ...patch });
/** 범위 제한으로 끝나 더 볼 것이 없는 partial (collect.ts 가 남기는 모양) */
const limitedScan = (repositoryKey: string, repositoryId: string) =>
  scanOf(repositoryKey, repositoryId, { cursor: cursorFor(repositoryKey, repositoryId, { coverageLimited: true }) });
/** 남은 트리가 있는 partial */
const pendingScan = (repositoryKey: string, repositoryId: string, errorCode: CollectResult['errorCode'] = null) =>
  scanOf(repositoryKey, repositoryId, { errorCode, cursor: cursorFor(repositoryKey, repositoryId, { pendingTrees: [{ path: 'src', sha: 'd'.repeat(40) }] }) });
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);
const publicProduct = async (slug: string, repositoryKey: string, status: 'seeded' | 'verified' = 'seeded') => (await db.insert(products).values({
  slug, url: `https://${slug}.example`, name: slug, tagline: 'test', description: 'test', category: 'Dev', verifyToken: `token-${slug}`,
  editTokenHash: 'a'.repeat(64), repoUrl: `https://github.com/${repositoryKey}`, status, createdAt: daysAgo(200) }).returning())[0];
const context = (cursor: AgentEvidenceRefreshCursor | null = null) => ({ cursor, save: async () => {}, hasBudget: () => true, log: () => {} });

it('doubles the retry delay while the same scan keeps failing, caps it at seven days and resets after a success', async () => {
  const failing = pendingScan('acme/flaky', '41', 'unavailable');
  let at = new Date('2026-10-19T00:00:00Z');
  const delays: number[] = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    const scan = (await saveRepositoryAgentScan(failing, at))!;
    delays.push((scan.nextAttemptAt.getTime() - at.getTime()) / 60_000);
    at = scan.nextAttemptAt; // 다음 시도는 기한에 한다
  }
  expect(delays).toEqual([15, 30, 60, 120, 240, 480, 960, 1_920, 3_840, 7_680, 10_080, 10_080]);
  expect(await db.select().from(agentRepositoryScans)).toHaveLength(1);
  // 성공하면 저장된 기본 시계(이어 하기 1분)로 돌아가고, 다음 실패는 다시 15분부터다
  const resumed = (await saveRepositoryAgentScan(pendingScan('acme/flaky', '41'), at))!;
  expect(resumed.nextAttemptAt.getTime() - at.getTime()).toBe(60_000);
  at = resumed.nextAttemptAt;
  expect((await saveRepositoryAgentScan(failing, at))!.nextAttemptAt.getTime() - at.getTime()).toBe(15 * 60_000);
});

it('keeps provider waits on their own clock and out of the doubling', async () => {
  let at = new Date('2026-10-19T00:00:00Z');
  for (let attempt = 0; attempt < 3; attempt++) at = (await saveRepositoryAgentScan(pendingScan('acme/flaky', '41', 'timeout'), at))!.nextAttemptAt;
  // 한도 대기(rate_limited)는 GitHub 이 준 시각 그대로다 — 저장소 탓이 아니다
  const resetAt = new Date(at.getTime() + 7 * 60_000);
  const limited = (await saveRepositoryAgentScan({ ...pendingScan('acme/flaky', '41', 'rate_limited'), retryAt: resetAt }, at))!;
  expect(limited.nextAttemptAt).toEqual(resetAt);
  // 인증 대기(retryAt 이 있는 unavailable)도 그 시각을 따른다
  const authAt = new Date(resetAt.getTime() + 3 * 60_000);
  expect((await saveRepositoryAgentScan({ ...pendingScan('acme/flaky', '41', 'unavailable'), retryAt: authAt }, resetAt))!.nextAttemptAt).toEqual(authAt);
});

it('keeps failed partial scans out of the resume slots and retries them from the general queue when due', async () => {
  await db.insert(crawlCandidates).values([{ repo: 'acme/clean' }, { repo: 'acme/failing' }]);
  await saveRepositoryAgentScan(pendingScan('acme/clean', '51'), daysAgo(1));
  await saveRepositoryAgentScan(pendingScan('acme/failing', '52', 'unavailable'), daysAgo(1));
  const request = repositories([], { 'acme/clean': 51, 'acme/failing': 52 });
  // 일반 대기는 커서 뒤에 아무것도 없다 — 앞자리(이어 하기)만 본다
  await refreshAgentEvidenceJob(context({ afterRepository: 'zzz/last' }), { request });
  expect(scannedKeys()).toEqual(['acme/clean']);
  spies.refresh.mockClear();
  await refreshAgentEvidenceJob(context(), { request });
  expect(scannedKeys()).toEqual(['acme/failing']);
  expect(await getLatestRepositoryAgentScan('acme/failing')).toMatchObject({ state: 'complete', lastErrorCode: null });
});

it('rescans coverage-limited public repositories on the background interval and counts the same demand as the job', async () => {
  await saveSettings({ enabled: false, agentEvidence: { enabled: true, backgroundRefreshDays: 90 } }, 'test');
  await publicProduct('settled', 'acme/settled');
  await saveRepositoryAgentScan(limitedScan('acme/settled', '61'), daysAgo(2));
  await publicProduct('expired', 'acme/expired', 'verified');
  await saveRepositoryAgentScan(limitedScan('acme/expired', '62'), daysAgo(91));
  // 후보가 원하는 저장소는 범위 제한이어도 지금처럼 매일 본다
  // 앱 시각으로 지난 시각을 준다 — DB 기본값(now())은 로컬 Docker 시계가 앞서면 읽는 시각보다 늦어 아직 대기가 아니다
  await db.insert(crawlCandidates).values({ repo: 'acme/candidate', state: 'needs_review', updatedAt: daysAgo(3) });
  await saveRepositoryAgentScan(limitedScan('acme/candidate', '63'), daysAgo(2));
  await publicProduct('complete', 'acme/complete');
  await saveRepositoryAgentScan(scanOf('acme/complete', '64', { state: 'complete', cursor: null }), daysAgo(2));
  await publicProduct('unscanned', 'acme/unscanned');
  await publicProduct('failing', 'acme/failing');
  await saveRepositoryAgentScan(pendingScan('acme/failing', '66', 'unavailable'), new Date(Date.now() - 60_000));
  const settled = await getLatestRepositoryAgentScan('acme/settled');
  // 저장된 시계는 그대로(하루 뒤)다 — 다시 보는 때만 배경 주기로 미룬다
  expect(settled!.nextAttemptAt.getTime()).toBeLessThan(Date.now());

  const progress = (await readWorkerProgress()).stages.find(stage => stage.stage === 'agent-evidence');
  // 실패 재시도(acme/failing)만 재시도 예약이다. 범위 제한 partial 은 complete 처럼 주기를 기다린다
  expect(progress).toMatchObject({ waiting: 3, deferred: 1 });
  await refreshAgentEvidenceJob(context(), { request: repositories() });
  expect(scannedKeys().sort()).toEqual(['acme/candidate', 'acme/expired', 'acme/unscanned']);
  expect(await getLatestRepositoryAgentScan('acme/settled')).toMatchObject({ id: settled!.id, nextAttemptAt: settled!.nextAttemptAt });
});

it('scans never-scanned public products in id order ahead of the sweep, once each, and keeps that place across traversals', async () => {
  const gone = await publicProduct('gone', 'acme/gone');
  const first = await publicProduct('first', 'zeta/first');
  const second = await publicProduct('second', 'zeta/second', 'verified');
  // 비공개 제품과 이미 스캔한 제품은 몫에 들지 않는다
  await db.insert(products).values({ slug: 'private', url: 'https://private.example', name: 'private', tagline: 'test', description: 'test',
    category: 'Dev', verifyToken: 'token-private', editTokenHash: 'a'.repeat(64), repoUrl: 'https://github.com/zeta/private' });
  await publicProduct('scanned', 'zeta/scanned');
  await saveRepositoryAgentScan(scanOf('zeta/scanned', '71', { state: 'complete', cursor: null }), new Date(Date.now() - 60_000));
  const request = repositories([], {}, ['acme/gone']);
  // 일반 대기는 커서 뒤에 아무것도 없다 — 새 제품 몫만 돈다
  const firstTick = await refreshAgentEvidenceJob(context({ afterRepository: 'zzz/last' }), { request });
  expect(scannedKeys()).toEqual(['acme/gone', 'zeta/first']);
  expect(firstTick.cursor).toMatchObject({ afterNewProduct: first.id });
  spies.refresh.mockClear();
  // 저장소가 사라져 스캔 행이 생기지 않은 제품은 몫에서 다시 고르지 않는다
  await refreshAgentEvidenceJob(context({ afterRepository: 'zzz/last', afterNewProduct: first.id }), { request });
  expect(scannedKeys()).toEqual(['zeta/second']);
  expect(await getLatestRepositoryAgentScan('acme/gone')).toBeNull();
  expect(gone.id).toBeLessThan(first.id);

  // 일반 대기를 다 돌아 처음으로 돌아가도 새 제품 몫의 자리는 남는다
  spies.refresh.mockClear();
  await db.insert(jobs).values({ name: 'agent-evidence-refresh', cursor: { afterRepository: '', afterNewProduct: second.id } });
  expect(await tick(request)).toMatchObject({ status: 'completed', done: true });
  // 일반 대기는 그대로 모든 수요를 돈다 — 사라진 저장소와 비공개 제품(매일 보는 수요)도 여기서 본다
  expect(scannedKeys()).toEqual(['acme/gone', 'zeta/private']);
  expect((await job()).cursor).toMatchObject({ afterNewProduct: second.id });
});
