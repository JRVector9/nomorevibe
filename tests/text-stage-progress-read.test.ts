import { beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { readTextStageProgress } from '@/lib/operations/text-stage-progress';

const fixture = vi.hoisted(() => ({ transactions: [] as Array<{ config: unknown; statements: string[] }>,
  query: 0, failure: 0 }));
vi.mock('@/lib/db', () => ({ db: {
  transaction: async (load: (tx: { execute(query: SQL): Promise<unknown> }) => Promise<unknown>, config: unknown) => {
    const record = { config, statements: [] as string[] }; fixture.transactions.push(record);
    return load({ execute: async query => {
      const compiled = new PgDialect().sqlToQuery(query).sql;
      record.statements.push(compiled);
      if (compiled.startsWith('SET ')) return [];
      fixture.query++;
      if (fixture.failure === fixture.query) throw Object.assign(new Error('fixture query deadline'), { code: '57014' });
      return fixture.query === 1
        ? [{ key: 'reason-translate', waiting: 3, oldest: '120', completed: 0, errors: 0, deferred: 0, blocked: 0, provider_errors: 0, error_age: null }]
        : [{ key: 'intro-check', waiting: 1, oldest: '20', completed: 2, errors: 0, deferred: 0, blocked: 0, provider_errors: 0, error_age: null }];
    } });
  },
} }));
vi.mock('@/lib/domain/products/korean-taglines', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/domain/products/korean-taglines')>(), homeListSlugs: async () => [],
}));

beforeEach(() => { fixture.transactions.length = 0; fixture.query = 0; fixture.failure = 0; });

it('merges exact reason and other queues from separate bounded read-only statements', async () => {
  const rows = await readTextStageProgress();
  expect(rows).toHaveLength(7);
  expect(rows.find(row => row.key === 'reason-translate')).toMatchObject({ waiting: 3, oldestMinutes: 120 });
  expect(rows.find(row => row.key === 'intro-check')).toMatchObject({ waiting: 1, completed5m: 2 });
  expect(fixture.transactions).toHaveLength(2);
  for (const tx of fixture.transactions) {
    expect(tx.config).toEqual({ accessMode: 'read only' });
    expect(tx.statements).toContain("SET LOCAL statement_timeout = '3s'");
    expect(tx.statements).toContain("SET LOCAL work_mem = '32MB'");
  }
});

it.each([1, 2])('propagates query %s failure instead of reporting omitted queues as no work', async failure => {
  fixture.failure = failure;
  await expect(readTextStageProgress()).rejects.toMatchObject({ code: '57014' });
});
