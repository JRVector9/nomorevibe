import { and, inArray, not, sql, type SQL } from 'drizzle-orm';
import { crawlCandidates, crawlDocuments, crawlReviewAttempts, type CandidateState } from '@/lib/db/schema';
import type { ReviewCursor } from './admin-review-cursor';
import type { ReviewAiDecision, ReviewSort } from './admin-review';

export type AdminReviewFilterState = 'all' | 'pending' | 'new' | 'approved' | 'needs_review' | 'rejected' | 'published';

/** Explicit all-stage reads include completed states. Existing pending reads retain their original three states. */
export function adminReviewCandidateStates(state?: AdminReviewFilterState): readonly CandidateState[] {
  if (state === 'all') return ['new', 'approved', 'needs_review', 'rejected', 'published'];
  if (state === 'rejected' || state === 'published' || state === 'needs_review' || state === 'new' || state === 'approved') return [state];
  return ['new', 'approved', 'needs_review'];
}

export type AdminReviewListOptions = {
  state?: AdminReviewFilterState; after?: number; offset?: number; limit?: number;
  /** Browser scroll uses the complete sort boundary; legacy after(id) remains for exports. */
  cursor?: ReviewCursor;
  /** 갈래로 걸러 볼 때. 계산으로 얻은 값이라 SQL로 거를 수 없어 id 를 받는다 */
  ids?: number[];
  /** 이름(페이지 제목)·레포·주소에 이 글자가 들어간 것만 */
  search?: string;
  /** Minimum GitHub stars, applied before pagination. Unknown counts do not match. */
  minStars?: number;
  /**
   * 마지막 푸시가 이 일수보다 오래된 것을 목록에서 뺀다 — 화면에서만 빼고 후보는 그대로 둔다(2026-09-19 사용자 결정).
   * 푸시 시각을 모르는 것은 오래됐다고 볼 근거가 없어 남긴다. 뺀 수는 hiddenByAge 로 돌려준다.
   */
  pushedWithinDays?: number;
  /** 표 머리에서 고른 정렬. 기본은 들어온 차례다 */
  sort?: ReviewSort;
  /** 저장된 판정 이유. action parser 가 검증한 원문과 같은 값만 */
  reason?: string;
  /** 자동 판정의 최신 성공 결과. 없거나 알 수 없으면 'none'. */
  aiDecision?: ReviewAiDecision;
};

/** 목록 정렬에 쓰는 별 수 식. 원본 repoNumber('stargazers_count') 와 같은 SQL 이다. */
const stargazers = sql`(select case when d.repo_meta->>${'stargazers_count'} ~ '^[0-9]+$'
  then (d.repo_meta->>${'stargazers_count'})::bigint end from ${crawlDocuments} d where d.repo = ${crawlCandidates.repo})`;

export function adminReviewListPredicates(options: AdminReviewListOptions): { base: SQL | undefined; where: SQL | undefined; stale: SQL | undefined } {
  const states = adminReviewCandidateStates(options.state);
  const emptyIds = options.ids !== undefined && options.ids.length === 0;
  const term = options.search?.trim().slice(0, 100);
  // ILIKE 의 % _ \\ 는 글자 그대로 찾는다
  const like = term ? `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
  const matches = like ? sql`(${crawlCandidates.repo} ilike ${like} or coalesce(${crawlCandidates.productUrl}, '') ilike ${like}
    or exists (select 1 from ${crawlDocuments} d where d.repo = ${crawlCandidates.repo} and coalesce(d.page_meta->>'title', '') ilike ${like}))` : undefined;
  const days = options.pushedWithinDays && Number.isSafeInteger(options.pushedWithinDays) && options.pushedWithinDays > 0 ? options.pushedWithinDays : null;
  const stale = days ? sql`exists (select 1 from ${crawlDocuments} d where d.repo = ${crawlCandidates.repo}
    and d.repo_meta->>'pushed_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
    and (d.repo_meta->>'pushed_at')::timestamptz <= now() - make_interval(days => ${days}))` : undefined;
  const reason = options.reason ? sql`${crawlCandidates.reason} = ${options.reason}` : undefined;
  const aiDecision = options.aiDecision ? sql`coalesce((
    select case
      when ${crawlReviewAttempts.outcome}->>'decision' in ('approve', 'reject', 'needs_review')
        then ${crawlReviewAttempts.outcome}->>'decision'
      else 'none'
    end
    from ${crawlReviewAttempts}
    where ${crawlReviewAttempts.candidateId} = ${crawlCandidates.id}
      and ${crawlReviewAttempts.state} = 'succeeded'
      and ${crawlReviewAttempts.kind} = 'automatic'
    order by ${crawlReviewAttempts.id} desc
    limit 1
  ), 'none') = ${options.aiDecision}` : undefined;
  const base = emptyIds ? sql`false` : and(inArray(crawlCandidates.state, [...states]),
    options.ids ? inArray(crawlCandidates.id, options.ids) : undefined,
    sql`${crawlCandidates.id} > ${Math.max(0, options.after ?? 0)}`, matches,
    Number.isSafeInteger(options.minStars) && options.minStars! >= 0
      ? sql`${stargazers} >= ${options.minStars}` : undefined,
    reason, aiDecision);
  const where = emptyIds ? sql`false` : stale ? and(base, not(stale)) : base;
  return { base, where, stale };
}
