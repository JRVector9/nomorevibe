import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from '@/lib/llm/capacity';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), replay: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { transaction: (load: (tx: unknown) => unknown) => load({ execute: mocks.execute }) }, onPrimary: (load: () => unknown) => load() }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: mocks.replay }));
import { capacityAdmissionBlocksFromSnapshot, readCapacityAdmissionBlocks } from '@/lib/operations/capacity-admission-block';
import { buildWorkerProgress } from '@/lib/operations/worker-progress-query';
import { roleHasUnexplainedStall } from '@/scripts/role-worker';
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 4, providerLimits: { mlx: 1, supa: 1 }, groupLimits: { mlx: 1, supa: 1 },
  poolLimits: { reviewer: 3, text: 1 }, weights: { first: 4, second: 2, background: 1 }, maxWaiting: 8,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: ['crawl-agent-review', 'second-review', 'product-translate'].map(routeId => ({ routeId, provider: 'abcllm', model: 'Exact Model', providerBudgetId: 'mlx', groupId: 'mlx' })) };
const snapshot = () => ({ mode: 'open', writerActive: true, oldActive: false, policy, policyHash: modelCapacityPolicyHash(policy),
  active: [{ groupId: 'mlx', providerBudgetId: 'mlx', pool: 'text', n: 1 }], waiting: [{ groupId: 'mlx', providerBudgetId: 'mlx', pool: 'reviewer', n: 1,
    routeId: 'crawl-agent-review', provider: 'abcllm', model: 'Exact Model', class: 'first' }] });
beforeEach(() => { vi.clearAllMocks(); mocks.replay.mockReturnValue(undefined); });
it('protects reviewer across an old-policy text unknown, even before a waiting row can be inserted', () => {
  const blocks = capacityAdmissionBlocksFromSnapshot({ ...snapshot(), oldActive: true, waiting: [] });
  expect(blocks).toEqual(['crawl-agent-review', 'second-review'].map(job => ({ job, routeId: job, groupId: 'mlx', scope: 'policy' })));
  const now = new Date('2026-10-28T15:00:00Z');
  const report = buildWorkerProgress({ measuredAt: now.toISOString(), stages: [{ key: 'first', label: 'first', unit: '표', enabled: true,
    waiting: 3, oldestMinutes: 200, completed1m: 0, completed5m: 0, progress5m: 0, errors5m: 0, queueNote: '', detail: '', status: 'stalled' }] },
  [{ name: 'crawl-agent-review', nextScheduledAt: now, notBefore: null }], ['scheduler', 'reviewer'].map(role => ({
    key: `service:${role}:fixture`, value: { status: 'running' }, observedAt: now })), now,
  { mode: 'legacy', writerContractVersion: 0 }, [], null, [], 'open', false, blocks);
  expect(report.stages[0]).toMatchObject({ reason: 'no_progress', alarm: true, restartEligible: false, admissionBlock: { scope: 'policy' } });
  expect(roleHasUnexplainedStall(report, 'reviewer')).toBe(false);
});
it('retains same-policy exact-route saturation and stops protection after occupancy clears', () => {
  expect(capacityAdmissionBlocksFromSnapshot(snapshot())).toEqual([{ job: 'crawl-agent-review', routeId: 'crawl-agent-review', groupId: 'mlx', scope: 'group' }]);
  expect(capacityAdmissionBlocksFromSnapshot({ ...snapshot(), active: [] })).toEqual([]);
  expect(capacityAdmissionBlocksFromSnapshot({ ...snapshot(), waiting: [] })).toEqual([]);
});
it.each([{ writerActive: false }, { mode: 'draining' }, { policyHash: 'a'.repeat(64) }, { oldActive: null }])('never invents protection with invalid control %j', patch => {
  expect(capacityAdmissionBlocksFromSnapshot({ ...snapshot(), oldActive: true, ...patch })).toEqual([]);
});
it('reads old-generation occupancy on the primary without locking or changing requests', async () => {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ value: { ...snapshot(), oldActive: true, waiting: [] } }]);
  expect(await readCapacityAdmissionBlocks()).toHaveLength(2);
  const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[2][0]).sql;
  expect(query).toContain("r.state IN ('dispatched','indeterminate')");
  expect(query).toContain('r.reserved_until > clock_timestamp()');
  expect(query).toContain('r.policy_hash IS DISTINCT FROM c.policy_hash');
  expect(query).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b|FOR SHARE/i);
});
