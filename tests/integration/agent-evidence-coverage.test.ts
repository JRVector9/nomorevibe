import { beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
vi.mock('server-only', () => ({}));
import { db } from '@/lib/db';
import { agentRepositoryScans, crawlSettings, productLinks, productEvidenceSources, products } from '@/lib/db/schema';
import { saveRepositoryAgentScan, refreshRepositoryAgentEvidence, attachRepositoryAgentScan } from '@/lib/domain/evidence/agents/repository';
import { agentCoverageRevision, agentCoverageRevisionSql, type AgentCoverageInput } from '@/lib/domain/evidence/agents/coverage';
import { loadAttributionAuditPage, classifyAttributionAuditRow } from '@/lib/domain/evidence/agents/audit';
import { getPublicObservedAgentFacts } from '@/lib/domain/products/detail-view';
import { loadAgentJudgeInput } from '@/lib/crawl/agent-evidence';
import { loadAgentJudgeInputs } from '@/lib/crawl/admin-review-batch';
import { mergeWithDefaults, saveSettings } from '@/lib/crawl/settings';
import { summarizeAgentEvidence } from '@/lib/domain/evidence/agents/summary';
import type { AgentObservation } from '@/lib/domain/evidence/agents/types';
import { AGENT_DETECTOR_VERSION } from '@/lib/domain/evidence/agents/types';
import type { AgentGitHubRequest, CollectCursor, CollectResult } from '@/lib/domain/evidence/agents/collect';
import { ensureSchema, resetTables } from './setup';

const repo = 'coverage/app', SHA = 'a'.repeat(40), TREE = 'b'.repeat(40), discovered = 'c'.repeat(40);
const observation: AgentObservation = { kind: 'commit_attribution', client: 'codex', compatibleClients: [],
  modelDeveloper: null, declaredModelId: null, gateway: null, routing: 'unknown', role: 'coauthor', scope: '',
  keyPath: null, ruleId: 'commit.coauthor.v1', sourcePath: null, blobSha: null, commitSha: SHA,
  sourceUrl: `https://github.com/${repo}/commit/${SHA}`,
  commitEvidence: { basis: 'coauthor', changedPaths: ['src/app.ts'], changeKind: 'development', headSha: SHA } };
const cursor: CollectCursor = { repositoryId: '12', repositoryKey: repo, commitSha: SHA,
  detectorVersion: AGENT_DETECTOR_VERSION, scope: '', repositoryFork: false, pendingTrees: [], pendingBlobs: [],
  pendingCommits: [{ sha: discovered, observations: [] }] };
const complete: CollectResult = { repositoryId: '12', repositoryKey: repo, repositoryFork: false, commitSha: SHA,
  scope: '', state: 'complete', cursor: null, observations: [observation], requestCount: 4, fileCount: 0, errorCode: null, retryAt: null };
beforeAll(ensureSchema);
beforeEach(async () => { await resetTables(); await db.delete(crawlSettings); });

it('projects a fresh same-head compare 404 as partial across judge, public, attachment and audit readers', async () => {
  const now = new Date(Date.now() - 2_000), settings = mergeWithDefaults({ agentEvidence: { displayObservedFacts: true } });
  await saveSettings(settings, 'test');
  const [product] = await db.insert(products).values({ slug: 'coverage-app', url: 'https://coverage.example',
    repoUrl: `https://github.com/${repo}`, name: 'App', tagline: 'test', description: 'test', category: 'Dev', status: 'seeded',
    verifyToken: 'token', editTokenHash: 'a'.repeat(64) }).returning();
  await db.insert(productLinks).values({ slug: product.slug, kind: 'repository', declarationSource: 'maker',
    url: `https://github.com/${repo}`, normalizedKey: repo, visible: true });
  await db.insert(productEvidenceSources).values({ slug: product.slug, kind: 'repository', provider: 'github', sourceKey: repo,
    state: 'ok', lastSuccessAt: now, normalizedFacts: { type: 'github_repository', relationshipState: 'site_link' } });
  const original = (await saveRepositoryAgentScan(complete, now))!;
  expect(await attachRepositoryAgentScan({ productSlug: product.slug, productId: product.id, scanId: original.id })).toBe(true);
  await saveRepositoryAgentScan({ ...complete, state: 'partial', observations: [], cursor }, now);
  const request: AgentGitHubRequest = async <T>(path: string) => {
    if (path.includes('/compare/')) return { ok: false, error: { kind: 'not_found' } };
    const value = path === `/repos/${repo}` ? { id: 12, private: false, fork: false, default_branch: 'main' }
      : path === `/repos/${repo}/commits/main` ? { sha: SHA, commit: { tree: { sha: TREE } } }
      : path === `/repos/${repo}/git/trees/${TREE}` ? { truncated: false, tree: [] } : undefined;
    if (!value) throw new Error(`unexpected request: ${path}`);
    return { ok: true, status: 200, value: value as T, etag: null, lastModified: null, link: null };
  };
  const refreshed = await refreshRepositoryAgentEvidence({ repositoryKey: repo, force: true, request });
  expect(refreshed.scan).toMatchObject({ id: original.id, state: 'complete', completedAt: original.completedAt,
    coverage: { limited: true }, cursor: { coverageLimited: true, pendingCommits: [],
      unavailableCommits: [{ sha: discovered, headSha: SHA, reason: 'comparison_not_found' }] } });
  expect(refreshed.observations).toEqual([observation]);
  const document = { repo, pageMeta: { repositoryKeys: [repo] }, fetchedAt: now };
  const single = await loadAgentJudgeInput(document, settings);
  expect(single).toMatchObject({ scanState: 'partial', observations: [observation] });
  expect(summarizeAgentEvidence(single).reason).toBe('ai_evidence_pending');
  expect((await loadAgentJudgeInputs([document], settings)).get(repo)).toEqual(single);
  expect(await attachRepositoryAgentScan({ productSlug: product.slug, productId: product.id, scanId: original.id })).toBe(false);
  const facts = (await getPublicObservedAgentFacts([product.slug])).get(product.slug)!;
  expect(facts).toMatchObject([{ coverageLabel: '일부 미확인', sourceUrl: observation.sourceUrl, observedAt: original.completedAt }]);
  const audit = classifyAttributionAuditRow((await loadAttributionAuditPage(db))[0], new Date());
  expect(audit).toMatchObject({ scanState: 'incomplete', claims: [{ qualified: false, sourceUrl: observation.sourceUrl }] });
  await saveRepositoryAgentScan({ ...complete, observations: [] });
  expect((await loadAgentJudgeInput(document, settings)).scanState).toBe('complete');
  expect((await db.select().from(agentRepositoryScans))[0].coverage).toMatchObject({ limited: false });
});

it('keeps the SQL review CAS signature identical to the bounded JS coverage signature', async () => {
  const empty = { ...cursor, pendingCommits: [] };
  const cases: AgentCoverageInput[] = [{}, { coverage: { limited: false }, cursor: null }, { coverage: { limited: true } },
    { cursor: { ...empty, coverageLimited: true } }, { cursor },
    { cursor: { ...empty, pendingTrees: [{ path: '', sha: TREE }] } },
    { cursor: { ...empty, pendingBlobs: [{ path: 'AGENTS.md', sha: TREE, size: 1, ruleId: 'shared.agents.v1' }] } },
    { coverage: { limited: true }, cursor: { ...empty, coverageLimited: true, unavailableCommits: [
      { sha: discovered, headSha: SHA, reason: 'comparison_not_found' }] } }];
  for (const input of cases) {
    const [row] = await db.execute(sql`SELECT ${agentCoverageRevisionSql(
      sql`${JSON.stringify(input.coverage ?? null)}::jsonb`, sql`${JSON.stringify(input.cursor ?? null)}::jsonb`)} AS revision`);
    expect(row.revision).toEqual(agentCoverageRevision(input) ?? {});
  }
});
