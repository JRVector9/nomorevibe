import { expect, it } from 'vitest';
import { prioritizeAgentRefreshDemand } from '@/lib/jobs/products/agent-evidence-refresh';
it('resumes due partial repositories before the pagination cursor without advancing it', () => {
  const work = prioritizeAgentRefreshDemand(['acme/first', 'acme/other'], ['acme/new', 'acme/other']);
  expect(work).toEqual([
    { repositoryKey: 'acme/first', advanceCursor: false },
    { repositoryKey: 'acme/other', advanceCursor: false },
    { repositoryKey: 'acme/new', advanceCursor: true },
  ]);
});
