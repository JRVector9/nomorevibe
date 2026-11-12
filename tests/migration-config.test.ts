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

  // PR 1b-A (device admission): 0153 / when 1794086401064 follows the runtime_settings document; rows are seeded from the live policy's groupLimits.
  it('registers the device admission tables as 0153 seeded from the live policy groupLimits', async () => {
    const { readFileSync } = await import('node:fs');
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
    expect(journal.entries.find(entry => entry.tag === '0153_model_capacity_devices')).toMatchObject({ idx: 153, when: 1794086401064, version: '7' });
    const migration = readFileSync('drizzle/0153_model_capacity_devices.sql', 'utf8');
    expect(migration).toContain('CREATE TABLE model_capacity_devices');
    expect(migration).toContain('CREATE TABLE model_capacity_device_roles');
    for (const name of ['model_capacity_devices_id_check', 'model_capacity_devices_limits_check', 'model_capacity_devices_physical_check',
      'model_capacity_devices_version_check', 'model_capacity_device_roles_rank_check', 'model_capacity_device_roles_route_check']) expect(migration).toContain(`CONSTRAINT ${name} CHECK`);
    expect(migration).toContain('REFERENCES model_capacity_devices (device_id) ON DELETE CASCADE');
    // seed: device = groupLimits key, cap = limit, idle 60000, reserve 0, no rank rows → identical to today's per-group rule until the operator edits
    expect(migration).toContain('INSERT INTO model_capacity_devices (device_id, limit_slots, secondary_cap, idle_ms, reserve_slots, updated_by, note)');
    expect(migration).toContain("SELECT g.key, g.value::integer, g.value::integer, 60000, 0, 'migration:0153',");
    expect(migration).toContain("FROM model_capacity_control c, jsonb_each_text(c.policy->'groupLimits') g");
    expect(migration).toContain("jsonb_typeof(c.policy->'groupLimits') = 'object'");
    expect(migration).toContain("g.value ~ '^[1-9][0-9]{0,2}$' AND g.value::integer BETWEEN 1 AND 256");
    expect(migration).toContain('ON CONFLICT (device_id) DO NOTHING;');
    expect(migration).not.toMatch(/ALTER TABLE|DROP |CREATE (OR REPLACE )?(FUNCTION|TRIGGER)|UPDATE model_capacity/);
  });
});

describe("운영 콘솔 개편 migration(0179·0180·0181, 2026-11-12 통합)", () => {
  // 0177·0178 은 비워 둔 번호다(0159 처럼). drizzle 은 journal 의 tag 로 파일을 읽고 when 으로 적용 여부를 정하며, 배포 관문(deploy_shared_images.py
  // migration_journal)은 journal 항목 수·마지막 when·해시를 본다 — 번호가 건너뛰어도 둘 다 받아들인다. journal 은 idx·when 이 함께 커져야 하므로
  // 0177·0178 은 다시 쓰지 않는다 — 다음 migration 은 0182(when 1794355200006 이상)다.
  it("keeps the console migrations after 0176 with the next whens, each taking a 5s lock timeout first", async () => {
    const { readFileSync } = await import('node:fs');
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: { idx: number; when: number; tag: string }[] };
    const tags = ['0176_geeknews_discovery_source', '0179_task_pool_member_slots', '0180_model_sample_comparisons', '0181_human_batch_gates'];
    const rows = tags.map(tag => journal.entries.find(entry => entry.tag === tag)!);
    expect(rows.map(row => [row.idx, row.when])).toEqual([[176, 1794355200000], [179, 1794355200003], [180, 1794355200004], [181, 1794355200005]]);
    expect(journal.entries.some(entry => entry.idx === 177 || entry.idx === 178)).toBe(false);
    for (const tag of tags.slice(1)) expect(readFileSync(`drizzle/${tag}.sql`, 'utf8').split('--> statement-breakpoint')[0], tag).toContain("SET LOCAL lock_timeout = '5s';");
  });
});
