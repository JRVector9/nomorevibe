import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryScans, crawlCandidates, crawlSettings, productEvidenceSources, productLinks, products } from '@/lib/db/schema';
import { saveRepositoryAgentScan, getLatestRepositoryAgentScan } from '@/lib/domain/evidence/agents/repository';
import { AGENT_DETECTOR_VERSION } from '@/lib/domain/evidence/agents/types';
import { ARTIFACT_RULES } from '@/lib/domain/evidence/agents/catalog';
import { saveSettings } from '@/lib/crawl/settings';
import { refreshAgentEvidenceJob } from '@/lib/jobs/products/agent-evidence-refresh';
import type { GitHubHttpResult } from '@/lib/crawl/github';
import { ensureSchema, resetTables } from './setup';
const spies = vi.hoisted(() => ({ refresh: vi.fn() }));
/** 실제 refresh 를 그대로 부르되 몇 번 불렸는지 센다 — 틱이 일반 슬롯을 어디에 썼는지의 척도다 */
vi.mock('@/lib/domain/evidence/agents/repository', async importOriginal => {
  const original = await importOriginal<typeof import('@/lib/domain/evidence/agents/repository')>();
  spies.refresh.mockImplementation(original.refreshRepositoryAgentEvidence);
  return { ...original, refreshRepositoryAgentEvidence: spies.refresh };
});
beforeAll(() => ensureSchema());
beforeEach(async () => { await resetTables(); await db.delete(crawlCandidates); await db.delete(crawlSettings); spies.refresh.mockClear(); });
/** 방금 끝나 하루 뒤에야 다시 볼 스캔 */
const completeScan = (repositoryKey: string, repositoryId: string) => saveRepositoryAgentScan({ repositoryId, repositoryKey,
  commitSha: 'c'.repeat(40), scope: '', state: 'complete', observations: [], requestCount: 1, fileCount: 0, errorCode: null, retryAt: null, cursor: null });
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
