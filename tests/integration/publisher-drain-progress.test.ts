import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { db } from '@/lib/db';
import * as schema from '@/lib/db/schema';
import { runJob } from '@/lib/jobs/runner';
import { modelCapacityPolicyHash } from '@/lib/llm/capacity';
import { PUBLISHER_DRAIN_KEY, readPublisherClassificationDrain, recordPublisherClassificationDraining } from '@/lib/operations/publisher-drain-progress';
import { ensureSchema, TEST_DATABASE_URL } from './setup';

const admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
const owner = { instanceId: 'publisher-drain-fixture', bootId: '11111111-1111-4111-8111-111111111111', release: 'd'.repeat(40), epoch: 250 };
const lease = { name: 'crawl-publish', token: '22222222-2222-4222-8222-222222222222', requestedVersion: 12 };
const policy = { version: 1 as const, globalLimit: 1, providerLimits: { account: 1 }, groupLimits: { group: 1 },
  poolLimits: { reviewer: 1, text: 1 }, weights: { first: 1, second: 1, background: 1 }, maxWaiting: 10,
  queueTtlMs: 60_000, reservationTtlMs: 15_000,
  routes: [{ routeId: 'crawl-publish-classify', provider: 'codex-cli', model: 'offline', providerBudgetId: 'account', groupId: 'group' }] };
const tables = ['model_capacity_control', 'job_batch_control', 'dr_writer_fence'] as const;
const originals = new Map<string, Record<string, unknown> | undefined>();
beforeAll(async () => {
  ensureSchema();
  for (const table of tables) {
    const [row] = await admin.unsafe(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE id=1`);
    originals.set(table, row?.value);
  }
  for (const [table, column, key] of [['jobs', 'name', lease.name], ['role_leases', 'role', 'publisher'],
    ['operations_observations', 'key', PUBLISHER_DRAIN_KEY]]) {
    const [row] = await admin.unsafe(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE ${column}=$1`, [key]);
    originals.set(table, row?.value);
  }
});
beforeEach(async () => {
  vi.stubEnv('ROLE_LEASE_ROLE', 'publisher'); vi.stubEnv('ROLE_LEASE_INSTANCE_ID', owner.instanceId);
  vi.stubEnv('ROLE_LEASE_BOOT_ID', owner.bootId); vi.stubEnv('ROLE_LEASE_RELEASE', owner.release); vi.stubEnv('ROLE_LEASE_EPOCH', String(owner.epoch));
  await admin`UPDATE model_capacity_control SET mode='draining',epoch=1,revision=3,policy=${admin.json(policy)},
    policy_hash=${modelCapacityPolicyHash(policy)},updated_at=clock_timestamp() WHERE id=1`;
  await admin`UPDATE job_batch_control SET mode='legacy',draining_from=NULL WHERE id=1`;
  await admin`UPDATE dr_writer_fence SET state='active',reason=NULL WHERE id=1`;
  await admin`INSERT INTO role_leases(role,owner_instance_id,owner_boot_id,owner_release,owner_kind,epoch,lease_until)
    VALUES('publisher',${owner.instanceId},${owner.bootId},${owner.release},'primary',${owner.epoch},clock_timestamp()+interval '5 minutes')
    ON CONFLICT(role) DO UPDATE SET owner_instance_id=excluded.owner_instance_id,owner_boot_id=excluded.owner_boot_id,
      owner_release=excluded.owner_release,owner_kind=excluded.owner_kind,epoch=excluded.epoch,lease_until=excluded.lease_until`;
  await admin`INSERT INTO jobs(name,requested_version,processed_version,runs,last_run_at,locked_at,lease_token)
    VALUES(${lease.name},12,7,8,now(),now(),${lease.token}) ON CONFLICT(name) DO UPDATE SET requested_version=12,
      processed_version=7,runs=8,last_run_at=now(),locked_at=now(),lease_token=excluded.lease_token,last_error=NULL,not_before=NULL`;
  await admin`DELETE FROM operations_observations WHERE key=${PUBLISHER_DRAIN_KEY}`;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
afterAll(async () => {
  try {
    for (const [table, column, key] of [...tables.map(table => [table, 'id', 1] as const),
      ['jobs', 'name', lease.name] as const, ['role_leases', 'role', 'publisher'] as const,
      ['operations_observations', 'key', PUBLISHER_DRAIN_KEY] as const]) {
      const row = originals.get(table);
      if (row) {
        const columns = Object.keys(row).filter(name => name !== column);
        await admin.unsafe(`UPDATE ${table} SET (${columns.join(',')})=(SELECT ${columns.join(',')} FROM jsonb_populate_record(NULL::${table},$1::text::jsonb)) WHERE ${column}=$2`, [JSON.stringify(row), key]);
      } else await admin.unsafe(`DELETE FROM ${table} WHERE ${column}=$1`, [key]);
      const [restored] = await admin.unsafe(`SELECT to_jsonb(t) AS value FROM ${table} t WHERE ${column}=$1`, [key]);
      expect(restored?.value).toEqual(row);
    }
  } finally { await admin.end(); }
});

it('records the exact generation, permits a complete defer release, and rejects stale/next claims', async () => {
  expect(await readPublisherClassificationDrain()).toBe(false);
  await recordPublisherClassificationDraining(lease);
  expect(await readPublisherClassificationDrain()).toBe(true);
  await admin`UPDATE jobs SET locked_at=now()-interval '91 seconds' WHERE name=${lease.name}`;
  expect(await readPublisherClassificationDrain()).toBe(false);
  await admin`UPDATE jobs SET lease_token=NULL,locked_at=NULL WHERE name=${lease.name}`;
  expect(await readPublisherClassificationDrain()).toBe(true);
  await admin`UPDATE jobs SET runs=runs+1 WHERE name=${lease.name}`;
  expect(await readPublisherClassificationDrain()).toBe(false);
});

it('retains the same hint after the real runner defers and releases both claim fields', async () => {
  await admin`UPDATE jobs SET lease_token=NULL,locked_at=NULL WHERE name=${lease.name}`;
  expect(await runJob<null>(lease.name, async ctx => {
    await recordPublisherClassificationDraining(ctx.lease);
    return { done: false, deferred: 'model_capacity' };
  }, { requestedOnly: true })).toMatchObject({ status: 'deferred', reason: 'model_capacity' });
  const [row] = await admin`SELECT lease_token,locked_at,requested_version::int,processed_version::int FROM jobs WHERE name=${lease.name}`;
  expect(row).toMatchObject({ lease_token: null, locked_at: null, requested_version: 12, processed_version: 7 });
  expect(await readPublisherClassificationDrain()).toBe(true);
});

it('refuses OPEN, a new drain cycle, successor role and durable error observations', async () => {
  await recordPublisherClassificationDraining(lease);
  await admin`UPDATE model_capacity_control SET mode='open' WHERE id=1`;
  expect(await readPublisherClassificationDrain()).toBe(false);
  await admin`UPDATE model_capacity_control SET mode='draining',updated_at=updated_at+interval '1 second' WHERE id=1`;
  expect(await readPublisherClassificationDrain()).toBe(false);
  await recordPublisherClassificationDraining(lease);
  await admin`UPDATE role_leases SET epoch=epoch+1 WHERE role='publisher'`;
  expect(await readPublisherClassificationDrain()).toBe(false);
  await admin`UPDATE role_leases SET epoch=${owner.epoch} WHERE role='publisher'`;
  await admin`UPDATE jobs SET last_error='actual_failure' WHERE name=${lease.name}`;
  expect(await readPublisherClassificationDrain()).toBe(false);
  await admin`DELETE FROM operations_observations WHERE key=${PUBLISHER_DRAIN_KEY}`;
  await recordPublisherClassificationDraining(lease);
  expect(await readPublisherClassificationDrain()).toBe(false);
});

it('rejects foreign claim/owner and OPEN writes without fabricating a hold', async () => {
  await expect(recordPublisherClassificationDraining({ ...lease, token: '33333333-3333-4333-8333-333333333333' })).rejects.toThrow('job_lease_lost');
  vi.stubEnv('ROLE_LEASE_BOOT_ID', '33333333-3333-4333-8333-333333333333');
  await expect(recordPublisherClassificationDraining(lease)).rejects.toThrow('role_lease_lost');
  vi.stubEnv('ROLE_LEASE_BOOT_ID', owner.bootId);
  await admin`UPDATE model_capacity_control SET mode='open' WHERE id=1`;
  await recordPublisherClassificationDraining(lease);
  expect(await readPublisherClassificationDrain()).toBe(false);
});

it('runs the actual reader with SELECT-only monitor grants, keeping FOR SHARE and writes forbidden', async () => {
  await recordPublisherClassificationDraining(lease);
  const name = 'publisher_drain_monitor_fixture';
  await admin.unsafe(`CREATE ROLE ${name} NOLOGIN`);
  const monitor = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  const globals = globalThis as unknown as { db: typeof db }, original = globals.db;
  try {
    await admin.unsafe(`GRANT USAGE ON SCHEMA public TO ${name}`);
    await admin.unsafe(`GRANT SELECT ON operations_observations,model_capacity_control,role_leases,jobs,dr_writer_fence,job_batch_control TO ${name}`);
    await monitor.unsafe(`SET ROLE ${name}`);
    globals.db = drizzle(monitor, { schema });
    expect(await readPublisherClassificationDrain()).toBe(true);
    await expect(monitor`SELECT * FROM dr_writer_fence FOR SHARE`).rejects.toMatchObject({ code: '42501' });
    await expect(monitor`UPDATE jobs SET runs=runs WHERE name=${lease.name}`).rejects.toMatchObject({ code: '42501' });
  } finally {
    globals.db = original; await monitor.end();
    await admin.unsafe(`DROP OWNED BY ${name}`); await admin.unsafe(`DROP ROLE ${name}`);
  }
});
