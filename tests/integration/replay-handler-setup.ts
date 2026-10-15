import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { assertLocalTestDatabase } from "@/scripts/test-database";
import { openVerifiedReplayHandlerDatabase, provisionReplayHandlerProfile, readReplayDatabaseIdentity } from "@/lib/operations/pipeline-replay-database";
import { TEST_DATABASE_URL } from "./setup";
import { getReplayIdentityPath } from "./replay-setup";

/** Test-owned profile only; returns the bootstrap helper's original ACLs on final release. */
export async function removeReplayHandlerTestProfile(identityPath: string): Promise<void> {
  assertLocalTestDatabase(TEST_DATABASE_URL);
  const identity = await readReplayDatabaseIdentity(identityPath);
  const verified = await openVerifiedReplayHandlerDatabase(identityPath, {});
  await verified.close();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.begin(async tx => {
      const [owner] = await tx`SELECT d.oid::int AS database_oid, d.datdba::int AS owner_oid,
        r.oid::int AS role_oid, r.rolsuper, current_user = session_user AS same_role,
        n.oid::int AS schema_oid, n.nspowner::int AS schema_owner, i.nonce
        FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname = current_user
        JOIN pg_catalog.pg_namespace n ON n.nspname = 'pipeline_replay'
        CROSS JOIN pipeline_replay.identity i WHERE d.datname = current_database() FOR UPDATE OF i`;
      if (!owner || !owner.rolsuper || !owner.same_role || owner.database_oid !== identity.databaseOid
        || owner.owner_oid !== identity.ownerOid || owner.role_oid !== identity.ownerOid
        || owner.schema_oid !== identity.schemaOid || owner.schema_owner !== identity.ownerOid || owner.nonce !== identity.nonce)
        throw new Error("replay_test_cleanup_identity_mismatch");
      const [runtime] = await tx`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE usesysid = ${identity.roleOid}::oid) AS active,
        EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relowner = ${identity.roleOid}::oid) AS owned`;
      if (runtime.active || runtime.owned) throw new Error("replay_test_runtime_still_connected");
      for (const table of ["crawl_settings", "crawl_documents", "agent_repository_scans", "agent_repository_observations",
        "pipeline_stage_modes", "pipeline_item_leases"])
        await tx.unsafe(`DROP TRIGGER IF EXISTS replay_handler_source_immutable ON public.${table}`);
      for (const table of ["public.crawl_candidates", "public.crawl_review_attempts", "public.second_reviews", "public.crawl_frontier",
        "public.jobs", "public.operations_observations", "pipeline_replay.capacity_calls"])
        await tx.unsafe(`DROP TRIGGER replay_handler_change ON ${table}`);
      await tx`DROP FUNCTION pipeline_replay.reject_handler_source_mutation()`;
      await tx`DROP TABLE pipeline_replay.handler_profile`;
      // The file schema validated this generated identifier, and ownership above is empty.
      const role = `"${identity.roleName}"`;
      await tx.unsafe(`DROP OWNED BY ${role}`);
      await tx.unsafe(`GRANT CONNECT ON DATABASE nomorevibe_test TO ${role}`);
      await tx.unsafe(`GRANT USAGE ON SCHEMA pipeline_replay TO ${role}`);
      await tx.unsafe(`GRANT SELECT ON pipeline_replay.identity TO ${role}`);
    });
  } finally { await admin.end({ timeout: 3 }); }
}

export async function getReplayHandlerIdentityPath(options: { beforeProvision?: (admin: postgres.Sql) => Promise<void> } = {}): Promise<{ identityPath: string; release(): Promise<void> }> {
  if (process.env.PIPELINE_REPLAY_IDENTITY_FILE) throw new Error("replay_handler_test_requires_owned_identity");
  const bootstrap = await getReplayIdentityPath();
  const admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await admin.unsafe(await readFile("scripts/sql/pipeline-replay-ledger.sql", "utf8"));
    await options.beforeProvision?.(admin);
  }
  finally { await admin.end({ timeout: 3 }); }
  await provisionReplayHandlerProfile({ databaseUrl: TEST_DATABASE_URL, identityPath: bootstrap.identityPath,
    acknowledgeDedicatedCluster: true, env: {} });
  return { identityPath: bootstrap.identityPath, async release() {
    await removeReplayHandlerTestProfile(bootstrap.identityPath);
    await bootstrap.release();
  } };
}
