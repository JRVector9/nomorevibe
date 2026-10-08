import { expect, it } from 'vitest';
import { parseQueueFilters, queueFilterHref, intersectQueueIds } from '@/app/admin/status/queue-filters';
import { reviewQueueBucket } from '@/lib/crawl/admin-review';

it('validates URL filters and rejects repeated or inherited keys', () => {
  expect(parseQueueFilters({ cause: 'constructor', ai: ['approve'], minStars: '-1', updated: '999', queuePage: 'Infinity' }))
    .toEqual({ q: '', cause: '', ai: '', minStars: '', updated: '', page: 1 });
  expect(parseQueueFilters({ q: '  timer  ', cause: 'agent_evidence', ai: 'reject', minStars: '500', updated: '90', queuePage: '2' }))
    .toEqual({ q: 'timer', cause: 'agent_evidence', ai: 'reject', minStars: '500', updated: '90', page: 2 });
});

it('keeps the complete filter combination across pages and resets page when a filter changes', () => {
  const filters = parseQueueFilters({ q: 'a & b', cause: 'no_description', ai: 'none', minStars: '100', updated: '30', queuePage: '3' });
  const next = new URL(queueFilterHref(filters, { page: 4 }), 'http://localhost');
  expect(Object.fromEntries(next.searchParams)).toEqual({ q: 'a & b', cause: 'no_description', ai: 'none', minStars: '100', updated: '30', queuePage: '4' });
  expect(new URL(queueFilterHref(filters, { ai: 'approve' }), 'http://localhost').searchParams.has('queuePage')).toBe(false);
});

it('intersects the entire cause and AI candidate sets, keeping empty matches empty', () => {
  expect(intersectQueueIds([1, 2, 31], [31, 50])).toEqual([31]);
  expect(intersectQueueIds(undefined, [31])).toEqual([31]);
  expect(intersectQueueIds([], [31])).toEqual([]);
  expect(intersectQueueIds(undefined, undefined)).toBeUndefined();
});

it('shows the same human-only and AI-rejection buckets as the cause filter', () => {
  // 갈래 칩(reviewQueueCauses)과 두 화면의 목록 칸이 모두 이 함수를 쓴다
  expect(reviewQueueBucket('no_description', { cause: 'installable_product' }, false)).toBe('no_description');
  expect(reviewQueueBucket('repo_deleted', null, false)).toBe('repo_deleted');
  expect(reviewQueueBucket('ambiguous', { cause: 'agent_evidence' }, true)).toBe('ai_reject');
  expect(reviewQueueBucket('ambiguous', { cause: 'agent_evidence' }, false)).toBe('agent_evidence');
  expect(reviewQueueBucket('ambiguous', { cause: null }, false)).toBe('resolved');
  expect(reviewQueueBucket('ambiguous', null, false)).toBe('unknown');
});
