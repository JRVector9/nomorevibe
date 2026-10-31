import { describe, expect, it, vi } from 'vitest';
import { ROLE_DEMAND_BEACONS } from '@/lib/llm/capacity-helpers';
import { createRoleDemandPublisher, parseRoleDemand, publishRoleDemand } from '@/lib/operations/role-demand';

// pr2-plan §3.6: 집 쪽 beacon 쓰기(main 역할). 실제 upsert·시각·written_by 는 tests/integration/capacity-supervisor.test.ts.
describe('parseRoleDemand', () => {
  const base = { roleId: 'human-review', deviceId: 'm3-deepseek', backlog: 3 };
  it('normalises the backlog, age and metrics and bounds the TTL to the table CHECK', () => {
    expect(parseRoleDemand({ ...base, backlog: 3.9, oldestAgeMs: 12.5, metrics: { pausedAll: false, devices: ['supa'] } }, 150_000)).toMatchObject({
      backlog: 3, oldestAgeMs: 12, ttlMs: 150_000, metricsJson: '{"pausedAll":false,"devices":["supa"]}' });
    expect(parseRoleDemand({ ...base, backlog: 1e12 }, 1_000).backlog).toBe(2_147_483_647);
    expect(parseRoleDemand(base, 300_000).oldestAgeMs).toBeNull();
  });
  it.each([
    [{ ...base, roleId: '' }, 150_000, 'roleId'], [{ ...base, roleId: ' x' }, 150_000, 'roleId'], [{ ...base, deviceId: 'a\u0000' }, 150_000, 'deviceId'],
    [{ ...base, backlog: -1 }, 150_000, 'backlog'], [{ ...base, backlog: Number.NaN }, 150_000, 'backlog'],
    [{ ...base, oldestAgeMs: -5 }, 150_000, 'oldestAgeMs'], [base, 300_001, 'ttlMs'], [base, 999, 'ttlMs'], [base, 1.5e3 + 0.5, 'ttlMs'],
    [{ ...base, metrics: { nested: { a: 1 } } as never }, 150_000, 'metrics.nested'], [{ ...base, metrics: { big: 'x'.repeat(201) } }, 150_000, 'metrics.big'],
    [{ ...base, metrics: { n: Number.POSITIVE_INFINITY } }, 150_000, 'metrics.n'],
  ])('refuses %j (ttl %s) at %s', (input, ttl, path) => {
    expect(() => parseRoleDemand(input, ttl)).toThrow(`role_demand_invalid:${path}`);
  });
});

describe('beacon publishers', () => {
  it('rate-limits the AI1 beacon to once per 15 s per process and fills the declared role, device and TTL', async () => {
    let now = 0;
    const publish = vi.fn(async () => true);
    const ai1 = createRoleDemandPublisher('ai1', { now: () => now, publish });
    expect(await ai1({ backlog: 4, metrics: { devices: ['supa'], pausedAll: false } })).toBe(true);
    now = 14_999;
    expect(await ai1({ backlog: 5 })).toBe(false);
    now = 15_000;
    expect(await ai1({ backlog: 6 })).toBe(true);
    expect(publish.mock.calls).toEqual([
      [{ roleId: 'ai1', deviceId: ROLE_DEMAND_BEACONS.ai1.deviceId, backlog: 4, oldestAgeMs: null, metrics: { devices: ['supa'], pausedAll: false } }, 45_000],
      [{ roleId: 'ai1', deviceId: ROLE_DEMAND_BEACONS.ai1.deviceId, backlog: 6, oldestAgeMs: null, metrics: {} }, 45_000]]);
  });
  it('writes the human-review beacon on every tick with a 150 s TTL', async () => {
    const publish = vi.fn(async () => true);
    const human = createRoleDemandPublisher('humanReview', { now: () => 0, publish });
    await human({ backlog: 2, oldestAgeMs: 1_000 }); await human({ backlog: 0 });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0]).toEqual([{ roleId: 'human-review', deviceId: 'm3-deepseek', backlog: 2, oldestAgeMs: 1_000, metrics: {} }, 150_000]);
  });
  it('never throws from publishRoleDemand: invalid input is logged and returns false', async () => {
    await expect(publishRoleDemand({ roleId: '', deviceId: 'm3-deepseek', backlog: 1 }, 150_000)).resolves.toBe(false);
  });
});
