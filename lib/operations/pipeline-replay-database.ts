import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type postgres from "postgres";
import { z } from "zod";
import { assertLocalTestDatabase } from "../../scripts/test-database";
import { provisionHandlerProfile, ReplayHandlerProfileError, verifyHandlerProfile } from "./pipeline-replay-handler-profile";

type Environment = Readonly<Record<string, string | undefined>>;
type ErrorCode = "local_test_database_required" | "replay_database_override_rejected" | "replay_identity_file_required"
  | "invalid_replay_identity" | "verified_replay_database_required" | "dedicated_replay_cluster_required"
  | "replay_identity_file_exists" | "replay_database_admin_required" | "replay_database_already_provisioned"
  | "replay_database_identity_mismatch" | "replay_database_privileges_rejected" | "replay_database_operation_failed"
  | "verified_replay_handler_database_required";
class ReplayDatabaseError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}
const fail = (code: ErrorCode): never => { throw new ReplayDatabaseError(code); };
export function formatReplayDatabaseError(error: unknown): string {
  return error instanceof ReplayDatabaseError || error instanceof ReplayHandlerProfileError ? error.code : "replay_database_operation_failed";
}
const oid = z.number().int().positive().safe();
const identitySchema = z.object({
  version: z.literal(1), databaseUrl: z.string().min(1).max(2048), databaseName: z.literal("nomorevibe_test"), databaseOid: oid,
  schemaName: z.literal("pipeline_replay"), schemaOid: oid,
  roleName: z.string().regex(/^nomorevibe_replay_[a-f0-9]{16}$/), roleOid: oid, ownerOid: oid,
  nonce: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ReplayDatabaseIdentity = Readonly<z.infer<typeof identitySchema>>;
export type ReplayDatabaseMetadata = Readonly<Omit<ReplayDatabaseIdentity, "databaseUrl" | "nonce">>;
const verifiedBrand: unique symbol = Symbol("VerifiedReplayDatabase");
export type VerifiedReplayDatabase = Readonly<{
  [verifiedBrand]: true; client: postgres.Sql; identity: ReplayDatabaseMetadata; close(): Promise<void>;
}>;
const verified = new WeakMap<object, ReplayDatabaseIdentity>();
const handlers = new WeakSet<object>();

/** Pure admission. No DB-dependent module is imported before this succeeds. */
export function assertReplayDatabaseTarget(url: string, env: Environment = process.env): void {
  try { assertLocalTestDatabase(url); } catch { fail("local_test_database_required"); }
  if (Object.entries(env).some(([key, value]) => key.startsWith("PG") && Boolean(value))
    || env.READ_DATABASE_URL || env.MIGRATION_DATABASE_URL || env.DATABASE_URL && env.DATABASE_URL !== url
    || env.DATABASE_FALLBACK_HOST || env.READ_DATABASE_FALLBACK_HOST)
    fail("replay_database_override_rejected");
}
function assertAmbientOverrides(): void {
  if (Object.entries(process.env).some(([key, value]) => key.startsWith("PG") && Boolean(value))
    || process.env.READ_DATABASE_URL || process.env.MIGRATION_DATABASE_URL
    || process.env.DATABASE_FALLBACK_HOST || process.env.READ_DATABASE_FALLBACK_HOST) fail("replay_database_override_rejected");
}
function metadata(identity: ReplayDatabaseIdentity): ReplayDatabaseMetadata {
  const { databaseUrl, nonce, ...publicIdentity } = identity; void databaseUrl; void nonce;
  return Object.freeze(publicIdentity);
}
export async function readReplayDatabaseIdentity(path: string): Promise<ReplayDatabaseIdentity> {
  let file;
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return fail("replay_identity_file_required"); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > 8192 || (stat.mode & 0o777) !== 0o600
      || stat.nlink !== 1 || process.getuid && stat.uid !== process.getuid()) fail("replay_identity_file_required");
    const bytes = await file.readFile();
    if (bytes.length > 8192) fail("replay_identity_file_required");
    try { return Object.freeze(identitySchema.parse(JSON.parse(bytes.toString("utf8")))); }
    catch { return fail("invalid_replay_identity"); }
  } finally { await file.close(); }
}
export function assertVerifiedReplayDatabase(value: unknown): asserts value is VerifiedReplayDatabase {
  if (!value || typeof value !== "object" || !verified.has(value)) fail("verified_replay_database_required");
}
export function assertVerifiedReplayHandlerDatabase(value: unknown): asserts value is VerifiedReplayDatabase {
  if (!value || typeof value !== "object" || !verified.has(value) || !handlers.has(value)) fail("verified_replay_handler_database_required");
}
/** Compare authenticated private identities, including credentials and nonce, without exposing either. */
export function assertSameReplayHandlerDatabase(left: VerifiedReplayDatabase, right: VerifiedReplayDatabase): void {
  assertVerifiedReplayHandlerDatabase(left);
  assertVerifiedReplayHandlerDatabase(right);
  if (!isDeepStrictEqual(verified.get(left), verified.get(right))) fail("replay_database_identity_mismatch");
}
const clientOptions = {
  max: 1, connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, prepare: false, fetch_types: false, ssl: false,
  onnotice: () => {},
  connection: { application_name: "nomorevibe:isolated-replay", search_path: "pg_catalog,pipeline_replay",
    statement_timeout: 5000, lock_timeout: 1000, idle_in_transaction_session_timeout: 5000 },
} as const;
function connectionOptions(databaseUrl: string, handler = false): postgres.Options<Record<string, never>> {
  const url = new URL(databaseUrl);
  if (!url.username) fail("invalid_replay_identity");
  // Pinned3.4.9 supports arrays (BaseOptions/parseOptions); its public Options type incorrectly narrows these two fields.
  return { ...clientOptions, connection: { ...clientOptions.connection,
    search_path: handler ? "pg_catalog,pipeline_replay,public" : clientOptions.connection.search_path },
    host: [url.hostname.replace(/^\[|\]$/g, "")], port: [Number(url.port || 5432)],
    database: url.pathname.slice(1), user: decodeURIComponent(url.username), password: () => decodeURIComponent(url.password),
    target_session_attrs: "primary", debug: false } as unknown as postgres.Options<Record<string, never>>;
}

async function verifySession(session: postgres.Sql | postgres.TransactionSql, identity: ReplayDatabaseIdentity, handler = false): Promise<void> {
  let rows;
  try {
    rows = await session`
      SELECT current_database() AS database_name, current_user AS role_name, session_user AS session_role,
        d.oid::int AS database_oid, d.datdba::int AS database_owner, r.oid::int AS role_oid,
        n.oid::int AS schema_oid, n.nspowner::int AS schema_owner, c.relowner::int AS marker_owner,
        c.relkind AS marker_kind, c.relrowsecurity AS marker_rls, i.nonce,
        i.database_oid::int AS stored_database_oid, i.schema_oid::int AS stored_schema_oid,
        i.role_oid::int AS stored_role_oid, i.owner_oid::int AS stored_owner_oid
      FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname = current_user
      JOIN pg_catalog.pg_namespace n ON n.nspname = 'pipeline_replay'
      JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = 'identity'
      CROSS JOIN pipeline_replay.identity i WHERE d.datname = current_database()`;
  } catch { return fail("replay_database_identity_mismatch"); }
  const row = rows[0];
  if (rows.length !== 1 || row.database_name !== identity.databaseName || row.role_name !== identity.roleName
    || row.session_role !== identity.roleName || row.database_oid !== identity.databaseOid
    || row.database_owner !== identity.ownerOid || row.role_oid !== identity.roleOid || row.schema_oid !== identity.schemaOid
    || row.schema_owner !== identity.ownerOid || row.marker_owner !== identity.ownerOid || row.marker_kind !== "r" || row.marker_rls
    || row.nonce !== identity.nonce || row.stored_database_oid !== identity.databaseOid || row.stored_schema_oid !== identity.schemaOid
    || row.stored_role_oid !== identity.roleOid || row.stored_owner_oid !== identity.ownerOid)
    fail("replay_database_identity_mismatch");
  const [permissions] = await session`
    SELECT r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolinherit AND NOT r.rolcreatedb AND NOT r.rolcreaterole
      AND NOT r.rolreplication AND NOT r.rolbypassrls
      AND r.oid <> d.datdba AND r.oid <> n.nspowner AND r.oid <> c.relowner
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
      AND has_database_privilege(r.oid, d.oid, 'CONNECT')
      AND NOT has_database_privilege(r.oid, d.oid, 'CREATE') AND NOT has_database_privilege(r.oid, d.oid, 'TEMP')
      AND has_schema_privilege(r.oid, n.oid, 'USAGE') AND NOT has_schema_privilege(r.oid, n.oid, 'CREATE')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace other
        WHERE other.nspname !~ '^pg_' AND other.nspname <> 'information_schema' AND other.oid <> n.oid
        AND NOT (${handler} AND other.nspname = 'public')
        AND (has_schema_privilege(r.oid, other.oid, 'USAGE') OR has_schema_privilege(r.oid, other.oid, 'CREATE')))
      AND (NOT ${handler} OR EXISTS (SELECT 1 FROM pg_catalog.pg_namespace public_schema WHERE public_schema.nspname = 'public'
        AND has_schema_privilege(r.oid, public_schema.oid, 'USAGE') AND NOT has_schema_privilege(r.oid, public_schema.oid, 'CREATE')))
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class owned WHERE owned.relowner = r.oid)
      AND has_table_privilege(r.oid, c.oid, 'SELECT')
      AND NOT has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE,REFERENCES')
      AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc routine WHERE routine.pronamespace = n.oid
        AND routine.prosecdef AND has_function_privilege(r.oid, routine.oid, 'EXECUTE')) AS safe
    FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname = current_database()
      JOIN pg_catalog.pg_namespace n ON n.nspname = 'pipeline_replay'
      JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = 'identity'
    WHERE r.rolname = current_user`;
  if (permissions?.safe !== true) fail("replay_database_privileges_rejected");
  if (handler) await verifyHandlerProfile(session, identity);
}
/** Parent must invoke this on its transaction connection before any replay write. */
export async function verifyReplayDatabaseSession(session: postgres.Sql | postgres.TransactionSql, database: VerifiedReplayDatabase): Promise<void> {
  assertVerifiedReplayDatabase(database);
  await verifySession(session, verified.get(database)!, handlers.has(database));
}
export async function openVerifiedReplayDatabase(path: string, env: Environment = process.env): Promise<VerifiedReplayDatabase> {
  return openReplayDatabase(path, env, false);
}
export async function openVerifiedReplayHandlerDatabase(path: string, env: Environment = process.env): Promise<VerifiedReplayDatabase> {
  return openReplayDatabase(path, env, true);
}
async function openReplayDatabase(path: string, env: Environment, handler: boolean): Promise<VerifiedReplayDatabase> {
  const identity = await readReplayDatabaseIdentity(path);
  assertReplayDatabaseTarget(identity.databaseUrl, env);
  assertAmbientOverrides();
  const url = new URL(identity.databaseUrl);
  if (url.username !== identity.roleName || !url.password) fail("invalid_replay_identity");
  const { default: postgres } = await import("postgres");
  const client = postgres(connectionOptions(identity.databaseUrl, handler));
  try { await verifySession(client, identity, handler); }
  catch (error) { await client.end({ timeout: 3 }).catch(() => {}); throw error; }
  const database: VerifiedReplayDatabase = Object.freeze({ [verifiedBrand]: true as const, client, identity: metadata(identity),
    async close() { verified.delete(database); handlers.delete(database); await client.end({ timeout: 3 }); } });
  verified.set(database, identity);
  if (handler) handlers.add(database);
  return database;
}

/** Trusted owner upgrade in a dedicated local cluster. No grant policy is accepted from callers. */
type HandlerProfileOptions = {
  databaseUrl: string; identityPath: string; acknowledgeDedicatedCluster: boolean; env?: Environment;
};
export async function provisionReplayItemHandlerProfile(options: HandlerProfileOptions): Promise<ReplayDatabaseMetadata> {
  return provisionReplayProfile(options, "handlers-v6-item");
}
export async function provisionReplayHandlerProfile(options: HandlerProfileOptions): Promise<ReplayDatabaseMetadata> {
  return provisionReplayProfile(options, "handlers-v5");
}
async function provisionReplayProfile(options: {
  databaseUrl: string; identityPath: string; acknowledgeDedicatedCluster: boolean; env?: Environment;
}, version: "handlers-v5" | "handlers-v6-item"): Promise<ReplayDatabaseMetadata> {
  if (options.acknowledgeDedicatedCluster !== true) fail("dedicated_replay_cluster_required");
  assertReplayDatabaseTarget(options.databaseUrl, options.env ?? process.env); assertAmbientOverrides();
  const identity = await readReplayDatabaseIdentity(options.identityPath);
  assertReplayDatabaseTarget(identity.databaseUrl, options.env ?? process.env);
  const adminUrl = new URL(options.databaseUrl), runtimeUrl = new URL(identity.databaseUrl);
  if (adminUrl.host !== runtimeUrl.host || adminUrl.pathname !== runtimeUrl.pathname) fail("replay_database_identity_mismatch");
  const { default: postgres } = await import("postgres");
  const admin = postgres(connectionOptions(options.databaseUrl));
  try {
    await admin.begin(async tx => {
      await tx`SELECT pg_catalog.pg_advisory_xact_lock(1485803, 1)`;
      const [owner] = await tx`SELECT current_database() AS database_name, current_user AS role_name, session_user AS session_role,
        d.oid::int AS database_oid, d.datdba::int AS owner_oid, r.oid::int AS role_oid, r.rolsuper, r.rolcanlogin
        FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname = current_user WHERE d.datname = current_database()`;
      if (!owner || owner.database_name !== identity.databaseName || owner.role_name !== owner.session_role
        || owner.role_name !== decodeURIComponent(adminUrl.username) || owner.owner_oid !== owner.role_oid
        || owner.role_oid !== identity.ownerOid || !owner.rolsuper || !owner.rolcanlogin) fail("replay_database_admin_required");
      const [marker] = await tx`SELECT i.*, n.oid::int AS actual_schema_oid, n.nspowner::int AS schema_owner,
        c.relowner::int AS marker_owner, c.relkind AS marker_kind, c.relrowsecurity AS marker_rls,
        runtime.oid::int AS actual_role_oid FROM pipeline_replay.identity i
        JOIN pg_catalog.pg_namespace n ON n.nspname = 'pipeline_replay'
        JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = 'identity'
        JOIN pg_catalog.pg_roles runtime ON runtime.rolname = ${identity.roleName} FOR UPDATE OF i`;
      if (!marker || owner.database_oid !== identity.databaseOid || marker.database_oid !== identity.databaseOid
        || marker.schema_oid !== identity.schemaOid || marker.actual_schema_oid !== identity.schemaOid
        || marker.role_oid !== identity.roleOid || marker.actual_role_oid !== identity.roleOid
        || marker.owner_oid !== identity.ownerOid || marker.schema_owner !== identity.ownerOid || marker.marker_owner !== identity.ownerOid
        || marker.marker_kind !== "r" || marker.marker_rls || marker.nonce !== identity.nonce) fail("replay_database_identity_mismatch");
      await provisionHandlerProfile(tx, identity, version);
    });
    const checked = await openVerifiedReplayHandlerDatabase(options.identityPath, options.env ?? process.env);
    await checked.close(); return metadata(identity);
  } finally { await admin.end({ timeout: 3 }); }
}

export async function bootstrapReplayDatabase(options: {
  databaseUrl: string; identityPath: string; acknowledgeDedicatedCluster: boolean; env?: Environment;
}): Promise<ReplayDatabaseMetadata> {
  if (options.acknowledgeDedicatedCluster !== true) fail("dedicated_replay_cluster_required");
  assertReplayDatabaseTarget(options.databaseUrl, options.env ?? process.env);
  assertAmbientOverrides();
  let file;
  try { file = await open(options.identityPath, "wx", 0o600); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") fail("replay_identity_file_exists");
    return fail("replay_identity_file_required");
  }
  let admin: postgres.Sql | undefined, runtime: postgres.Sql | undefined, saved = false;
  try {
    const { default: postgres } = await import("postgres");
    admin = postgres(connectionOptions(options.databaseUrl));
    const [owner] = await admin`
      SELECT current_database() AS database_name, current_user AS role_name, session_user AS session_role,
        d.oid::int AS database_oid, d.datdba::int AS owner_oid, r.oid::int AS role_oid, r.rolsuper, r.rolcanlogin
      FROM pg_catalog.pg_database d JOIN pg_catalog.pg_roles r ON r.rolname = current_user
      WHERE d.datname = current_database()`;
    const adminUrl = new URL(options.databaseUrl);
    if (!owner || owner.database_name !== "nomorevibe_test" || owner.role_name !== owner.session_role
      || owner.role_name !== decodeURIComponent(adminUrl.username) || owner.owner_oid !== owner.role_oid
      || owner.rolsuper !== true || owner.rolcanlogin !== true) fail("replay_database_admin_required");
    const roleName = `nomorevibe_replay_${randomBytes(8).toString("hex")}`;
    const password = randomBytes(32).toString("hex"), nonce = randomBytes(32).toString("hex");
    const identity = await admin.begin(async tx => {
      await tx`SELECT pg_catalog.pg_advisory_xact_lock(1485803, 1)`;
      const [existing] = await tx`SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname = 'pipeline_replay')
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${roleName}) AS present`;
      if (existing.present) fail("replay_database_already_provisioned");
      // Both interpolated identifiers/literals below are cryptographically generated fixed-format hex, never caller input.
      await tx.unsafe(`CREATE ROLE "${roleName}" LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await tx`CREATE SCHEMA pipeline_replay`;
      await tx`REVOKE ALL ON SCHEMA pipeline_replay FROM PUBLIC`;
      await tx`CREATE TABLE pipeline_replay.identity (
        singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
        database_oid oid NOT NULL, schema_oid oid NOT NULL, role_oid oid NOT NULL, owner_oid oid NOT NULL,
        nonce text NOT NULL CHECK (nonce ~ '^[a-f0-9]{64}$'))`;
      await tx`REVOKE ALL ON TABLE pipeline_replay.identity FROM PUBLIC`;
      await tx`REVOKE ALL ON DATABASE nomorevibe_test FROM PUBLIC`;
      await tx`REVOKE ALL ON SCHEMA public FROM PUBLIC`;
      await tx.unsafe(`GRANT CONNECT ON DATABASE nomorevibe_test TO "${roleName}"`);
      await tx.unsafe(`GRANT USAGE ON SCHEMA pipeline_replay TO "${roleName}"`);
      await tx.unsafe(`GRANT SELECT ON TABLE pipeline_replay.identity TO "${roleName}"`);
      await tx.unsafe(`ALTER ROLE "${roleName}" IN DATABASE nomorevibe_test SET search_path = pg_catalog, pipeline_replay`);
      const [created] = await tx`SELECT n.oid::int AS schema_oid, r.oid::int AS role_oid
        FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.rolname = ${roleName} WHERE n.nspname = 'pipeline_replay'`;
      await tx`INSERT INTO pipeline_replay.identity (database_oid, schema_oid, role_oid, owner_oid, nonce)
        VALUES (${owner.database_oid}, ${created.schema_oid}, ${created.role_oid}, ${owner.owner_oid}, ${nonce})`;
      const runtimeUrl = new URL(options.databaseUrl); runtimeUrl.username = roleName; runtimeUrl.password = password;
      return Object.freeze(identitySchema.parse({ version: 1, databaseUrl: runtimeUrl.toString(), databaseName: "nomorevibe_test",
        databaseOid: owner.database_oid, schemaName: "pipeline_replay", schemaOid: created.schema_oid,
        roleName, roleOid: created.role_oid, ownerOid: owner.owner_oid, nonce }));
    });
    runtime = postgres(connectionOptions(identity.databaseUrl));
    await verifySession(runtime, identity);
    await file.writeFile(`${JSON.stringify(identity)}\n`); await file.sync(); saved = true;
    return metadata(identity);
  } finally {
    await Promise.allSettled([runtime?.end({ timeout: 3 }), admin?.end({ timeout: 3 })]);
    await file.close();
    if (!saved) await unlink(options.identityPath).catch(() => {});
  }
}
