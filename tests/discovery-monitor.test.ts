import { expect, it } from 'vitest';
import { DISCOVERY_SOURCES, discoveryHash } from '@/lib/crawl/discovery-checkpoint-contract';
import { buildDiscoveryMonitor, type DiscoveryObligation, type DiscoveryReceipt } from '@/lib/operations/discovery-monitor';

const at = '2026-11-01T04:00:00.000Z';
const ago = (minutes: number) => new Date(Date.parse(at) - minutes * 60_000).toISOString();
const obligation = (extra: Partial<DiscoveryObligation> = {}): DiscoveryObligation => ({
  source: 'github-full', subject: discoveryHash('query-a'), generation: discoveryHash('config'), semantic: discoveryHash('cursor'),
  configuredAt: ago(180), graceMs: 5 * 60_000, workerPresent: true, ...extra,
});
const receipt = (extra: Partial<DiscoveryReceipt> = {}): DiscoveryReceipt => ({
  source: 'github-full', subject: discoveryHash('query-a'), generation: discoveryHash('config'), semantic: discoveryHash('cursor'),
  reference: null, intent: 'ready', resumeAt: null, firstSeenAt: ago(120), progressAt: ago(1),
  failureStartedAt: null, acknowledgedAt: null, recordedAt: ago(0), ...extra,
});
function report(subjects = [obligation()], receipts = [receipt()]) {
  const otherSources = DISCOVERY_SOURCES.filter(s => !subjects.some(row => row.source === s));
  return buildDiscoveryMonitor(at, [...subjects, ...otherSources.map(source => obligation({ source, exempt: true }))], receipts);
}

it('detects a healthy-process stall from semantic progress, ignoring attempts and fresh receipt timestamps', () => {
  expect(report().overall).toBe('ok');
  expect(report(undefined, [receipt({ progressAt: ago(30), recordedAt: at })]).failures.failures)
    .toEqual([{ source: 'github-full', reason: 'no_progress' }]);
});

it('does not let a busier query mask another query in the same lane', () => {
  const subject = discoveryHash('query-b');
  expect(report([obligation(), obligation({ subject })], [receipt(), receipt({ subject, progressAt: ago(30) })]).failures.failures)
    .toEqual([{ source: 'github-full', reason: 'no_progress' }]);
  const missing = report([obligation(), obligation({ subject })], [receipt()]);
  expect(missing.overall).toBe('unknown');
  expect(missing.failures.covered).not.toContain('github-full');
});

it.each([
  { generation: discoveryHash('old-config') }, { semantic: discoveryHash('old-cursor') },
  { progressAt: '2099-01-01T00:00:00Z' }, { firstSeenAt: 'invalid' }, { intent: 'measurement_unknown' as const },
])('preserves unknown for unmatched or invalid durable evidence: %j', extra => {
  const result = report(undefined, [receipt(extra)]);
  expect(result.overall).toBe('unknown');
  expect(result.failures.covered).not.toContain('github-full');
  expect(result.failures.failures).toEqual([]);
});

it('requires a receipt for an active obligation, but explicit current pause/cap/no-work facts need no old receipt', () => {
  expect(report(undefined, []).overall).toBe('unknown');
  expect(report([obligation({ exempt: true })], []).overall).toBe('ok');
  expect(report([obligation({ unknown: true, exempt: true })], []).overall).toBe('unknown');
});

it('gives a genuinely new matching obligation first-seen grace without inventing a successful scan', () => {
  expect(report(undefined, [receipt({ firstSeenAt: ago(1), progressAt: null, acknowledgedAt: null })]).overall).toBe('ok');
  expect(report(undefined, [receipt({ firstSeenAt: ago(6), progressAt: null, acknowledgedAt: null })]).overall).toBe('alarm');
});

it('accepts only the current canonical future backoff and allows due-time grace after expiry', () => {
  const resumeAt = ago(-5);
  expect(report([obligation({ resumeAt })], [receipt({ intent: 'backoff', resumeAt, progressAt: ago(60) })]).overall).toBe('ok');
  expect(report([obligation({ resumeAt })], [receipt({ intent: 'backoff', resumeAt: ago(-4), progressAt: ago(60) })]).overall).toBe('alarm');
  expect(report([obligation({ resumeAt: ago(1) })], [receipt({ intent: 'caught_up', resumeAt: ago(1), progressAt: ago(60) })]).overall).toBe('ok');
  expect(report([obligation({ resumeAt: ago(6) })], [receipt({ intent: 'caught_up', resumeAt: ago(6), progressAt: ago(60) })]).overall).toBe('alarm');
});

it('uses due demand as grace but does not let unrelated configuration saves renew progress', () => {
  expect(report([obligation({ dueAt: ago(1) })], [receipt({ progressAt: ago(60) })]).overall).toBe('ok');
  expect(report([obligation({ configuredAt: ago(1) })], [receipt({ progressAt: ago(60) })]).overall).toBe('alarm');
  expect(report([obligation({ dueAt: ago(6) })], [receipt({ progressAt: ago(60) })]).overall).toBe('alarm');
});

it('allows a completed empty Show HN scan for three scheduled intervals but detects a stopped scanner', () => {
  const source = 'show-hn' as const;
  const row = obligation({ source, graceMs: 90 * 60_000, empty: true });
  expect(report([row], [receipt({ source, progressAt: null, acknowledgedAt: ago(60) })]).overall).toBe('ok');
  expect(report([row], [receipt({ source, progressAt: null, acknowledgedAt: ago(100) })]).failures.failures)
    .toEqual([{ source, reason: 'no_progress' }]);
  // An attempt that never completed has no empty-scan acknowledgement.
  expect(report([row], [receipt({ source, progressAt: null, recordedAt: at })]).overall).toBe('alarm');
});

it('distinguishes an explicitly completed query from the next due cycle', () => {
  expect(report([obligation({ completed: true })], [receipt({ progressAt: ago(60), acknowledgedAt: ago(60) })]).overall).toBe('ok');
  expect(report([obligation({ completed: false })], [receipt({ progressAt: ago(60), acknowledgedAt: ago(60) })]).overall).toBe('alarm');
});

it('reports missing workers and consumers only after current work is due and grace expires', () => {
  expect(report([obligation({ workerPresent: false, dueAt: ago(1) })], [receipt({ progressAt: ago(60) })]).overall).toBe('ok');
  expect(report([obligation({ workerPresent: false })], [receipt({ progressAt: ago(60) })]).failures.failures)
    .toEqual([{ source: 'github-full', reason: 'worker_missing' }]);
  expect(report([obligation({ source: 'korean-query', workerPresent: false, consumer: true })],
    [receipt({ source: 'korean-query', progressAt: ago(60) })]).failures.failures)
    .toEqual([{ source: 'korean-query', reason: 'consumer_missing' }]);
});

it('retains an upstream error across repeated attempts and gives it a bounded longer grace', () => {
  expect(report(undefined, [receipt({ intent: 'upstream_error', failureStartedAt: ago(20) })]).overall).toBe('ok');
  expect(report(undefined, [receipt({ intent: 'upstream_error', failureStartedAt: ago(31), recordedAt: at })]).failures.failures)
    .toEqual([{ source: 'github-full', reason: 'upstream_stalled' }]);
});

it('can report a proved fault beside an unknown subject but cannot emit an unproved clear', () => {
  const result = report([obligation(), obligation({ subject: discoveryHash('unobserved') })], [receipt({ progressAt: ago(20) })]);
  expect(result.failures.covered).toContain('github-full');
  expect(result.failures.failures).toEqual([{ source: 'github-full', reason: 'no_progress' }]);
  expect(buildDiscoveryMonitor(at, [], []).failures).toEqual({ v: 1, covered: [], failures: [] });
});

it('uses a deterministic source fault when unordered query rows have different failure reasons', () => {
  const subject = discoveryHash('query-b');
  const rows = [obligation(), obligation({ subject })];
  const receipts = [receipt({ progressAt: ago(60) }), receipt({ subject, progressAt: ago(60), intent: 'upstream_error', failureStartedAt: ago(60) })];
  const expected = [{ source: 'github-full', reason: 'upstream_stalled' }];
  expect(report(rows, receipts).failures.failures).toEqual(expected);
  expect(report([...rows].reverse(), receipts).failures.failures).toEqual(expected);
});

it('keeps failure grace independent of changing attempts, references, semantics and future retry times', () => {
  const source = 'korean-language' as const, semantic = discoveryHash('latest-attempt');
  const row = obligation({ source, semantic, dueAt: '2099-01-01T00:00:00Z', demandAt: ago(60) });
  const failed = receipt({ source, semantic, reference: 'acme/another-repo', intent: 'upstream_error',
    firstSeenAt: ago(1), progressAt: null, failureStartedAt: ago(45) });
  expect(report([row], [failed]).failures.failures).toEqual([{ source, reason: 'upstream_stalled' }]);
  // A genuinely new oldest demand has its own grace; repeated attempts do not change its creation time.
  expect(report([{ ...row, demandAt: ago(1) }], [failed]).overall).toBe('ok');
  expect(report([{ ...row, demandAt: ago(31) }], [failed]).overall).toBe('alarm');
  expect(report([{ ...row, exempt: true }], []).overall).toBe('ok');
  expect(report([row], [{ ...failed, intent: 'ready', failureStartedAt: null, progressAt: ago(0) }]).overall).toBe('ok');
  expect(report([row], [{ ...failed, failureStartedAt: null }]).overall).toBe('unknown');
});

it('cannot use a recent empty-scan acknowledgement to clear a partial HN scan that is failing', () => {
  const source = 'show-hn' as const, row = obligation({ source, graceMs: 90 * 60_000, empty: true });
  const failed = receipt({ source, intent: 'upstream_error', failureStartedAt: ago(91), acknowledgedAt: ago(1) });
  expect(report([row], [failed]).failures.failures).toEqual([{ source, reason: 'upstream_stalled' }]);
  expect(report([row], [{ ...failed, failureStartedAt: ago(15) }]).overall).toBe('ok');
  expect(report([row], [{ ...failed, intent: 'caught_up', failureStartedAt: null }]).overall).toBe('ok');
});
