import { expect, it } from 'vitest';
import { reviewQueueBucket } from '@/lib/crawl/admin-review';

it('shows the same human-only and AI-rejection buckets as the cause filter', () => {
  // 갈래 칩(reviewQueueCauses)과 두 화면의 목록 칸이 모두 이 함수를 쓴다
  expect(reviewQueueBucket('no_description', { cause: 'installable_product' }, false)).toBe('no_description');
  expect(reviewQueueBucket('repo_deleted', null, false)).toBe('repo_deleted');
  expect(reviewQueueBucket('ambiguous', { cause: 'agent_evidence' }, true)).toBe('ai_reject');
  expect(reviewQueueBucket('ambiguous', { cause: 'agent_evidence' }, false)).toBe('agent_evidence');
  expect(reviewQueueBucket('ambiguous', { cause: null }, false)).toBe('resolved');
  expect(reviewQueueBucket('ambiguous', null, false)).toBe('unknown');
});
