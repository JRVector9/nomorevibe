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
// PR 1b: 장비(mlx) 한도 1 은 정책 groupLimits 대체값에서 온다(장비 행 없음). 점유는 (장비, 경로)로 센다.
const snapshot = () => ({ mode: 'open', writerActive: true, oldActive: false, policy, policyHash: modelCapacityPolicyHash(policy),
  active: [{ groupId: 'mlx', routeId: 'product-translate', providerBudgetId: 'mlx', pool: 'text', n: 1 }], waiting: [{ groupId: 'mlx', providerBudgetId: 'mlx', pool: 'reviewer', n: 1,
    routeId: 'crawl-agent-review', provider: 'abcllm', model: 'Exact Model', class: 'first' }], devices: [] });
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
it('retains same-policy exact-route device saturation and stops protection after occupancy clears', () => {
  expect(capacityAdmissionBlocksFromSnapshot(snapshot())).toEqual([{ job: 'crawl-agent-review', routeId: 'crawl-agent-review', groupId: 'mlx', scope: 'device' }]);
  expect(capacityAdmissionBlocksFromSnapshot({ ...snapshot(), active: [] })).toEqual([]);
  expect(capacityAdmissionBlocksFromSnapshot({ ...snapshot(), waiting: [] })).toEqual([]);
  // 장비 행이 있으면 그 한도가 정책 대체값을 덮는다 — 한도 2 면 점유 1 은 포화가 아니다.
  const devices = [{ deviceId: 'mlx', limitSlots: 2, secondaryCap: 2, roles: [] }];
  expect(capacityAdmissionBlocksFromSnapshot({ ...snapshot(), devices })).toEqual([]);
  // 전역·풀·공급자 한도는 더 보지 않는다: 다른 장비의 점유가 아무리 많아도 이 장비의 대기는 막힌 것이 아니다.
  const elsewhere = Array.from({ length: 6 }, (_, i) => ({ groupId: `other-${i}`, routeId: 'second-review', providerBudgetId: 'mlx', pool: 'reviewer', n: 4 }));
  expect(capacityAdmissionBlocksFromSnapshot({ ...snapshot(), devices, active: [...snapshot().active, ...elsewhere] })).toEqual([]);
});
it('reports device_cap when a lower-rank route waits behind the secondary cap while the primary role is busy', () => {
  const devices = [{ deviceId: 'mlx', limitSlots: 4, secondaryCap: 1, roles: [{ routeId: 'crawl-agent-review', rank: 1 }, { routeId: 'second-review', rank: 2 }] }];
  const waiting = [{ groupId: 'mlx', providerBudgetId: 'mlx', pool: 'reviewer', n: 1, routeId: 'second-review', provider: 'abcllm', model: 'Exact Model', class: 'second' }];
  const primaryActive = { groupId: 'mlx', routeId: 'crawl-agent-review', providerBudgetId: 'mlx', pool: 'reviewer', n: 1 };
  const secondaryActive = { groupId: 'mlx', routeId: 'product-translate', providerBudgetId: 'mlx', pool: 'text', n: 1 };
  expect(capacityAdmissionBlocksFromSnapshot({ ...snapshot(), devices, waiting, active: [primaryActive, secondaryActive] }))
    .toEqual([{ job: 'second-review', routeId: 'second-review', groupId: 'mlx', scope: 'device_cap' }]);
  // 우선 역할이 점유도 대기도 아니면(유휴) 낮은 순위는 장비 한도까지 빌려 쓸 수 있다 — 상한 막힘이 아니다.
  expect(capacityAdmissionBlocksFromSnapshot({ ...snapshot(), devices, waiting, active: [secondaryActive] })).toEqual([]);
  // 우선 역할(rank 1)의 대기는 상한과 무관하고, 장비가 차지 않았으면 막힌 것이 아니다.
  const primaryWaiting = [{ ...waiting[0], routeId: 'crawl-agent-review', class: 'first' }];
  expect(capacityAdmissionBlocksFromSnapshot({ ...snapshot(), devices, waiting: primaryWaiting, active: [secondaryActive, secondaryActive] })).toEqual([]);
});
it.each([{ writerActive: false }, { mode: 'draining' }, { policyHash: 'a'.repeat(64) }, { oldActive: null }])('never invents protection with invalid control %j', patch => {
  expect(capacityAdmissionBlocksFromSnapshot({ ...snapshot(), oldActive: true, ...patch })).toEqual([]);
});
it('reads old-generation occupancy on the primary without locking or changing requests', async () => {
  mocks.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([{ value: { ...snapshot(), oldActive: true, waiting: [] } }]);
  expect(await readCapacityAdmissionBlocks()).toHaveLength(2);
  const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[2][0]).sql;
  // 2026-10-30: indeterminate 는 점유가 아니다 — 결과 모르는 전송(dispatched)과 살아 있는 예약만 막는다.
  expect(query).toContain("r.state = 'dispatched'"); expect(query).not.toContain("'indeterminate'");
  // PR 1b: 장비 행·순위를 같은 문장으로 읽고, 점유는 (장비, 경로)로 센다.
  expect(query).toContain('FROM model_capacity_devices WHERE enabled'); expect(query).toContain('FROM model_capacity_device_roles ro');
  expect(query).toContain('GROUP BY group_id, route_id, provider_budget_id, pool');
  expect(query).toContain('r.reserved_until > clock_timestamp()');
  expect(query).toContain('r.policy_hash IS DISTINCT FROM c.policy_hash');
  expect(query).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b|FOR SHARE/i);
});
