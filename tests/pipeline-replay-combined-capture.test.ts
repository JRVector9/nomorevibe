import { expect, it } from "vitest";
import type postgres from "postgres";
import { getTableColumns } from "drizzle-orm";
import * as schema from "@/lib/db/schema";
import { createReviewInput, reviewHash, REVIEW_PROMPT_VERSION, REVIEW_RULES_VERSION } from "@/lib/crawl/agent-review-contract";
import { README_SAMPLE_VERSION } from "@/lib/crawl/readme";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { itemBindingHash, type Ai1ItemBinding } from "@/lib/jobs/items/types";
import type { CapacityManifest } from "@/lib/operations/pipeline-capacity";
import type { ReplayReadinessProjection } from "@/lib/operations/pipeline-replay-readiness";
import { captureReplayCombinedState, type ReplayCombinedState } from "@/lib/operations/pipeline-replay-combined-capture";

const reference = "2001-11-01T00:00:00.000Z";
const utc = "2026-10-16T01:02:03.123001Z", rawAt = "2026-10-16 10:02:03.123001+09:00";
function row(table: Parameters<typeof getTableColumns>[0], values: Record<string, unknown>) {
  return { ...Object.fromEntries(Object.values(getTableColumns(table)).map(column => [column.name, null])), ...values } as
    ReplayReadinessProjection["tables"]["jobs"][number];
}
function payload(): ReplayCombinedState {
  const candidate = row(schema.crawlCandidates, { id: 1, repo: "combined/app", product_url: "https://combined.example",
    state: "approved", reason: "passed", decided_by: "auto", judged_at: reference, updated_at: rawAt });
  const document = row(schema.crawlDocuments, { id: 1, repo: "combined/app", product_url: "https://combined.example",
    fetched_at: "2001-10-31T23:59:59.000Z", page_status: 200,
    repo_meta: { description: "A deployed task tracker", homepage: "https://combined.example", fork: false,
      private: false, archived: false, owner: { type: "User" }, stargazers_count: 10 },
    page_meta: { title: "Task tracker", description: "Manage projects and tasks in your browser",
      textSample: "Create a project and manage tasks in the application.", readmeSample: "An online task tracker",
      readmeSampleVersion: README_SAMPLE_VERSION } });
  const settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true, reviewMode: "enforce" as const,
    firstReview: { provider: "abcllm" as const, model: "model-one" } };
  const typed = <T>(raw: Record<string, unknown>, table: Parameters<typeof getTableColumns>[0]): T => Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([key, column]) => [key, raw[column.name] === null ? null
      : column.dataType === "date" ? new Date(String(raw[column.name])) : column.mapFromDriverValue(raw[column.name])])) as T;
  const input = createReviewInput(typed(candidate, schema.crawlCandidates), typed(document, schema.crawlDocuments), settings,
    { scan: null, observations: [] }, new Date(reference));
  const frozenInput = JSON.parse(JSON.stringify(input));
  const binding: Ai1ItemBinding = { stage: "ai1", candidateId: 1, inputHash: input.inputHash,
    sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash,
    promptVersion: REVIEW_PROMPT_VERSION, rulesVersion: REVIEW_RULES_VERSION, reviewer: settings.firstReview };
  return { kind: "pipeline-replay-combined-state", version: 1, domain: {
    version: 1, referenceTime: reference, universe: [{ candidateId: 1, inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, policyHash: input.policyHash, frozenInput, frozenHash: reviewHash(frozenInput) }],
    tables: { crawl_settings: [row(schema.crawlSettings, { id: 1, values: settings })], crawl_candidates: [candidate],
      crawl_documents: [document], crawl_review_attempts: [], second_reviews: [], agent_repository_scans: [],
      agent_repository_observations: [], products: [], crawl_frontier: [],
      jobs: [row(schema.jobs, { name: "z-foreign", updated_at: rawAt }), row(schema.jobs, { name: "a-foreign", updated_at: rawAt })],
      operations_observations: [], capacity_calls: [] },
  }, items: { kind: "pipeline-replay-item-state", version: 1, tables: {
    pipeline_stage_modes: (["fetch", "ai2", "ai1"] as const).map(stage => ({ stage, mode: "legacy",
      draining_from: null, epoch: 1, writer_contract_version: 0, updated_at: rawAt })),
    pipeline_item_leases: [{ stage: "ai1", work_key: "ai1:1", binding, binding_hash: itemBindingHash(binding),
      owner_instance_id: "foreign-worker", owner_boot_id: "00000000-0000-4000-8000-000000000001",
      token: "00000000-0000-4000-8000-000000000002", stage_epoch: 1, item_epoch: 2,
      lease_until: rawAt, created_at: rawAt, updated_at: rawAt }],
  } } };
}
function expected(value = payload()): ReplayCombinedState {
  const state = structuredClone(value);
  state.domain.tables.crawl_candidates[0].updated_at = utc;
  state.domain.tables.jobs.reverse();
  for (const job of state.domain.tables.jobs) job.updated_at = utc;
  state.items.tables.pipeline_stage_modes.reverse();
  for (const stage of state.items.tables.pipeline_stage_modes) stage.updated_at = utc;
  for (const item of state.items.tables.pipeline_item_leases)
    item.lease_until = item.created_at = item.updated_at = utc;
  return state;
}
function manifest(state = payload()): CapacityManifest {
  return { version: 1, runId: "combined-unit", revision: "ee6bc24", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference, startedAt: reference, endedAt: "2001-11-01T00:00:01.000Z",
    inputPolicyHash: state.domain.universe[0].policyHash, fullReviewPolicyHash: "a".repeat(64),
    comparisonPolicyHash: "b".repeat(64), initialStateHash: "c".repeat(64),
    models: { first: { provider: "abcllm", model: "model-one", canonicalModel: "model-one" }, second: [], fallbacks: [] },
    inputs: state.domain.universe.map(input => ({ candidateId: input.candidateId, inputHash: input.inputHash,
      sourceRevisionHash: input.sourceRevisionHash, readyAt: reference, stratum: "new", reReview: false })),
    limits: { maxCalls: 4, maxTokens: 400, maxDurationMs: 120_000, concurrency: 1, perCallTokenUpperBound: 100 } };
}
// Raw SQL boundary only: this double grants no execution authority or MVCC evidence.
function sqlRows(result: unknown) {
  const statements: Array<{ sql: string; parameters: unknown[] }> = [];
  const tx = (async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    statements.push({ sql: strings.join("?"), parameters });
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as postgres.TransactionSql;
  return { tx, statements };
}

it("captures canonical full domain and item rows through one fixed parameterized SELECT", async () => {
  const input = payload(), before = structuredClone(input), checked = manifest(input), beforeManifest = structuredClone(checked);
  const db = sqlRows([{ state: input }]), captured = await captureReplayCombinedState(db.tx, checked);
  expect(captured.state).toEqual(expected());
  expect(input).toEqual(before);
  expect(checked).toEqual(beforeManifest);
  expect(db.statements).toHaveLength(1);
  expect(db.statements[0].parameters).toEqual([reference, checked.runId, checked.runId]);
  for (const name of Object.keys(input.domain.tables).filter(name => name !== "capacity_calls"))
    expect(db.statements[0].sql).toContain(`public.${name}`);
  for (const name of ["pipeline_replay.capacity_inputs", "pipeline_replay.capacity_calls", "public.pipeline_stage_modes", "public.pipeline_item_leases"])
    expect(db.statements[0].sql).toContain(name);
  expect(db.statements[0].sql).not.toMatch(/\b(?:LIMIT|FOR\s+UPDATE|FOR\s+SHARE|pg_advisory)\b/i);
});

it("hashes the entire canonical envelope while equivalent raw spellings have the same hash", async () => {
  const input = payload(), captured = await captureReplayCombinedState(sqlRows([{ state: input }]).tx, manifest(input));
  expect(captured.stateHash).toBe(reviewHash(expected()));
  const equivalent = expected();
  equivalent.domain.tables.jobs.reverse(); equivalent.items.tables.pipeline_stage_modes.reverse();
  expect((await captureReplayCombinedState(sqlRows([{ state: equivalent }]).tx, manifest(equivalent))).stateHash).toBe(captured.stateHash);
  const domainChanged = payload(); domainChanged.domain.tables.jobs[0].cursor = { foreign: "preserved" };
  const itemChanged = payload(); itemChanged.items.tables.pipeline_item_leases[0].item_epoch += 1;
  for (const state of [domainChanged, itemChanged])
    expect((await captureReplayCombinedState(sqlRows([{ state }]).tx, manifest(state))).stateHash).not.toBe(captured.stateHash);
});

it("retains the domain snapshot when there are no item lease rows", async () => {
  const state = payload(); state.items.tables.pipeline_item_leases = [];
  const canonical = expected(state);
  expect(await captureReplayCombinedState(sqlRows([{ state }]).tx, manifest(state)))
    .toEqual({ state: canonical, stateHash: reviewHash(canonical) });
});

it("clones nested raw state and rejects extra envelope or missing full-row columns", async () => {
  const input = payload(), before = structuredClone(input);
  const captured = await captureReplayCombinedState(sqlRows([{ state: input }]).tx, manifest(input));
  captured.state.domain.tables.jobs[0].cursor = { changed: true };
  const binding = captured.state.items.tables.pipeline_item_leases[0].binding;
  if (binding.stage !== "ai1") throw new Error("unexpected fixture binding");
  binding.reviewer.model = "changed";
  expect(input).toEqual(before);
  const extra = payload(), missing = payload();
  Object.assign(extra, { ready: true }); Reflect.deleteProperty(missing.domain.tables.crawl_documents[0], "page_meta");
  for (const state of [extra, missing])
    await expect(captureReplayCombinedState(sqlRows([{ state }]).tx, manifest(input))).rejects.toThrow();
});

it("validates the manifest before SQL and requires its exact DB frozen universe and policy", async () => {
  const input = payload(), checked = manifest(input), db = sqlRows([{ state: input }]);
  const invalid = { ...checked, limits: { ...checked.limits, concurrency: 0 } };
  await expect(captureReplayCombinedState(db.tx, invalid)).rejects.toThrow();
  expect(db.statements).toHaveLength(0);
  const missing = payload(), extra = payload(), wrong = payload(), duplicate = payload();
  missing.domain.universe = [];
  extra.domain.universe.push({ ...extra.domain.universe[0], candidateId: 2 });
  wrong.domain.universe[0].policyHash = "0".repeat(64);
  duplicate.domain.universe.push(structuredClone(duplicate.domain.universe[0]));
  for (const state of [missing, extra, wrong, duplicate])
    await expect(captureReplayCombinedState(sqlRows([{ state }]).tx, checked)).rejects.toThrow();
});

it("propagates original SQL cancellation and rejects non-array, wrong-cardinality and malformed results", async () => {
  const checked = manifest(), cancelled = Object.assign(new Error("canceling statement due to user request"), { code: "57014" });
  await expect(captureReplayCombinedState(sqlRows(cancelled).tx, checked)).rejects.toBe(cancelled);
  for (const result of [[], [{ state: payload() }, { state: payload() }], null, { length: 1, 0: { state: payload() } }, [{ state: null }]])
    await expect(captureReplayCombinedState(sqlRows(result).tx, checked)).rejects.toThrow();
});
