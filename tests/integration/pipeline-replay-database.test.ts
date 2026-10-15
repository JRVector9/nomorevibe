import { afterAll, beforeAll, expect, it } from "vitest";
import postgres from "postgres";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertLocalTestDatabase } from "@/scripts/test-database";
import { assertVerifiedReplayDatabase, bootstrapReplayDatabase, openVerifiedReplayDatabase,
  readReplayDatabaseIdentity, verifyReplayDatabaseSession, type VerifiedReplayDatabase } from "@/lib/operations/pipeline-replay-database";
import { TEST_DATABASE_URL } from "./setup";
import { getReplayIdentityPath } from "./replay-setup";

let admin: postgres.Sql;
let database: VerifiedReplayDatabase;
let identityPath: string;
let release: () => Promise<void>;
const url = TEST_DATABASE_URL;
beforeAll(async () => {
  assertLocalTestDatabase(url);
  ({ identityPath, release } = await getReplayIdentityPath());
  database = await openVerifiedReplayDatabase(identityPath, {});
  admin = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  await admin`CREATE TABLE IF NOT EXISTS public.replay_boundary_probe (id integer primary key)`;
}, 20_000);
afterAll(async () => { await database?.close(); await admin?.end({ timeout: 3 }); await release?.(); });

it("returns only a frozen authentic handle and verifies on the same transaction connection", async () => {
  expect(() => assertVerifiedReplayDatabase(database)).not.toThrow();
  expect(Object.isFrozen(database)).toBe(true); expect(Object.isFrozen(database.identity)).toBe(true);
  expect(JSON.stringify(database.identity)).not.toContain("nonce"); expect(JSON.stringify(database.identity)).not.toContain("postgres:");
  expect(() => assertVerifiedReplayDatabase({ ...database })).toThrow("verified_replay_database_required");
  await database.client.begin(async tx => {
    await verifyReplayDatabaseSession(tx, database);
    const [row] = await tx`SELECT current_database() AS name, current_user AS role`;
    expect(row.name).toBe("nomorevibe_test"); expect(row.role).toBe(database.identity.roleName);
  });
});
it("denies public table access and every marker mutation or schema creation path", async () => {
  for (const sql of ["SELECT * FROM public.replay_boundary_probe", "INSERT INTO public.replay_boundary_probe VALUES (1)",
    "UPDATE pipeline_replay.identity SET nonce = repeat('b', 64)", "DELETE FROM pipeline_replay.identity", "TRUNCATE pipeline_replay.identity",
    "CREATE TABLE pipeline_replay.forbidden (id integer)", "CREATE TABLE public.forbidden (id integer)", "CREATE TEMP TABLE forbidden (id integer)",
    "CREATE SCHEMA forbidden", "ALTER TABLE pipeline_replay.identity ADD COLUMN forbidden text"])
    await expect(database.client.unsafe(sql)).rejects.toMatchObject({ code: "42501" });
  await verifyReplayDatabaseSession(database.client, database);
});
it("refuses altered provisioned nonce both at open and inside a write transaction", async () => {
  const original = await readReplayDatabaseIdentity(identityPath);
  await admin`UPDATE pipeline_replay.identity SET nonce = ${"b".repeat(64)}`;
  try {
    await expect(openVerifiedReplayDatabase(identityPath, {})).rejects.toThrow("replay_database_identity_mismatch");
    await expect(database.client.begin(async tx => { await verifyReplayDatabaseSession(tx, database); }))
      .rejects.toThrow("replay_database_identity_mismatch");
  } finally { await admin`UPDATE pipeline_replay.identity SET nonce = ${original.nonce}`; }
});
it("refuses role privilege and public schema grant drift", async () => {
  await admin.unsafe(`ALTER ROLE "${database.identity.roleName}" CREATEDB`);
  try { await expect(verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin.unsafe(`ALTER ROLE "${database.identity.roleName}" NOCREATEDB`); }
  await admin.unsafe(`GRANT USAGE ON SCHEMA public TO "${database.identity.roleName}"`);
  try { await expect(verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin.unsafe(`REVOKE USAGE ON SCHEMA public FROM "${database.identity.roleName}"`); }
});
it("refuses column-level marker mutations even without a whole-table grant", async () => {
  await admin.unsafe(`GRANT UPDATE (nonce) ON pipeline_replay.identity TO "${database.identity.roleName}"`);
  try { await expect(verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin.unsafe(`REVOKE UPDATE (nonce) ON pipeline_replay.identity FROM "${database.identity.roleName}"`); }
});
it("refuses callable SECURITY DEFINER functions in the allowed schema", async () => {
  await admin`CREATE FUNCTION pipeline_replay.boundary_privilege_canary() RETURNS void LANGUAGE sql SECURITY DEFINER
    AS 'UPDATE pipeline_replay.identity SET nonce = nonce'`;
  try { await expect(verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin`DROP FUNCTION pipeline_replay.boundary_privilege_canary()`; }
});
it("does not allow an edited private identity to authenticate itself", async () => {
  const altered = join(await mkdtemp(join(tmpdir(), "replay-db-altered-")), "identity.json");
  const original = await readReplayDatabaseIdentity(identityPath);
  await writeFile(altered, JSON.stringify({ ...original, nonce: "c".repeat(64) }), { mode: 0o600 });
  await expect(openVerifiedReplayDatabase(altered, {})).rejects.toThrow("replay_database_identity_mismatch");
});
it("refuses another bootstrap without altering identity or creating another role", async () => {
  const before = await readFile(identityPath, "utf8");
  const [rolesBefore] = await admin`SELECT count(*)::int AS count FROM pg_roles WHERE rolname LIKE 'nomorevibe_replay_%'`;
  const another = join(await mkdtemp(join(tmpdir(), "replay-db-duplicate-")), "identity.json");
  await expect(bootstrapReplayDatabase({ databaseUrl: url!, identityPath: another, acknowledgeDedicatedCluster: true, env: {} }))
    .rejects.toThrow("replay_database_already_provisioned");
  const [rolesAfter] = await admin`SELECT count(*)::int AS count FROM pg_roles WHERE rolname LIKE 'nomorevibe_replay_%'`;
  expect(rolesAfter.count).toBe(rolesBefore.count); expect(await readFile(identityPath, "utf8")).toBe(before);
  await verifyReplayDatabaseSession(database.client, database);
});
it("invalidates the runtime brand when a connection is closed", async () => {
  const another = await openVerifiedReplayDatabase(identityPath, {});
  await another.close(); expect(() => assertVerifiedReplayDatabase(another)).toThrow("verified_replay_database_required");
});
