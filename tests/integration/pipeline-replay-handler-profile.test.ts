import { afterAll, beforeAll, expect, it } from "vitest";
import postgres from "postgres";
import { readFile, writeFile } from "node:fs/promises";
import * as replay from "@/lib/operations/pipeline-replay-database";
import { ensureSchema, TEST_DATABASE_URL } from "./setup";
import { getReplayIdentityPath } from "./replay-setup";
import { removeReplayHandlerTestProfile } from "./replay-handler-setup";
import { withReplayDatabaseScope } from "@/lib/db/replay-scope";
import { db } from "@/lib/db";
import { claimItemLease, lockItemStage, readItemStage, releaseItemLease, renewItemLease } from "@/lib/jobs/items/repository";
import { itemBindingHash, type Ai1ItemBinding, type ItemLease } from "@/lib/jobs/items/types";

type HandlerApi = typeof replay & {
  provisionReplayHandlerProfile(options: { databaseUrl: string; identityPath: string; acknowledgeDedicatedCluster: boolean; env?: Record<string, string> }): Promise<unknown>;
  openVerifiedReplayHandlerDatabase(path: string, env?: Record<string, string>): Promise<replay.VerifiedReplayDatabase>;
  assertVerifiedReplayHandlerDatabase(value: unknown): void;
};
const api = replay as HandlerApi;
let admin: postgres.Sql, database: replay.VerifiedReplayDatabase, baseline: replay.VerifiedReplayDatabase;
let identityPath: string, role: string, release: () => Promise<void>, installed = false;
let originalStage: { mode: string; draining_from: string | null; epoch: string; writer_contract_version: number };
const binding: Ai1ItemBinding = { stage: "ai1", candidateId: 90901, inputHash: "a".repeat(64),
  sourceRevisionHash: "b".repeat(64), policyHash: "c".repeat(64), promptVersion: "profile-test", rulesVersion: "profile-test",
  reviewer: { provider: "abcllm", model: "profile-test" } };
const owner = { instanceId: "profile-item-owner", bootId: "00000000-0000-4000-8000-000000090901" };
let itemLease: ItemLease;
const quoted = () => `"${role}"`;
const provision = () => api.provisionReplayHandlerProfile({ databaseUrl: TEST_DATABASE_URL, identityPath,
  acknowledgeDedicatedCluster: true, env: {} });
beforeAll(async () => {
  ensureSchema();
  ({ identityPath, release } = await getReplayIdentityPath());
  baseline = await replay.openVerifiedReplayDatabase(identityPath, {}); role = baseline.identity.roleName;
  admin = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe(await readFile("scripts/sql/pipeline-replay-ledger.sql", "utf8"));
  [originalStage] = await admin<typeof originalStage[]>`SELECT mode, draining_from, epoch::text, writer_contract_version
    FROM public.pipeline_stage_modes WHERE stage = 'ai1'`;
  await admin`UPDATE public.pipeline_stage_modes SET mode = 'items', draining_from = NULL, writer_contract_version = 1 WHERE stage = 'ai1'`;
  const [item] = await admin`INSERT INTO public.pipeline_item_leases
    (stage, work_key, binding, binding_hash, owner_instance_id, owner_boot_id, token, stage_epoch, item_epoch, lease_until)
    VALUES ('ai1', 'ai1:90901', ${admin.json(binding)}, ${itemBindingHash(binding)}, ${owner.instanceId}, ${owner.bootId},
      '00000000-0000-4000-8000-000000090902', ${originalStage.epoch}, 1, clock_timestamp() + interval '1 hour')
    RETURNING stage_epoch, item_epoch, lease_until`;
  itemLease = { stage: "ai1", workKey: "ai1:90901", binding, bindingHash: itemBindingHash(binding), owner,
    token: "00000000-0000-4000-8000-000000090902", stageEpoch: Number(item.stage_epoch), itemEpoch: Number(item.item_epoch),
    leaseUntil: item.lease_until };
  expect(api.provisionReplayHandlerProfile).toBeTypeOf("function");
  expect(api.openVerifiedReplayHandlerDatabase).toBeTypeOf("function");
  expect(api.assertVerifiedReplayHandlerDatabase).toBeTypeOf("function");
  await admin`GRANT SELECT ON public.products TO PUBLIC`;
  try { await expect(provision()).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin`REVOKE SELECT ON public.products FROM PUBLIC`; }
  await admin.unsafe(`GRANT CREATE ON SCHEMA public TO ${quoted()}`);
  try {
    await expect(provision()).rejects.toThrow("replay_database_privileges_rejected");
    const [marker] = await admin`SELECT to_regclass('pipeline_replay.handler_profile') IS NOT NULL AS present`;
    expect(marker.present).toBe(false);
  } finally { await admin.unsafe(`REVOKE CREATE ON SCHEMA public FROM ${quoted()}`); }
  await provision(); installed = true;
  database = await api.openVerifiedReplayHandlerDatabase(identityPath, {});
});
afterAll(async () => {
  await database?.close(); await baseline?.close();
  try {
    if (installed) await removeReplayHandlerTestProfile(identityPath);
    if (originalStage) {
      await admin`DELETE FROM public.pipeline_item_leases WHERE stage = 'ai1' AND work_key IN ('ai1:90901', 'ai1:90902')`;
      await admin`UPDATE public.pipeline_stage_modes SET mode = ${originalStage.mode}, draining_from = ${originalStage.draining_from},
        epoch = ${originalStage.epoch}, writer_contract_version = ${originalStage.writer_contract_version} WHERE stage = 'ai1'`;
    }
    await release?.();
  } finally { await admin?.end({ timeout: 3 }); }
});

it("permits restricted-role stage row locks and authentic transaction guards", async () => {
  await database.client.begin(async tx => {
    await replay.verifyReplayDatabaseSession(tx, database);
    expect(await tx`SELECT stage FROM public.pipeline_stage_modes ORDER BY stage FOR SHARE`).toHaveLength(3);
    expect(await tx`SELECT stage FROM public.pipeline_stage_modes WHERE stage = 'ai1' FOR UPDATE`).toHaveLength(1);
  });
  await withReplayDatabaseScope(identityPath, () => db.transaction(async tx => {
    const guard = await lockItemStage(tx, "ai1");
    expect((await readItemStage(tx, guard)).stage).toBe("ai1");
  }));
});

it("permits restricted-role live-item SHARE and UPDATE locks", async () => {
  await database.client.begin(async tx => {
    await replay.verifyReplayDatabaseSession(tx, database);
    expect(await tx`SELECT work_key FROM public.pipeline_item_leases WHERE stage = 'ai1' AND work_key = 'ai1:90901' FOR SHARE`).toHaveLength(1);
    expect(await tx`SELECT work_key FROM public.pipeline_item_leases WHERE stage = 'ai1' AND work_key = 'ai1:90901' FOR UPDATE`).toHaveLength(1);
  });
});

it("keeps stage and item rows immutable despite row-lock UPDATE column grants", async () => {
  for (const statement of ["UPDATE public.pipeline_stage_modes SET stage = stage WHERE stage = 'ai1'",
    "UPDATE public.pipeline_item_leases SET work_key = work_key WHERE stage = 'ai1' AND work_key = 'ai1:90901'"])
    await expect(database.client.unsafe(statement)).rejects.toThrow("replay_handler_source_immutable");
  for (const statement of ["UPDATE public.pipeline_stage_modes SET mode = 'legacy' WHERE stage = 'ai1'",
    "UPDATE public.pipeline_stage_modes SET epoch = epoch + 1 WHERE stage = 'ai1'",
    "UPDATE public.pipeline_stage_modes SET writer_contract_version = 2 WHERE stage = 'ai1'",
    "INSERT INTO public.pipeline_stage_modes (stage) VALUES ('ai1')",
    "DELETE FROM public.pipeline_stage_modes WHERE stage = 'ai1'",
    "INSERT INTO public.pipeline_item_leases (stage,work_key,binding,binding_hash) VALUES ('ai1','ai1:90902','{}','')",
    "UPDATE public.pipeline_item_leases SET lease_until = clock_timestamp() WHERE stage = 'ai1'",
    "DELETE FROM public.pipeline_item_leases WHERE stage = 'ai1'"])
    await expect(database.client.unsafe(statement)).rejects.toThrow("permission denied");
  const [before] = await admin`SELECT to_jsonb(i) AS row FROM public.pipeline_item_leases i WHERE stage = 'ai1' AND work_key = 'ai1:90901'`;
  for (const operation of [
    (tx: Parameters<typeof lockItemStage>[0], guard: Awaited<ReturnType<typeof lockItemStage>>) =>
      claimItemLease(tx, guard, { ...binding, candidateId: 90902 }, owner, 60_000),
    (tx: Parameters<typeof lockItemStage>[0], guard: Awaited<ReturnType<typeof lockItemStage>>) => renewItemLease(tx, guard, itemLease, 60_000),
    (tx: Parameters<typeof lockItemStage>[0], guard: Awaited<ReturnType<typeof lockItemStage>>) => releaseItemLease(tx, guard, itemLease),
  ]) await expect(withReplayDatabaseScope(identityPath, () => db.transaction(async tx => {
    const guard = await lockItemStage(tx, "ai1");
    return operation(tx, guard);
  }))).rejects.toMatchObject({ cause: { code: "42501" } });
  const [after] = await admin`SELECT to_jsonb(i) AS row FROM public.pipeline_item_leases i WHERE stage = 'ai1' AND work_key = 'ai1:90901'`;
  expect(after.row).toEqual(before.row);
  const [absent] = await admin`SELECT count(*)::int AS count FROM public.pipeline_item_leases WHERE stage = 'ai1' AND work_key = 'ai1:90902'`;
  expect(absent.count).toBe(0);
});

it("keeps handler capability explicit, authentic, immutable and separate from baseline admission", async () => {
  expect(() => api.assertVerifiedReplayHandlerDatabase(database)).not.toThrow();
  for (const forged of [baseline, { ...database }, null, {}])
    expect(() => api.assertVerifiedReplayHandlerDatabase(forged)).toThrow("verified_replay_handler_database_required");
  expect(Object.isFrozen(database)).toBe(true);
  expect(JSON.stringify(database.identity)).not.toMatch(/nonce|postgres:/);
  await expect(replay.openVerifiedReplayDatabase(identityPath, {})).rejects.toThrow("replay_database_privileges_rejected");
  await expect(replay.verifyReplayDatabaseSession(baseline.client, baseline)).rejects.toThrow("replay_database_privileges_rejected");
  await database.client.begin(async tx => {
    await replay.verifyReplayDatabaseSession(tx, database);
    const [row] = await tx`SELECT pg_backend_pid() AS pid, current_user AS role`;
    await replay.verifyReplayDatabaseSession(tx, database);
    const [after] = await tx`SELECT pg_backend_pid() AS pid`;
    expect(after.pid).toBe(row.pid); expect(row.role).toBe(role);
  });
});
it("authenticates two separate handler connections against the same private identity", async () => {
  expect(api.assertSameReplayHandlerDatabase).toBeTypeOf("function");
  const other = await api.openVerifiedReplayHandlerDatabase(identityPath, {});
  try {
    expect(() => api.assertSameReplayHandlerDatabase(database, other)).not.toThrow();
    for (const forged of [baseline, { ...database }])
      expect(() => api.assertSameReplayHandlerDatabase(database, forged)).toThrow("verified_replay_handler_database_required");
    expect(other.client).not.toBe(database.client);
  } finally { await other.close(); }
  expect(() => api.assertSameReplayHandlerDatabase(database, other)).toThrow("verified_replay_handler_database_required");
});
it("rejects a private nonce or connection target swap even when public metadata is identical", async () => {
  const original = await readFile(identityPath, "utf8"), identity = JSON.parse(original);
  let other: replay.VerifiedReplayDatabase | undefined;
  try {
    const replacement = { ...identity, nonce: "d".repeat(64) };
    await admin`UPDATE pipeline_replay.identity SET nonce = ${replacement.nonce}`;
    await admin`UPDATE pipeline_replay.handler_profile SET nonce = ${replacement.nonce}`;
    await writeFile(identityPath, JSON.stringify(replacement));
    other = await api.openVerifiedReplayHandlerDatabase(identityPath, {});
    expect(other.identity).toEqual(database.identity);
    expect(() => api.assertSameReplayHandlerDatabase(database, other!)).toThrow("replay_database_identity_mismatch");
    await other.close(); other = undefined;
    await admin`UPDATE pipeline_replay.identity SET nonce = ${identity.nonce}`;
    await admin`UPDATE pipeline_replay.handler_profile SET nonce = ${identity.nonce}`;
    const url = new URL(identity.databaseUrl);
    url.hostname = url.hostname === "localhost" ? "127.0.0.1" : "localhost";
    await writeFile(identityPath, JSON.stringify({ ...identity, databaseUrl: url.toString() }));
    other = await api.openVerifiedReplayHandlerDatabase(identityPath, {});
    expect(other.identity).toEqual(database.identity);
    expect(() => api.assertSameReplayHandlerDatabase(database, other!)).toThrow("replay_database_identity_mismatch");
  } finally {
    await other?.close();
    await admin`UPDATE pipeline_replay.identity SET nonce = ${identity.nonce}`;
    await admin`UPDATE pipeline_replay.handler_profile SET nonce = ${identity.nonce}`;
    await writeFile(identityPath, original);
  }
});
it("grants only fixed capacity ledger inserts and lifecycle updates", async () => {
  await database.client`SELECT frozen_input, frozen_hash FROM pipeline_replay.capacity_inputs LIMIT 1`;
  await database.client`SELECT * FROM pipeline_replay.capacity_finals LIMIT 1`;
  await database.client`SELECT * FROM pipeline_replay.capacity_transitions LIMIT 1`;
  await database.client.begin(async tx => {
    await replay.verifyReplayDatabaseSession(tx, database);
    await tx`INSERT INTO pipeline_replay.capacity_runs (run_id, owner_id, manifest, manifest_hash, state)
      VALUES ('profile-ledger', '00000000-0000-4000-8000-000000000001', '{}', ${"a".repeat(64)}, 'prepared')`;
    await tx`UPDATE pipeline_replay.capacity_runs SET event_seq = 1 WHERE run_id = 'profile-ledger' RETURNING *`;
    await tx`INSERT INTO pipeline_replay.capacity_transitions (run_id, seq, kind, payload) VALUES ('profile-ledger', 1, 'prepared', '{}')`;
  });
  for (const query of ["UPDATE pipeline_replay.capacity_runs SET manifest = '{}'", "DELETE FROM pipeline_replay.capacity_runs",
    "INSERT INTO pipeline_replay.capacity_runs (run_id, owner_id, manifest, manifest_hash, state, charged_tokens) VALUES ('forbidden', '00000000-0000-4000-8000-000000000001', '{}', repeat('a',64), 'prepared', 0)",
    "UPDATE pipeline_replay.capacity_inputs SET frozen_input = '{}'",
    "UPDATE pipeline_replay.capacity_finals SET decision = 'reject'", "DELETE FROM pipeline_replay.capacity_finals",
    "INSERT INTO pipeline_replay.capacity_finals (run_id,candidate_id,input_hash,source_revision_hash,policy_hash,seq,first_attempt_id,first_call_id,decision,second_witnesses,at) VALUES ('profile-ledger',1,repeat('a',64),repeat('b',64),repeat('c',64),1,1,'fake','approve','[]',now())",
    "UPDATE pipeline_replay.capacity_transitions SET payload = '{}'",
    "UPDATE pipeline_replay.capacity_runs SET initial_state_hash = repeat('b',64)",
    "UPDATE pipeline_replay.capacity_transactions SET changes = '[]'", "DELETE FROM pipeline_replay.capacity_changes",
    "UPDATE pipeline_replay.capacity_commit_confirmations SET confirmed_at = now()",
    "INSERT INTO pipeline_replay.capacity_commit_confirmations (run_id,tx_key,confirmed_at) VALUES ('fake','00000000-0000-4000-8000-000000000001',now())",
    "INSERT INTO pipeline_replay.capacity_transitions (run_id, seq, at, kind, payload) VALUES ('profile-ledger', 2, now(), 'forbidden', '{}')",
    "UPDATE pipeline_replay.capacity_calls SET second_review_id = 2", "UPDATE pipeline_replay.capacity_calls SET request_hash = repeat('b',64)"])
    await expect(database.client.unsafe(query)).rejects.toMatchObject({ code: "42501" });
});
it("supports exact existing handler locks and job writes while all source tables remain immutable", async () => {
  await database.client.begin(async tx => {
    await replay.verifyReplayDatabaseSession(tx, database);
    for (const table of ["crawl_documents", "crawl_settings", "agent_repository_scans", "agent_repository_observations"])
      await tx.unsafe(`SELECT * FROM public.${table} FOR SHARE`);
    await tx`INSERT INTO public.jobs (name, requested_version) VALUES ('replay-profile-probe', 1)
      ON CONFLICT (name) DO UPDATE SET requested_version = jobs.requested_version + 1 RETURNING *`;
    await tx`UPDATE public.jobs SET locked_at = now(), lease_token = 'profile', runs = runs + 1 WHERE name = 'replay-profile-probe' RETURNING *`;
  });
  for (const table of ["crawl_documents", "crawl_settings", "agent_repository_scans", "agent_repository_observations"])
    await expect(database.client.unsafe(`UPDATE public.${table} SET id = id`)).rejects.toMatchObject({ code: "42501" });
});
it("denies products writes, unrelated tables, extra source columns and marker mutations at the SQL boundary", async () => {
  await database.client`SELECT * FROM public.products LIMIT 1`;
  for (const query of ["INSERT INTO public.products DEFAULT VALUES", "UPDATE public.products SET name = name", "DELETE FROM public.products",
    "SELECT * FROM public.public_users", "UPDATE public.crawl_documents SET repo = repo", "DELETE FROM public.crawl_review_attempts",
    "UPDATE pipeline_replay.handler_profile SET nonce = nonce", "DELETE FROM pipeline_replay.handler_profile",
    "TRUNCATE pipeline_replay.handler_profile", "CREATE TABLE public.replay_forbidden (id integer)", "CREATE TEMP TABLE replay_forbidden (id integer)"])
    await expect(database.client.unsafe(query)).rejects.toMatchObject({ code: "42501" });
});
it("rejects privilege drift on the same transaction before a handler write", async () => {
  for (const grant of ["UPDATE (name) ON public.products", "UPDATE (repo) ON public.crawl_documents", "DELETE ON public.jobs",
    "SELECT ON public.public_users", "UPDATE (nonce) ON pipeline_replay.handler_profile", "USAGE ON SEQUENCE public.products_id_seq",
    "UPDATE (manifest) ON pipeline_replay.capacity_runs", "INSERT (charged_tokens) ON pipeline_replay.capacity_runs",
    "UPDATE (decision) ON pipeline_replay.capacity_finals", "UPDATE (vote) ON pipeline_replay.capacity_calls", "INSERT (at) ON pipeline_replay.capacity_transitions"]) {
    await admin.unsafe(`GRANT ${grant} TO ${quoted()}`);
    try {
      await expect(database.client.begin(async tx => { await replay.verifyReplayDatabaseSession(tx, database); }))
        .rejects.toThrow("replay_database_privileges_rejected");
    } finally { await admin.unsafe(`REVOKE ${grant} FROM ${quoted()}`); }
  }
  await replay.verifyReplayDatabaseSession(database.client, database);
});
it("rejects broad PUBLIC grants, another usable schema and callable SECURITY DEFINER functions", async () => {
  await admin`GRANT SELECT ON public.public_users TO PUBLIC`;
  try { await expect(replay.verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin`REVOKE SELECT ON public.public_users FROM PUBLIC`; }
  await admin`CREATE SCHEMA replay_other`;
  await admin.unsafe(`GRANT USAGE ON SCHEMA replay_other TO ${quoted()}`);
  try { await expect(replay.verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin`DROP SCHEMA replay_other`; }
  await admin`CREATE FUNCTION public.replay_definer_canary() RETURNS void LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`;
  try { await expect(replay.verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin`DROP FUNCTION public.replay_definer_canary()`; }
});
it("binds protected profile nonce and exact object OIDs instead of authenticating an edited identity or replaced table", async () => {
  const identity = await replay.readReplayDatabaseIdentity(identityPath);
  await admin`UPDATE pipeline_replay.handler_profile SET nonce = ${"e".repeat(64)}`;
  try { await expect(api.openVerifiedReplayHandlerDatabase(identityPath, {})).rejects.toThrow("replay_database_identity_mismatch"); }
  finally { await admin`UPDATE pipeline_replay.handler_profile SET nonce = ${identity.nonce}`; }
  await admin`ALTER TABLE public.jobs RENAME TO replay_original_jobs`;
  await admin`CREATE TABLE public.jobs (LIKE public.replay_original_jobs INCLUDING ALL)`;
  try { await expect(replay.verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin`DROP TABLE public.jobs`; await admin`ALTER TABLE public.replay_original_jobs RENAME TO jobs`; }
  expect(await readFile(identityPath, "utf8")).toContain(identity.nonce);
  await replay.verifyReplayDatabaseSession(database.client, database);
});
it("binds the fixed ledger version and complete column definitions", async () => {
  const [profile] = await admin`SELECT version FROM pipeline_replay.handler_profile`;
  expect(profile.version).toBe("handlers-v5");
  await admin`ALTER TABLE pipeline_replay.capacity_calls ADD COLUMN extra_identity text`;
  try { await expect(replay.verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin`ALTER TABLE pipeline_replay.capacity_calls DROP COLUMN extra_identity`; }
  await replay.verifyReplayDatabaseSession(database.client, database);
});
it("rejects disabled immutable-source guards and privilege changes even when effective permissions are unchanged", async () => {
  for (const table of ["crawl_documents", "pipeline_stage_modes", "pipeline_item_leases"]) {
    await admin.unsafe(`ALTER TABLE public.${table} DISABLE TRIGGER replay_handler_source_immutable`);
    try { await expect(replay.verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected"); }
    finally { await admin.unsafe(`ALTER TABLE public.${table} ENABLE ALWAYS TRIGGER replay_handler_source_immutable`); }
  }
  await admin`GRANT SELECT ON public.products TO PUBLIC`;
  try { await expect(replay.verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin`REVOKE SELECT ON public.products FROM PUBLIC`; }
  await replay.verifyReplayDatabaseSession(database.client, database);
});
it("binds stage/item guard OIDs and exact immutable function definition", async () => {
  const guards = await admin`SELECT c.relname, t.oid::int AS trigger_oid, t.tgenabled, p.oid::int AS function_oid,
    pg_get_functiondef(p.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgname = 'replay_handler_source_immutable' ORDER BY c.relname`;
  expect(guards).toHaveLength(6);
  expect(guards.every(guard => guard.tgenabled === "A" && guard.function_oid === guards[0].function_oid)).toBe(true);
  expect(guards.map(guard => guard.relname)).toContain("pipeline_stage_modes");
  expect(guards.map(guard => guard.relname)).toContain("pipeline_item_leases");
  try {
    await admin`CREATE OR REPLACE FUNCTION pipeline_replay.reject_handler_source_mutation() RETURNS trigger
      LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS 'BEGIN RETURN NULL; END'`;
    await expect(replay.verifyReplayDatabaseSession(database.client, database)).rejects.toThrow("replay_database_privileges_rejected");
  } finally { await admin.unsafe(guards[0].definition); }
  const restored = await admin`SELECT c.relname, t.oid::int AS trigger_oid, t.tgenabled, p.oid::int AS function_oid,
    pg_get_functiondef(p.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgname = 'replay_handler_source_immutable' ORDER BY c.relname`;
  expect(restored).toEqual(guards);
  await replay.verifyReplayDatabaseSession(database.client, database);
});
it("rejects a disabled mutation journal trigger before a handler can run unobserved", async () => {
  await admin`ALTER TABLE public.jobs DISABLE TRIGGER replay_handler_change`;
  try { await expect(api.openVerifiedReplayHandlerDatabase(identityPath, {})).rejects.toThrow("replay_database_privileges_rejected"); }
  finally { await admin`ALTER TABLE public.jobs ENABLE ALWAYS TRIGGER replay_handler_change`; }
  await replay.verifyReplayDatabaseSession(database.client, database);
});
it("requires the original trusted admin for provisioning and refuses duplicate provisioning", async () => {
  const identity = await replay.readReplayDatabaseIdentity(identityPath);
  await expect(api.provisionReplayHandlerProfile({ databaseUrl: identity.databaseUrl, identityPath, acknowledgeDedicatedCluster: true, env: {} }))
    .rejects.toThrow("replay_database_admin_required");
  await expect(provision()).rejects.toThrow("replay_handler_profile_already_provisioned");
});
