import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDbClient, dbPoolConfig, postgresClientOptions } from "@/lib/db/pool";

const driver = vi.hoisted(() => ({ create: vi.fn(() => Object.assign(() => undefined, { unsafe: vi.fn(), options: { parsers: {}, serializers: {} } })) }));
vi.mock('postgres', () => ({ default: driver.create }));

const budgetPolicy = { version: 1, host: 'oracle-osaka-smoke', release: 'r1', roles: ['translation'],
  schedulerReplicas: 1, webReplicas: 1, webReadReplica: true, monitor: false, connectAgent: false,
  preflightProcesses: 0, migrationProcesses: 0, rolloutCopies: 1 };
function parentEnvironment() {
  return { WORKER_ROLE: 'translation', PHYSICAL_HOST: 'oracle-osaka-smoke', RELEASE_TAG: 'r1',
    HOST_DB_BUDGET: JSON.stringify({ mode: 'enabled', policy: budgetPolicy,
      process: { kind: 'role-parent', role: 'translation', host: 'oracle-osaka-smoke', release: 'r1', replica: 1, copy: 1 } }) };
}
beforeEach(() => driver.create.mockClear());
afterEach(() => vi.unstubAllEnvs());

describe("PostgreSQL client options", () => {
  it("omits unsupported timeout startup parameters for PgBouncer", () => {
    const config = dbPoolConfig({
      WORKER_ROLE: "web",
      DB_POOLER_MODE: "pgbouncer",
    });

    expect(postgresClientOptions(config)).toMatchObject({
      max: 8,
      connection: { application_name: "nomorevibe:web" },
    });
    expect(postgresClientOptions(config).connection).not.toHaveProperty("statement_timeout");
    expect(postgresClientOptions(config).connection).not.toHaveProperty("lock_timeout");
    expect(postgresClientOptions(config).connection).not.toHaveProperty("idle_in_transaction_session_timeout");
  });

  it("keeps server-side timeout startup parameters for direct PostgreSQL", () => {
    const config = dbPoolConfig({ WORKER_ROLE: "maintenance" });

    expect(postgresClientOptions(config).connection).toMatchObject({
      application_name: "nomorevibe:maintenance",
      statement_timeout: 120_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 120_000,
    });
  });

  it("rejects an unknown pooler mode", () => {
    expect(() => dbPoolConfig({ DB_POOLER_MODE: "unknown" })).toThrow("Invalid DB_POOLER_MODE");
  });

  it("gives the private connect agent its own bounded pool identity", () => {
    expect(dbPoolConfig({ WORKER_ROLE: "connect-agent" })).toMatchObject({
      role: "connect-agent",
      max: 1,
    });
  });
});


it('uses the declared parent quota instead of the legacy role default when max is absent', () => {
  expect(dbPoolConfig(parentEnvironment()).max).toBe(1);
});

it('rejects an explicit environment max above the parent quota', () => {
  expect(() => dbPoolConfig({ ...parentEnvironment(), DB_POOL_MAX: '64' })).toThrow('host_db_pool_quota_exceeded');
});

it('rejects an explicit client configuration above quota before creating the driver', () => {
  const explicit = dbPoolConfig({ WORKER_ROLE: 'translation', DB_POOL_MAX: '64' });
  for (const [key, value] of Object.entries(parentEnvironment())) vi.stubEnv(key, value);
  expect(() => createDbClient('postgres://not-used', explicit)).toThrow('host_db_pool_quota_exceeded');
  expect(driver.create).not.toHaveBeenCalled();
});

it('rejects a nonweb READ pool before creating the driver', () => {
  const explicit = dbPoolConfig({ WORKER_ROLE: 'translation', DB_POOL_MAX: '1' });
  for (const [key, value] of Object.entries(parentEnvironment())) vi.stubEnv(key, value);
  expect(() => Reflect.apply(createDbClient, undefined, ['postgres://not-used', explicit, 'read'])).toThrow('host_db_read_pool_not_declared');
  expect(driver.create).not.toHaveBeenCalled();
});


it.each([0, -1, 0.5, NaN, Infinity])('rejects explicit invalid max %s before driver construction', max => {
  const explicit = { ...dbPoolConfig({ WORKER_ROLE: 'translation' }), max };
  for (const [key, value] of Object.entries(parentEnvironment())) vi.stubEnv(key, value);
  expect(() => createDbClient('postgres://not-used', explicit)).toThrowError(new Error('host_db_pool_quota_exceeded'));
  expect(driver.create).not.toHaveBeenCalled();
});

it('keeps explicit configurations and driver options unchanged when the budget is disabled', () => {
  vi.stubEnv('HOST_DB_BUDGET', '{"mode":"disabled"}');
  const config = dbPoolConfig({ WORKER_ROLE: 'crawler', DB_POOL_MAX: '7', DB_POOLER_MODE: 'pgbouncer', DB_POOL_WAIT_MS: '40' });
  const before = structuredClone(config);
  createDbClient('postgres://not-used', config);
  expect(driver.create).toHaveBeenCalledWith('postgres://not-used', postgresClientOptions(before));
  expect(config).toEqual(before);
});

it('enforces the web READ quota separately from primary and keeps absent legacy READ defaults', () => {
  const env = { ...parentEnvironment(), WORKER_ROLE: 'web' };
  env.HOST_DB_BUDGET = JSON.stringify({ mode: 'enabled', policy: budgetPolicy,
    process: { kind: 'web', role: 'web', host: 'oracle-osaka-smoke', release: 'r1', replica: 1, copy: 1 } });
  expect(dbPoolConfig(env).max).toBe(8);
  expect(dbPoolConfig(env, 'read').max).toBe(4);
  expect(dbPoolConfig({ ...env, READ_DB_POOL_MAX: '2' }, 'read').max).toBe(2);
  expect(() => dbPoolConfig({ ...env, READ_DB_POOL_MAX: '5' }, 'read')).toThrow('host_db_pool_quota_exceeded');
  expect(dbPoolConfig({ WORKER_ROLE: 'crawler', DB_POOL_MAX: '7' }, 'read').max).toBe(4);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const explicit = { ...dbPoolConfig(env), max: 5 };
  expect(() => createDbClient('postgres://not-used', explicit, 'read')).toThrow('host_db_pool_quota_exceeded');
  expect(driver.create).not.toHaveBeenCalled();
});

it('passes the parent default quota through the actual lazy primary factory', async () => {
  vi.resetModules();
  const globals = globalThis as { pgClient?: unknown; db?: unknown; readDb?: unknown };
  const before = { pgClient: globals.pgClient, db: globals.db, readDb: globals.readDb };
  delete globals.pgClient; delete globals.db; delete globals.readDb;
  for (const [key, value] of Object.entries(parentEnvironment())) vi.stubEnv(key, value);
  vi.stubEnv('DATABASE_URL', 'postgres://not-used');
  try {
    const { db } = await import('@/lib/db');
    expect(driver.create).not.toHaveBeenCalled();
    db.select();
    expect(driver.create).toHaveBeenCalledWith('postgres://not-used', expect.objectContaining({ max: 1 }));
    db.select();
    expect(driver.create).toHaveBeenCalledOnce();
  } finally { Object.assign(globals, before); }
});

it('rejects nonweb READ in the actual lazy replica factory before driver construction', async () => {
  vi.resetModules();
  const globals = globalThis as { readDb?: unknown };
  const before = globals.readDb;
  delete globals.readDb;
  for (const [key, value] of Object.entries(parentEnvironment())) vi.stubEnv(key, value);
  vi.stubEnv('READ_DATABASE_URL', 'postgres://not-used');
  try {
    const { onReplica } = await import('@/lib/db');
    await expect(onReplica(async () => 'unreachable')).rejects.toThrow('host_db_read_pool_not_declared');
    expect(driver.create).not.toHaveBeenCalled();
  } finally {
    if (before === undefined) delete globals.readDb; else globals.readDb = before;
  }
});


it('rejects a missing max in an explicit configuration rather than treating it as an absent override', () => {
  const explicit = { ...dbPoolConfig({ WORKER_ROLE: 'translation' }), max: undefined as unknown as number };
  for (const [key, value] of Object.entries(parentEnvironment())) vi.stubEnv(key, value);
  expect(() => createDbClient('postgres://not-used', explicit)).toThrowError(new Error('host_db_pool_quota_exceeded'));
  expect(driver.create).not.toHaveBeenCalled();
});
