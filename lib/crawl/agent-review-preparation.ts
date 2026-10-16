import { findRepositoryProduct } from '@/lib/domain/products/repository';
import type { DecisionReason, ProductStatus } from '@/lib/db/schema';
import { accessFromDocument, judgeStoredDocument } from './rules';
import { REVIEW_RULES_VERSION, type ReviewOutcome } from './agent-review-contract';
import type { ReviewDomainContext } from './agent-review-repository';
import { reviewSemanticNow } from './review-replay-context';

/** Existing server classification shared by the job and the prepared-item consumer. */
export async function prepareAgentReview(context: ReviewDomainContext, reviewer: { provider: string; model: string }) {
  const { document, settings, input } = context;
  const verdict = judgeStoredDocument(document, settings, reviewSemanticNow(), settings.agentEvidence.enforceEligibility ? {
    relationship: input.snapshot.relationship, scanState: input.snapshot.scanState,
    observations: input.snapshot.evidence.map(evidence => evidence.observation),
  } : undefined);
  if (verdict.reason === 'suspected_spam') return { verdict, spam: true, provider: 'rules', model: REVIEW_RULES_VERSION };
  const access = accessFromDocument(document, settings, reviewSemanticNow());
  const existing = access && verdict.state !== 'rejected'
    ? await findRepositoryProduct(document.repo, document.productUrl) : null;
  const hardReason = verdict.state === 'rejected' ? verdict.reason
    : existing ? existing.status === 'banned' ? 'banned' : 'already_listed' : null;
  const evidenceHold = !hardReason && settings.agentEvidence.enforceEligibility
    && !input.snapshot.evidenceSummary.eligible ? input.snapshot.evidenceSummary.reason : null;
  const provider = hardReason || evidenceHold ? 'rules' : reviewer.provider;
  const outcome: ReviewOutcome | undefined = hardReason ? {
    decision: 'reject', reason: `기존 등재 규칙에 해당합니다: ${hardReason}`, evidenceIds: ['product'],
  } : evidenceHold ? {
    decision: 'needs_review', reason: `개발 근거 확인이 필요합니다 (${evidenceHold}). 현재 수집 내용만으로 승인하거나 부적격으로 확정하지 않습니다.`,
    evidenceIds: ['product', ...input.snapshot.evidence.slice(0, 8).map(item => item.id)],
  } : undefined;
  const ruleRejection: { reason: DecisionReason; existingSlug?: string; existingStatus?: ProductStatus } | undefined = hardReason
    ? { reason: hardReason, ...(existing ? { existingSlug: existing.slug, existingStatus: existing.status } : {}) } : undefined;
  return { verdict, spam: false, provider, model: provider === 'rules' ? REVIEW_RULES_VERSION : reviewer.model,
    hardReason, evidenceHold, outcome, ruleRejection };
}
