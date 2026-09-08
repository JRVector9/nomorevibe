import { beforeAll, beforeEach, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryScans, crawlCandidates, crawlSettings, products } from '@/lib/db/schema';
import { saveRepositoryAgentScan, getLatestRepositoryAgentScan } from '@/lib/domain/evidence/agents/repository';
import { AGENT_DETECTOR_VERSION } from '@/lib/domain/evidence/agents/types';
import { ARTIFACT_RULES } from '@/lib/domain/evidence/agents/catalog';
import { saveSettings } from '@/lib/crawl/settings';
import { refreshAgentEvidenceJob } from '@/lib/jobs/products/agent-evidence-refresh';
import type { GitHubHttpResult } from '@/lib/crawl/github';
import { ensureSchema, resetTables } from './setup';
beforeAll(() => ensureSchema());
beforeEach(async () => { await resetTables(); await db.delete(crawlCandidates); await db.delete(crawlSettings); });
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
