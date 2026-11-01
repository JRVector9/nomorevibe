import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

const principal = 'nomorevibe_monitor_20261022';
const tables = ['discovery_checkpoints', 'github_ko_discovery_control', 'github_ko_discovery_queries', 'github_ko_discovery_staging', 'github_discovery_pages'];
const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
let created = false;
beforeAll(async () => {
  ensureSchema();
  expect(await admin`SELECT 1 FROM pg_roles WHERE rolname=${principal}`).toHaveLength(0);
  await admin.unsafe(`CREATE ROLE ${principal} NOLOGIN`); created = true;
  // Exercise the actual additive migration block when the documented runtime principal already exists.
  const migration = readFileSync(new URL('../../drizzle/0162_discovery_checkpoints.sql', import.meta.url), 'utf8');
  await admin.unsafe(migration.slice(migration.indexOf('DO $$ BEGIN')));
});
afterAll(async () => {
  try {
    if (created) { await admin.unsafe(`DROP OWNED BY ${principal}`); await admin.unsafe(`DROP ROLE ${principal}`); }
  } finally { await admin.end({ timeout: 5 }); }
});

it('grants SELECT on exactly the five added monitor tables without write, role, or unrelated table authority', async () => {
  for (const table of tables) {
    const [rights] = await admin`SELECT has_table_privilege(${principal},${table},'SELECT') AS read,
      has_any_column_privilege(${principal},${table},'INSERT,UPDATE') OR has_table_privilege(${principal},${table},'DELETE,TRUNCATE') AS write`;
    expect(rights, table).toEqual({ read: true, write: false });
  }
  expect((await admin`SELECT table_name FROM information_schema.role_table_grants WHERE grantee=${principal} ORDER BY table_name`).map(row => row.table_name))
    .toEqual([...tables].sort());
  const [role] = await admin`SELECT rolcreaterole,rolcreatedb,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=${principal}`;
  expect(role).toEqual({ rolcreaterole: false, rolcreatedb: false, rolsuper: false, rolbypassrls: false });
});
