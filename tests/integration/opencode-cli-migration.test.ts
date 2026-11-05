import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { itemBindingHash, type ItemBinding } from "@/lib/jobs/items/types";
import { cliDispatchBindingHash, type CliDispatchBinding } from "@/lib/llm/capacity";
import { TEST_DATABASE_URL } from "./test-database-url";

/** Only local test DB. Temporary clones exercise the real migrated guards; no application rows or model calls. */
const client = postgres(TEST_DATABASE_URL, { max: 1, prepare: false, onnotice: () => {} });
const tag = "0163_opencode_review_cli", sha = "a".repeat(64), other = "b".repeat(64), C = 200_000;
const owner = { instanceId: "opencode-schema-fixture", bootId: "00000000-0000-4000-8000-000000000001" };
type Provider = "opencode-cli" | "claude-cli" | "grok-cli";
const model = "opencode/deepseek-v4.1-flash", id = "00000000-0000-4000-8000-000000000002";
const token = "00000000-0000-4000-8000-000000000003";
const transport = (provider: Provider) => ({ protocol: "cli-process-v1" as const, provider, model, argvHash: sha, inputHash: other,
  envPolicyHash: sha, cliContractHash: other, timeoutMs: 20_000, maxStdoutBytes: 65_536, maxStderrBytes: 16_384 });
const charge = (provider: Provider) => ({ transport: transport(provider), totalTokenBound: C, chargedTokens: C });
function bindings(provider: Provider): CliDispatchBinding[] {
  const first: Extract<ItemBinding, { stage: "ai1" }> = { stage: "ai1", candidateId: 7, inputHash: sha, sourceRevisionHash: other,
    policyHash: sha, promptVersion: "p1", rulesVersion: "r1", reviewer: { provider, model } };
  const second: Extract<ItemBinding, { stage: "ai2" }> = { stage: "ai2", secondReviewId: 11, candidateId: 7,
    source: { kind: "first_attempt", firstAttemptId: 5 }, inputHash: sha, sourceRevisionHash: other, policyHash: sha, promptVersion: "p1",
    rulesVersion: "r1", reviewer: { provider, model }, generationKey: other, vote: 11, fallbackForId: null };
  const item = (workKey: string, review: ItemBinding) => ({ workKey, owner, token, stageEpoch: 1, itemEpoch: 2, bindingHash: itemBindingHash(review) });
  return [
    { kind: "ai1_legacy_cli", version: 1, logicalWorkKey: "ai1:7", candidateId: 7, attemptId: 41, inputHash: sha, sourceRevisionHash: other,
      reviewPolicyHash: sha, promptVersion: "p1", rulesVersion: "r1", provider, model, routeId: "crawl-agent-review", stageEpoch: 1,
      ...charge(provider), job: { name: "crawl-agent-review", token, requestedVersion: 3 } },
    { kind: "ai1_item_cli", version: 1, logicalWorkKey: "ai1:7", attemptId: 42, review: first, item: item("ai1:7", first),
      routeId: "crawl-agent-review", provider, model, ...charge(provider) },
    { kind: "ai2_item_cli", version: 1, logicalWorkKey: "ai2:7:11", review: second, rowIdentityHash: sha, failureCount: 1,
      item: item("ai2:11", second), inputPolicyHash: other, routeId: "second-review", provider, model, ...charge(provider) },
  ];
}
type Row = Record<string, unknown>;
function request(binding: CliDispatchBinding): Row {
  const suffix = "item" in binding ? binding.item.bindingHash : "inputHash" in binding ? binding.inputHash : "";
  return { request_id: id, work_key: `${binding.logicalWorkKey}:${suffix}`, owner_instance_id: owner.instanceId, owner_boot_id: owner.bootId,
    class: binding.kind === "ai2_item_cli" ? "second" : "first", pool: "reviewer", route_id: binding.routeId, provider: binding.provider, model,
    provider_budget_id: "fixture", group_id: "fixture", epoch: 1, revision: 1, policy_hash: sha, state: "dispatched", token,
    reserved_until: "2026-11-05T00:01:00.000Z", queued_at: "2026-11-05T00:00:00.000Z", queue_until: "2026-11-05T00:01:00.000Z",
    updated_at: "2026-11-05T00:00:00.000Z", queue_ordinal: 1, logical_work_key: binding.logicalWorkKey, logical_member_keys: null,
    dispatch_binding: binding, dispatch_binding_hash: cliDispatchBindingHash(binding), dispatched_at: "2026-11-05T00:00:00.000Z",
    terminal_evidence: null, terminal_evidence_hash: null, settled_at: null };
}
function event(binding: CliDispatchBinding): Row {
  return { id: 1, request_id: id, kind: "dispatch_settled", epoch: 1, revision: 1, policy_hash: sha, from_state: "dispatched", to_state: "settled", reason: null,
    created_at: "2026-11-05T00:00:01.000Z", evidence: { version: 1, kind: "cli_model_terminal",
      dispatch: { requestId: id, owner, token, epoch: 1, revision: 1, policyHash: sha, binding, bindingHash: cliDispatchBindingHash(binding) },
      process: { version: 1, kind: "cli_process_terminal", requestId: id, transport: binding.transport, totalTokenBound: C, ending: "exited",
        exitCode: 0, signal: null, killReason: null, stdoutHash: sha, stderrHash: createHash("sha256").update("").digest("hex"),
        stdoutBytes: 100, stderrBytes: 0, actualUsage: null, provenance: "unknown", reportedCostUsdMicros: null } } };
}
const migration = readFileSync(`drizzle/${tag}.sql`, "utf8");
beforeAll(async () => {
  // Global setup applied the migration. Attach only the real 0160 guard to private temporary clones.
  await client.unsafe("CREATE TEMP TABLE opencode_requests (LIKE model_capacity_requests INCLUDING DEFAULTS INCLUDING CONSTRAINTS)");
  await client.unsafe("CREATE TRIGGER opencode_requests_guard BEFORE INSERT ON opencode_requests FOR EACH ROW EXECUTE FUNCTION nmv_model_capacity_requests_check_guard()");
  await client.unsafe("CREATE TEMP TABLE opencode_events (LIKE model_capacity_events INCLUDING DEFAULTS INCLUDING CONSTRAINTS)");
  await client.unsafe("CREATE TRIGGER opencode_events_guard BEFORE INSERT ON opencode_events FOR EACH ROW EXECUTE FUNCTION nmv_model_capacity_events_check_guard()");
  await client.unsafe("CREATE TEMP TABLE opencode_connections (LIKE ai_connections INCLUDING DEFAULTS INCLUDING CONSTRAINTS)");
  // Exercise the new host-connection DDL on a private clone, including when a developer's shared test DB predates it.
  await client.begin(async tx => {
    const ddl = readFileSync("drizzle/0164_opencode_host_catalog.sql", "utf8").replaceAll("ALTER TABLE ai_connections", "ALTER TABLE opencode_connections");
    for (const statement of ddl.split("--> statement-breakpoint").map(part => part.trim()).filter(Boolean)) await tx.unsafe(statement);
  });
  for (const [table, short] of [["model_capacity_requests", "request"], ["model_capacity_events", "event"]] as const) {
    const rules = await client<{ constraint_name: string; predicate: string }[]>`SELECT constraint_name,predicate FROM model_capacity_check_rules
      WHERE table_name=${table} AND source<>${tag} ORDER BY constraint_name,ordinal`;
    const names = [...new Set(rules.map(rule => rule.constraint_name))];
    // CHECK semantics: FALSE rejects, NULL passes. This is the exact old set of rule ordinals.
    const predicate = names.map(name => `coalesce((${rules.filter(rule => rule.constraint_name === name).map(rule => `(${rule.predicate})`).join(" OR ")}),true)`).join(" AND ");
    await client.unsafe(`CREATE FUNCTION pg_temp.opencode_before_${short}(v jsonb) RETURNS boolean LANGUAGE sql AS $fixture$
      SELECT ${predicate} FROM jsonb_populate_record(NULL::${table},v) AS ${table} $fixture$`);
  }
});
afterAll(() => client.end({ timeout: 5 }));
async function insert(target: "requests" | "events" | "connections", row: Row): Promise<string> {
  try {
    await client.begin(tx => tx.unsafe(`INSERT INTO opencode_${target} SELECT (jsonb_populate_record(NULL::opencode_${target}, $1::text::jsonb)).*`, [JSON.stringify(row)]));
    return "accepted";
  } catch (error) { const e = error as { code: string; constraint_name: string }; return `${e.code}:${e.constraint_name}`; }
}
async function before(target: "request" | "event", row: Row): Promise<boolean> {
  return (await client.unsafe<{ ok: boolean }[]>(`SELECT pg_temp.opencode_before_${target}($1::text::jsonb) AS ok`, [JSON.stringify(row)]))[0].ok;
}

it("appends exactly the intended rules and leaves all earlier predicates in place", async () => {
  const rows = await client<{ constraint_name: string; predicate: string; ordinal: number }[]>`SELECT constraint_name,predicate,ordinal
    FROM model_capacity_check_rules WHERE source=${tag} ORDER BY constraint_name`;
  expect(rows.map(row => row.constraint_name)).toEqual(["model_capacity_events_terminal_check", "model_capacity_requests_dispatch_check", "model_capacity_requests_logical_check"]);
  for (const row of rows) {
    expect(migration).toContain(`$branch$${row.predicate}$branch$`);
    expect(Number(row.ordinal)).toBeGreaterThan(1);
  }
});

it("applies the complete final migration to an isolated schema and preserves prior rule bytes", async () => {
  const schema = `opencode_migration_${randomUUID().replaceAll("-", "")}`;
  await client.begin(async tx => {
    await tx.unsafe(`CREATE SCHEMA ${schema}`);
    await tx.unsafe(`SET LOCAL search_path = ${schema}, public`);
    for (const table of ["ai_connections", "model_capacity_requests", "model_capacity_events", "model_capacity_check_rules"]) {
      await tx.unsafe(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await tx`INSERT INTO model_capacity_check_rules SELECT * FROM public.model_capacity_check_rules WHERE source<>${tag}`;
    const previous = await tx`SELECT table_name,constraint_name,ordinal,predicate,source FROM model_capacity_check_rules ORDER BY table_name,constraint_name,ordinal`;
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await tx.unsafe(statement);
    expect(await tx`SELECT table_name,constraint_name,ordinal,predicate,source FROM model_capacity_check_rules WHERE source<>${tag}
      ORDER BY table_name,constraint_name,ordinal`).toEqual(previous);
    expect((await tx`SELECT count(*)::int n FROM model_capacity_check_rules WHERE source=${tag}`)[0].n).toBe(3);
    expect((await tx`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid=${`${schema}.ai_connections`}::regclass
      AND conname='ai_connections_cli_check'`)[0].def).toContain("opencode");
    const functions = await tx`SELECT proname FROM pg_proc WHERE pronamespace=${schema}::regnamespace
      AND proname IN ('nmv_model_capacity_requests_check_guard','nmv_model_capacity_events_check_guard') ORDER BY proname`;
    expect(functions).toHaveLength(2);
    await tx.unsafe(`DROP SCHEMA ${schema} CASCADE`);
  });
});

it("fails closed on a missing/duplicate baseline or missing/changed/duplicate append, using a private temporary rules table", async () => {
  const statements = migration.split("--> statement-breakpoint");
  const preflight = statements.find(sql => sql.trimStart().startsWith("DO $opencode_preflight$"))!;
  const postflight = statements.find(sql => sql.trimStart().startsWith("DO $opencode_postflight$"))!;
  const appends = statements.filter(sql => sql.trimStart().startsWith("INSERT INTO model_capacity_check_rules"));
  expect(preflight).toBeDefined(); expect(postflight).toBeDefined(); expect(appends).toHaveLength(3);
  await client.begin(async tx => {
    await tx.unsafe("CREATE TEMP TABLE model_capacity_check_rules (LIKE public.model_capacity_check_rules INCLUDING ALL) ON COMMIT DROP");
    await tx`INSERT INTO model_capacity_check_rules SELECT * FROM public.model_capacity_check_rules WHERE source<>${tag}`;
    const rejects = async (changes: () => Promise<unknown>, assertion: string) => {
      try {
        await tx.savepoint(async save => { await changes(); await save.unsafe(assertion); });
        return "accepted";
      } catch (error) { return (error as { code: string }).code; }
    };
    expect(await rejects(() => tx`DELETE FROM model_capacity_check_rules WHERE constraint_name='model_capacity_requests_logical_check'
      AND source='0160_ledger_check_rules'`, preflight)).toBe("23514");
    expect(await rejects(() => tx`INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
      SELECT table_name,constraint_name,max(ordinal)+1,'false','0160_ledger_check_rules' FROM model_capacity_check_rules
      WHERE constraint_name='model_capacity_requests_logical_check' GROUP BY table_name,constraint_name`, preflight)).toBe("23514");
    expect(await rejects(() => tx`INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
      SELECT table_name,constraint_name,max(ordinal)+1,'false',${tag} FROM model_capacity_check_rules
      WHERE constraint_name='model_capacity_requests_logical_check' GROUP BY table_name,constraint_name`, preflight)).toBe("23514");
    await tx.unsafe(preflight);
    for (const append of appends) await tx.unsafe(append);
    await tx.unsafe(postflight);
    expect(await rejects(() => tx`UPDATE model_capacity_check_rules SET predicate='false' WHERE source=${tag}
      AND constraint_name='model_capacity_requests_logical_check'`, postflight)).toBe("23514");
    expect(await rejects(() => tx`DELETE FROM model_capacity_check_rules WHERE source=${tag}
      AND constraint_name='model_capacity_requests_logical_check'`, postflight)).toBe("23514");
    expect(await rejects(() => tx`INSERT INTO model_capacity_check_rules(table_name,constraint_name,ordinal,predicate,source)
      SELECT table_name,constraint_name,max(ordinal)+1,'false',${tag} FROM model_capacity_check_rules
      WHERE constraint_name='model_capacity_requests_logical_check' GROUP BY table_name,constraint_name`, postflight)).toBe("23514");
  });
});

for (const provider of ["claude-cli", "grok-cli", "opencode-cli"] as const) it(`${provider}: complete AI1 legacy/item and AI2 bindings pass dispatch and physical-terminal event guards`, async () => {
  for (const binding of bindings(provider)) {
    const row = request(binding), terminal = event(binding);
    expect(await before("request", row), `${binding.kind}: predecessor`).toBe(provider !== "opencode-cli");
    expect(await before("event", terminal), `${binding.kind}: predecessor terminal`).toBe(provider !== "opencode-cli");
    expect(await insert("requests", row), binding.kind).toBe("accepted");
    expect(await insert("events", terminal), binding.kind).toBe("accepted");
    const rejected = { ...row, dispatch_binding: { ...binding, chargedTokens: C - 1 } };
    expect(await before("request", rejected), `${binding.kind}: old charge guard`).toBe(false);
    expect(await insert("requests", rejected), `${binding.kind}: new charge guard`).toMatch(/^23514:/);
  }
});

it("rejects OpenCode binding/transport/model/route/owner/shape mismatches and every non-review target", async () => {
  const binding = bindings("opencode-cli")[1], base = request(binding);
  const item = "item" in binding ? binding.item : null;
  const badBindings = [
    { ...binding, transport: { ...binding.transport, provider: "claude-cli" } },
    { ...binding, transport: { ...binding.transport, model: "another-model" } },
    { ...binding, transport: { ...binding.transport, argvHash: "invalid" } },
    { ...binding, logicalWorkKey: "ai1:8" }, { ...binding, routeId: "second-review" },
    { ...binding, item: { ...item, owner: { ...owner, bootId: randomUUID() } } },
    { ...binding, item: { ...item, workKey: "ai1:8" } }, { ...binding, unexpected: true },
    { ...binding, provider: "codex-cli", transport: { ...binding.transport, provider: "codex-cli" } },
  ];
  for (const forged of badBindings) expect(await insert("requests", { ...base, dispatch_binding: forged })).toMatch(/^23514:/);
  for (const route of ["product-audit", "product-intro-check", "grok-session-check", "crawl-publish-classify"]) {
    expect(await insert("requests", { ...base, class: "background", route_id: route,
      dispatch_binding: { ...binding, routeId: route } })).toMatch(/^23514:/);
  }
  const terminal = event(binding), evidence = terminal.evidence as { process: Row };
  for (const forged of [{ ...evidence.process, requestId: randomUUID() }, { ...evidence.process, totalTokenBound: C - 1 },
    { ...evidence.process, transport: { ...binding.transport, argvHash: other } }]) {
    expect(await insert("events", { ...terminal, evidence: { ...evidence, process: forged } })).toMatch(/^23514:/);
  }
});

it("preserves provider-independent request terminal guards and indeterminate/withdrawn semantics", async () => {
  for (const binding of bindings("opencode-cli")) {
    const base = request(binding), terminal = event(binding).evidence;
    const settled = { ...base, state: "settled", terminal_evidence: terminal, terminal_evidence_hash: sha, settled_at: "2026-11-05T00:00:01.000Z" };
    expect(await insert("requests", settled)).toBe("accepted");
    expect(await insert("requests", { ...base, state: "indeterminate" })).toBe("accepted");
    // Merely claiming withdrawn is not physical-terminal evidence and must continue to fail.
    expect(await insert("requests", { ...base, state: "withdrawn", token: null, reserved_until: null })).toMatch(/^23514:/);
  }
});

it("accepts the OpenCode connection while retaining all existing CLI null/model-array checks", async () => {
  const row: Row = { id, label: "OpenCode fixture", kind: "cli", cli_tool: "opencode", cli_models: ["deepseek-v4.1-flash"],
    base_url: null, api_key_ciphertext: null, models: null, models_read_at: null, models_error: null,
    device_id: "fixture", capacity_slots: 1, options: {}, enabled: true, version: 1, note: null, updated_by: "fixture" };
  // jsonb_populate_record fills omitted NOT NULL defaults with NULL; supply timestamps explicitly.
  Object.assign(row, { created_at: "2026-11-05T00:00:00.000Z", updated_at: "2026-11-05T00:00:00.000Z" });
  for (const tool of ["claude", "codex", "grok", "opencode"]) expect(await insert("connections", { ...row, cli_tool: tool })).toBe("accepted");
  expect(await insert("connections", { ...row, base_url: "https://m3.test/v1", api_key_ciphertext: "encrypted-bridge-fixture" })).toBe("accepted");
  for (const tool of ["claude", "codex", "grok"]) expect(await insert("connections", { ...row, cli_tool: tool, base_url: "https://m3.test/v1", api_key_ciphertext: "encrypted-bridge-fixture" })).toBe("23514:ai_connections_cli_check");
  for (const count of [111, 512]) expect(await insert("connections", { ...row, cli_models: Array.from({ length: count }, (_, i) => `opencode/model-${i}`) })).toBe("accepted");
  for (const tool of ["claude", "codex", "grok"]) expect(await insert("connections", { ...row, cli_tool: tool, cli_models: Array(33).fill("model") })).toBe("23514:ai_connections_cli_check");
  for (const forged of [{ cli_tool: "unknown" }, { cli_models: [] }, { cli_models: [null] }, { cli_models: Array(513).fill("model") },
    { api_key_ciphertext: "fixture-only" }, { base_url: "https://example.test/v1" }, { models: [] }, { models_read_at: "2026-11-05T00:00:00.000Z" },
    { models_error: "fixture" }]) expect(await insert("connections", { ...row, ...forged })).toBe("23514:ai_connections_cli_check");
});
