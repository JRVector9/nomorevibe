import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentRepositoryScans } from '@/lib/db/schema';
import { collectRepositoryAgentEvidence, type AgentGitHubRequest, type CollectCursor, type CollectResult } from '@/lib/domain/evidence/agents/collect';
import { getLatestRepositoryAgentEvidence, getLatestRepositoryAgentScan, refreshRepositoryAgentEvidence, saveRepositoryAgentScan } from '@/lib/domain/evidence/agents/repository';
import { AGENT_DETECTOR_VERSION, type AgentObservation } from '@/lib/domain/evidence/agents/types';
import { ensureSchema, resetTables } from './setup';

const SHA = 'a'.repeat(40), TREE = 'b'.repeat(40);
const OLD = 'acme/old', RENAMED = 'acme/renamed';
function cursor(repositoryKey: string): CollectCursor {
  return { repositoryId: '12', repositoryKey, commitSha: SHA, detectorVersion: AGENT_DETECTOR_VERSION,
    scope: '', pendingTrees: [{ path: '', sha: TREE }], pendingBlobs: [] };
}
function partial(repositoryKey: string): CollectResult {
  return { repositoryId: '12', repositoryKey, commitSha: SHA, scope: '', state: 'partial',
    cursor: cursor(repositoryKey), observations: [], requestCount: 2, fileCount: 0, errorCode: null, retryAt: null };
}
async function mismatchedScan(repositoryKey = OLD, cursorKey = RENAMED, complete = false) {
  const scan = (await saveRepositoryAgentScan({ ...partial(repositoryKey), state: complete ? 'complete' : 'partial' }, new Date('2026-09-01')))!;
  // Reproduce rows written by the old immutable-ID upsert, which updated only the cursor's name.
  await db.update(agentRepositoryScans).set({ cursor: cursor(cursorKey) }).where(eq(agentRepositoryScans.id, scan.id));
  return scan;
}
function emptyRepository(repositoryKey: string, id = 12) {
  const paths: string[] = [];
  const request: AgentGitHubRequest = async <T>(path: string) => {
    paths.push(path);
    let value: unknown;
    if (path === `/repos/${repositoryKey}`) value = { id, private: false, fork: false, default_branch: 'main' };
    else if (path === `/repos/${repositoryKey}/commits/main`) value = { sha: SHA, commit: { tree: { sha: TREE } } };
    else if (path === `/repos/${repositoryKey}/git/trees/${TREE}`) value = { truncated: false, tree: [] };
    else throw new Error(`unexpected request: ${path}`);
    return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
  };
  return { paths, request };
}
beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

describe('repository rename cursor recovery', () => {
  it('keeps the existing repository lookup and binds a renamed cursor to the same immutable identity', async () => {
    const original = await saveRepositoryAgentScan(partial(OLD));
    const renamed = await saveRepositoryAgentScan(partial(RENAMED));
    expect(renamed).toMatchObject({ id: original!.id, repositoryKey: OLD, cursor: { repositoryKey: OLD } });
    expect(await db.select().from(agentRepositoryScans)).toHaveLength(1);
    expect((await getLatestRepositoryAgentScan(OLD))?.id).toBe(original!.id);
  });

  it('retains confirmed evidence at the name used by existing products after an alias refresh', async () => {
    const observation: AgentObservation = { kind: 'model_config', client: 'claude-code', compatibleClients: [],
      modelDeveloper: 'z-ai', declaredModelId: 'glm-4.7', gateway: 'z-ai', routing: 'fixed', role: 'sonnet',
      scope: '', keyPath: 'env.ANTHROPIC_DEFAULT_SONNET_MODEL', ruleId: 'claude.settings.v1',
      sourcePath: '.claude/settings.json', commitSha: SHA, blobSha: 'c'.repeat(40),
      sourceUrl: `https://github.com/${OLD}/blob/${SHA}/.claude/settings.json` };
    const original = await saveRepositoryAgentScan({ ...partial(OLD), state: 'complete', cursor: null, observations: [observation] });
    await saveRepositoryAgentScan(partial(RENAMED));
    const retained = await getLatestRepositoryAgentEvidence(OLD);
    expect(retained?.scan).toMatchObject({ id: original!.id, state: 'complete', completedAt: original!.completedAt });
    expect(retained?.observations).toEqual([observation]);
  });

  it('does not confirm the retained name until its metadata is rechecked after an alias completes', async () => {
    const original = (await saveRepositoryAgentScan({ ...partial(OLD), state: 'complete', cursor: null }, new Date('2026-09-01')))!;
    const mock = emptyRepository(RENAMED);
    const renamed = await refreshRepositoryAgentEvidence({ repositoryKey: RENAMED, request: mock.request });
    expect(renamed.errorCode).toBe('alias_recheck_required');
    expect(renamed.scan).toMatchObject({ id: original.id, repositoryKey: OLD, completedAt: original.completedAt,
      lastErrorCode: 'alias_recheck_required', cursor: null });
    expect(renamed.scan!.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    const retained = emptyRepository(OLD);
    const confirmed = await refreshRepositoryAgentEvidence({ repositoryKey: OLD, request: retained.request });
    expect(confirmed.scan).toMatchObject({ id: original.id, state: 'complete', lastErrorCode: null });
    expect(confirmed.scan!.completedAt!.getTime()).toBeGreaterThan(original.completedAt!.getTime());
    expect(retained.paths).toEqual([`/repos/${OLD}`, `/repos/${OLD}/commits/main`]);
  });

  it('preserves the upstream rate-limit deadline when an alias also needs a recheck', async () => {
    await saveRepositoryAgentScan(partial(OLD), new Date('2026-09-01'));
    const mock = emptyRepository(RENAMED);
    const resetAt = new Date(Date.now() + 30 * 60_000);
    const request: AgentGitHubRequest = async <T>(path: string) => path.includes('/git/trees/')
      ? { ok: false, error: { kind: 'rate_limited', resetAt } } : mock.request<T>(path);
    const refreshed = await refreshRepositoryAgentEvidence({ repositoryKey: RENAMED, request });
    expect(refreshed.errorCode).toBe('rate_limited');
    expect(refreshed.retryAt).toEqual(resetAt);
    expect(refreshed.scan).toMatchObject({ repositoryKey: OLD, lastErrorCode: 'alias_recheck_required', nextAttemptAt: resetAt });
    const original = emptyRepository(OLD);
    expect((await refreshRepositoryAgentEvidence({ repositoryKey: OLD, request: original.request })).cached).toBe(true);
    expect(original.paths).toEqual([]);
  });

  it('rechecks cached commit claims through the retained name before saving their provenance', async () => {
    const discovered = 'c'.repeat(40);
    const claim: AgentObservation = { kind: 'commit_attribution', client: 'codex', compatibleClients: [],
      modelDeveloper: null, declaredModelId: null, gateway: null, routing: 'unknown', role: 'coauthor',
      scope: '', keyPath: null, ruleId: 'commit.coauthor.v1', sourcePath: null, blobSha: null, commitSha: discovered,
      sourceUrl: `https://github.com/${RENAMED}/commit/${discovered}`,
      commitEvidence: { basis: 'coauthor', changedPaths: ['src/app.ts'], changeKind: 'development', headSha: SHA } };
    const original = await saveRepositoryAgentScan(partial(OLD));
    await saveRepositoryAgentScan({ ...partial(RENAMED), cursor: { ...cursor(RENAMED), pendingTrees: [],
      pendingCommits: [{ sha: discovered, observations: [claim] }] } });
    const mock = emptyRepository(OLD);
    const request: AgentGitHubRequest = async <T>(path: string) => {
      let value: unknown;
      if (path === `/repos/${OLD}/commits/${discovered}`) value = { sha: discovered,
        commit: { message: 'Update\n\nCo-authored-by: Codex <codex@example.com>' },
        parents: [{ sha: 'd'.repeat(40) }], files: [{ filename: 'src/app.ts', changes: 1 }] };
      else if (path === `/repos/${OLD}/compare/${discovered}...${SHA}?per_page=1&page=2`) value = { status: 'ahead' };
      else return mock.request<T>(path);
      mock.paths.push(path);
      return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
    };
    const refreshed = await refreshRepositoryAgentEvidence({ repositoryKey: OLD, force: true, request });
    expect(refreshed.scan).toMatchObject({ id: original!.id, state: 'complete', cursor: null, lastErrorCode: null });
    expect(mock.paths).toEqual([`/repos/${OLD}`, `/repos/${OLD}/commits/${discovered}`, `/repos/${OLD}/compare/${discovered}...${SHA}?per_page=1&page=2`]);
    expect(refreshed.observations).toMatchObject([{ kind: 'commit_attribution', sourceUrl: `https://github.com/${OLD}/commit/${discovered}` }]);
  });

  it.each(['private', 'different_id'] as const)('does not resume renamed work if the retained name is %s', async change => {
    await saveRepositoryAgentScan(partial(OLD));
    await saveRepositoryAgentScan(partial(RENAMED));
    const paths: string[] = [];
    const request: AgentGitHubRequest = async <T>(path: string) => {
      paths.push(path);
      return { ok: true, status: 200, value: { id: change === 'different_id' ? 99 : 12,
        private: change === 'private', fork: false, default_branch: 'main' } as T,
        etag: null, lastModified: null, link: null };
    };
    const refreshed = await refreshRepositoryAgentEvidence({ repositoryKey: OLD, force: true, request });
    expect(refreshed.errorCode).toBe('invalid');
    expect(refreshed.scan?.state).toBe('partial');
    expect(refreshed.observations).toEqual([]);
    expect(paths).toEqual([`/repos/${OLD}`]);
  });

  it.each([
    ['hraness/atet', 'hraness/slopcamera'],
    ['hraness/hra', 'hraness/oompa'],
    ['hraness/message-like-me', 'hraness/textbutler'],
  ])('recovers a legacy mismatch for %s by pinning a fresh public head', async (repositoryKey, cursorKey) => {
    const original = await mismatchedScan(repositoryKey, cursorKey);
    const mock = emptyRepository(repositoryKey);
    const refreshed = await refreshRepositoryAgentEvidence({ repositoryKey, request: mock.request });
    expect(refreshed.scan).toMatchObject({ id: original.id, repositoryKey, state: 'complete', cursor: null, lastErrorCode: null });
    expect(mock.paths).toEqual([`/repos/${repositoryKey}`, `/repos/${repositoryKey}/commits/main`, `/repos/${repositoryKey}/git/trees/${TREE}`]);
    const cached = await refreshRepositoryAgentEvidence({ repositoryKey, request: mock.request });
    expect(cached.cached).toBe(true);
    expect(mock.paths).toHaveLength(3);
  });

  it.each(['transport', 'private', 'rate_limited'] as const)('persists %s recovery failure and defers the next attempt', async failure => {
    const original = await mismatchedScan(OLD, RENAMED, true);
    let calls = 0;
    const resetAt = new Date(Date.now() + 30 * 60_000);
    const request: AgentGitHubRequest = async <T>() => {
      calls++;
      if (failure === 'private') return { ok: true, status: 200, value: { id: 12, private: true, default_branch: 'main' } as T, etag: null, lastModified: null, link: null };
      return { ok: false, error: failure === 'transport' ? { kind: 'transport' } : { kind: 'rate_limited', resetAt } };
    };
    const refreshed = await refreshRepositoryAgentEvidence({ repositoryKey: OLD, request });
    expect(refreshed.scan).toMatchObject({ id: original.id, state: 'complete', cursor: null,
      completedAt: original.completedAt, lastErrorCode: failure === 'transport' ? 'timeout' : failure === 'private' ? 'invalid' : 'rate_limited' });
    expect(refreshed.scan!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    if (failure === 'rate_limited') expect(refreshed.scan!.nextAttemptAt).toEqual(resetAt);
    expect(refreshed.observations).toEqual([]);
    expect((await refreshRepositoryAgentEvidence({ repositoryKey: OLD, request })).cached).toBe(true);
    expect(calls).toBe(1);
  });

  it('starts separate evidence if a name now resolves to a different GitHub ID', async () => {
    const original = await mismatchedScan();
    const mock = emptyRepository(OLD, 99);
    const refreshed = await refreshRepositoryAgentEvidence({ repositoryKey: OLD, request: mock.request });
    expect(refreshed.scan).toMatchObject({ githubRepositoryId: BigInt(99), state: 'complete', cursor: null });
    expect(refreshed.scan!.id).not.toBe(original.id);
    expect(mock.paths).toHaveLength(3);
  });

  it('preserves existing evidence and performs no network work without a budget', async () => {
    const original = await mismatchedScan();
    const mock = emptyRepository(OLD);
    const refreshed = await refreshRepositoryAgentEvidence({ repositoryKey: OLD, request: mock.request, hasBudget: () => false });
    expect(refreshed.errorCode).toBe('budget_exhausted');
    expect(refreshed.scan).toMatchObject({ id: original.id, lastErrorCode: null, cursor: { repositoryKey: RENAMED } });
    expect(mock.paths).toEqual([]);
  });

  it('keeps the collector strict instead of silently trusting an unrelated cursor', async () => {
    const mock = emptyRepository(OLD);
    await expect(collectRepositoryAgentEvidence({ repositoryKey: OLD, cursor: cursor(RENAMED), request: mock.request })).rejects.toThrow('invalid agent scan cursor');
    expect(mock.paths).toEqual([]);
  });
});
