import { expect, it } from 'vitest';
import { discoveryHash, githubDiscoveryGeneration, githubDiscoveryReceipts, githubDiscoverySemantic, githubDiscoverySharedWait,
  koreanCursorSemantic, koreanQueryGeneration, validDiscoveryFailures } from '@/lib/crawl/discovery-checkpoint-contract';

const window = { from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
const cursor = { signal: 'a', cycleWindow: window, window, page: 1, states: { b: { window, page: 2, pendingWindows: [] } },
  pendingPage: { items: ['acme/app'], itemIndex: 0, size: 1 }, doneSignals: [] };
const discover = { sort: 'recent', windowDays: 3, maxNewPerHour: 3000, maxReviewBacklog: 100000 };
const queries = [{ label: 'a', kind: 'repositories', query: 'topic:vibe' }, { label: 'b', kind: 'commits', query: 'Codex' }];

it('hashes canonical durable work positions without fairness clocks, retries or attempts', () => {
  expect(discoveryHash({ b: 2, a: 1 })).toBe(discoveryHash({ a: 1, b: 2 }));
  const renewed = { ...cursor, retryAt: '2099-01-01T00:00:00Z', retryKind: 'rate_limited', attempts: 50,
    states: { ...cursor.states, b: { ...cursor.states.b, lastServedAt: 999999 } } };
  expect(githubDiscoverySemantic(renewed, 'a')).toBe(githubDiscoverySemantic(cursor, 'a'));
  expect(githubDiscoverySemantic(renewed, 'b')).toBe(githubDiscoverySemantic(cursor, 'b'));
  expect(githubDiscoverySemantic({ ...cursor, pendingPage: { ...cursor.pendingPage, itemIndex: 1 } }, 'a'))
    .not.toBe(githubDiscoverySemantic(cursor, 'a'));
});

it('keeps unrelated query positions independent and revisions tied to actual work configuration', () => {
  expect(githubDiscoverySemantic({ ...cursor, page: 5 }, 'b')).toBe(githubDiscoverySemantic(cursor, 'b'));
  expect(githubDiscoveryGeneration(queries[0], discover)).not.toBe(githubDiscoveryGeneration({ ...queries[0], query: 'new query' }, discover));
  expect(githubDiscoveryGeneration(queries[0], discover)).not.toBe(githubDiscoveryGeneration(queries[0], { ...discover, sort: 'relevance' }));
  expect(koreanQueryGeneration(1, '한국어', 3)).not.toBe(koreanQueryGeneration(2, '한국어', 3));
  expect(koreanCursorSemantic({ window, page: 1, pendingWindows: [] })).toBe(koreanCursorSemantic({ window, page: 1, pendingWindows: [], waitingUntil: '2099-01-01T00:00:00Z' }));
});

it('attributes progress and completed scans only to their query and never promotes retry updates', () => {
  const receipts = githubDiscoveryReceipts(cursor, queries, discover, 'github-full', { progressed: new Set(['a']), acknowledged: new Set(['a']) });
  expect(receipts[0]).toMatchObject({ source: 'github-full', subject: discoveryHash('a'), progressed: true, acknowledged: true });
  expect(receipts[1]).toMatchObject({ subject: discoveryHash('b'), progressed: false, acknowledged: false });
  expect(githubDiscoveryReceipts({ ...cursor, retryKind: 'upstream_unavailable' }, queries, discover, 'github-latest')[0])
    .toMatchObject({ intent: 'upstream_error', progressed: undefined, acknowledged: undefined });
});

it('shares only the same canonical future authentication/quota holds as the two-lane crawler', () => {
  const now = Date.parse('2026-11-01T00:00:00Z'), retryAt = '2026-11-01T00:05:00Z';
  expect(githubDiscoverySharedWait({ retryAt, retryKind: 'rate_limited' }, now)).toBe(true);
  expect(githubDiscoverySharedWait({ retryAt, retryKind: 'auth_unavailable' }, now)).toBe(true);
  expect(githubDiscoverySharedWait({ retryAt, retryKind: 'discovery_busy' }, now)).toBe(false);
  expect(githubDiscoverySharedWait({ retryAt, waiting: true }, now)).toBe(false);
  expect(githubDiscoverySharedWait({ retryAt, phase: 'retry' }, now)).toBe(false);
  expect(githubDiscoverySharedWait({ retryAt, retryKind: 'rate_limited' }, now + 6 * 60_000)).toBe(false);
});

it('requires the versioned per-source coverage protocol; literal legacy arrays cannot clear discovery', () => {
  expect(validDiscoveryFailures({ v: 1, covered: [], failures: [] })).toBe(true);
  expect(validDiscoveryFailures({ v: 1, covered: ['github-full'], failures: [{ source: 'github-full', reason: 'no_progress' }] })).toBe(true);
  for (const invalid of [[], null, { v: 2, covered: [], failures: [] }, { v: 1, covered: ['github-full', 'github-full'], failures: [] },
    { v: 1, covered: [], failures: [{ source: 'github-full', reason: 'no_progress' }] },
    { v: 1, covered: ['private-query'], failures: [] }, { v: 1, covered: [], failures: [], token: 'private' },
    { v: 1, covered: ['github-full'], failures: [{ source: 'github-full', reason: 'no_progress', query: 'private' }] },
    { v: 1, covered: ['github-full'], failures: [{ source: 'github-full', reason: 'invented' }] }])
    expect(validDiscoveryFailures(invalid), JSON.stringify(invalid)).toBe(false);
});
