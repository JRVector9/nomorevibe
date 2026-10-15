import { beforeAll, afterAll, expect, it } from "vitest";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { TEST_DATABASE_URL } from "./setup";
import { getReplayIdentityPath } from "./replay-setup";
import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import type { CrawlCandidate, CrawlDocument } from "@/lib/db/schema";
import { createReviewInput, reviewHash } from "@/lib/crawl/agent-review-contract";
import { openVerifiedReplayDatabase, type VerifiedReplayDatabase } from "@/lib/operations/pipeline-replay-database";
import { ReplayLedger, type ReplayCallRequest, type ReplayRun } from "@/lib/operations/pipeline-replay-ledger";
import { runFixtureReplayCall } from "@/lib/operations/pipeline-replay-transport";
import type { CapacityManifest } from "@/lib/operations/pipeline-capacity";

let admin: postgres.Sql, database: VerifiedReplayDatabase, ledger: ReplayLedger;
let release: () => Promise<void>;
let identityPath: string;
let serial = 0;
const reference = new Date("2026-09-08T00:00:00.000Z");
function fixture(overrides: Partial<CapacityManifest["limits"]> = {}, mode: CapacityManifest["mode"] = "fixtures") {
  const candidate = { id: 1, repo: "owner/app", productUrl: "https://app.example", judgedAt: reference } as CrawlCandidate;
  const document = { id: 1, repo: candidate.repo, productUrl: candidate.productUrl, fetchedAt: reference,
    pageStatus: 200, repoMeta: { description: "A useful service" },
    pageMeta: { title: "App", description: "Service", readmeSample: "", repositoryKeys: ["owner/app"] } } as CrawlDocument;
  const input = createReviewInput(candidate, document, DEFAULT_CRAWL_SETTINGS, { scan: null, observations: [] }, reference);
  const hash = reviewHash({ fixture: true });
  const manifest: CapacityManifest = { version: 1, runId: `ledger-${++serial}`, revision: "2ce8cff", mode, cacheMode: "cold",
    referenceTime: reference.toISOString(), startedAt: reference.toISOString(), endedAt: new Date(+reference + 10_000).toISOString(),
    inputPolicyHash: input.policyHash, fullReviewPolicyHash: hash, comparisonPolicyHash: hash, initialStateHash: hash,
    models: { first: { provider: "abcllm", model: "first", canonicalModel: "first" },
      second: [{ provider: "abcllm", model: "second", canonicalModel: "second" }], fallbacks: [] },
    inputs: [{ candidateId: 1, inputHash: input.inputHash, sourceRevisionHash: input.sourceRevisionHash,
      readyAt: reference.toISOString(), stratum: "new", reReview: false }],
    limits: { maxCalls: 8, maxTokens: 800, perCallTokenUpperBound: 100, maxDurationMs: 10_000, concurrency: 2, ...overrides } };
  return { manifest, inputs: [{ candidateId: 1, input }] };
}
function request(run: ReplayRun, stage: "first" | "second" = "first", changes: Partial<ReplayCallRequest> = {}): ReplayCallRequest {
  void run;
  const { inputs } = fixture();
  return { callId: `call-${++serial}`, candidateId: 1, firstAttemptId: 11, stage,
    inputHash: inputs[0].input.inputHash, sourceRevisionHash: inputs[0].input.sourceRevisionHash,
    provider: "abcllm", model: stage, requestHash: reviewHash({ request: serial }), tokenUpperBound: 100,
    ...(stage === "second" ? { secondReviewId: 12, generationKey: "generation-1", vote: 12 } : {}), ...changes } as ReplayCallRequest;
}
async function prepare(overrides: Partial<CapacityManifest["limits"]> = {}, mode: CapacityManifest["mode"] = "fixtures") {
  const value = fixture(overrides, mode), run = await ledger.prepare(value.manifest, value.inputs);
  await ledger.start(run); return run;
}
async function clear() {
  await admin`TRUNCATE pipeline_replay.capacity_finals, pipeline_replay.capacity_transitions, pipeline_replay.capacity_calls,
    pipeline_replay.capacity_inputs, pipeline_replay.capacity_runs`;
}
beforeAll(async () => {
  const setup = await getReplayIdentityPath(); release = setup.release; identityPath = setup.identityPath;
  database = await openVerifiedReplayDatabase(setup.identityPath, {});
  admin = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
  await admin`DROP TABLE IF EXISTS pipeline_replay.capacity_finals, pipeline_replay.capacity_transitions, pipeline_replay.capacity_calls,
    pipeline_replay.capacity_inputs, pipeline_replay.capacity_runs`;
  await admin.unsafe(await readFile("scripts/sql/pipeline-replay-ledger.sql", "utf8"));
  const role = database.identity.roleName;
  await admin.unsafe(`GRANT SELECT, INSERT ON pipeline_replay.capacity_runs, pipeline_replay.capacity_inputs, pipeline_replay.capacity_calls, pipeline_replay.capacity_transitions TO "${role}"`);
  await admin.unsafe(`GRANT UPDATE (state, started_at, deadline_at, charged_calls, charged_tokens, event_seq)
    ON pipeline_replay.capacity_runs TO "${role}"`);
  await admin.unsafe(`GRANT UPDATE (state, dispatched_at, settled_at, input_tokens, output_tokens, result_ok, result_hash, result_decision_hash)
    ON pipeline_replay.capacity_calls TO "${role}"`);
  ledger = new ReplayLedger(database);
}, 20_000);
afterAll(async () => { await database?.close(); await admin?.end({ timeout: 3 }); await release?.(); });

it("binds frozen inputs and manifest immutably before starting; rejects altered inputs and fake handles", async () => {
  await clear();
  expect(() => new ReplayLedger({ ...database })).toThrow("verified_replay_database_required");
  const value = fixture();
  value.inputs[0].input.snapshot.product.name = "altered";
  await expect(ledger.prepare(value.manifest, value.inputs)).rejects.toThrow("replay_input_mismatch");
  const run = await prepare();
  await expect(ledger.inspect({ ...run })).rejects.toThrow("replay_run_required");
  for (const sql of ["UPDATE pipeline_replay.capacity_runs SET manifest = '{}'", "UPDATE pipeline_replay.capacity_inputs SET frozen_input = '{}'",
    "DELETE FROM pipeline_replay.capacity_transitions", "UPDATE pipeline_replay.capacity_calls SET request_hash = repeat('b',64)"])
    await expect(database.client.unsafe(sql)).rejects.toMatchObject({ code: "42501" });
  expect(await ledger.inspect(run)).toMatchObject({ evidence: "fixture_call_ledger_only", authenticity: "unverified", state: "running" });
});
it("serializes competing AI1/AI2 reservations under the same concurrency and token budget", async () => {
  await clear(); const run = await prepare({ concurrency: 1, maxCalls: 2, maxTokens: 200 });
  const results = await Promise.allSettled([ledger.reserve(run, request(run)), ledger.reserve(run, request(run, "second"))]);
  expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
  expect(await ledger.inspect(run)).toMatchObject({ chargedCalls: 1, chargedTokens: 100, activeCalls: 1 });
});
it("retains the whole cancelled reservation and rejects dispatch races and reused call IDs", async () => {
  await clear(); const run = await prepare({ maxCalls: 1, maxTokens: 100 }); const req = request(run);
  await ledger.reserve(run, req); await ledger.cancelBeforeDispatch(run, req.callId);
  await expect(ledger.markDispatching(run, req.callId)).rejects.toThrow("replay_call_state_mismatch");
  await expect(ledger.reserve(run, { ...req, callId: "next" })).rejects.toThrow("replay_budget_exhausted");
  expect(await ledger.inspect(run)).toMatchObject({ chargedCalls: 1, chargedTokens: 100, activeCalls: 0 });
});
it("persists stage-bound AI2 identity including nullable published first attempt and fallback root slot", async () => {
  await clear(); const run = await prepare();
  const req = request(run, "second", { firstAttemptId: null, secondReviewId: 21, generationKey: "published-generation", vote: 12 });
  await ledger.reserve(run, req);
  const [stored] = await admin`SELECT first_attempt_id, second_review_id, generation_key, vote FROM pipeline_replay.capacity_calls
    WHERE run_id = ${run.runId} AND call_id = ${req.callId}`;
  expect(stored).toEqual({ first_attempt_id: null, second_review_id: "21", generation_key: "published-generation", vote: "12" });
  const [event] = await admin`SELECT payload FROM pipeline_replay.capacity_transitions WHERE run_id = ${run.runId} AND kind = 'reserved'`;
  expect(event.payload).toMatchObject({ secondReviewId: 21, generationKey: "published-generation", vote: 12 });
});
it("rejects missing, malformed or first-stage AI2 identity before charging", async () => {
  await clear(); const run = await prepare();
  const first = request(run), second = request(run, "second");
  for (const invalid of [{ ...first, secondReviewId: 21, generationKey: "generation-1", vote: 12 },
    { ...first, firstAttemptId: null }, { ...second, secondReviewId: undefined }, { ...second, generationKey: undefined },
    { ...second, vote: undefined }, { ...second, secondReviewId: 0 }, { ...second, generationKey: "" }, { ...second, vote: 0 }])
    await expect(ledger.reserve(run, invalid as ReplayCallRequest)).rejects.toThrow("replay_call_binding_mismatch");
  expect(await ledger.inspect(run)).toMatchObject({ chargedCalls: 0, eventSeq: 2 });
});
it("records committed in-flight state before callback and does not refund unused tokens", async () => {
  await clear(); const run = await prepare(), req = request(run);
  let calls = 0;
  await runFixtureReplayCall(ledger, run, req, async () => {
    calls++;
    const [stored] = await admin`SELECT state FROM pipeline_replay.capacity_calls WHERE run_id = ${run.runId} AND call_id = ${req.callId}`;
    expect(stored.state).toBe("in_flight");
    expect(await ledger.inspect(run)).toMatchObject({ chargedCalls: 1, chargedTokens: 100 });
    return { inputTokens: 8, outputTokens: 2 };
  });
  expect(calls).toBe(1); expect(await ledger.inspect(run)).toMatchObject({ activeCalls: 0, chargedTokens: 100 });
  await expect(ledger.settle(run, req.callId, { inputTokens: 1, outputTokens: 1 })).rejects.toThrow("replay_call_state_mismatch");
});
it.each([null, { inputTokens: 100, outputTokens: 1 }, { inputTokens: -1, outputTokens: 1 }])(
  "closes admission on missing/invalid/excess usage without refund: %j", async receipt => {
    await clear(); const run = await prepare(), req = request(run);
    await ledger.reserve(run, req); await ledger.markDispatching(run, req.callId); await ledger.markInFlight(run, req.callId);
    await expect(ledger.settle(run, req.callId, receipt)).rejects.toThrow("replay_call_indeterminate");
    expect(await ledger.inspect(run)).toMatchObject({ state: "draining", activeCalls: 1, chargedTokens: 100 });
    await expect(ledger.reserve(run, request(run))).rejects.toThrow("replay_run_not_running");
    await expect(ledger.start(await ledger.prepare(fixture().manifest, fixture().inputs))).rejects.toThrow("replay_active_run_exists");
  });
it("fences run owners, input/model/request bindings and deadline before dispatch", async () => {
  await clear(); const run = await prepare();
  await expect(ledger.reserve(run, request(run, "first", { model: "other" }))).rejects.toThrow("replay_call_binding_mismatch");
  await expect(ledger.reserve(run, request(run, "first", { inputHash: "b".repeat(64) }))).rejects.toThrow("replay_call_binding_mismatch");
  await admin`UPDATE pipeline_replay.capacity_runs SET deadline_at = clock_timestamp() - interval '1 second' WHERE run_id = ${run.runId}`;
  await expect(ledger.reserve(run, request(run))).rejects.toThrow("replay_deadline_elapsed");
  expect(await ledger.inspect(run)).toMatchObject({ state: "draining", chargedCalls: 0 });
});
it("rejects actual provider mode before any reservation or fixture callback", async () => {
  await clear(); const run = await prepare({}, "model-replay"); let calls = 0;
  await expect(runFixtureReplayCall(ledger, run, request(run), async () => { calls++; return null; }))
    .rejects.toThrow("unsupported_provider_budget");
  expect(calls).toBe(0); expect(await ledger.inspect(run)).toMatchObject({ chargedCalls: 0 });
});
it("rolls back call insertion, charge and event sequence together on append failure", async () => {
  await clear(); const run = await prepare();
  await admin.unsafe(`REVOKE INSERT ON pipeline_replay.capacity_transitions FROM "${database.identity.roleName}"`);
  try { await expect(ledger.reserve(run, request(run))).rejects.toThrow("replay_ledger_operation_failed"); }
  finally { await admin.unsafe(`GRANT INSERT ON pipeline_replay.capacity_transitions TO "${database.identity.roleName}"`); }
  expect(await ledger.inspect(run)).toMatchObject({ chargedCalls: 0, chargedTokens: 0, activeCalls: 0, eventSeq: 2 });
});

it("shares the final call budget between simultaneous AI1 and AI2 admissions", async () => {
  await clear(); const run = await prepare({ concurrency: 4, maxCalls: 1, maxTokens: 100 });
  const results = await Promise.allSettled([ledger.reserve(run, request(run)), ledger.reserve(run, request(run, "second"))]);
  expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find(row => row.status === "rejected") as PromiseRejectedResult;
  expect(rejected.reason.message).toBe("replay_budget_exhausted");
  expect(await ledger.inspect(run)).toMatchObject({ chargedCalls: 1, chargedTokens: 100 });
});
it("never dispatches an existing reservation after drain or a wall-clock deadline", async () => {
  await clear(); const run = await prepare(), req = request(run);
  await ledger.reserve(run, req); await ledger.drain(run);
  await expect(ledger.markDispatching(run, req.callId)).rejects.toThrow("replay_run_not_running");
  await ledger.cancelBeforeDispatch(run, req.callId);
  await clear(); const next = await prepare(), expired = request(next);
  await ledger.reserve(next, expired);
  await admin`UPDATE pipeline_replay.capacity_runs SET deadline_at = clock_timestamp() - interval '1 second' WHERE run_id = ${next.runId}`;
  await expect(ledger.markDispatching(next, expired.callId)).rejects.toThrow("replay_deadline_elapsed");
  expect(await ledger.inspect(next)).toMatchObject({ state: "draining", chargedTokens: 100 });
});
it("cannot resend a duplicate call or hide a dispatching crash by starting another run", async () => {
  await clear(); const run = await prepare(), req = request(run);
  await ledger.reserve(run, req);
  await expect(ledger.reserve(run, req)).rejects.toThrow("replay_call_id_reused");
  await ledger.markDispatching(run, req.callId); await ledger.markIndeterminate(run, req.callId);
  await expect(ledger.markInFlight(run, req.callId)).rejects.toThrow("replay_run_not_running");
  const pending = fixture();
  await expect(ledger.start(await ledger.prepare(pending.manifest, pending.inputs))).rejects.toThrow("replay_active_run_exists");
  expect(await ledger.inspect(run)).toMatchObject({ state: "draining", chargedTokens: 100, activeCalls: 1 });
});
it("poisons admission immediately if recording a lost callback response fails", async () => {
  await clear(); const run = await prepare({ concurrency: 2 }), req = request(run);
  try {
    await expect(runFixtureReplayCall(ledger, run, req, async () => {
      await admin.unsafe(`REVOKE INSERT ON pipeline_replay.capacity_transitions FROM "${database.identity.roleName}"`);
      throw new Error("lost_fixture_response");
    })).rejects.toThrow("replay_call_indeterminate");
  } finally { await admin.unsafe(`GRANT INSERT ON pipeline_replay.capacity_transitions TO "${database.identity.roleName}"`); }
  await expect(ledger.reserve(run, request(run))).rejects.toThrow("replay_run_not_running");
  // Even if the uncertainty transaction failed, restart cannot reuse this run's owner handle.
  const next = fixture();
  await expect(ledger.start(await ledger.prepare(next.manifest, next.inputs))).rejects.toThrow("replay_active_run_exists");
});

it("reads admission wall time after obtaining a contended run lock", async () => {
  await clear(); const run = await prepare();
  await admin`UPDATE pipeline_replay.capacity_runs SET deadline_at = clock_timestamp() + interval '400 milliseconds' WHERE run_id = ${run.runId}`;
  let pending: Promise<unknown>;
  await admin.begin(async tx => {
    await tx`SELECT run_id FROM pipeline_replay.capacity_runs WHERE run_id = ${run.runId} FOR UPDATE`;
    pending = ledger.reserve(run, request(run)).then(() => "admitted", error => error.message);
    // Keep the unchanged row locked across the admission deadline.
    await tx`SELECT pg_sleep(0.55)`;
  });
  expect(await pending!).toBe("replay_deadline_elapsed");
  expect(await ledger.inspect(run)).toMatchObject({ state: "draining", chargedCalls: 0 });
});

it("admits only one run when independent verified connections start together", async () => {
  await clear();
  const otherDatabase = await openVerifiedReplayDatabase(identityPath, {});
  try {
    const other = new ReplayLedger(otherDatabase), a = fixture(), b = fixture();
    const first = await ledger.prepare(a.manifest, a.inputs), second = await other.prepare(b.manifest, b.inputs);
    const results = await Promise.allSettled([ledger.start(first), other.start(second)]);
    expect(results.filter(row => row.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(row => row.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toBe("replay_active_run_exists");
  } finally { await otherDatabase.close(); }
});
it("requires the exact configured route as well as canonical model identity", async () => {
  await clear(); const run = await prepare();
  await expect(ledger.reserve(run, request(run, "first", { model: "[MLX] first" })))
    .rejects.toThrow("replay_call_binding_mismatch");
  expect(await ledger.inspect(run)).toMatchObject({ chargedCalls: 0 });
});
it("rejects a manifest whose planned whole-call token budget exceeds its limit", async () => {
  await clear(); const value = fixture({ maxTokens: 799 });
  await expect(ledger.prepare(value.manifest, value.inputs)).rejects.toThrow("invalid_replay_manifest");
  const [row] = await admin`SELECT count(*)::int AS count FROM pipeline_replay.capacity_runs`;
  expect(row.count).toBe(0);
});
