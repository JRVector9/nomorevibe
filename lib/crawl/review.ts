import type { DecisionReason } from '@/lib/db/schema';
import { logger } from '@/lib/observability/logger';
import { overrideCandidate } from './admin-review';

export const REVIEW_REJECT_REASONS = [
  { value: 'personal_site', label: '개인 사이트·블로그' },
  { value: 'not_a_product', label: '배포된 서비스가 아님' },
  { value: 'large_oss', label: '대형 오픈소스' },
] as const satisfies readonly { value: DecisionReason; label: string }[];
export type ReviewDecision = 'approve' | 'reject';
export type ReviewResult = { ok: true } | { ok: false; message: string };

/** Legacy entrypoint now uses the same audited, stale-input-protected admin transaction. */
export async function decideCandidate(input: {
  repo: string; decision: ReviewDecision; reason?: string; admin: string;
  note?: string; inputHash?: string; sourceRevisionHash?: string; candidateRevisionHash?: string;
}): Promise<ReviewResult> {
  const reasonCode = input.decision === 'approve' ? 'passed' : REVIEW_REJECT_REASONS.find(row => row.value === input.reason)?.value;
  if (!reasonCode) return { ok: false, message: '알 수 없는 거부 사유입니다' };
  const result = await overrideCandidate({
    repo: input.repo, actor: input.admin, decision: input.decision, reasonCode, reason: input.note ?? '',
    inputHash: input.inputHash ?? '', sourceRevisionHash: input.sourceRevisionHash ?? '',
    candidateRevisionHash: input.candidateRevisionHash ?? '',
  });
  if (!result.ok) return result;
  logger.info('crawl.reviewed', { repo: input.repo, decision: input.decision, reason: reasonCode, admin: input.admin });
  return { ok: true };
}
