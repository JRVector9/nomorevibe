import { and, desc, eq } from 'drizzle-orm';
import { agentRepositoryObservations, agentRepositoryScans, crawlCandidates, crawlDocuments,
  crawlReviewAttempts, crawlSettings, type AgentRepositoryScan, type CrawlCandidate,
  type CrawlDocument, type CrawlReviewAttempt } from '@/lib/db/schema';
import type { ProductTransaction } from '@/lib/domain/products/generation';
import { lockRepositoryAgentEvidence } from '@/lib/domain/evidence/agents/lock';
import { effectiveAgentScanState } from '@/lib/domain/evidence/agents/coverage';
import { readItemStage, type ItemStageGuard } from '@/lib/jobs/items/repository';
import { DEFAULT_CRAWL_SETTINGS } from './settings-schema';

const lockedContext: unique symbol = Symbol('AdminEvidenceRefreshCompletion');
export type AdminEvidenceRefreshCompletionContext = Readonly<{
  [lockedContext]: {
    tx: ProductTransaction;
    fetchGuard: ItemStageGuard;
    candidate: CrawlCandidate;
    document: CrawlDocument;
    scan: AgentRepositoryScan | undefined;
    request: CrawlReviewAttempt;
  };
}>;
export type AdminEvidenceRefreshCompletionResult = { consumed: boolean; needsJudgement: boolean };

/** Caller holds fetch→ai1→ai2 stage SHARE first. Acquire this domain prefix
 * before frontier/item locks; no job lock or nested transaction is taken here. */
export async function lockAdminEvidenceRefreshCompletion(
  tx: ProductTransaction, repo: string, fetchGuard: ItemStageGuard,
): Promise<AdminEvidenceRefreshCompletionContext | null> {
  const stage = await readItemStage(tx, fetchGuard);
  if (stage.stage !== 'fetch') throw new Error('admin_evidence_refresh_stage_guard_required');
  const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.repo, repo)).for('update');
  const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.repo, repo)).for('share');
  if (!candidate || !document || candidate.decidedBy !== 'auto' || candidate.state !== 'needs_review'
    || candidate.publishedSlug) return null;
  await tx.insert(crawlSettings).values({ id: 1, values: DEFAULT_CRAWL_SETTINGS }).onConflictDoNothing();
  await tx.select({ id: crawlSettings.id }).from(crawlSettings).where(eq(crawlSettings.id, 1)).for('share');
  await lockRepositoryAgentEvidence(tx, repo.toLowerCase());
  const [scan] = await tx.select().from(agentRepositoryScans).where(and(
    eq(agentRepositoryScans.repositoryKey, repo.toLowerCase()), eq(agentRepositoryScans.scope, ''),
  )).orderBy(desc(agentRepositoryScans.startedAt), desc(agentRepositoryScans.id)).limit(1).for('update');
  if (scan) await tx.select({ id: agentRepositoryObservations.id }).from(agentRepositoryObservations)
    .where(eq(agentRepositoryObservations.scanId, scan.id)).for('share');
  const [request] = await tx.select().from(crawlReviewAttempts).where(and(
    eq(crawlReviewAttempts.candidateId, candidate.id), eq(crawlReviewAttempts.kind, 'evidence_refresh'),
  )).orderBy(desc(crawlReviewAttempts.id)).limit(1).for('share');
  if (!request) return null;
  return Object.freeze({ [lockedContext]: { tx, fetchGuard, candidate, document, scan, request } });
}

/** Apply after source writes and before item release/jobs. Only already locked
 * rows are read or changed; the supplied timestamp must match the actual row. */
export async function applyAdminEvidenceRefreshCompletion(
  tx: ProductTransaction, context: AdminEvidenceRefreshCompletionContext,
  saved: { documentFetchedAt?: Date } = {},
): Promise<AdminEvidenceRefreshCompletionResult> {
  const locked = context[lockedContext];
  if (!locked || locked.tx !== tx) throw new Error('admin_evidence_refresh_transaction_mismatch');
  await readItemStage(tx, locked.fetchGuard);
  const unchanged = { consumed: false, needsJudgement: false };
  const [document] = await tx.select().from(crawlDocuments).where(eq(crawlDocuments.id, locked.document.id));
  const [candidate] = await tx.select().from(crawlCandidates).where(eq(crawlCandidates.id, locked.candidate.id));
  if (!candidate || !document || document.repo !== locked.document.repo
    || candidate.decidedBy !== 'auto' || candidate.publishedSlug
    || (candidate.state !== 'needs_review' && !(candidate.state === 'new' && candidate.reason === 'source_changed'))
    || saved.documentFetchedAt && saved.documentFetchedAt.getTime() !== document.fetchedAt.getTime()) return unchanged;
  const { request, scan } = locked;
  if (Number(candidate.signals?.adminEvidenceRefreshConsumedId ?? 0) >= request.id
    || request.source.candidateJudgedAt !== (candidate.judgedAt?.toISOString() ?? null)) return unchanged;
  const freshDocument = document.fetchedAt > new Date(request.source.documentFetchedAt);
  const freshScan = !!scan?.completedAt && effectiveAgentScanState(scan) === 'complete' && !scan.lastErrorCode
    && scan.completedAt > new Date(request.source.scanCompletedAt ?? request.startedAt.toISOString());
  if (!freshDocument && !freshScan) return unchanged;
  await tx.update(crawlCandidates).set({ state: 'new', reason: 'source_changed', updatedAt: new Date(),
    signals: { ...candidate.signals, adminEvidenceRefreshConsumedId: request.id },
  }).where(eq(crawlCandidates.id, candidate.id));
  return { consumed: true, needsJudgement: true };
}
