import { expect, it } from 'vitest';
import { NEW_PRODUCT_SCAN_SHARE, prioritizeAgentRefreshDemand, REVIEW_SCAN_SHARE } from '@/lib/jobs/products/agent-evidence-refresh';
it('resumes due partial repositories before the pagination cursor without advancing it', () => {
  const work = prioritizeAgentRefreshDemand(['acme/first', 'acme/other'], ['acme/new', 'acme/other']);
  expect(work).toEqual([
    { repositoryKey: 'acme/first', advanceCursor: false },
    { repositoryKey: 'acme/other', advanceCursor: false },
    { repositoryKey: 'acme/new', advanceCursor: true },
  ]);
});

it('puts repositories waiting on first review between resumed scans and the alphabetical sweep, capped per tick', () => {
  // 심사를 기다리는 레포는 몫(REVIEW_SCAN_SHARE)까지만 앞에 선다. 나머지는 다음 틱에 다시 골린다
  const waiting = Array.from({ length: REVIEW_SCAN_SHARE + 1 }, (_, i) => `wait/r${i}`);
  const work = prioritizeAgentRefreshDemand(['acme/partial'], ['aaa/sweep', 'wait/r0'], waiting);
  expect(work).toEqual([
    { repositoryKey: 'acme/partial', advanceCursor: false },
    ...waiting.slice(0, REVIEW_SCAN_SHARE).map(repositoryKey => ({ repositoryKey, advanceCursor: false })),
    // 일반 대기에도 있던 wait/r0 은 앞에서 한 번만 본다 — 커서는 일반 대기의 것만 옮긴다
    { repositoryKey: 'aaa/sweep', advanceCursor: true },
  ]);
});

it('does not scan a repository twice when it is both resumable and waiting on review', () => {
  const work = prioritizeAgentRefreshDemand(['acme/both'], [], ['acme/both', 'acme/review']);
  expect(work.map(row => row.repositoryKey)).toEqual(['acme/both', 'acme/review']);
});

it('puts never-scanned public products after review waits and before the sweep, capped per tick, carrying their product id', () => {
  const fresh = Array.from({ length: NEW_PRODUCT_SCAN_SHARE + 1 }, (_, i) => ({ id: 100 + i, repositoryKey: `new/p${i}` }));
  const work = prioritizeAgentRefreshDemand(['acme/partial'], ['aaa/sweep', 'new/p0'], ['wait/r0'], fresh);
  expect(work).toEqual([
    { repositoryKey: 'acme/partial', advanceCursor: false },
    { repositoryKey: 'wait/r0', advanceCursor: false },
    ...fresh.slice(0, NEW_PRODUCT_SCAN_SHARE).map(({ id, repositoryKey }) => ({ repositoryKey, advanceCursor: false, newProductId: id })),
    // 일반 대기에도 있던 new/p0 은 앞에서 한 번만 본다
    { repositoryKey: 'aaa/sweep', advanceCursor: true },
  ]);
});

it('keeps the new-product position when its repository is already ahead for another reason', () => {
  const work = prioritizeAgentRefreshDemand(['acme/both'], [], [], [{ id: 7, repositoryKey: 'acme/both' }]);
  expect(work).toEqual([{ repositoryKey: 'acme/both', advanceCursor: false, newProductId: 7 }]);
});
