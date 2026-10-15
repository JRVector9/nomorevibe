import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import postgres from "postgres";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { readReplayDatabaseIdentity } from "@/lib/operations/pipeline-replay-database";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import * as replaySetup from "./replay-setup";
import { getReplayHandlerIdentityPath } from "./replay-handler-setup";

const originalBootstrap = replaySetup.getReplayIdentityPath;
let admin: postgres.Sql;
let bootstrap: Awaited<ReturnType<typeof originalBootstrap>> | undefined;
let cleanupFailure: Error | undefined;

async function databaseState() {
  const [schema] = await admin`SELECT to_regnamespace('pipeline_replay')::text AS name`;
  const roles = await admin`SELECT oid::text, rolname FROM pg_roles WHERE rolname LIKE 'nomorevibe_replay_%' ORDER BY rolname`;
  const acl = await admin`
    SELECT 'database' AS kind, grantor.rolname AS grantor, a.privilege_type, a.is_grantable
    FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
      JOIN pg_roles grantor ON grantor.oid = a.grantor
    WHERE d.datname = current_database() AND a.grantee = 0
    UNION ALL
    SELECT 'schema' AS kind, grantor.rolname AS grantor, a.privilege_type, a.is_grantable
    FROM pg_namespace n CROSS JOIN LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
      JOIN pg_roles grantor ON grantor.oid = a.grantor
    WHERE n.nspname = 'public' AND a.grantee = 0
    ORDER BY kind, grantor, privilege_type, is_grantable`;
  return { schema: schema.name, roles: [...roles], acl: [...acl] };
}

beforeAll(() => {
  ensureSchema();
  admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
});
beforeEach(() => {
  vi.spyOn(replaySetup, "getReplayIdentityPath").mockImplementation(async () => {
    bootstrap = await originalBootstrap();
    const owned = bootstrap;
    return { ...owned, async release() {
      if (cleanupFailure) throw cleanupFailure;
      await owned.release();
    } };
  });
});
afterEach(async () => {
  try { await bootstrap?.release(); }
  finally { bootstrap = undefined; cleanupFailure = undefined; vi.restoreAllMocks(); }
});
afterAll(async () => { await admin?.end({ timeout: 3 }); });

it("restores the owned schema, role, identity file and PUBLIC ACLs when beforeProvision throws", async () => {
  const baseline = await databaseState();
  const failure = new Error("replay_setup_before_provision_failure");
  await expect(getReplayHandlerIdentityPath({ beforeProvision: async () => { throw failure; } })).rejects.toBe(failure);
  expect(bootstrap).toBeDefined();
  const identity = await readReplayDatabaseIdentity(bootstrap!.identityPath).catch(() => undefined);
  expect(await databaseState()).toEqual(baseline);
  await expect(access(bootstrap!.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(dirname(bootstrap!.identityPath))).rejects.toMatchObject({ code: "ENOENT" });
  expect(identity).toBeUndefined();
});

it("restores bootstrap resources after an actual CREATE TRIGGER lock timeout", async () => {
  const baseline = await databaseState();
  const blocker = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  let unlock!: () => void, locked!: () => void, blockerPid: number | undefined;
  const unlockBarrier = new Promise<void>(resolve => { unlock = resolve; });
  const lockBarrier = new Promise<void>(resolve => { locked = resolve; });
  let blocking: Promise<unknown> | undefined, error: unknown;
  const setup = getReplayHandlerIdentityPath({ beforeProvision: async () => {
    blocking = blocker.begin(async tx => {
      const [backend] = await tx`SELECT pg_backend_pid() AS pid`;
      blockerPid = backend.pid;
      await tx`LOCK TABLE public.crawl_candidates IN ROW EXCLUSIVE MODE`;
      locked();
      await unlockBarrier;
    });
    await lockBarrier;
  } }).then(() => { throw new Error("replay_setup_lock_timeout_missing"); }, failure => { error = failure; });
  try {
    await Promise.race([lockBarrier, setup]);
    let observed = false;
    const deadline = Date.now() + 3_000;
    while (!observed && !error && Date.now() < deadline) {
      const [wait] = await admin`SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE query LIKE 'CREATE TRIGGER replay_handler_change%ON public.crawl_candidates%'
          AND ${blockerPid!} = ANY(pg_blocking_pids(pid)) AND wait_event_type = 'Lock') AS observed`;
      observed = wait.observed;
      if (!observed) await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(observed).toBe(true);
    await setup;
    expect(error).toMatchObject({ code: "55P03" });
    expect((error as postgres.PostgresError).query).toContain("CREATE TRIGGER replay_handler_change");
    expect((error as postgres.PostgresError).query).toContain("public.crawl_candidates");
    expect(await databaseState()).toEqual(baseline);
    await expect(access(bootstrap!.identityPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(dirname(bootstrap!.identityPath))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    unlock();
    await blocking;
    await setup;
    await blocker.end({ timeout: 3 });
  }
});

it("preserves the original error and exposes a failed bootstrap cleanup", async () => {
  const failure = new Error("replay_setup_original_failure");
  cleanupFailure = new Error("replay_setup_cleanup_failure");
  let error: unknown;
  try { await getReplayHandlerIdentityPath({ beforeProvision: async () => { throw failure; } }); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).cause).toBe(failure);
  expect((error as AggregateError).errors).toEqual([failure, cleanupFailure]);
  expect((await databaseState()).schema).toBe("pipeline_replay");
  await expect(access(bootstrap!.identityPath)).resolves.toBeUndefined();
});
