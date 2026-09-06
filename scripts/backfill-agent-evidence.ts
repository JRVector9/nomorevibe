/** Dry-run by default. --apply collects public evidence; maker removals stay removed. */
import { parseArgs } from 'node:util';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { and, asc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { db } from '@/lib/db';
import { products, productLinks, productEvidenceSources } from '@/lib/db/schema';
import { normalizeTypedLink } from '@/lib/domain/evidence/contracts';
import { syncRepositoryLink } from '@/lib/domain/evidence/repository-link-sync';
import { refreshProductEvidence } from '@/lib/domain/evidence/refresh';
import { getLatestRepositoryAgentScan, refreshRepositoryAgentEvidence } from '@/lib/domain/evidence/agents/repository';
import { summarizeAgentEvidence } from '@/lib/domain/evidence/agents/summary';

async function main() {
  const { values } = parseArgs({ options: {
    apply: { type: 'boolean', default: false },
    'links-only': { type: 'boolean', default: false },
    limit: { type: 'string', default: '10' },
    slug: { type: 'string', multiple: true },
    output: { type: 'string', default: '/private/tmp/nomorevibe-agent-backfill.json' },
  } });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be 1..1000');
  const output = resolve(values.output!);
  const selected = await db.select({ id: products.id, slug: products.slug, repoUrl: products.repoUrl,
    source: products.source, claimedAt: products.claimedAt, builder: products.builder })
    .from(products).where(and(isNotNull(products.repoUrl), inArray(products.status, ['seeded', 'verified']),
      values.slug?.length ? inArray(products.slug, values.slug) : undefined)).orderBy(asc(products.id)).limit(limit);
  if (values.slug?.some(slug => !selected.some(product => product.slug === slug))) throw new Error('requested slug missing or limit too small');
  const report = { startedAt: new Date().toISOString(), apply: values.apply, selectedCount: selected.length, completedAt: null as string | null,
    products: [] as Record<string, unknown>[] };
  await mkdir(dirname(output), { recursive: true });
  async function checkpoint() {
    await writeFile(`${output}.tmp`, JSON.stringify(report, null, 2) + '\n');
    await rename(`${output}.tmp`, output);
  }
  async function metadataRateLimit() {
    const [limited] = await db.select({ retryAt: productEvidenceSources.nextAttemptAt })
      .from(productEvidenceSources).where(and(eq(productEvidenceSources.provider, 'github'),
        eq(productEvidenceSources.lastErrorCode, 'rate_limited'), gt(productEvidenceSources.nextAttemptAt, new Date()))).limit(1);
    return limited?.retryAt;
  }
  for (const product of selected) {
    const normalized = normalizeTypedLink('repository', product.repoUrl!);
    const row: Record<string, unknown> = { slug: product.slug, repository: normalized?.normalizedKey ?? null,
      legacyGuessPresent: product.source === 'crawler' && !product.claimedAt && !!product.builder };
    report.products.push(row);
    if (!normalized) { row.problem = 'invalid_repository'; await checkpoint(); continue; }
    const existing = await db.select({ visible: productLinks.visible }).from(productLinks).where(and(
      eq(productLinks.slug, product.slug), eq(productLinks.kind, 'repository'), eq(productLinks.normalizedKey, normalized.normalizedKey)));
    row.linkBefore = existing[0] ? existing[0].visible ? 'visible' : 'hidden' : 'missing';
    if (!values.apply) { row.action = 'dry_run'; await checkpoint(); continue; }
    try {
      const sync = await syncRepositoryLink({ productId: product.id, slug: product.slug, repoUrl: product.repoUrl,
        declarationSource: 'discovered', mode: 'backfill' });
      row.linkAction = sync.action;
      if (sync.action === 'preserved_hidden' || sync.action === 'review_required') {
        row.problem = sync.action; await checkpoint(); continue;
      }
      if (values['links-only']) { row.action = 'links_backfilled'; await checkpoint(); continue; }
      const repositoryKey = normalized.normalizedKey.replace(/^github:/, '');
      const previous = await getLatestRepositoryAgentScan(repositoryKey);
      if (previous?.lastErrorCode === 'rate_limited' && previous.nextAttemptAt > new Date()) {
        row.problem = 'rate_limited'; row.retryAt = previous.nextAttemptAt; await checkpoint(); break;
      }
      const limitedBefore = await metadataRateLimit();
      if (limitedBefore) { row.problem = 'rate_limited'; row.retryAt = limitedBefore; await checkpoint(); break; }
      const deadline = Date.now() + 60_000;
      const factsRefresh = await refreshProductEvidence(product.slug, { force: true, hasBudget: () => Date.now() < deadline });
      row.factsRefresh = factsRefresh;
      const limitedAfter = await metadataRateLimit();
      if (limitedAfter) { row.problem = 'rate_limited'; row.retryAt = limitedAfter; await checkpoint(); break; }
      let result = await refreshRepositoryAgentEvidence({ repositoryKey, productSlug: product.slug, productId: product.id, force: true });
      let rounds = 1;
      // Resume exhausted local budgets, but never bypass provider failures/backoff.
      while (rounds < 8 && result.scan?.state === 'partial' && !result.errorCode &&
        (result.scan.cursor?.pendingTrees.length || result.scan.cursor?.pendingBlobs.length || result.scan.cursor?.pendingCommits?.length)) {
        rounds++;
        result = await refreshRepositoryAgentEvidence({ repositoryKey, productSlug: product.slug, productId: product.id, force: true });
      }
      const sources = await db.select({ kind: productEvidenceSources.kind, key: productEvidenceSources.sourceKey,
        state: productEvidenceSources.state, facts: productEvidenceSources.normalizedFacts, observedAt: productEvidenceSources.observedAt,
        lastSuccessAt: productEvidenceSources.lastSuccessAt, error: productEvidenceSources.lastErrorCode })
        .from(productEvidenceSources).where(eq(productEvidenceSources.slug, product.slug));
      const repository = sources.find(source => source.kind === 'repository' && source.key === normalized.normalizedKey);
      const site = sources.find(source => source.key === 'canonical_site');
      const keys = Array.isArray(site?.facts?.repositoryKeys) && site?.state === 'ok' ? site.facts.repositoryKeys : [];
      const relationship = keys.length !== 1 ? 'unknown' : keys[0] === normalized.normalizedKey ? 'same_product' : 'conflict';
      row.scan = result.scan ? { id: result.scan.id, state: result.scan.state, commitSha: result.scan.commitSha,
        detectorVersion: result.scan.detectorVersion, observedAt: result.scan.completedAt, coverage: result.scan.coverage } : null;
      row.rounds = rounds;
      row.errorCode = result.errorCode;
      if (result.errorCode === 'rate_limited') { row.problem = 'rate_limited'; row.retryAt = result.retryAt; await checkpoint(); break; }
      row.relationship = relationship;
      row.eligibility = summarizeAgentEvidence({ scanState: result.scan?.state ?? 'failed', relationship, observations: result.observations });
      row.repositoryFacts = repository ?? null;
      row.site = site ?? null;
      row.observations = result.observations;
      row.problem = !result.scan || result.scan.state !== 'complete' ? result.errorCode ?? 'incomplete_scan' : null;
      row.issues = [
        ...(!factsRefresh.complete ? ['facts_collection_incomplete'] : []),
        ...(factsRefresh.sourcesFailed > 0 ? ['facts_source_failed'] : []),
        ...(site?.state !== 'ok' ? ['site_fingerprint_unavailable'] : []),
        ...(relationship === 'conflict' ? ['repository_relationship_conflict'] : []),
        ...(row.problem ? [row.problem] : []),
      ];
    } catch (error) {
      // Raw provider/SQL errors can contain response or credential payloads.
      row.problem = 'collection_exception';
      row.errorType = error instanceof Error ? error.name : 'unknown';
    }
    await checkpoint();
    console.log(JSON.stringify({ slug: row.slug, scan: row.scan, problem: row.problem, relationship: row.relationship }));
  }
  report.completedAt = new Date().toISOString();
  await checkpoint();
  console.log(JSON.stringify({ output, count: report.products.length, apply: values.apply }));
  process.exitCode = report.products.length !== selected.length || report.products.some(row =>
    (Array.isArray(row.issues) && row.issues.length > 0) ||
    (row.problem && !['preserved_hidden', 'review_required'].includes(String(row.problem)))) ? 1 : 0;
}
main().catch(() => { console.error('Backfill failed; verify arguments and database availability.'); process.exitCode = 1; })
  .finally(async () => { await (globalThis as unknown as { pgClient?: { end: () => Promise<void> } }).pgClient?.end(); });
