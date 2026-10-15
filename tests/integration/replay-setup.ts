import { mkdtemp, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type postgres from "postgres";
import { assertReplayDatabaseTarget, bootstrapReplayDatabase, openVerifiedReplayDatabase,
  readReplayDatabaseIdentity, type ReplayDatabaseIdentity } from "@/lib/operations/pipeline-replay-database";
import { TEST_DATABASE_URL } from "./setup";

type PublicAcl = { kind: "database" | "schema"; grantor_name: string; privilege_type: string; is_grantable: boolean };
const identifier = (name: string) => `"${name.replace(/"/g, '""')}"`;
const canonicalAcl = (rows: PublicAcl[]) => rows.map(row => JSON.stringify(row)).sort().join("\n");
async function publicAcl(sql: postgres.Sql | postgres.TransactionSql): Promise<PublicAcl[]> {
  return sql<PublicAcl[]>`
    SELECT 'database' AS kind, r.rolname AS grantor_name, acl.privilege_type, acl.is_grantable
    FROM pg_catalog.pg_database d CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(d.datacl, pg_catalog.acldefault('d', d.datdba))) acl
      JOIN pg_catalog.pg_roles r ON r.oid = acl.grantor WHERE d.datname = current_database() AND acl.grantee = 0
    UNION ALL
    SELECT 'schema' AS kind, r.rolname AS grantor_name, acl.privilege_type, acl.is_grantable
    FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) acl
      JOIN pg_catalog.pg_roles r ON r.oid = acl.grantor WHERE n.nspname = 'public' AND acl.grantee = 0`;
}
async function restorePublicAcl(tx: postgres.TransactionSql, original: PublicAcl[]): Promise<void> {
  await tx`REVOKE ALL ON DATABASE nomorevibe_test FROM PUBLIC`;
  await tx`REVOKE ALL ON SCHEMA public FROM PUBLIC`;
  for (const row of original) {
    const allowed = row.kind === "database" ? ["CONNECT", "CREATE", "TEMPORARY"] : ["USAGE", "CREATE"];
    if (!allowed.includes(row.privilege_type)) throw new Error("replay_test_acl_restore_failed");
    await tx.unsafe(`SET LOCAL ROLE ${identifier(row.grantor_name)}`);
    await tx.unsafe(`GRANT ${row.privilege_type} ON ${row.kind === "database" ? "DATABASE nomorevibe_test" : "SCHEMA public"} TO PUBLIC${row.is_grantable ? " WITH GRANT OPTION" : ""}`);
    await tx`SET LOCAL ROLE NONE`;
  }
  if (canonicalAcl(await publicAcl(tx)) !== canonicalAcl(original)) throw new Error("replay_test_acl_restore_failed");
}

/** Explicit local reuse never drops/restores anything; fresh CI files own only their private schema/role. */
export async function getReplayIdentityPath(): Promise<{ identityPath: string; release(): Promise<void> }> {
  assertReplayDatabaseTarget(TEST_DATABASE_URL);
  const reuse = process.env.PIPELINE_REPLAY_IDENTITY_FILE;
  if (reuse) {
    const identity = await readReplayDatabaseIdentity(reuse);
    const expected = new URL(TEST_DATABASE_URL), actual = new URL(identity.databaseUrl);
    if (actual.protocol !== expected.protocol || actual.host !== expected.host || actual.pathname !== expected.pathname)
      throw new Error("replay_test_database_mismatch");
    const checked = await openVerifiedReplayDatabase(reuse, {}); await checked.close();
    return { identityPath: reuse, release: async () => {} };
  }
  const directory = await mkdtemp(join(tmpdir(), "replay-db-integration-"));
  const identityPath = join(directory, "identity.json");
  const { default: postgres } = await import("postgres");
  const admin = postgres(TEST_DATABASE_URL, { max: 1, connect_timeout: 3, prepare: false, onnotice: () => {},
    connection: { statement_timeout: 5000, lock_timeout: 1000, idle_in_transaction_session_timeout: 5000 } });
  let originalAcl: PublicAcl[], identity: ReplayDatabaseIdentity;
  try {
    originalAcl = await publicAcl(admin);
    await bootstrapReplayDatabase({ databaseUrl: TEST_DATABASE_URL, identityPath, acknowledgeDedicatedCluster: true });
    identity = await readReplayDatabaseIdentity(identityPath);
  } catch (error) {
    await admin.end({ timeout: 3 }).catch(() => {});
    // Preserve any provisioned identity for inspection; remove only an empty directory.
    await rmdir(directory).catch(() => {});
    throw error;
  }
  let released = false;
  return { identityPath, async release() {
    if (released) return;
    try {
      // The caller must close its own runtime clients. Never terminate someone else's backend.
      const checked = await openVerifiedReplayDatabase(identityPath, {}); await checked.close();
      await admin.begin(async tx => {
      const [current] = await tx`
        SELECT current_database() AS name, current_user AS owner_name, session_user AS session_role,
          d.oid::int AS database_oid, d.datdba::int AS database_owner, owner.oid::int AS current_oid, owner.rolsuper,
          n.oid::int AS schema_oid, n.nspowner::int AS schema_owner, c.relowner::int AS marker_owner,
          runtime.oid::int AS role_oid, i.nonce
        FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles owner ON owner.rolname = current_user
          JOIN pg_catalog.pg_namespace n ON n.nspname = 'pipeline_replay'
          JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = 'identity'
          JOIN pg_catalog.pg_roles runtime ON runtime.rolname = ${identity.roleName}
          CROSS JOIN pipeline_replay.identity i WHERE d.datname = current_database() FOR UPDATE OF i`;
      if (!current || current.name !== identity.databaseName || current.database_oid !== identity.databaseOid
        || current.database_owner !== identity.ownerOid || current.current_oid !== identity.ownerOid || !current.rolsuper
        || current.owner_name !== current.session_role || current.schema_oid !== identity.schemaOid
        || current.schema_owner !== identity.ownerOid || current.marker_owner !== identity.ownerOid
        || current.role_oid !== identity.roleOid || current.nonce !== identity.nonce)
        throw new Error("replay_test_cleanup_identity_mismatch");
      const [active] = await tx`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid = ${identity.roleOid}::oid) AS present`;
      if (active.present) throw new Error("replay_test_runtime_still_connected");
      await tx`DROP SCHEMA pipeline_replay CASCADE`;
      await tx.unsafe(`REVOKE CONNECT ON DATABASE nomorevibe_test FROM ${identifier(identity.roleName)}`);
      await tx.unsafe(`DROP ROLE ${identifier(identity.roleName)}`);
      await restorePublicAcl(tx, originalAcl);
      });
    } finally { await admin.end({ timeout: 3 }); }
    await unlink(identityPath); await rmdir(directory); released = true;
  } };
}
