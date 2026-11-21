import { findRepositoryProduct } from '@/lib/domain/products/repository';
import type { DecisionReason, ProductStatus } from '@/lib/db/schema';
import { accessFromDocument, judgeStoredDocument } from './rules';
import { REVIEW_RULES_VERSION, type ReviewOutcome } from './agent-review-contract';
import type { ReviewDomainContext } from './agent-review-repository';
import { reviewSemanticNow } from './review-replay-context';

/**
 * 심사자와 무관한 규칙 갈림 — 스팸 의심(사람에게)·규칙 거절·이미 등재·금지·근거 보류(모델을 부르지 않는다).
 * 1차는 JS 앱 껍데기를 그리기 전에도 이것을 본다(jobs/agent-review.ts → shell-render-document.ts gate, 2026-11-21 983-A) — 모델을 부르지 않을
 * 후보, 특히 스팸 의심을 m1 의 Chromium 에서 실행하지 않는다. 그린 글은 이 갈림에 들어가지 않는다(원본의 수집 본문·README·근거만 본다).
 */
export async function prepareAgentReviewRules(context: ReviewDomainContext) {
  const { document, settings, input } = context;
  const verdict = judgeStoredDocument(document, settings, reviewSemanticNow(), settings.agentEvidence.enforceEligibility ? {
    relationship: input.snapshot.relationship, scanState: input.snapshot.scanState,
    observations: input.snapshot.evidence.map(evidence => evidence.observation),
  } : undefined);
  if (verdict.reason === 'suspected_spam') return { verdict, spam: true as const };
  const access = accessFromDocument(document, settings, reviewSemanticNow());
  const existing = access && verdict.state !== 'rejected'
    ? await findRepositoryProduct(document.repo, document.productUrl) : null;
  const hardReason = verdict.state === 'rejected' ? verdict.reason
    : existing ? existing.status === 'banned' ? 'banned' : 'already_listed' : null;
  const evidenceHold = !hardReason && settings.agentEvidence.enforceEligibility
    && !input.snapshot.evidenceSummary.eligible ? input.snapshot.evidenceSummary.reason : null;
  return { verdict, spam: false as const, existing, hardReason, evidenceHold };
}

/** 규칙 갈림이 모델을 부르지 않게 하는 까닭 — 없으면 null(모델이 가른다). 1차가 그리기 전 관문으로 쓴다 */
export function ruleGateReason(rules: Awaited<ReturnType<typeof prepareAgentReviewRules>>): string | null {
  if (rules.spam) return 'suspected_spam';
  if (rules.hardReason) return `rule_${rules.hardReason}`.slice(0, 80);
  return rules.evidenceHold ? 'evidence_hold' : null;
}

/** Existing server classification shared by the job and the prepared-item consumer. */
export async function prepareAgentReview(context: ReviewDomainContext, reviewer: { provider: string; model: string }) {
  const { input } = context;
  const rules = await prepareAgentReviewRules(context);
  const { verdict } = rules;
  if (rules.spam) return { verdict, spam: true, provider: 'rules', model: REVIEW_RULES_VERSION };
  const { existing, hardReason, evidenceHold } = rules;
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
