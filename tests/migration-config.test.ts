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

describe('migration journal order', () => {
  // drizzle 의 migrator 는 journal 의 when 이 이미 적용된 최신 created_at 보다 클 때만 그 migration 을 적용한다(drizzle-orm pg-core dialect.migrate).
  // 기존 when 이 미래 시각(1794086400xxx)이라 drizzle-kit generate 가 지금 시각으로 만든 다음 migration 은 운영에서 조용히 건너뛴다.
  it('keeps every journal entry strictly after the previous one so a new migration is never skipped', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
    expect(journal.entries.length).toBeGreaterThan(0);
    journal.entries.forEach((entry, index) => {
      expect(Number.isSafeInteger(entry.when), entry.tag).toBe(true);
      expect(existsSync(`drizzle/${entry.tag}.sql`), entry.tag).toBe(true);
      if (index === 0) return;
      const previous = journal.entries[index - 1];
      expect(entry.idx, entry.tag).toBeGreaterThan(previous.idx);
      expect(entry.when, `${entry.tag} when must exceed ${previous.tag} (${previous.when})`).toBeGreaterThan(previous.when);
    });
  });

  // PR 1a (live settings): 0151 is taken by the parallel device-admission PR, so the runtime_settings document takes 0152 / when 1794086401063.
  it('registers the runtime_settings document migration as 0152 with a seeded empty document', async () => {
    const { readFileSync } = await import('node:fs');
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
    expect(journal.entries.find(entry => entry.tag === '0152_runtime_settings')).toMatchObject({ idx: 152, when: 1794086401063, version: '7' });
    const migration = readFileSync('drizzle/0152_runtime_settings.sql', 'utf8');
    expect(migration).toContain('CREATE TABLE runtime_settings');
    expect(migration).toContain("CONSTRAINT runtime_settings_single_row_check CHECK (id = 1)");
    // NULL passes a CHECK: a document without version must still be refused
    expect(migration).toContain("coalesce(values->>'version', '') = '1'");
    expect(migration).toContain(`INSERT INTO runtime_settings (id, values, updated_by) VALUES (1, '{"version":1}'::jsonb, 'migration:0152') ON CONFLICT (id) DO NOTHING;`);
    expect(migration).not.toMatch(/ALTER TABLE|DROP /);
  });
});
