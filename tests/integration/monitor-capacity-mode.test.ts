import { afterAll, beforeAll, expect, it } from 'vitest';
import postgres from 'postgres';
import { readCapacityModeObservation } from '@/lib/operations/failover-monitor';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

// 2026-11-11 배포 창 DRAIN 알림 유예: monitor 가 model_capacity_control 의 모드와 updated_at 나이를 읽어 heartbeat 에 남긴다(Oracle 이 읽는다).
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const locker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
beforeAll(() => { ensureSchema(); });
afterAll(async () => {
  await admin.end();
  await locker.end();
  const client = (globalThis as unknown as { pgClient?: postgres.Sql }).pgClient;
  await client?.end();
});

it('reads the admission mode and the age of its last write without waiting for a ledger row lock', async () => {
  const [original] = await admin<{ mode: string; policy: unknown; policy_hash: string | null; updated_at: Date }[]>`
    SELECT mode, policy, policy_hash, updated_at FROM model_capacity_control WHERE id = 1`;
  expect(original).toBeDefined();
  try {
    await admin`UPDATE model_capacity_control SET mode = 'draining', policy = coalesce(policy, '{}'::jsonb),
      policy_hash = coalesce(policy_hash, repeat('a', 64)), updated_at = clock_timestamp() - interval '7 minutes' WHERE id = 1`;
    // 장부 쓰기는 control 행을 FOR UPDATE 로 쥔다 — 관측은 그 잠금을 기다리지 않는다.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>(resolve => { locked = resolve; });
    const holder = locker.begin(async tx => {
      await tx`SELECT 1 FROM model_capacity_control WHERE id = 1 FOR UPDATE`;
      locked();
      await held;
    });
    await lockTaken;
    try {
      const before = Date.now();
      const draining = await readCapacityModeObservation();
      const after = Date.now();
      expect(draining.mode).toBe('draining');
      expect(before - draining.changedAt).toBeGreaterThan(420_000 - 2_000);
      expect(after - draining.changedAt).toBeLessThan(420_000 + 2_000);
      expect(after - before).toBeLessThan(5_000);
    } finally {
      release();
      await holder;
    }
    await admin`UPDATE model_capacity_control SET mode = 'open', updated_at = clock_timestamp() WHERE id = 1`;
    const open = await readCapacityModeObservation();
    expect(open.mode).toBe('open');
    expect(Math.abs(Date.now() - open.changedAt)).toBeLessThan(2_000);
  } finally {
    await admin`UPDATE model_capacity_control SET mode = ${original.mode},
      policy = ${original.policy === null ? null : JSON.stringify(original.policy)}::text::jsonb,
      policy_hash = ${original.policy_hash}, updated_at = ${original.updated_at} WHERE id = 1`;
  }
  const [restored] = await admin<{ mode: string; policy_hash: string | null; updated_at: Date }[]>`
    SELECT mode, policy_hash, updated_at FROM model_capacity_control WHERE id = 1`;
  expect(restored).toEqual({ mode: original.mode, policy_hash: original.policy_hash, updated_at: original.updated_at });
});
