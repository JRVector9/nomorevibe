import { createHash } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db';
import { agentRepositoryScans, agentRepositoryObservations, crawlDiscoveryEvidence, productEvidenceSources, productLinks, type AgentRepositoryScan } from '@/lib/db/schema';
import { withProductGeneration } from '@/lib/domain/products/generation';
import { agentObservationSchema, AGENT_DETECTOR_VERSION, type AgentObservation } from './types';
import { collectRepositoryAgentEvidence, normalizeAgentRepositoryKey, type CollectResult, type AgentGitHubRequest } from './collect';
import { lockRepositoryAgentEvidence } from './lock';
const DAY = 24 * 60 * 60 * 1000;
const digest = (input: unknown) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
const observationKey = (observation: AgentObservation) => digest(Object.keys(observation).sort().map(key => [key, observation[key as keyof AgentObservation]]));
export async function recordDiscoveryEvidence(input: { repositoryKey: string; signalId: string; sourceUrl: string; commitSha?: string | null; attribution?: { client: string | null; label: string } | null; searchWindowFrom?: Date | null; searchWindowTo?: Date | null; incomplete?: boolean }): Promise<void> {
  const repositoryKey = normalizeAgentRepositoryKey(input.repositoryKey);
  const url = new URL(input.sourceUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || !url.pathname.toLowerCase().startsWith(`/${repositoryKey}/`) && url.pathname.toLowerCase() !== `/${repositoryKey}`) throw new Error('invalid discovery source');
  const signalId = z.string().min(1).max(80).parse(input.signalId);
  const commitSha = input.commitSha == null ? null : z.string().regex(/^[a-f0-9]{40,64}$/).parse(input.commitSha);
  const attribution = input.attribution == null ? null : z.object({ client: z.string().max(80).nullable(), label: z.string().max(120).regex(/^[^\x00-\x1f<>@]+$/) }).parse(input.attribution);
  const evidenceKey = digest([input.sourceUrl, commitSha, attribution, signalId]);
  await db.insert(crawlDiscoveryEvidence).values({ repositoryKey, signalId, evidenceKey, sourceUrl: url.href, commitSha, attribution, searchWindowFrom: input.searchWindowFrom, searchWindowTo: input.searchWindowTo, incomplete: input.incomplete ?? false }).onConflictDoNothing();
}
export async function listDiscoveryEvidence(repositoryKey: string) {
  return db.select().from(crawlDiscoveryEvidence).where(eq(crawlDiscoveryEvidence.repositoryKey, normalizeAgentRepositoryKey(repositoryKey))).orderBy(desc(crawlDiscoveryEvidence.observedAt)).limit(200);
}
export async function getRepositoryAgentEvidence(scanId: number): Promise<{ scan: AgentRepositoryScan; observations: AgentObservation[] } | null> {
  const scan = await db.query.agentRepositoryScans.findFirst({ where: eq(agentRepositoryScans.id, scanId) });
  if (!scan) return null;
  const rows = await db.select().from(agentRepositoryObservations).where(eq(agentRepositoryObservations.scanId, scanId)).orderBy(agentRepositoryObservations.id);
  return { scan, observations: rows.flatMap(row => { const parsed = agentObservationSchema.safeParse(row.facts); return parsed.success ? [parsed.data] : []; }) };
}
export async function getLatestRepositoryAgentScan(repositoryKey: string, scope = '') {
  return await db.query.agentRepositoryScans.findFirst({ where: and(eq(agentRepositoryScans.repositoryKey, normalizeAgentRepositoryKey(repositoryKey)), eq(agentRepositoryScans.scopeHash, digest(scope)), eq(agentRepositoryScans.detectorVersion, AGENT_DETECTOR_VERSION)), orderBy: [desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)] }) ?? null;
}
export async function getLatestRepositoryAgentEvidence(repositoryKey: string, scope = '') {
  const scan = await db.query.agentRepositoryScans.findFirst({ where: and(eq(agentRepositoryScans.repositoryKey, normalizeAgentRepositoryKey(repositoryKey)), eq(agentRepositoryScans.scopeHash, digest(scope)), eq(agentRepositoryScans.detectorVersion, AGENT_DETECTOR_VERSION), eq(agentRepositoryScans.state, 'complete')), orderBy: [desc(agentRepositoryScans.completedAt), desc(agentRepositoryScans.id)] });
  const selected = scan ?? await getLatestRepositoryAgentScan(repositoryKey, scope);
  return selected ? getRepositoryAgentEvidence(selected.id) : null;
}
export async function saveRepositoryAgentScan(result: CollectResult, now = new Date()) {
  if (!result.repositoryId || !result.commitSha) return null;
  const observations = result.observations.map(value => agentObservationSchema.parse(value));
  if (observations.some(value => {
    if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) return true;
    if (value.kind === 'commit_attribution') return value.sourcePath !== null || value.blobSha !== null || value.sourceUrl !== `https://github.com/${result.repositoryKey}/commit/${value.commitSha}`;
    return value.commitSha !== result.commitSha || value.sourcePath === null || value.sourceUrl !== `https://github.com/${result.repositoryKey}/blob/${result.commitSha}/${value.sourcePath.split('/').map(encodeURIComponent).join('/')}`;
  })) throw new Error('invalid agent observation');
  const nextAttemptAt = result.retryAt && result.retryAt > now ? result.retryAt : new Date(now.getTime() + (result.state === 'complete' || result.cursor?.coverageLimited && !result.cursor.pendingTrees.length && !result.cursor.pendingBlobs.length && !result.cursor.pendingCommits?.length ? DAY : result.errorCode ? 15 * 60_000 : 60_000));
  return db.transaction(async tx => {
    await lockRepositoryAgentEvidence(tx, result.repositoryKey, result.scope);
    const [scan] = await tx.insert(agentRepositoryScans).values({ githubRepositoryId: BigInt(result.repositoryId!), repositoryKey: result.repositoryKey, commitSha: result.commitSha!, detectorVersion: AGENT_DETECTOR_VERSION, scope: result.scope, scopeHash: digest(result.scope), state: result.state, cursor: result.cursor, requestCount: result.requestCount, fileCount: result.fileCount, coverage: { limited: result.cursor?.coverageLimited ?? false }, startedAt: now, completedAt: result.state === 'complete' ? now : null, lastErrorCode: result.errorCode, nextAttemptAt }).onConflictDoUpdate({ target: [agentRepositoryScans.githubRepositoryId, agentRepositoryScans.commitSha, agentRepositoryScans.detectorVersion, agentRepositoryScans.scopeHash], set: { state: sql`CASE WHEN ${agentRepositoryScans.state} = 'complete' THEN 'complete' ELSE ${result.state} END`, cursor: sql`CASE WHEN ${agentRepositoryScans.state} = 'complete' THEN NULL ELSE ${JSON.stringify(result.cursor)}::jsonb END`, requestCount: sql`${agentRepositoryScans.requestCount} + ${result.requestCount}`, fileCount: sql`${agentRepositoryScans.fileCount} + ${result.fileCount}`, startedAt: now, completedAt: result.state === 'complete' ? now : sql`${agentRepositoryScans.completedAt}`, lastErrorCode: result.errorCode, nextAttemptAt } }).returning();
    for (const facts of observations) await tx.insert(agentRepositoryObservations).values({ scanId: scan.id, observationKey: observationKey(facts), facts }).onConflictDoNothing();
    return scan;
  });
}
/** Attach only to an existing visible repository source, under the product generation lock. */
export async function attachRepositoryAgentScan(input: { productSlug: string; productId: number; scanId: number }) {
  return withProductGeneration(input.productSlug, input.productId, async tx => {
    const scan = await tx.query.agentRepositoryScans.findFirst({ where: eq(agentRepositoryScans.id, input.scanId) });
    if (!scan || scan.state !== 'complete' || scan.lastErrorCode || scan.scope !== '') return false;
    const links = await tx.select().from(productLinks).where(and(eq(productLinks.slug, input.productSlug), eq(productLinks.kind, 'repository'), eq(productLinks.visible, true)));
    const link = links.find(row => row.normalizedKey.toLowerCase() === `github:${scan.repositoryKey}` || row.normalizedKey.toLowerCase() === scan.repositoryKey || row.url.replace(/\/$/, '').toLowerCase() === `https://github.com/${scan.repositoryKey}`);
    if (!link) return false;
    const sources = await tx.select().from(productEvidenceSources).where(and(eq(productEvidenceSources.slug, input.productSlug), eq(productEvidenceSources.kind, 'repository'), eq(productEvidenceSources.sourceKey, link.normalizedKey))).for('update');
    if (!sources[0]) return false;
    const normalizedFacts = { ...sources[0].normalizedFacts, agentScanId: scan.id, agentDetectorVersion: scan.detectorVersion };
    if (Buffer.byteLength(JSON.stringify(normalizedFacts)) > 64 * 1024) return false;
    await tx.update(productEvidenceSources).set({ normalizedFacts, updatedAt: new Date() }).where(eq(productEvidenceSources.id, sources[0].id));
    return true;
  });
}
export async function refreshRepositoryAgentEvidence(input: { repositoryKey: string; scope?: string; productSlug?: string; productId?: number; force?: boolean; hasBudget?: () => boolean; request?: AgentGitHubRequest; deadlineAt?: number }) {
  const latest = await getLatestRepositoryAgentScan(input.repositoryKey, input.scope);
  const now = new Date();
  if (latest && !input.force && latest.nextAttemptAt > now) {
    if (latest.state === 'complete' && input.productSlug && input.productId) await attachRepositoryAgentScan({ productSlug: input.productSlug, productId: input.productId, scanId: latest.id });
    return { ...(await getRepositoryAgentEvidence(latest.id))!, cached: true, errorCode: latest.lastErrorCode, retryAt: latest.nextAttemptAt };
  }
  const resume = latest?.state === 'partial' && latest.cursor && (latest.cursor.pendingTrees.length || latest.cursor.pendingBlobs.length || latest.cursor.pendingCommits?.length) ? latest.cursor : null;
  const discovery = await listDiscoveryEvidence(input.repositoryKey);
  const discoveryCommitShas = discovery.flatMap(row => row.commitSha ? [row.commitSha] : []);
  const result = await collectRepositoryAgentEvidence({ ...input, discoveryCommitShas, cursor: resume, knownComplete: latest?.state === 'complete' ? { repositoryId: String(latest.githubRepositoryId), commitSha: latest.commitSha } : undefined });
  // A failed metadata/branch request cannot create a new immutable scan, but it must
  // invalidate the previous confirmation until a successful public recheck clears it.
  // Budget exhaustion is a deferred attempt, never an upstream failure.
  const persistedResult: CollectResult = !result.commitSha && result.errorCode && result.errorCode !== 'budget_exhausted' && latest
    ? { ...result, repositoryId: String(latest.githubRepositoryId), commitSha: latest.commitSha, scope: latest.scope, state: 'failed', cursor: null }
    : result;
  const scan = await saveRepositoryAgentScan(persistedResult, now);
  if (!scan) return { scan: null, observations: result.observations, cached: false, errorCode: result.errorCode, retryAt: result.retryAt };
  if (scan.state === 'complete' && input.productSlug && input.productId) await attachRepositoryAgentScan({ productSlug: input.productSlug, productId: input.productId, scanId: scan.id });
  return { ...(await getRepositoryAgentEvidence(scan.id))!, cached: false, errorCode: result.errorCode, retryAt: result.retryAt };
}
