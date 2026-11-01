import { afterEach, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { discoveryReadWithDeadline } from '@/lib/operations/discovery-monitor';
import type { ProductTransaction } from '@/lib/domain/products/generation';

afterEach(() => vi.restoreAllMocks());

it('shrinks SQL timeouts across sequential monitor reads and refuses another read after exhaustion', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const budgets: number[] = [], reads: string[] = [];
  const execute = vi.fn(async (query: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const compiled = new PgDialect().sqlToQuery(query);
    if (compiled.sql.includes('set_config')) { budgets.push(Number(compiled.params[0])); return []; }
    reads.push(compiled.sql); now += 900; return [{ value: 1 }];
  });
  const read = discoveryReadWithDeadline({ execute } as unknown as ProductTransaction, 4_000);
  await read(sql`SELECT 1`); await read(sql`SELECT 2`); await read(sql`SELECT 3`);
  expect(budgets).toEqual([2_950, 2_050, 1_150]);
  now = 3_951;
  await expect(read(sql`SELECT 4`)).rejects.toThrow('discovery_monitor_deadline');
  expect(reads).toHaveLength(3);
});

it('checks wall time after setting the timeout and after executing a read', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const execute = vi.fn(async () => { now += 3_000; return []; });
  await expect(discoveryReadWithDeadline({ execute } as unknown as ProductTransaction, 4_000)(sql`SELECT 1`))
    .rejects.toThrow('discovery_monitor_deadline');
  expect(execute).toHaveBeenCalledOnce();
  now = 1_000; execute.mockClear().mockImplementation(async () => { if (execute.mock.calls.length === 2) now += 3_000; return []; });
  await expect(discoveryReadWithDeadline({ execute } as unknown as ProductTransaction, 4_000)(sql`SELECT 1`))
    .rejects.toThrow('discovery_monitor_deadline');
  expect(execute).toHaveBeenCalledTimes(2);
});
