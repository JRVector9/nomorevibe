import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { crawlCandidates, products } from '@/lib/db/schema';
import { AGENT_DETECTOR_VERSION } from '@/lib/domain/evidence/agents/types';
import { getSettings } from '@/lib/crawl/settings';
import { refreshRepositoryAgentEvidence } from '@/lib/domain/evidence/agents/repository';
import type { AgentGitHubRequest } from '@/lib/domain/evidence/agents/collect';
import type { JobContext, JobOutcome } from '@/lib/jobs/runner';

export type AgentEvidenceRefreshCursor = { afterRepository?: string; retryAfter?: string };
export function prioritizeAgentRefreshDemand(duePartial: string[], repositories: string[]) {
  const resumed = new Set(duePartial.slice(0, 3));
  return [...resumed].map(repositoryKey => ({ repositoryKey, advanceCursor: false }))
    .concat(repositories.filter(key => !resumed.has(key)).map(repositoryKey => ({ repositoryKey, advanceCursor: true })));
}
export async function refreshAgentEvidenceJob(ctx: JobContext<AgentEvidenceRefreshCursor>, dependencies: { request?: AgentGitHubRequest } = {}): Promise<JobOutcome<AgentEvidenceRefreshCursor>> {
  const deadlineAt = Date.now() + 20_000;
  const settings = await getSettings();
  if (!settings.agentEvidence.enabled) { ctx.log('agent_evidence.disabled'); return { done: true }; }
  if (ctx.cursor?.retryAfter && new Date(ctx.cursor.retryAfter).getTime() > Date.now()) return { done: false, cursor: ctx.cursor };
  let afterRepository = ctx.cursor?.afterRepository ?? '';
  // Merge product and candidate demand. Only public GitHub owner/repo identities enter the collector.
  const demand = sql`
      SELECT lower(regexp_replace(repo_url, '^https://github.com/([^/]+/[^/#?]+?)([.]git)?/?$', '\\1')) AS repository_key
      FROM products WHERE status != 'banned' AND repo_url ~ '^https://github.com/[^/]+/[^/#?]+/?$'
      UNION
      SELECT lower(repo) AS repository_key FROM crawl_candidates WHERE state IN ('new', 'needs_review', 'approved')
  `;
  const partial = await db.execute<{ repository_key: string }>(sql`
    SELECT latest.repository_key FROM (
      SELECT DISTINCT ON (repository_key) repository_key, state, next_attempt_at, cursor
      FROM agent_repository_scans WHERE scope = '' AND detector_version = ${AGENT_DETECTOR_VERSION}
      ORDER BY repository_key, started_at DESC, id DESC
    ) latest JOIN (${demand}) demand USING (repository_key)
    WHERE latest.state = 'partial' AND latest.next_attempt_at <= now()
      AND (jsonb_array_length(coalesce(latest.cursor->'pendingTrees', '[]'::jsonb)) > 0
        OR jsonb_array_length(coalesce(latest.cursor->'pendingBlobs', '[]'::jsonb)) > 0
        OR jsonb_array_length(coalesce(latest.cursor->'pendingCommits', '[]'::jsonb)) > 0)
    ORDER BY latest.next_attempt_at, latest.repository_key LIMIT 3
  `);
  const rows = await db.execute<{ repository_key: string }>(sql`
    SELECT repository_key FROM (${demand}) demand
    WHERE repository_key > ${afterRepository} ORDER BY repository_key LIMIT 10
  `);
  const work = prioritizeAgentRefreshDemand(partial.map(row => row.repository_key), rows.map(row => row.repository_key));
  for (const row of work) {
    if (!ctx.hasBudget() || Date.now() > deadlineAt - 8_000) return { done: false, cursor: { afterRepository } };
    const repositoryKey = row.repositoryKey;
    try {
      const result = await refreshRepositoryAgentEvidence({ repositoryKey, hasBudget: ctx.hasBudget, request: dependencies.request, deadlineAt });
      if (result.errorCode === 'budget_exhausted') {
        ctx.log('agent_evidence.deferred', { repositoryKey, scanId: result.scan?.id ?? null, state: 'pending', errorCode: result.errorCode });
        const cursor = { afterRepository };
        await ctx.save(cursor);
        return { done: false, cursor };
      }
      ctx.log('agent_evidence.scanned', { repositoryKey, scanId: result.scan?.id ?? null, state: result.scan?.state ?? 'failed', observations: result.observations.length, cached: result.cached, errorCode: result.errorCode });
      if (result.scan?.state === 'complete' && !result.errorCode) {
        // Attach all products sharing the repo; refresh's cache prevents repeated HTTP work.
        const linkedProducts = await db.select({ id: products.id, slug: products.slug }).from(products).where(sql`lower(regexp_replace(${products.repoUrl}, '/$', '')) IN (${`https://github.com/${repositoryKey}`}, ${`https://github.com/${repositoryKey}.git`})`);
        for (const product of linkedProducts) await refreshRepositoryAgentEvidence({ repositoryKey, productSlug: product.slug, productId: product.id });
        await db.update(crawlCandidates).set({ state: 'new', updatedAt: new Date() }).where(and(sql`lower(${crawlCandidates.repo}) = ${repositoryKey}`, eq(crawlCandidates.state, 'needs_review'), eq(crawlCandidates.reason, 'ai_evidence_pending'), eq(crawlCandidates.decidedBy, 'auto')));
      }
      if (result.errorCode === 'rate_limited') {
        const retryAfter = result.retryAt ?? result.scan?.nextAttemptAt ?? new Date(Date.now() + 15 * 60_000);
        const cursor = { afterRepository, retryAfter: retryAfter.toISOString() };
        await ctx.save(cursor); return { done: false, cursor };
      }
    } catch (error) {
      ctx.log('agent_evidence.failed', { repositoryKey, errorCode: error instanceof Error ? error.name : 'unknown' });
    }
    if (row.advanceCursor) afterRepository = repositoryKey;
    await ctx.save({ afterRepository });
  }
  return rows.length < 10 ? { done: true } : { done: false, cursor: { afterRepository } };
}
