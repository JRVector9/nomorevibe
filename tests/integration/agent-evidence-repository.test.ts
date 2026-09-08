import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/lib/db';
import { agentRepositoryObservations, productAgents, productEvidenceSources, productLinks, products } from '@/lib/db/schema';
import { attachRepositoryAgentScan, getLatestRepositoryAgentEvidence, listDiscoveryEvidence, recordDiscoveryEvidence, refreshRepositoryAgentEvidence, saveRepositoryAgentScan } from '@/lib/domain/evidence/agents/repository';
import { loadAgentJudgeInput } from '@/lib/crawl/agent-evidence';
import { DEFAULT_CRAWL_SETTINGS } from '@/lib/crawl/settings-schema';
import type { GitHubHttpResult } from '@/lib/crawl/github';
import type { CollectResult } from '@/lib/domain/evidence/agents/collect';
import type { AgentObservation } from '@/lib/domain/evidence/agents/types';
import { ensureSchema, resetTables } from './setup';
const SHA = 'a'.repeat(40);
const observation: AgentObservation = { kind: 'model_config', client: 'claude-code', compatibleClients: [], modelDeveloper: 'z-ai', declaredModelId: 'glm-4.7', gateway: 'z-ai', routing: 'fixed', role: 'sonnet', scope: '', keyPath: 'env.ANTHROPIC_DEFAULT_SONNET_MODEL', ruleId: 'claude.settings.v1', sourcePath: '.claude/settings.json', commitSha: SHA, blobSha: 'b'.repeat(40), sourceUrl: `https://github.com/acme/app/blob/${SHA}/.claude/settings.json` };
function result(overrides: Partial<CollectResult> = {}): CollectResult { return { repositoryId: '12', repositoryKey: 'acme/app', commitSha: SHA, scope: '', state: 'complete', cursor: null, observations: [observation], requestCount: 4, fileCount: 1, errorCode: null, retryAt: null, ...overrides }; }
beforeAll(() => ensureSchema());
beforeEach(async () => { await resetTables(); });
describe('repository agent observations', () => {
  it('deduplicates immutable observations while preserving multiple role models', async () => {
    await saveRepositoryAgentScan(result());
    await saveRepositoryAgentScan(result({ observations: [observation, { ...observation, declaredModelId: 'deepseek-v4-pro', role: 'opus' }] }));
    expect(await db.select().from(agentRepositoryObservations)).toHaveLength(2);
  });
  it('preserves a previous complete scan after another commit fails', async () => {
    await saveRepositoryAgentScan(result(), new Date('2026-09-01'));
    await saveRepositoryAgentScan(result({ commitSha: 'c'.repeat(40), state: 'failed', observations: [], errorCode: 'timeout' }), new Date('2026-09-02'));
    expect((await getLatestRepositoryAgentEvidence('acme/app'))?.scan.commitSha).toBe(SHA);
  });
  it('refreshes confirmation time when an unchanged SHA is checked again', async () => {
    await saveRepositoryAgentScan(result(), new Date('2026-09-01'));
    await saveRepositoryAgentScan(result({ observations: [], fileCount: 0, requestCount: 2 }), new Date('2026-09-03'));
    expect((await getLatestRepositoryAgentEvidence('acme/app'))?.scan.completedAt).toEqual(new Date('2026-09-03'));
  });
  it('does not downgrade a completed immutable scan when a retry fails', async () => {
    await saveRepositoryAgentScan(result());
    await saveRepositoryAgentScan(result({ state: 'failed', observations: [], errorCode: 'timeout' }));
    const found = await getLatestRepositoryAgentEvidence('acme/app');
    expect(found?.scan.state).toBe('complete');
    expect(found?.observations).toHaveLength(1);
  });
  it.each(['private', 'not_found', 'transport'] as const)('retains history but gates old confirmation after a metadata %s failure', async failure => {
    const original = await saveRepositoryAgentScan(result());
    const request = async <T>(): Promise<GitHubHttpResult<T>> => failure === 'private'
      ? { ok: true, status: 200, value: { id: 12, private: true, default_branch: 'main' } as T, etag: null, lastModified: null, link: null }
      : { ok: false, error: { kind: failure } };
    const refreshed = await refreshRepositoryAgentEvidence({ repositoryKey: 'acme/app', force: true, request });
    expect(refreshed.scan?.id).toBe(original?.id);
    expect(refreshed.scan?.lastErrorCode).toBe(failure === 'private' ? 'invalid' : failure === 'transport' ? 'timeout' : 'unavailable');
    expect(refreshed.observations).toHaveLength(1);
    const judge = await loadAgentJudgeInput({ repo: 'acme/app', pageMeta: { repositoryKeys: ['acme/app'] }, fetchedAt: new Date() }, DEFAULT_CRAWL_SETTINGS);
    expect(judge.scanState).toBe('pending');
  });
  it('does not mark a complete scan failed when a later tick has no collection budget', async () => {
    const original = await saveRepositoryAgentScan(result());
    const refreshed = await refreshRepositoryAgentEvidence({ repositoryKey: 'acme/app', force: true, hasBudget: () => false });
    expect(refreshed.errorCode).toBe('budget_exhausted');
    const retained = await getLatestRepositoryAgentEvidence('acme/app');
    expect(retained?.scan.lastErrorCode).toBeNull();
    expect(retained?.scan.completedAt).toEqual(original?.completedAt);
  });
  it('resumes additional commit discoveries on a complete scan and preserves a failed recheck across an empty budget', async () => {
    const original = (await saveRepositoryAgentScan(result(), new Date(Date.now() - 2000)))!;
    const discovered = ['c'.repeat(40), 'd'.repeat(40)];
    for (const commitSha of discovered) await recordDiscoveryEvidence({ repositoryKey: 'acme/app', signalId: 'codex',
      sourceUrl: `https://github.com/acme/app/commit/${commitSha}`, commitSha });
    const paths: string[] = [];
    const request = async <T>(path: string): Promise<GitHubHttpResult<T>> => {
      paths.push(path);
      let value: unknown;
      if (path === '/repos/acme/app') value = { id: 12, private: false, default_branch: 'main' };
      else if (path.endsWith('/commits/main')) value = { sha: SHA, commit: { tree: { sha: 'e'.repeat(40) } } };
      else if (path.includes('/compare/')) value = { status: 'ahead' };
      else if (discovered.some(sha => path.endsWith(`/commits/${sha}`))) value = { sha: path.split('/').at(-1),
        commit: { message: 'Update\n\nCo-authored-by: Codex <codex@example.com>' }, parents: [{ sha: 'f'.repeat(40) }] };
      else throw new Error(`unexpected request: ${path}`);
      return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
    };
    const partial = await refreshRepositoryAgentEvidence({ repositoryKey: 'acme/app', force: true,
      request, hasBudget: () => paths.length < 4 });
    expect(partial.scan).toMatchObject({ id: original.id, state: 'complete', completedAt: original.completedAt,
      lastErrorCode: null, cursor: { pendingCommits: [expect.objectContaining({ sha: expect.any(String) })] } });
    expect(partial.observations).toHaveLength(2);
    const pending = partial.scan!.cursor!.pendingCommits![0].sha;
    const failed = await refreshRepositoryAgentEvidence({ repositoryKey: 'acme/app', force: true,
      request: async () => ({ ok: false, error: { kind: 'transport' } }) });
    expect(failed.scan).toMatchObject({ state: 'complete', completedAt: original.completedAt, lastErrorCode: 'timeout',
      cursor: { pendingCommits: [{ sha: pending }] } });
    const empty = await refreshRepositoryAgentEvidence({ repositoryKey: 'acme/app', force: true, hasBudget: () => false, request });
    expect(empty.errorCode).toBe('budget_exhausted');
    expect((await getLatestRepositoryAgentEvidence('acme/app'))?.scan.lastErrorCode).toBe('timeout');
    expect((await loadAgentJudgeInput({ repo: 'acme/app', pageMeta: { repositoryKeys: ['acme/app'] }, fetchedAt: new Date() },
      DEFAULT_CRAWL_SETTINGS)).scanState).toBe('pending');
    paths.length = 0;
    const resumed = await refreshRepositoryAgentEvidence({ repositoryKey: 'acme/app', force: true, request });
    expect(paths).toEqual(['/repos/acme/app', `/repos/acme/app/commits/${pending}`, `/repos/acme/app/compare/${pending}...${SHA}`]);
    expect(resumed.scan).toMatchObject({ id: original.id, state: 'complete', cursor: null, lastErrorCode: null });
    expect(resumed.scan!.completedAt!.getTime()).toBeGreaterThan(original.completedAt!.getTime());
    expect(resumed.observations).toHaveLength(3);
  });
  it('keeps maker disclosures untouched and attaches only to visible matching links', async () => {
    const [product] = await db.insert(products).values({ slug: 'app', url: 'https://app.example', name: 'app', tagline: 'test', description: 'test', category: 'Dev', verifyToken: 'token', editTokenHash: 'a'.repeat(64) }).returning();
    await db.insert(productAgents).values({ slug: 'app', provider: 'Maker provider', evidenceLevel: 'maker_reported' });
    await db.insert(productLinks).values({ slug: 'app', kind: 'repository', declarationSource: 'maker', url: 'https://github.com/acme/app', normalizedKey: 'acme/app', visible: false });
    await db.insert(productEvidenceSources).values({ slug: 'app', kind: 'repository', provider: 'github', sourceKey: 'acme/app', normalizedFacts: { type: 'github_repository', stars: 42 } });
    const scan = await saveRepositoryAgentScan(result());
    expect(await attachRepositoryAgentScan({ productSlug: 'app', productId: product.id, scanId: scan!.id })).toBe(false);
    await db.update(productLinks).set({ visible: true });
    expect(await attachRepositoryAgentScan({ productSlug: 'app', productId: product.id, scanId: scan!.id })).toBe(true);
    expect((await db.select().from(productEvidenceSources))[0].normalizedFacts).toMatchObject({ stars: 42, agentScanId: scan!.id });
    expect((await db.select().from(productAgents))[0].provider).toBe('Maker provider');
    await expect(attachRepositoryAgentScan({ productSlug: 'app', productId: product.id + 100, scanId: scan!.id })).rejects.toThrow('product generation changed');
  });
  it('preserves multiple search signals independently of frontier dedupe', async () => {
    const base = { repositoryKey: 'acme/app', sourceUrl: `https://github.com/acme/app/commit/${SHA}`, commitSha: SHA };
    await recordDiscoveryEvidence({ ...base, signalId: 'claude', attribution: { client: 'claude-code', label: 'Claude' } });
    await recordDiscoveryEvidence({ ...base, signalId: 'qwen', attribution: { client: 'qwen-code', label: 'Qwen-Coder' } });
    await recordDiscoveryEvidence({ ...base, signalId: 'qwen', attribution: { client: 'qwen-code', label: 'Qwen-Coder' } });
    expect(await listDiscoveryEvidence('acme/app')).toHaveLength(2);
  });
});
