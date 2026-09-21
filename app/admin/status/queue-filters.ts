import type { AdminReviewEntry, ReviewAiDecision } from '@/lib/crawl/admin-review';
import { CAUSE_GUIDE, type CauseKey } from '../review/causes';

export type QueueSearch = Record<string, string | string[] | undefined>;
export const QUEUE_PAGE_SIZE = 14;
export const QUEUE_AI_FILTERS: [ReviewAiDecision, string][] = [
  ['reject', 'AI 거부'], ['approve', 'AI 승인'], ['needs_review', 'AI 보류'], ['none', '판단 없음'],
];
export const QUEUE_STAR_FILTERS = ['100', '500', '1000', '5000'] as const;
export const QUEUE_PUSH_FILTERS = ['30', '90', '180', '365'] as const;
export type QueueFilters = {
  q: string; cause: CauseKey | ''; ai: ReviewAiDecision | '';
  minStars: string; updated: string; page: number;
};
const one = (value: string | string[] | undefined) => typeof value === 'string' ? value : '';

export function parseQueueFilters(params: QueueSearch): QueueFilters {
  const cause = one(params.cause), ai = one(params.ai), stars = one(params.minStars), updated = one(params.updated);
  const page = Number(one(params.queuePage) || 1);
  return {
    q: one(params.q).trim().slice(0, 100),
    cause: Object.hasOwn(CAUSE_GUIDE, cause) ? cause as CauseKey : '',
    ai: QUEUE_AI_FILTERS.some(([key]) => key === ai) ? ai as ReviewAiDecision : '',
    minStars: QUEUE_STAR_FILTERS.some(value => value === stars) ? stars : '',
    updated: QUEUE_PUSH_FILTERS.some(value => value === updated) ? updated : '',
    page: Number.isSafeInteger(page) && page > 0 && page <= 1_000_000 ? page : 1,
  };
}

/** A changed condition starts at page one; pagination explicitly supplies its page. */
export function queueFilterHref(filters: QueueFilters, patch: Partial<QueueFilters> = {}): string {
  const { page, ...values } = { ...filters, page: 1, ...patch };
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value) query.set(key, value);
  if (page > 1) query.set('queuePage', String(page));
  return `/admin/status${query.size ? `?${query}` : ''}`;
}

export function intersectQueueIds(causeIds?: number[], aiIds?: number[]): number[] | undefined {
  if (!causeIds) return aiIds;
  if (!aiIds) return causeIds;
  const allowed = new Set(aiIds);
  return causeIds.filter(id => allowed.has(id));
}

/** Match reviewQueueCauses, including reasons that do not appear in the rule verdict. */
export function queueEntryCause(entry: AdminReviewEntry): CauseKey {
  if (entry.candidate.reason === 'second_review_split' || entry.candidate.reason === 'no_description') return entry.candidate.reason;
  if (!entry.verdict) return 'unknown';
  if (!entry.verdict.cause) return 'resolved';
  return entry.review?.decision === 'reject' ? 'ai_reject' : entry.verdict.cause;
}
