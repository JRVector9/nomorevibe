import { describe, expect, it } from "vitest";
import { getTableColumns, type Table } from "drizzle-orm";
import type postgres from "postgres";
import * as dbSchema from "@/lib/db/schema";
import { createReviewInput, reviewHash } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { itemBindingHash, itemWorkKey, type ItemBinding } from "@/lib/jobs/items/types";
import { parseCapacityManifest, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { captureReplayCombinedState, type ReplayCombinedState } from "@/lib/operations/pipeline-replay-combined-capture";
import { ReplayReadinessProjectionSchema, type ReplayReadinessProjection } from "@/lib/operations/pipeline-replay-readiness";
import { parseReplayArtifact, replayArtifactFromVerified } from "@/lib/operations/pipeline-replay-artifact";

const reference = "2001-11-01T00:00:00.000Z", fetched = "2001-10-31T23:59:59.000Z";
const utc = "2026-10-15T23:59:59.123456Z", offset = "2026-10-16 08:59:59.123456+09:00";
const expired = "2001-02-03T04:05:06.000001Z", expiredOffset = "2001-02-03 01:05:06.000001-03:00";
const boot = "11111111-1111-4111-8111-111111111111", token = "22222222-2222-4222-8222-222222222222";
const publicTables = { crawl_settings: dbSchema.crawlSettings, crawl_candidates: dbSchema.crawlCandidates,
  crawl_documents: dbSchema.crawlDocuments, crawl_review_attempts: dbSchema.crawlReviewAttempts,
  second_reviews: dbSchema.secondReviews, agent_repository_scans: dbSchema.agentRepositoryScans,
  agent_repository_observations: dbSchema.agentRepositoryObservations, products: dbSchema.products,
  crawl_frontier: dbSchema.crawlFrontier, jobs: dbSchema.jobs, operations_observations: dbSchema.operationsObservations };
const callColumns = "run_id call_id candidate_id first_attempt_id input_hash source_revision_hash stage provider model second_review_id generation_key vote request_hash token_upper_bound state dispatched_at settled_at input_tokens output_tokens result_ok result_hash result_decision_hash failure_class".split(" ");
type DomainRow = ReplayReadinessProjection["tables"]["jobs"][number];
type ItemRow = ReplayCombinedState["items"]["tables"]["pipeline_item_leases"][number];
function row(table: Table, values: Record<string, unknown>): DomainRow {
  return { ...Object.fromEntries(Object.values(getTableColumns(table)).map(column =>
    [column.name, column.dataType === "date" ? utc : null])), ...values } as DomainRow;
}
function typed<T>(raw: DomainRow, table: Table): T {
  return Object.fromEntries(Object.entries(getTableColumns(table)).map(([name, column]) => [name,
    raw[column.name] === null ? null : column.dataType === "date" ? new Date(String(raw[column.name]))
      : column.mapFromDriverValue(raw[column.name])])) as T;
}
function inputRows(id: number, title = `Independent app ${id}`, enforceEligibility = false) {
  const repo = `combined/app-${id}`, productUrl = `https://combined-${id}.example`;
  const candidate = row(dbSchema.crawlCandidates, { id, repo, product_url: productUrl, state: "approved",
    reason: "passed", decided_by: "auto", judged_at: reference });
  const document = row(dbSchema.crawlDocuments, { id, repo, product_url: productUrl, fetched_at: fetched, page_status: 200,
    repo_meta: { description: "A deployed task tracker", homepage: productUrl, fork: false, private: false,
      archived: false, owner: { type: "User" }, stargazers_count: 10 },
    page_meta: { title, description: "Manage projects in the browser", textSample: "Create a project and manage tasks.",
      readmeSample: "An online task tracker", readmeSampleVersion: README_SAMPLE_VERSION } });
  const settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce" as const,
    firstReview: { provider: "abcllm" as const, model: "first" },
    agentEvidence: { ...DEFAULT_CRAWL_SETTINGS.agentEvidence, enforceEligibility } };
  const input = createReviewInput(typed(candidate, dbSchema.crawlCandidates), typed(document, dbSchema.crawlDocuments),
    settings, { scan: null, observations: [] }, new Date(reference));
  const frozenInput = JSON.parse(JSON.stringify(input));
  return { candidate, document, settings, identity: { candidateId: id, inputHash: input.inputHash,
    sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, frozenInput, frozenHash: reviewHash(frozenInput) } };
}
function item(id: number): ItemRow {
  // These raw owner values are structural evidence, never execution receipts.
  const binding: ItemBinding = { stage: "ai2", secondReviewId: id, candidateId: 900 + id,
    source: { kind: "published", slug: `foreign-${id}`, productId: 700 + id }, inputHash: "a".repeat(64),
    sourceRevisionHash: "b".repeat(64), policyHash: "c".repeat(64), promptVersion: "p1", rulesVersion: "r1",
    reviewer: { provider: "abcllm", model: "second" }, generationKey: "d".repeat(64), vote: id, fallbackForId: null };
  return { stage: "ai2", work_key: itemWorkKey(binding), binding, binding_hash: itemBindingHash(binding),
    owner_instance_id: "foreign-worker", owner_boot_id: boot, token, stage_epoch: 1, item_epoch: 3,
    lease_until: expired, created_at: utc, updated_at: utc };
}
function fixture() {
  const first = inputRows(2), second = inputRows(10);
  const tables = Object.fromEntries(Object.entries(publicTables).map(([name, table]) => [name, [10, 2].map(id =>
    row(table, name === "jobs" ? { name: `foreign-job-${id}` }
      : name === "operations_observations" ? { key: `foreign-key-${id}` } : { id }))])) as ReplayReadinessProjection["tables"];
  tables.crawl_candidates = [second.candidate, first.candidate];
  tables.crawl_documents = [second.document, first.document];
  tables.crawl_settings[0].values = second.settings; tables.crawl_settings[1].values = first.settings;
  tables.capacity_calls = [10, 2].map(id => ({ ...Object.fromEntries(callColumns.map(column => [column, null])),
    run_id: "combined-independent", call_id: `call-${id}`, candidate_id: id,
    state: "settled", dispatched_at: utc, settled_at: utc }));
  const released = { ...item(2), owner_instance_id: null, owner_boot_id: null, token: null, lease_until: null, item_epoch: 0 };
  const state: ReplayCombinedState = { kind: "pipeline-replay-combined-state", version: 1,
    domain: { version: 1, referenceTime: reference, universe: [first.identity, second.identity], tables },
    items: { kind: "pipeline-replay-item-state", version: 1, tables: {
      pipeline_stage_modes: [
        { stage: "ai1", mode: "items", draining_from: null, epoch: 4, writer_contract_version: 1, updated_at: utc },
        { stage: "ai2", mode: "draining", draining_from: "items", epoch: 7, writer_contract_version: 2, updated_at: utc },
        { stage: "fetch", mode: "legacy", draining_from: null, epoch: 2, writer_contract_version: 0, updated_at: utc },
      ], pipeline_item_leases: [item(10), released],
    } } };
  const manifest: CapacityManifest = { version: 1, runId: "combined-independent", revision: "ee6bc24", mode: "fixtures",
    cacheMode: "cold", referenceTime: reference, startedAt: "2026-10-16T00:00:00.000Z", endedAt: "2026-10-16T00:01:00.000Z",
    inputPolicyHash: first.identity.policyHash, fullReviewPolicyHash: "e".repeat(64), comparisonPolicyHash: "f".repeat(64),
    initialStateHash: "1".repeat(64), models: { first: { provider: "abcllm", model: "first", canonicalModel: "first" },
      second: [{ provider: "abcllm", model: "second", canonicalModel: "second" }], fallbacks: [] },
    inputs: state.domain.universe.map(identity => ({ candidateId: identity.candidateId, inputHash: identity.inputHash,
      sourceRevisionHash: identity.sourceRevisionHash, readyAt: reference, stratum: "new", reReview: false })),
    limits: { maxCalls: 100, maxTokens: 100_000, maxDurationMs: 60_000, concurrency: 4, perCallTokenUpperBound: 1000 } };
  return { state, manifest };
}
function rawVariant(value: ReplayCombinedState): ReplayCombinedState {
  const raw = structuredClone(value);
  raw.domain.universe.reverse();
  for (const [name, rows] of Object.entries(raw.domain.tables)) {
    rows.reverse();
    const dates = name === "capacity_calls" ? ["dispatched_at", "settled_at"]
      : Object.values(getTableColumns(publicTables[name as keyof typeof publicTables])).filter(column => column.dataType === "date").map(column => column.name);
    for (const record of rows) for (const date of dates) if (record[date] === utc) record[date] = offset;
  }
  raw.items.tables.pipeline_stage_modes.reverse(); raw.items.tables.pipeline_item_leases.reverse();
  for (const stage of raw.items.tables.pipeline_stage_modes) stage.updated_at = offset;
  for (const lease of raw.items.tables.pipeline_item_leases) {
    lease.created_at = offset; lease.updated_at = offset;
    if (lease.lease_until === expired) lease.lease_until = expiredOffset;
  }
  return raw;
}
function freeze(value: unknown): void {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
}
function sqlResult(result: unknown, error?: unknown) {
  const calls: Array<{ strings: string[]; raw: readonly string[]; parameters: unknown[] }> = [];
  const forbidden = () => { throw new Error("only_the_owned_literal_capture_statement_is_allowed"); };
  const tx = Object.assign(async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    calls.push({ strings: [...strings], raw: strings.raw, parameters });
    if (error !== undefined) throw error;
    return result;
  }, { unsafe: forbidden, begin: forbidden, savepoint: forbidden, reserve: forbidden, end: forbidden }) as unknown as postgres.TransactionSql;
  return { tx, calls };
}
const capture = (state: unknown, manifest = fixture().manifest) => captureReplayCombinedState(sqlResult([{ state }]).tx, manifest);

describe("combined capture literal boundary and canonical evidence", () => {
  it("runs one literal SELECT over all full domain/item rows with only validated reference/run parameters", async () => {
    const { state, manifest } = fixture(), sql = sqlResult([{ state }]);
    await captureReplayCombinedState(sql.tx, manifest);
    expect(sql.calls).toHaveLength(1);
    const call = sql.calls[0], statement = call.strings.join("?");
    expect(call.raw).toEqual(call.strings); expect(call.strings).toHaveLength(4);
    expect(call.parameters).toEqual([reference, manifest.runId, manifest.runId]);
    expect(statement.trim()).toMatch(/^SELECT\s/i);
    for (const table of [...Object.keys(publicTables), "pipeline_stage_modes", "pipeline_item_leases"])
      expect(statement).toMatch(new RegExp(`\\bpublic\\.${table}\\b`));
    for (const table of ["capacity_inputs", "capacity_calls"]) expect(statement).toContain(`pipeline_replay.${table}`);
    expect(statement.match(/jsonb_agg\s*\(\s*to_jsonb\s*\(\s*\w+\s*\)\s*\)/gi)?.length).toBeGreaterThanOrEqual(14);
    expect(statement.match(/\bWHERE\b/gi)).toHaveLength(2);
    expect(statement).not.toMatch(/\b(?:LIMIT|DISTINCT|FILTER|FOR|LOCK|INSERT|UPDATE|DELETE|BEGIN|COMMIT)\b|pg_advisory|;/i);
    expect(statement).not.toContain(reference); expect(statement).not.toContain(manifest.runId);
  });

  it("keeps a valid SQL-looking run ID exclusively in parameter values", async () => {
    const { state, manifest } = fixture(); manifest.runId = "run'); DROP TABLE jobs;--";
    state.domain.tables.capacity_calls.forEach(row => { row.run_id = manifest.runId; });
    const sql = sqlResult([{ state }]); await captureReplayCombinedState(sql.tx, manifest);
    expect(sql.calls).toHaveLength(1); expect(sql.calls[0].strings.join("")).not.toContain(manifest.runId);
    expect(sql.calls[0].parameters).toEqual([reference, manifest.runId, manifest.runId]);
  });

  it("returns the independently ordered complete envelope and its entire hash", async () => {
    const { state, manifest } = fixture(), result = await capture(rawVariant(state), manifest);
    expect(result).toEqual({ state, stateHash: reviewHash(state) });
    expect(Object.keys(result).sort()).toEqual(["state", "stateHash"]);
  });

  it("normalizes UTC offsets while preserving a one-microsecond difference in both components", async () => {
    const { state, manifest } = fixture(), base = await capture(state, manifest), aliases = await capture(rawVariant(state), manifest);
    expect(aliases).toEqual(base);
    const domainLater = structuredClone(state); domainLater.domain.tables.products[0].created_at = "2026-10-15T23:59:59.123457Z";
    const itemLater = structuredClone(state); itemLater.items.tables.pipeline_item_leases[0].lease_until = "2001-02-03T04:05:06.000002Z";
    expect((await capture(domainLater, manifest)).stateHash).not.toBe(base.stateHash);
    expect((await capture(itemLater, manifest)).stateHash).not.toBe(base.stateHash);
  });

  it("never mutates raw rows or the manifest and returns independent nested copies", async () => {
    const { state, manifest } = fixture(), raw = rawVariant(state), before = structuredClone(raw), original = structuredClone(manifest);
    freeze(raw); freeze(manifest);
    const a = await capture(raw, manifest), b = await capture(raw, manifest);
    expect(a).toEqual(b); expect(a.state).not.toBe(b.state);
    const binding = a.state.items.tables.pipeline_item_leases[0].binding;
    if (binding.stage !== "ai2" || binding.source.kind !== "published") throw new Error("invalid_test_binding");
    binding.source.productId = 9999;
    (a.state.domain.universe[0].frozenInput as { source: { productUrl: string } }).source.productUrl = "mutated";
    a.state.domain.tables.products[0].id = 9999; a.state.items.tables.pipeline_stage_modes[0].epoch = 99;
    expect(raw).toEqual(before); expect(manifest).toEqual(original); expect(b.state).toEqual(state);
  });

  it("retains all 137 foreign domain/call/item rows without an eligibility or ownership cap", async () => {
    const { state, manifest } = fixture();
    state.domain.tables.products = Array.from({ length: 137 }, (_, id) => row(dbSchema.products, { id: 1000 + id })).reverse();
    state.domain.tables.capacity_calls = Array.from({ length: 137 }, (_, id) => ({ ...state.domain.tables.capacity_calls[0], call_id: `call-${1000 + id}` })).reverse();
    state.items.tables.pipeline_item_leases = Array.from({ length: 137 }, (_, id) => item(1000 + id)).reverse();
    const result = await capture(state, manifest);
    for (const rows of [result.state.domain.tables.products, result.state.domain.tables.capacity_calls,
      result.state.items.tables.pipeline_item_leases]) expect(rows).toHaveLength(137);
    expect(result.state.domain.tables.products.map(row => row.id)).toEqual(Array.from({ length: 137 }, (_, id) => 1000 + id));
    expect(result.state.items.tables.pipeline_item_leases.map(row => row.work_key)).toEqual(Array.from({ length: 137 }, (_, id) => `ai2:${1000 + id}`));
    expect(result.stateHash).toBe(reviewHash(result.state));
  });

  it("preserves stale/released owners and all table columns without issuing authority", async () => {
    const { state, manifest } = fixture(), result = await capture(state, manifest);
    for (const [name, table] of Object.entries(publicTables)) for (const record of result.state.domain.tables[name as keyof typeof publicTables])
      expect(Object.keys(record).sort()).toEqual(Object.values(getTableColumns(table)).map(column => column.name).sort());
    expect(result.state.items.tables.pipeline_item_leases).toEqual([item(10), { ...item(2), owner_instance_id: null,
      owner_boot_id: null, token: null, lease_until: null, item_epoch: 0 }]);
    expect(result.state.items.tables.pipeline_stage_modes.find(row => row.stage === "ai2")?.epoch).toBe(7);
    expect(ReplayReadinessProjectionSchema.safeParse(result.state).success).toBe(false);
    expect(() => parseReplayArtifact(result.state)).toThrow("invalid_replay_artifact");
    expect(() => replayArtifactFromVerified(result)).toThrow("verified_replay_artifact_required");
  });

  it("does not pretend that a read snapshot revalidates current domain against its frozen source", async () => {
    const { state, manifest } = fixture();
    state.domain.tables.crawl_documents[0].page_meta = { changedAfterFreezing: true };
    state.domain.tables.crawl_candidates[0].decided_by = "admin";
    expect((await capture(state, manifest)).state).toEqual(state);
  });

  it("accepts empty domain tables, calls and items without inventing rows or dropping the universe", async () => {
    const { state, manifest } = fixture();
    Object.keys(state.domain.tables).forEach(name => { state.domain.tables[name as keyof typeof state.domain.tables] = []; });
    state.items.tables.pipeline_item_leases = [];
    expect(await capture(state, manifest)).toEqual({ state, stateHash: reviewHash(state) });
  });
});

describe("full-envelope hash commitment", () => {
  for (const [name, table] of Object.entries(publicTables)) {
    for (const column of Object.values(getTableColumns(table))) {
      it(`commits domain ${name}.${column.name}`, async () => {
        const { state, manifest } = fixture(), before = await capture(state, manifest), changed = structuredClone(state);
        const record = changed.domain.tables[name as keyof typeof publicTables][0];
        record[column.name] = column.dataType === "date" ? "2026-10-15T23:59:59.123457Z"
          : column.name === "id" ? 999 : column.name === "name" || column.name === "key" ? "another-key" : { independentlyChanged: true };
        const result = await capture(changed, manifest);
        expect(result.stateHash).not.toBe(before.stateHash); expect(result.stateHash).toBe(reviewHash(result.state));
      });
    }
  }
  it.each(callColumns)("commits capacity_calls.%s", async column => {
    const { state, manifest } = fixture(), before = await capture(state, manifest);
    state.domain.tables.capacity_calls[0][column] = column === "dispatched_at" || column === "settled_at"
      ? "2026-10-15T23:59:59.123457Z" : "independently-changed";
    if (column === "run_id") { manifest.runId = "independently-changed";
      state.domain.tables.capacity_calls.forEach(row => { row.run_id = manifest.runId; }); }
    const result = await capture(state, manifest);
    expect(result.stateHash).not.toBe(before.stateHash); expect(result.stateHash).toBe(reviewHash(result.state));
  });
  it("commits each stage and item authority field, nested binding and the frozen universe", async () => {
    const { state, manifest } = fixture(), before = await capture(state, manifest);
    const variants = [
      (value: ReplayCombinedState) => { value.items.tables.pipeline_stage_modes[0].epoch++; },
      (value: ReplayCombinedState) => { value.items.tables.pipeline_stage_modes[0].writer_contract_version++; },
      (value: ReplayCombinedState) => { value.items.tables.pipeline_stage_modes[0].mode = "legacy"; },
      (value: ReplayCombinedState) => { value.items.tables.pipeline_item_leases[0].stage_epoch++; },
      (value: ReplayCombinedState) => { value.items.tables.pipeline_item_leases[0].item_epoch++; },
      (value: ReplayCombinedState) => { value.items.tables.pipeline_item_leases[0].owner_instance_id = "other-owner"; },
      (value: ReplayCombinedState) => { value.items.tables.pipeline_item_leases[0].owner_boot_id = token; },
      (value: ReplayCombinedState) => { value.items.tables.pipeline_item_leases[0].token = boot; },
      (value: ReplayCombinedState) => { const record = value.items.tables.pipeline_item_leases[0];
        if (record.binding.stage !== "ai2" || record.binding.source.kind !== "published") throw new Error("invalid_test_binding");
        record.binding.source.productId++; record.binding_hash = itemBindingHash(record.binding); },
      (value: ReplayCombinedState) => { const frozen = value.domain.universe[0].frozenInput as Record<string, unknown>;
        frozen.extraEvidence = "preserved"; value.domain.universe[0].frozenHash = reviewHash(frozen); },
    ];
    for (const mutate of variants) {
      const changed = structuredClone(state); mutate(changed);
      const result = await capture(changed, manifest);
      expect(result.stateHash).not.toBe(before.stateHash); expect(result.stateHash).toBe(reviewHash(result.state));
    }
  });
});

describe("validated manifest and exact DB frozen universe", () => {
  const invalidManifest: Array<[string, (value: Record<string, unknown>) => void]> = [
    ["unknown authority", value => { value.certified = true; }],
    ["wrong version", value => { value.version = 2; }],
    ["empty run", value => { value.runId = ""; }],
    ["noncanonical reference", value => { value.referenceTime = "2001-11-01T09:00:00.000+09:00"; }],
    ["backward window", value => { value.endedAt = value.startedAt; }],
    ["missing inputs", value => { value.inputs = []; }],
    ["unknown limits", value => { (value.limits as Record<string, unknown>).bypass = true; }],
    ["duplicate inputs", value => { const inputs = value.inputs as unknown[]; inputs.push(structuredClone(inputs[0])); }],
    ["model alias mismatch", value => { ((value.models as { first: Record<string, unknown> }).first).canonicalModel = "other"; }],
    ["unsafe candidate", value => { (value.inputs as Array<Record<string, unknown>>)[0].candidateId = Number.MAX_SAFE_INTEGER + 1; }],
  ];
  it.each(invalidManifest)("rejects %s before any SQL", async (_label, change) => {
    const { state, manifest } = fixture(), invalid = structuredClone(manifest) as unknown as Record<string, unknown>;
    change(invalid); const sql = sqlResult([{ state }]);
    expect(() => parseCapacityManifest(invalid)).toThrow();
    await expect(captureReplayCombinedState(sql.tx, invalid as unknown as CapacityManifest)).rejects.toThrow();
    expect(sql.calls).toEqual([]);
  });

  const invalidUniverse: Array<[string, (state: ReplayCombinedState) => void]> = [
    ["missing member", value => { value.domain.universe.pop(); }],
    ["additional internally valid member", value => { value.domain.universe.push(inputRows(33).identity); }],
    ["duplicate member", value => { value.domain.universe.push(structuredClone(value.domain.universe[0])); }],
    ["same-count different candidate", value => { value.domain.universe[0].candidateId = 33; }],
    ["same candidate different valid frozen input", value => { value.domain.universe[0] = inputRows(2, "Different actual title").identity; }],
    ["valid frozen but different policy", value => { value.domain.universe[0] = inputRows(2, undefined, true).identity; }],
    ["input hash", value => { value.domain.universe[0].inputHash = "a".repeat(64); }],
    ["source hash", value => { value.domain.universe[0].sourceRevisionHash = "b".repeat(64); }],
    ["frozen hash", value => { value.domain.universe[0].frozenHash = "c".repeat(64); }],
    ["policy hash", value => { value.domain.universe[0].policyHash = "d".repeat(64); }],
    ["frozen tamper", value => { (value.domain.universe[0].frozenInput as { source: { productUrl: string } }).source.productUrl = "tampered"; }],
    ["rehash does not repair inner tamper", value => { const entry = value.domain.universe[0];
      (entry.frozenInput as { snapshot: { product: { name: string } } }).snapshot.product.name = "tampered";
      entry.frozenHash = reviewHash(entry.frozenInput); }],
  ];
  it.each(invalidUniverse)("fails closed for DB universe %s", async (_label, change) => {
    const { state, manifest } = fixture(); change(state);
    await expect(capture(state, manifest)).rejects.toThrow();
  });

  it("accepts input-order permutation while retaining distinct generations for a candidate", async () => {
    const { state, manifest } = fixture(), another = inputRows(2, "Another valid generation").identity;
    const originalHash = manifest.inputs[0].inputHash;
    state.domain.universe.push(another); manifest.inputs.push({ ...manifest.inputs[0], inputHash: another.inputHash,
      sourceRevisionHash: another.sourceRevisionHash }); manifest.inputs.reverse();
    const result = await capture(state, manifest);
    expect(result.state.domain.universe).toHaveLength(3);
    expect(result.state.domain.universe.filter(identity => identity.candidateId === 2).map(identity => identity.inputHash).sort())
      .toEqual([originalHash, another.inputHash].sort());
    expect(result.stateHash).toBe(reviewHash(result.state));
  });
});

describe("strict raw result and original failures", () => {
  const invalidResults: Array<[string, (state: ReplayCombinedState) => unknown]> = [
    ["undefined", () => undefined], ["null", () => null], ["object", () => ({})], ["no row", () => []],
    ["two rows", state => [{ state }, { state }]], ["wrong alias", state => [{ row: state }]],
    ["null row", () => [null]], ["null state", () => [{ state: null }]],
    ["array-like result", state => ({ length: 1, 0: { state } })],
  ];
  it.each(invalidResults)("rejects %s without a default or second statement", async (_label, result) => {
    const { state, manifest } = fixture(), sql = sqlResult(result(state));
    await expect(captureReplayCombinedState(sql.tx, manifest)).rejects.toThrow(); expect(sql.calls).toHaveLength(1);
  });

  const invalidEnvelope: Array<[string, (state: Record<string, unknown>) => void]> = [
    ["unknown root", value => { value.authority = { verified: true }; }],
    ["wrong kind", value => { value.kind = "pipeline-replay-ledger"; }], ["wrong version", value => { value.version = 2; }],
    ["missing domain", value => { delete value.domain; }], ["missing items", value => { delete value.items; }],
    ["unknown domain", value => { (value.domain as Record<string, unknown>).capturedAt = utc; }],
    ["unknown items", value => { (value.items as Record<string, unknown>).ready = true; }],
  ];
  it.each(invalidEnvelope)("rejects %s envelope metadata", async (_label, change) => {
    const { state, manifest } = fixture(); change(state as unknown as Record<string, unknown>);
    await expect(capture(state, manifest)).rejects.toThrow();
  });

  for (const name of [...Object.keys(publicTables), "capacity_calls"] as Array<keyof ReplayReadinessProjection["tables"]>) {
    it(`rejects an incomplete ${name} row`, async () => {
      const { state, manifest } = fixture(); delete state.domain.tables[name][0][name === "jobs" ? "lease_token"
        : name === "capacity_calls" ? "failure_class" : name === "operations_observations" ? "value" : "id"];
      await expect(capture(state, manifest)).rejects.toThrow();
    });
    it(`rejects unknown ${name} columns instead of silently omitting them`, async () => {
      const { state, manifest } = fixture(); state.domain.tables[name][0].unrecorded_column = true;
      await expect(capture(state, manifest)).rejects.toThrow();
    });
  }

  it.each(["stage", "work_key", "binding", "binding_hash", "owner_instance_id", "owner_boot_id", "token", "stage_epoch", "item_epoch", "lease_until", "created_at", "updated_at"])("rejects missing item %s", async column => {
    const { state, manifest } = fixture(); delete (state.items.tables.pipeline_item_leases[0] as unknown as Record<string, unknown>)[column];
    await expect(capture(state, manifest)).rejects.toThrow();
  });

  const invalidItem: Array<[string, (state: ReplayCombinedState) => void]> = [
    ["missing stage", value => { value.items.tables.pipeline_stage_modes.pop(); }],
    ["duplicate stage", value => { value.items.tables.pipeline_stage_modes[0] = value.items.tables.pipeline_stage_modes[1]; }],
    ["duplicate item", value => { value.items.tables.pipeline_item_leases.push(value.items.tables.pipeline_item_leases[0]); }],
    ["partial owner", value => { value.items.tables.pipeline_item_leases[0].token = null; }],
    ["unsafe epoch", value => { value.items.tables.pipeline_item_leases[0].item_epoch = Number.MAX_SAFE_INTEGER + 1; }],
    ["binding hash mismatch", value => { value.items.tables.pipeline_item_leases[0].binding_hash = "e".repeat(64); }],
    ["binding logical key mismatch", value => { value.items.tables.pipeline_item_leases[0].work_key = "ai2:999"; }],
    ["invalid published generation", value => { const binding = value.items.tables.pipeline_item_leases[0].binding;
      if (binding.stage !== "ai2" || binding.source.kind !== "published") throw new Error("invalid_test_binding"); binding.source.productId = 0; }],
    ["invalid calendar", value => { value.items.tables.pipeline_item_leases[0].lease_until = "2026-02-30T00:00:00.000Z"; }],
    ["unsafe domain integer", value => { value.domain.tables.products[0].id = Number.MAX_SAFE_INTEGER + 1; }],
    ["duplicate domain row", value => { value.domain.tables.products.push(value.domain.tables.products[0]); }],
  ];
  it.each(invalidItem)("fails closed for %s", async (_label, change) => {
    const { state, manifest } = fixture(); change(state); await expect(capture(state, manifest)).rejects.toThrow();
  });

  it.each(["57014", "42501", "55P03", "08006"])("propagates original SQL %s identity without a fallback read", async code => {
    const { manifest } = fixture(), error = Object.assign(new Error(`database-${code}`), { code }), sql = sqlResult(undefined, error);
    await expect(captureReplayCombinedState(sql.tx, manifest)).rejects.toBe(error); expect(sql.calls).toHaveLength(1);
  });
  it("also preserves a non-Error rejection identity", async () => {
    const { manifest } = fixture(), error = { code: "57014", detail: "original cancellation" }, sql = sqlResult(undefined, error);
    await expect(captureReplayCombinedState(sql.tx, manifest)).rejects.toBe(error); expect(sql.calls).toHaveLength(1);
  });
});
