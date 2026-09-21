import { expect, it } from 'vitest';
import { parseQueueFilters, queueFilterHref, intersectQueueIds, queueEntryCause } from '@/app/admin/status/queue-filters';
import type { AdminReviewEntry } from '@/lib/crawl/admin-review';

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
  const entry = { candidate: { reason: 'no_description' }, verdict: { cause: null }, review: { decision: 'approve' } } as AdminReviewEntry;
  expect(queueEntryCause(entry)).toBe('no_description');
  expect(queueEntryCause({ ...entry, candidate: { reason: 'ambiguous' }, verdict: { cause: 'agent_evidence' }, review: { decision: 'reject' } } as AdminReviewEntry)).toBe('ai_reject');
  expect(queueEntryCause({ ...entry, candidate: { reason: 'ambiguous' }, verdict: null } as AdminReviewEntry)).toBe('unknown');
});
