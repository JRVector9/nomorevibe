import { describe, expect, it } from 'vitest';
import { migrationDatabaseUrl } from '../scripts/migration-config.mjs';

describe('migration database selection', () => {
  it('prefers the direct migration endpoint over the pooled runtime endpoint', () => {
    expect(migrationDatabaseUrl({
      DATABASE_URL: 'postgres://pooler:6432/runtime',
      MIGRATION_DATABASE_URL: 'postgres://primary:5432/runtime',
    })).toBe('postgres://primary:5432/runtime');
  });

  it('keeps DATABASE_URL compatibility for local one-shot migrations', () => {
    expect(migrationDatabaseUrl({ DATABASE_URL: 'postgres://db:5432/local' }))
      .toBe('postgres://db:5432/local');
  });
});
