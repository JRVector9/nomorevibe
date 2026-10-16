import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type postgres from "postgres";
import type { ReplayDatabaseIdentity } from "./pipeline-replay-database";

type Session = postgres.Sql | postgres.TransactionSql;
type Policy = Readonly<{ schema?: "pipeline_replay"; name: string; select: true | readonly string[];
  insert?: true | readonly string[]; update?: readonly string[]; immutable?: true }>;
// This is code policy, never a caller-provided grant list. Existing Drizzle writers
// render omitted columns as DEFAULT and require table INSERT; raw ledger writes use columns.
const tables: readonly Policy[] = [
  { name: "crawl_settings", select: true, update: ["id"], immutable: true },
  { name: "crawl_documents", select: true, update: ["id"], immutable: true },
  { name: "agent_repository_scans", select: true, update: ["id"], immutable: true },
  { name: "agent_repository_observations", select: true, update: ["id"], immutable: true },
  { name: "pipeline_stage_modes", select: true, update: ["stage"], immutable: true },
  { name: "pipeline_item_leases", select: true, update: ["work_key"], immutable: true },
  { name: "products", select: true, update: ["id"], immutable: true },
  { name: "crawl_candidates", select: true, update: ["state", "reason", "decided_by", "signals", "updated_at"] },
  { name: "crawl_review_attempts", select: true, insert: true,
    update: ["state", "error_code", "completed_at", "retry_after", "outcome", "input_tokens", "output_tokens", "cost_usd"] },
  { name: "second_reviews", select: true, insert: true,
    update: ["status", "resolution", "resolved_at", "second_decision", "second_confidence", "second_reason", "failure_count", "reviewed_at", "error_code", "error_detail"] },
  { name: "crawl_frontier", select: true, insert: true,
    update: ["state", "attempts", "next_attempt_at", "last_error", "updated_at"] },
  { name: "jobs", select: true, insert: true,
    update: ["locked_at", "last_run_at", "updated_at", "lease_token", "runs", "requested_version", "worker_seen_at", "cursor", "processed_version", "not_before", "last_success_at", "last_error"] },
  { name: "operations_observations", select: true, insert: true, update: ["value", "observed_at"] },
  { schema: "pipeline_replay", name: "capacity_runs", select: true,
    insert: ["run_id", "owner_id", "manifest", "manifest_hash", "state", "initial_projection", "current_projection",
      "initial_state_hash", "comparison_state_hash", "captured_at", "runner", "quality"],
    update: ["state", "started_at", "deadline_at", "charged_calls", "charged_tokens", "event_seq",
      "admission_closed_at", "writers_fenced_at", "sealed_at", "current_projection", "seal"] },
  { schema: "pipeline_replay", name: "capacity_changes", select: true,
    insert: ["run_id", "tx_key", "ordinal", "table_name", "operation", "old_row", "new_row"] },
  { schema: "pipeline_replay", name: "capacity_transactions", select: true,
    insert: ["run_id", "tx_key", "db_xid", "seq", "tx_started_at", "recorded_at", "changes"] },
  { schema: "pipeline_replay", name: "capacity_commit_confirmations", select: true, insert: ["run_id", "tx_key"] },
  { schema: "pipeline_replay", name: "capacity_inputs", select: true,
    insert: ["run_id", "candidate_id", "input_hash", "source_revision_hash", "frozen_input", "frozen_hash"] },
  { schema: "pipeline_replay", name: "capacity_calls", select: true,
    insert: ["run_id", "call_id", "candidate_id", "first_attempt_id", "input_hash", "source_revision_hash", "stage",
      "second_review_id", "generation_key", "vote", "provider", "model", "request_hash", "token_upper_bound", "state"],
    update: ["state", "dispatched_at", "settled_at", "input_tokens", "output_tokens", "result_ok", "result_hash", "result_decision_hash", "failure_class"] },
  { schema: "pipeline_replay", name: "capacity_finals", select: true,
    insert: ["run_id", "candidate_id", "input_hash", "source_revision_hash", "policy_hash", "seq",
      "first_attempt_id", "first_call_id", "decision", "second_witnesses"] },
  { schema: "pipeline_replay", name: "capacity_transitions", select: true, insert: ["run_id", "seq", "kind", "payload"] },
];
const sequences = ["crawl_review_attempts_id_seq", "second_reviews_id_seq", "crawl_frontier_id_seq"] as const;
const journalTables = ["public.crawl_candidates", "public.crawl_review_attempts", "public.second_reviews", "public.crawl_frontier",
  "public.jobs", "public.operations_observations", "pipeline_replay.capacity_calls"] as const;
const profileVersion = "handlers-v5";
export type ReplayHandlerProfileVersion = "handlers-v5" | "handlers-v6-item";
function policy(version: ReplayHandlerProfileVersion) {
  const selected = version === "handlers-v5" ? tables : tables.map(table => table.name === "pipeline_item_leases"
    ? { name: table.name, select: true as const, insert: true as const,
      update: ["binding", "binding_hash", "owner_instance_id", "owner_boot_id", "token", "stage_epoch", "item_epoch", "lease_until", "updated_at"] } : table);
  const journal = version === "handlers-v5" ? [...journalTables] : [...journalTables, "public.pipeline_stage_modes", "public.pipeline_item_leases"];
  return { tables: selected, journal, hash: createHash("sha256").update(JSON.stringify({ version,
    tables: selected, sequences, journalTables: journal })).digest("hex") };
}
const itemGuard = "BEGIN IF NEW.stage <> 'ai2' THEN RAISE EXCEPTION 'replay_handler_item_stage_rejected' USING ERRCODE = '42501'; END IF; RETURN NEW; END";
const sourceGuard = "BEGIN RAISE EXCEPTION 'replay_handler_source_immutable' USING ERRCODE = '42501'; END";
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
export class ReplayHandlerProfileError extends Error {
  constructor(readonly code: "replay_database_identity_mismatch" | "replay_database_privileges_rejected" | "replay_handler_profile_already_provisioned") { super(code); }
}
const reject = (code: ConstructorParameters<typeof ReplayHandlerProfileError>[0]): never => { throw new ReplayHandlerProfileError(code); };

type Column = { name: string; select: boolean; insert: boolean; update: boolean; references: boolean };
type ObjectRow = { schema_name: string; name: string; oid: number; owner: number; kind: string; rls: boolean; force_rls: boolean;
  select: boolean; insert: boolean; update: boolean; delete: boolean; truncate: boolean; references: boolean; trigger: boolean; maintain: boolean;
  usage: boolean; unsafe_acl: boolean; columns: Column[]; binding: postgres.JSONValue };
async function objects(session: Session, identity: ReplayDatabaseIdentity): Promise<ObjectRow[]> {
  return session<ObjectRow[]>`
    SELECT n.nspname AS schema_name, c.relname AS name, c.oid::int AS oid, c.relowner::int AS owner,
      c.relkind AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
      CASE WHEN c.relkind <> 'S' THEN has_table_privilege(${identity.roleOid}::oid, c.oid, 'SELECT') ELSE has_sequence_privilege(${identity.roleOid}::oid, c.oid, 'SELECT') END AS select,
      CASE WHEN c.relkind <> 'S' THEN has_table_privilege(${identity.roleOid}::oid, c.oid, 'INSERT') ELSE false END AS insert,
      CASE WHEN c.relkind <> 'S' THEN has_table_privilege(${identity.roleOid}::oid, c.oid, 'UPDATE') ELSE has_sequence_privilege(${identity.roleOid}::oid, c.oid, 'UPDATE') END AS update,
      CASE WHEN c.relkind <> 'S' THEN has_table_privilege(${identity.roleOid}::oid, c.oid, 'DELETE') ELSE false END AS delete,
      CASE WHEN c.relkind <> 'S' THEN has_table_privilege(${identity.roleOid}::oid, c.oid, 'TRUNCATE') ELSE false END AS truncate,
      CASE WHEN c.relkind <> 'S' THEN has_table_privilege(${identity.roleOid}::oid, c.oid, 'REFERENCES') ELSE false END AS references,
      CASE WHEN c.relkind <> 'S' THEN has_table_privilege(${identity.roleOid}::oid, c.oid, 'TRIGGER') ELSE false END AS trigger,
      CASE WHEN c.relkind <> 'S' THEN has_table_privilege(${identity.roleOid}::oid, c.oid, 'MAINTAIN') ELSE false END AS maintain,
      CASE WHEN c.relkind = 'S' THEN has_sequence_privilege(${identity.roleOid}::oid, c.oid, 'USAGE') ELSE false END AS usage,
      EXISTS (SELECT 1 FROM pg_catalog.aclexplode(c.relacl) a WHERE a.grantee = 0 OR (a.grantee = ${identity.roleOid}::oid AND a.is_grantable))
        OR EXISTS (SELECT 1 FROM pg_catalog.pg_attribute ca CROSS JOIN LATERAL pg_catalog.aclexplode(ca.attacl) a
          WHERE ca.attrelid = c.oid AND (a.grantee = 0 OR (a.grantee = ${identity.roleOid}::oid AND a.is_grantable))) AS unsafe_acl,
      CASE WHEN c.relkind <> 'S' THEN coalesce((SELECT jsonb_agg(jsonb_build_object('name', a.attname,
        'select', has_column_privilege(${identity.roleOid}::oid, c.oid, a.attnum, 'SELECT'),
        'insert', has_column_privilege(${identity.roleOid}::oid, c.oid, a.attnum, 'INSERT'),
        'update', has_column_privilege(${identity.roleOid}::oid, c.oid, a.attnum, 'UPDATE'),
        'references', has_column_privilege(${identity.roleOid}::oid, c.oid, a.attnum, 'REFERENCES')) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::jsonb) ELSE '[]'::jsonb END AS columns,
      CASE WHEN (n.nspname = 'public' AND c.relname IN (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify([
        ...tables.filter(table => !table.schema).map(table => table.name), ...sequences])}::text::jsonb)))
        OR (n.nspname = 'pipeline_replay' AND c.relname IN (SELECT pg_catalog.jsonb_array_elements_text(${JSON.stringify([
          ...tables.filter(table => table.schema === 'pipeline_replay').map(table => table.name), 'identity', 'handler_profile'])}::text::jsonb)))
      THEN jsonb_build_object('oid', c.oid::int, 'owner', c.relowner::int, 'kind', c.relkind, 'acl', c.relacl::text,
        'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity,
        'columns', coalesce((SELECT jsonb_agg(jsonb_build_object('number', a.attnum, 'name', a.attname,
          'type', a.atttypid::int, 'typeMod', a.atttypmod, 'acl', a.attacl::text, 'notNull', a.attnotnull,
          'default', pg_catalog.pg_get_expr(ad.adbin, ad.adrelid)) ORDER BY a.attnum)
          FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped), '[]'::jsonb),
        'triggers', coalesce((SELECT jsonb_agg(jsonb_build_object('oid', t.oid::int, 'enabled', t.tgenabled,
          'definition', pg_catalog.pg_get_triggerdef(t.oid), 'functionOid', p.oid::int, 'functionOwner', p.proowner::int,
          'functionAcl', p.proacl::text, 'functionDefinition', pg_catalog.pg_get_functiondef(p.oid)) ORDER BY t.oid)
          FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgrelid = c.oid AND NOT t.tgisinternal), '[]'::jsonb)) ELSE NULL END AS binding
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f','S')
    ORDER BY n.nspname, c.relname`;
}
function assertObjectPolicy(rows: ObjectRow[], identity: ReplayDatabaseIdentity, version: ReplayHandlerProfileVersion): ObjectRow[] {
  const expected = new Map<string, Policy>(policy(version).tables.map(table => [`${table.schema ?? "public"}.${table.name}`, table]));
  expected.set("pipeline_replay.identity", { name: "identity", select: true });
  expected.set("pipeline_replay.handler_profile", { name: "handler_profile", select: true });
  const allowed: ObjectRow[] = [];
  for (const row of rows) {
    const key = `${row.schema_name}.${row.name}`, table = expected.get(key), sequence = row.schema_name === "public" && sequences.some(name => name === row.name);
    if (row.owner === identity.roleOid || row.unsafe_acl) reject("replay_database_privileges_rejected");
    if (!table && !sequence) {
      if ([row.select, row.insert, row.update, row.delete, row.truncate, row.references, row.trigger, row.maintain, row.usage].some(Boolean)
        || row.columns.some(column => column.select || column.insert || column.update || column.references)) reject("replay_database_privileges_rejected");
      continue;
    }
    if (row.owner !== identity.ownerOid || row.rls || row.force_rls || row.delete || row.truncate || row.references || row.trigger || row.maintain)
      reject("replay_database_privileges_rejected");
    if (sequence) {
      if (row.kind !== "S" || !row.usage || row.select || row.update) reject("replay_database_privileges_rejected");
    } else {
      if (row.kind !== "r" || row.select !== (table!.select === true) || row.insert !== (table!.insert === true) || row.update || row.usage)
        reject("replay_database_privileges_rejected");
      if (table!.update?.some(name => !row.columns.some(column => column.name === name))
        || Array.isArray(table!.insert) && table!.insert.some(name => !row.columns.some(column => column.name === name))
        || table!.select !== true && table!.select.some(name => !row.columns.some(column => column.name === name))) reject("replay_database_privileges_rejected");
      for (const column of row.columns) {
        if (column.select !== (table!.select === true || table!.select.includes(column.name))
          || column.insert !== (table!.insert === true || Boolean(table!.insert && table!.insert.includes(column.name)))
          || column.update !== Boolean(table!.update?.includes(column.name)) || column.references) reject("replay_database_privileges_rejected");
      }
      expected.delete(key);
    }
    allowed.push(row);
  }
  if (expected.size || allowed.filter(row => row.kind === "S").length !== sequences.length) reject("replay_database_privileges_rejected");
  return allowed;
}
async function binding(session: Session, identity: ReplayDatabaseIdentity, version: ReplayHandlerProfileVersion): Promise<postgres.JSONValue> {
  const rows = assertObjectPolicy((await objects(session, identity)).map(row => ({ ...row,
    columns: json(row.columns) as Column[], binding: json(row.binding) })), identity, version);
  const schemas = await session`
    SELECT n.oid::int AS oid, n.nspname AS name, n.nspowner::int AS owner, n.nspacl::text AS acl
    FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public', 'pipeline_replay') ORDER BY n.nspname`;
  const [database] = await session`SELECT d.oid::int AS oid, d.datdba::int AS owner, d.datacl::text AS acl
    FROM pg_catalog.pg_database d WHERE d.datname = current_database()`;
  const [safe] = await session`
    SELECT current_schemas(false) = ARRAY['pg_catalog', 'pipeline_replay', 'public']::name[] AS path,
      EXISTS (SELECT 1 FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname = current_database()
        WHERE r.oid = ${identity.roleOid}::oid AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolinherit AND NOT r.rolcreatedb
        AND NOT r.rolcreaterole AND NOT r.rolreplication AND NOT r.rolbypassrls
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid)
        AND has_database_privilege(r.oid, d.oid, 'CONNECT') AND NOT has_database_privilege(r.oid, d.oid, 'CREATE,TEMP')
        AND NOT EXISTS (SELECT 1 FROM pg_catalog.aclexplode(d.datacl) a
          WHERE a.grantee IN (0, r.oid) AND a.is_grantable)) AS role,
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
        WHERE n.nspname IN ('public', 'pipeline_replay') AND a.grantee IN (0, ${identity.roleOid}::oid) AND a.is_grantable) AS schema_grants,
      (SELECT count(*) = 2 FROM pg_catalog.pg_namespace n WHERE n.nspname IN ('public', 'pipeline_replay')
        AND has_schema_privilege(${identity.roleOid}::oid, n.oid, 'USAGE')
        AND NOT has_schema_privilege(${identity.roleOid}::oid, n.oid, 'CREATE')) AS schema_permissions,
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
        AND n.nspname NOT IN ('public', 'pipeline_replay')
        AND (has_schema_privilege(${identity.roleOid}::oid, n.oid, 'USAGE') OR has_schema_privilege(${identity.roleOid}::oid, n.oid, 'CREATE'))) AS schemas,
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND p.prosecdef
        AND has_function_privilege(${identity.roleOid}::oid, p.oid, 'EXECUTE')) AS functions,
      NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
        WHERE n.nspname IN ('public', 'pipeline_replay') AND p.prosecdef) AS triggers`;
  if (!safe?.path || !safe.role || !safe.schema_grants || !safe.schema_permissions || !safe.schemas || !safe.functions || !safe.triggers || schemas.length !== 2
    || database.oid !== identity.databaseOid || database.owner !== identity.ownerOid) reject("replay_database_privileges_rejected");
  const publicTables = rows.filter(row => row.schema_name === "public" && row.kind !== "S");
  const resolved = await session<{ name: string; oid: number | null }[]>`
    SELECT name, pg_catalog.to_regclass(name)::oid::int AS oid
    FROM pg_catalog.jsonb_array_elements_text(${JSON.stringify(tables.filter(table => !table.schema).map(table => table.name))}::text::jsonb) AS names(name)`;
  const resolvedOids = new Map(resolved.map(row => [row.name, row.oid]));
  if (resolved.length !== publicTables.length || resolvedOids.size !== publicTables.length
    || publicTables.some(row => resolvedOids.get(row.name) !== row.oid)) reject("replay_database_privileges_rejected");
  return { database: JSON.parse(JSON.stringify(database)), schemas: JSON.parse(JSON.stringify(schemas)),
    objects: rows.map(row => ({ name: `${row.schema_name}.${row.name}`, binding: row.binding })) };
}
function json(value: unknown): postgres.JSONValue {
  if (typeof value !== "string") return value as postgres.JSONValue;
  try { return JSON.parse(value); } catch { return reject("replay_database_privileges_rejected"); }
}

export async function provisionHandlerProfile(tx: postgres.TransactionSql, identity: ReplayDatabaseIdentity, version: ReplayHandlerProfileVersion = profileVersion): Promise<void> {
  const selected = policy(version);
  const [existing] = await tx`SELECT pg_catalog.to_regclass('pipeline_replay.handler_profile') IS NOT NULL AS present`;
  if (existing.present) reject("replay_handler_profile_already_provisioned");
  await tx`CREATE TABLE pipeline_replay.handler_profile (singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version text NOT NULL, nonce text NOT NULL, database_oid oid NOT NULL, schema_oid oid NOT NULL,
    role_oid oid NOT NULL, owner_oid oid NOT NULL, policy_hash text NOT NULL, manifest jsonb NOT NULL)`;
  await tx`REVOKE ALL ON pipeline_replay.handler_profile FROM PUBLIC`;
  await tx.unsafe(`GRANT SELECT ON pipeline_replay.handler_profile TO ${ident(identity.roleName)}`);
  await tx.unsafe(`GRANT USAGE ON SCHEMA public TO ${ident(identity.roleName)}`);
  await tx.unsafe(`CREATE FUNCTION pipeline_replay.reject_handler_source_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS '${sourceGuard.replace(/'/g, "''")}'`);
  await tx`REVOKE ALL ON FUNCTION pipeline_replay.reject_handler_source_mutation() FROM PUBLIC`;
  for (const table of selected.tables) {
    const relation = `${table.schema ?? "public"}.${ident(table.name)}`, target = ident(identity.roleName);
    const grants = [];
    if (table.select === true) grants.push("SELECT");
    else if (table.select.length) grants.push(`SELECT (${table.select.map(ident).join(",")})`);
    if (table.insert === true) grants.push("INSERT");
    else if (table.insert?.length) grants.push(`INSERT (${table.insert.map(ident).join(",")})`);
    if (grants.length) await tx.unsafe(`GRANT ${grants.join(",")} ON ${relation} TO ${target}`);
    if (table.update) await tx.unsafe(`GRANT UPDATE (${table.update.map(ident).join(",")}) ON ${relation} TO ${target}`);
    if (table.immutable) {
      await tx.unsafe(`CREATE TRIGGER replay_handler_source_immutable BEFORE UPDATE ON ${relation} FOR EACH STATEMENT EXECUTE FUNCTION pipeline_replay.reject_handler_source_mutation()`);
      await tx.unsafe(`ALTER TABLE ${relation} ENABLE ALWAYS TRIGGER replay_handler_source_immutable`);
    }
  }
  if (version === "handlers-v6-item") {
    await tx.unsafe(`CREATE FUNCTION pipeline_replay.guard_handler_item_mutation() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS '${itemGuard.replace(/'/g, "''")}'`);
    await tx`REVOKE ALL ON FUNCTION pipeline_replay.guard_handler_item_mutation() FROM PUBLIC`;
    await tx`CREATE TRIGGER replay_handler_item_stage BEFORE INSERT OR UPDATE ON public.pipeline_item_leases
      FOR EACH ROW EXECUTE FUNCTION pipeline_replay.guard_handler_item_mutation()`;
    await tx`ALTER TABLE public.pipeline_item_leases ENABLE ALWAYS TRIGGER replay_handler_item_stage`;
  }
  for (const name of sequences) await tx.unsafe(`GRANT USAGE ON SEQUENCE public.${ident(name)} TO ${ident(identity.roleName)}`);
  for (const relation of selected.journal) {
    await tx.unsafe(`CREATE TRIGGER replay_handler_change AFTER INSERT OR UPDATE OR DELETE ON ${relation}
      FOR EACH ROW EXECUTE FUNCTION pipeline_replay.capture_handler_change()`);
    await tx.unsafe(`ALTER TABLE ${relation} ENABLE ALWAYS TRIGGER replay_handler_change`);
  }
  // Manifest is built by the owner but validates the runtime role's effective rights.
  // SET LOCAL only pins resolution while building the same snapshot used at runtime.
  await tx`SET LOCAL search_path = pg_catalog,pipeline_replay,public`;
  const manifest = await binding(tx, identity, version);
  await tx`INSERT INTO pipeline_replay.handler_profile (version, nonce, database_oid, schema_oid, role_oid, owner_oid, policy_hash, manifest)
    VALUES (${version}, ${identity.nonce}, ${identity.databaseOid}, ${identity.schemaOid}, ${identity.roleOid}, ${identity.ownerOid}, ${selected.hash}, ${tx.json(manifest)})`;
}
export async function verifyHandlerProfile(session: Session, identity: ReplayDatabaseIdentity): Promise<void> {
  let rows;
  try {
    rows = await session`SELECT p.*, c.oid::int AS marker_oid, c.relowner::int AS marker_owner, c.relkind AS marker_kind,
      c.relrowsecurity AS marker_rls FROM pipeline_replay.handler_profile p
      JOIN pg_catalog.pg_class c ON c.oid = 'pipeline_replay.handler_profile'::regclass`;
  } catch { return reject("replay_database_identity_mismatch"); }
  const row = rows[0];
  if (rows.length !== 1 || !["handlers-v5", "handlers-v6-item"].includes(row.version) || row.nonce !== identity.nonce || row.database_oid !== identity.databaseOid
    || row.schema_oid !== identity.schemaOid || row.role_oid !== identity.roleOid || row.owner_oid !== identity.ownerOid
    || row.marker_owner !== identity.ownerOid || row.marker_kind !== "r" || row.marker_rls) reject("replay_database_identity_mismatch");
  if (row.policy_hash !== policy(row.version).hash || !isDeepStrictEqual(await binding(session, identity, row.version), json(row.manifest)))
    reject("replay_database_privileges_rejected");
}
