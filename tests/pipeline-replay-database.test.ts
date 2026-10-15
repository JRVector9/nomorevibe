import { afterEach, expect, it, vi } from "vitest";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const driverImport = vi.hoisted(() => vi.fn());
vi.mock("postgres", () => { driverImport(); throw new Error("unexpected_driver_import_canary"); });
const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); driverImport.mockClear(); vi.unstubAllEnvs(); });
async function api() { return import("@/lib/operations/pipeline-replay-database"); }
async function directory() { const path = await mkdtemp(join(tmpdir(), "replay-db-unit-")); paths.push(path); return path; }
function identity() {
  return { version: 1, databaseUrl: "postgres://nomorevibe_replay_0123456789abcdef:private_password_canary@127.0.0.1:55453/nomorevibe_test",
    databaseName: "nomorevibe_test", databaseOid: 100, schemaName: "pipeline_replay", schemaOid: 101,
    roleName: "nomorevibe_replay_0123456789abcdef", roleOid: 102, ownerOid: 10, nonce: "a".repeat(64) };
}
async function identityFile(value: unknown = identity()) { const path = join(await directory(), "identity.json"); await writeFile(path, JSON.stringify(value), { mode: 0o600 }); return path; }

it("admits the exact local database and rejects driver/parser escapes before importing the driver", async () => {
  const loaded = await api(); expect(loaded.assertReplayDatabaseTarget).toBeTypeOf("function");
  const guard = loaded.assertReplayDatabaseTarget;
  expect(() => guard("postgres://fixture:p%40ss@127.0.0.1:55453/nomorevibe_test", {})).not.toThrow();
  for (const url of ["postgres://fixture@production.invalid/nomorevibe_test", "postgres://fixture@localhost/nomorevibe",
    "postgres://fixture@localhost/nomorevibe_test?host=prod", "postgres://fixture@localhost/nomorevibe_test#x",
    "postgres://fixture:fixture@production.invalid,127.0.0.1@localhost/nomorevibe_test",
    "postgres://fixture:fixture@production.invalid%2c127.0.0.1@localhost/nomorevibe_test"])
    expect(() => guard(url, {})).toThrow("local_test_database_required");
  expect(driverImport).not.toHaveBeenCalled();
});
it("rejects ambient database overrides without exposing values", async () => {
  const loaded = await api(); expect(loaded.assertReplayDatabaseTarget).toBeTypeOf("function");
  const guard = loaded.assertReplayDatabaseTarget;
  for (const env of [{ PGHOST: "private_canary" }, { PGOPTIONS: "private_canary" }, { PGSSLMODE: "private_canary" },
    { READ_DATABASE_URL: "private_canary" }, { MIGRATION_DATABASE_URL: "private_canary" }, { DATABASE_URL: "private_canary" }])
    expect(() => guard(identity().databaseUrl, env)).toThrow("replay_database_override_rejected");
  expect(driverImport).not.toHaveBeenCalled();
});
it("reads only strict private bootstrap identity files", async () => {
  const loaded = await api(); expect(loaded.readReplayDatabaseIdentity).toBeTypeOf("function");
  const read = loaded.readReplayDatabaseIdentity as (path: string) => Promise<unknown>;
  const path = await identityFile(); expect(await read(path)).toEqual(identity());
  await chmod(path, 0o644); await expect(read(path)).rejects.toThrow("replay_identity_file_required");
  await chmod(path, 0o600); const link = join(await directory(), "link.json"); await symlink(path, link);
  await expect(read(link)).rejects.toThrow("replay_identity_file_required");
});
it("rejects malformed oversized and unknown-key identity without echoing canaries", async () => {
  const loaded = await api(); expect(loaded.readReplayDatabaseIdentity).toBeTypeOf("function");
  const read = loaded.readReplayDatabaseIdentity as (path: string) => Promise<unknown>;
  for (const value of [{ ...identity(), secret_unknown_key_canary: "secret_canary" }, { ...identity(), schemaName: "public" }])
    await expect(read(await identityFile(value))).rejects.toThrow("invalid_replay_identity");
  const path = await identityFile(); await writeFile(path, "{secret_canary"); await expect(read(path)).rejects.toThrow("invalid_replay_identity");
  await writeFile(path, "x".repeat(16 * 1024)); await expect(read(path)).rejects.toThrow("replay_identity_file_required");
});
it("rejects a forged verified handle", async () => {
  const loaded = await api(); expect(loaded.assertVerifiedReplayDatabase).toBeTypeOf("function");
  const assert = loaded.assertVerifiedReplayDatabase as (value: unknown) => void;
  for (const value of [null, {}, Object.freeze({ client: {}, identity: Object.freeze(identity()), verified: true })])
    expect(() => assert(value)).toThrow("verified_replay_database_required");
});
it("rejects an identity's remote URL before importing the driver", async () => {
  const loaded = await api(); expect(loaded.openVerifiedReplayDatabase).toBeTypeOf("function");
  const open = loaded.openVerifiedReplayDatabase as (path: string, env: Record<string, string>) => Promise<unknown>;
  const path = await identityFile({ ...identity(), databaseUrl: identity().databaseUrl.replace("127.0.0.1", "production.invalid") });
  await expect(open(path, {})).rejects.toThrow("local_test_database_required"); expect(driverImport).not.toHaveBeenCalled();
});
it("rejects real ambient PGPORT even when the pure environment argument is empty", async () => {
  const loaded = await api(); const path = await identityFile();
  vi.stubEnv("PGPORT", "65431");
  await expect(loaded.openVerifiedReplayDatabase(path, {})).rejects.toThrow("replay_database_override_rejected");
  expect(driverImport).not.toHaveBeenCalled();
});
it("requires dedicated cluster acknowledgement before bootstrap driver import", async () => {
  const loaded = await api(); expect(loaded.bootstrapReplayDatabase).toBeTypeOf("function");
  const bootstrap = loaded.bootstrapReplayDatabase as (options: Record<string, unknown>) => Promise<unknown>;
  await expect(bootstrap({ databaseUrl: "postgres://fixture@127.0.0.1:55453/nomorevibe_test", identityPath: join(await directory(), "identity.json"),
    acknowledgeDedicatedCluster: false, env: {} })).rejects.toThrow("dedicated_replay_cluster_required");
  expect(driverImport).not.toHaveBeenCalled();
});
it("never overwrites an existing private identity before driver import", async () => {
  const loaded = await api(); expect(loaded.bootstrapReplayDatabase).toBeTypeOf("function");
  const bootstrap = loaded.bootstrapReplayDatabase as (options: Record<string, unknown>) => Promise<unknown>;
  const path = await identityFile(); const before = await readFile(path, "utf8");
  await expect(bootstrap({ databaseUrl: "postgres://fixture@127.0.0.1:55453/nomorevibe_test", identityPath: path,
    acknowledgeDedicatedCluster: true, env: {} })).rejects.toThrow("replay_identity_file_exists");
  expect(await readFile(path, "utf8")).toBe(before); expect(driverImport).not.toHaveBeenCalled();
});
it("the CLI fails closed without acknowledgement and sanitizes environment canaries", async () => {
  const path = join(await directory(), "identity.json");
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(PG|DATABASE_URL$|READ_DATABASE_URL$|MIGRATION_DATABASE_URL$|TEST_DATABASE_URL$|NODE_OPTIONS$)/.test(key)));
  const run = (extra: string[], values = {}) => spawnSync(process.execPath, ["--import", "tsx", "scripts/bootstrap-pipeline-replay.ts", "--identity", path, ...extra],
    { encoding: "utf8", env: { ...env, NODE_ENV: "test", TEST_DATABASE_URL: "postgres://fixture:password_canary@127.0.0.1:55453/nomorevibe_test", ...values }, timeout: 10_000 });
  const missing = run([]); expect(missing.status).toBe(1); expect(missing.stderr.trim()).toBe("dedicated_replay_cluster_required");
  const rejected = run(["--acknowledge-dedicated-cluster"], { PGHOST: "secret_environment_canary" });
  expect(rejected.status).toBe(1); expect(rejected.stderr.trim()).toBe("replay_database_override_rejected");
  expect(rejected.stderr).not.toContain("canary");
});
