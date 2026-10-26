import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readModelCapacityControlObservation } from '@/lib/llm/capacity-repository';
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from '@/lib/llm/capacity';
import { withSlotOnlyModelCapacity } from '@/lib/llm/capacity-consumer-scope';

const mocks = vi.hoisted(() => ({ execute: vi.fn(), primary: vi.fn((load: () => unknown) => load()), replay: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: { execute: mocks.execute }, onPrimary: mocks.primary }));
vi.mock('@/lib/db/replay-scope', () => ({ currentReplayDb: mocks.replay }));
const activeFence = { lineage_id: '00000000-0000-4000-8000-000000000001', writer_epoch: 1, state: 'active',
  reason: null, fenced_db: null, promotion_id: null };
const row = () => ({ mode: 'disabled', epoch: '1', revision: '2', policy: null, policy_hash: null, writer_fence: activeFence });
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { engine: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 4,
  queueTtlMs: 60_000, reservationTtlMs: 60_000,
  routes: [{ routeId: 'product-translate', provider: 'abcllm', model: 'Exact Model', providerBudgetId: 'account', groupId: 'engine' }] };

beforeEach(() => { vi.clearAllMocks(); mocks.replay.mockReturnValue(undefined); mocks.execute.mockResolvedValue([row()]); });

it('uses one nonlocking primary SELECT for a consistent fence/control observation, without transport admission behavior', async () => {
  expect(await withSlotOnlyModelCapacity(readModelCapacityControlObservation))
    .toEqual({ mode: 'disabled', epoch: 1, revision: 2, policyHash: null, policy: null });
  expect(mocks.primary).toHaveBeenCalledOnce(); expect(mocks.execute).toHaveBeenCalledOnce();
  const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]).sql;
  expect(query).toContain('SELECT to_jsonb(f) FROM dr_writer_fence');
  expect(query).toContain('FROM model_capacity_control');
  expect(query).not.toMatch(/\bFOR\s+(?:SHARE|UPDATE)\b|\b(?:INSERT|UPDATE|DELETE)\b/i);
});

it('returns the same validated immutable policy snapshot used by caller admission', async () => {
  mocks.execute.mockResolvedValue([{ ...row(), mode: 'open', policy, policy_hash: modelCapacityPolicyHash(policy) }]);
  const snapshot = await readModelCapacityControlObservation();
  expect(snapshot).toMatchObject({ mode: 'open', policy });
  expect(snapshot.policy).not.toBe(policy);
  for (const value of [snapshot, snapshot.policy, snapshot.policy!.routes, snapshot.policy!.routes[0], snapshot.policy!.poolLimits])
    expect(Object.isFrozen(value)).toBe(true);
});

it('observes a valid fenced writer as draining without acquiring a fence lock', async () => {
  mocks.execute.mockResolvedValue([{ ...row(), writer_fence: { ...activeFence, state: 'fenced', reason: 'operator_fence',
    fenced_db: { systemIdentifier: '1', databaseOid: '2', databaseName: 'fixture' } } }]);
  expect(await readModelCapacityControlObservation()).toMatchObject({ mode: 'draining', policy: null });
  expect(mocks.execute).toHaveBeenCalledOnce();
});

it.each([
  { patch: { mode: 'unknown' }, error: 'model_capacity_control_invalid' },
  { patch: { epoch: '0' }, error: 'model_capacity_control_invalid' },
  { patch: { revision: '9007199254740992' }, error: 'model_capacity_control_invalid' },
  { patch: { mode: 'open' }, error: 'model_capacity_control_invalid' },
  { patch: { policy, policy_hash: 'a'.repeat(64) }, error: 'model_capacity_policy_hash_mismatch' },
  { patch: { writer_fence: null }, error: 'dr_writer_fence_missing' },
  { patch: { writer_fence: { ...activeFence, state: 'unknown' } }, error: 'dr_writer_fence_invalid' },
])('rejects invalid observation fields: $error', async ({ patch, error }) => {
  mocks.execute.mockResolvedValue([{ ...row(), ...patch }]);
  await expect(readModelCapacityControlObservation()).rejects.toThrow(error);
});

it('rejects missing control and malformed policy instead of defaulting to intentional waiting', async () => {
  mocks.execute.mockResolvedValue([]);
  await expect(readModelCapacityControlObservation()).rejects.toThrow('model_capacity_control_missing');
  mocks.execute.mockResolvedValue([{ ...row(), policy: { ...policy, supported: true } }]);
  await expect(readModelCapacityControlObservation()).rejects.toThrow();
});

it('propagates SELECT failures and refuses replay without querying', async () => {
  const failure = Object.assign(new Error('fixture permission denied'), { code: '42501' });
  mocks.execute.mockRejectedValueOnce(failure);
  await expect(readModelCapacityControlObservation()).rejects.toBe(failure);
  mocks.execute.mockClear(); mocks.replay.mockReturnValue({});
  await expect(readModelCapacityControlObservation()).rejects.toThrow('model_capacity_replay_unsupported');
  expect(mocks.execute).not.toHaveBeenCalled();
});
