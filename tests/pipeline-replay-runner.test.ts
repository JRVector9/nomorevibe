import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { comparisonReviewPolicyHash, fullReviewPolicyHash, type CapacityManifest } from "@/lib/operations/pipeline-capacity";
import { reviewPolicyHash, type ReviewInput } from "@/lib/crawl/agent-review-contract";
import { DEFAULT_CRAWL_SETTINGS, type CrawlSettings } from "@/lib/crawl/settings-schema";
import { canonicalReviewModel } from "@/lib/crawl/review-model-identity";

const fake = vi.hoisted(() => ({
  open: vi.fn(), close: vi.fn(), prepare: vi.fn(), start: vi.fn(), drain: vi.fn(), inspect: vi.fn(),
  dbScope: vi.fn(), currentDb: vi.fn(), identity: vi.fn(), semantic: vi.fn(), transport: vi.fn(), runJob: vi.fn(),
  first: vi.fn(), second: vi.fn(), settings: vi.fn(), traces: [] as string[],
}));
vi.mock("@/lib/operations/pipeline-replay-database", () => ({ openVerifiedReplayHandlerDatabase: fake.open }));
vi.mock("@/lib/operations/pipeline-replay-ledger", () => ({ ReplayLedger: class {
  prepare = fake.prepare; start = fake.start; drain = fake.drain; inspect = fake.inspect;
} }));
vi.mock("@/lib/db/replay-scope", () => ({ withReplayDatabaseScope: fake.dbScope, currentReplayDb: fake.currentDb, assertReplayDatabaseScopeIdentity: fake.identity }));
vi.mock("@/lib/crawl/review-replay-context", () => ({ withReviewReplayContext: fake.semantic }));
vi.mock("@/lib/crawl/review-fixture-transport", () => ({ withReviewFixtureTransport: fake.transport }));
vi.mock("@/lib/jobs/runner", () => ({ runJob: fake.runJob }));
vi.mock("@/lib/crawl/jobs/agent-review", () => ({ reviewCrawlCandidates: fake.first }));
vi.mock("@/lib/crawl/jobs/second-review", () => ({ secondReviewCandidates: fake.second }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: fake.settings }));
import { runFixtureReviewReplay } from "@/lib/operations/pipeline-replay-runner";

const reference = "2001-10-01T00:00:00.000Z", hash = "a".repeat(64);
function settings(): CrawlSettings {
  return { ...structuredClone(DEFAULT_CRAWL_SETTINGS), enabled: true, reviewMode: "enforce",
    firstReview: { provider: "abcllm", model: "first" },
    secondReview: { ...structuredClone(DEFAULT_CRAWL_SETTINGS.secondReview), enabled: true,
      voters: [{ provider: "abcllm", model: "second" }, { provider: "abcllm", model: "second-other" }],
      fallbacks: [{ provider: "abcllm", model: "fallback" }] } };
}
function options() {
  const policy = settings();
  const identity = (value: { provider: "abcllm" | "claude-cli" | "grok-cli"; model: string }) => ({ ...value, canonicalModel: canonicalReviewModel(value.model) });
  const manifest: CapacityManifest = { version: 1, runId: "runner-unit", revision: "9601e3b", mode: "fixtures", cacheMode: "cold",
    referenceTime: reference, startedAt: reference, endedAt: "2001-10-01T00:00:10.000Z",
    inputPolicyHash: reviewPolicyHash(policy), fullReviewPolicyHash: fullReviewPolicyHash(policy), comparisonPolicyHash: comparisonReviewPolicyHash(policy), initialStateHash: hash,
    models: { first: identity(policy.firstReview!), second: policy.secondReview.voters.map(identity), fallbacks: policy.secondReview.fallbacks!.map(identity) },
    inputs: [{ candidateId: 1, inputHash: hash, sourceRevisionHash: hash, readyAt: reference, stratum: "new", reReview: false }],
    limits: { maxCalls: 8, maxTokens: 800, perCallTokenUpperBound: 100, maxDurationMs: 10_000, concurrency: 2 } };
  return { identityPath: "protected-identity", manifest, inputs: [{ candidateId: 1, input: {} as ReviewInput }], fixture: vi.fn() };
}
const run = Object.freeze({ runId: "runner-unit" });
const rawDatabase = { close: fake.close };
beforeEach(() => {
  vi.resetAllMocks(); fake.traces.length = 0;
  fake.open.mockImplementation(async () => { fake.traces.push("open-raw"); return rawDatabase; });
  fake.close.mockImplementation(async () => { fake.traces.push("close-raw"); });
  fake.settings.mockImplementation(async () => settings());
  fake.prepare.mockImplementation(async () => { fake.traces.push("prepare"); return run; });
  fake.start.mockImplementation(async () => { fake.traces.push("start"); });
  fake.drain.mockImplementation(async () => { fake.traces.push("drain"); });
  fake.inspect.mockImplementation(async () => { fake.traces.push("inspect"); return { evidence: "fixture_call_ledger_only", authenticity: "unverified", finalThroughput: null }; });
  fake.dbScope.mockImplementation(async (_identity: string, load: () => Promise<unknown>) => {
    fake.traces.push("db-enter"); try { return await load(); } finally { fake.traces.push("db-exit"); }
  });
  fake.identity.mockImplementation(() => { fake.traces.push("same-identity"); });
  fake.semantic.mockImplementation(async (_options: unknown, load: () => Promise<unknown>) => {
    fake.traces.push("clock-enter"); try { return await load(); } finally { fake.traces.push("clock-exit"); }
  });
  fake.transport.mockImplementation(async (_options: unknown, load: () => Promise<unknown>) => {
    fake.traces.push("fixture-enter"); try { return await load(); } finally { fake.traces.push("fixture-exit"); }
  });
  fake.runJob.mockImplementation(async (name: string) => { fake.traces.push(name); return { status: "completed", done: true, durationMs: 1 }; });
});
afterEach(() => { vi.useRealTimers(); });

it("opens owned connections and runs only the fixed actual handlers under frozen fixture scopes", async () => {
  const value = options();
  const result = await runFixtureReviewReplay(value);
  expect(fake.open).toHaveBeenCalledWith(value.identityPath, {});
  expect(fake.identity).toHaveBeenCalledWith(rawDatabase);
  expect(fake.prepare).toHaveBeenCalledWith(value.manifest, value.inputs);
  expect(fake.semantic).toHaveBeenCalledWith({ referenceTime: new Date(reference) }, expect.any(Function));
  expect(fake.transport).toHaveBeenCalledWith(expect.objectContaining({ run, fixture: value.fixture,
    fullReviewPolicyHash: value.manifest.fullReviewPolicyHash, tokenUpperBound: 100 }), expect.any(Function));
  expect(fake.runJob.mock.calls).toEqual([
    ["crawl-agent-review", fake.first, { requestedOnly: true, budgetMs: 110_000, signal: expect.any(AbortSignal) }],
    ["second-review", fake.second, { requestedOnly: true, budgetMs: 110_000, signal: expect.any(AbortSignal) }],
  ]);
  expect(result).toMatchObject({ runId: run.runId, jobs: [{ name: "crawl-agent-review" }, { name: "second-review" }],
    diagnostics: { evidence: "fixture_call_ledger_only", authenticity: "unverified", finalThroughput: null } });
  expect(fake.traces).toEqual(["open-raw", "prepare", "start", "db-enter", "same-identity", "clock-enter", "fixture-enter",
    "crawl-agent-review", "second-review", "fixture-exit", "clock-exit", "db-exit", "drain", "inspect", "close-raw"]);
});

it.each(["crawl-fetch", "crawl-publish", "unknown"])("rejects caller job %s before opening connections", async name => {
  await expect(runFixtureReviewReplay({ ...options(), jobs: [name] as never })).rejects.toThrow("replay_job_not_allowed");
  expect(fake.open).not.toHaveBeenCalled(); expect(fake.runJob).not.toHaveBeenCalled();
});

it("refuses real-provider mode before DB open or callback", async () => {
  const value = options(); value.manifest.mode = "model-replay";
  await expect(runFixtureReviewReplay(value)).rejects.toThrow("unsupported_provider_budget");
  expect(fake.open).not.toHaveBeenCalled(); expect(value.fixture).not.toHaveBeenCalled();
});

it("rejects malformed fixture-run options before opening the identity", async () => {
  await expect(runFixtureReviewReplay({ ...options(), budgetMs: -1 })).rejects.toThrow("invalid_replay_runner_options");
  await expect(runFixtureReviewReplay({ ...options(), jobs: [] })).rejects.toThrow("invalid_replay_runner_options");
  expect(fake.open).not.toHaveBeenCalled();
});

it("snapshots the job sequence before awaited admission", async () => {
  const jobs: Array<"crawl-agent-review" | "second-review"> = ["crawl-agent-review"];
  fake.start.mockImplementation(async () => { jobs[0] = "crawl-publish" as never; });
  await runFixtureReviewReplay({ ...options(), jobs, budgetMs: 30_000 });
  expect(fake.runJob).toHaveBeenCalledExactlyOnceWith("crawl-agent-review", fake.first, { requestedOnly: true, budgetMs: 30_000, signal: expect.any(AbortSignal) });
});

it("binds the raw ledger identity before any review claim and drains on mismatch", async () => {
  fake.identity.mockImplementation(() => { throw new Error("replay_database_identity_mismatch"); });
  await expect(runFixtureReviewReplay(options())).rejects.toThrow("replay_database_identity_mismatch");
  expect(fake.runJob).not.toHaveBeenCalled();
  expect(fake.drain).toHaveBeenCalledWith(run); expect(fake.close).toHaveBeenCalledTimes(1);
});

it("waits for each job including its heartbeat before scope teardown", async () => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  fake.runJob.mockImplementation(async () => { fake.traces.push("held-job"); await held; return { status: "completed", done: true, durationMs: 1 }; });
  const pending = runFixtureReviewReplay({ ...options(), jobs: ["crawl-agent-review"] });
  await vi.waitFor(() => expect(fake.traces).toContain("held-job"));
  expect(fake.traces).not.toContain("db-exit"); expect(fake.close).not.toHaveBeenCalled();
  release(); await pending;
  expect(fake.traces.indexOf("held-job")).toBeLessThan(fake.traces.indexOf("db-exit"));
});

it("drains and closes when a claimed job reports failure, without starting another review", async () => {
  fake.runJob.mockResolvedValueOnce({ status: "failed", error: "writer_failed", durationMs: 1 });
  const result = await runFixtureReviewReplay(options());
  expect(result.jobs).toHaveLength(1);
  expect(result.jobs[0].result).toMatchObject({ status: "failed" });
  expect(fake.drain).toHaveBeenCalledWith(run); expect(fake.close).toHaveBeenCalledTimes(1);
});

it("drains admission and closes raw ownership after unexpected dispatch failure", async () => {
  fake.runJob.mockRejectedValueOnce(new Error("claim_failed"));
  await expect(runFixtureReviewReplay(options())).rejects.toThrow("claim_failed");
  expect(fake.traces.slice(-2)).toEqual(["drain", "close-raw"]);
});

it("does not return success diagnostics when drain fails", async () => {
  fake.drain.mockRejectedValueOnce(new Error("drain_failed"));
  await expect(runFixtureReviewReplay(options())).rejects.toThrow("drain_failed");
  expect(fake.inspect).not.toHaveBeenCalled(); expect(fake.close).toHaveBeenCalledTimes(1);
});

it.each(["prepare", "start"] as const)("closes the raw connection when %s fails", async method => {
  fake[method].mockRejectedValueOnce(new Error(`${method}_failed`));
  await expect(runFixtureReviewReplay(options())).rejects.toThrow(`${method}_failed`);
  expect(fake.close).toHaveBeenCalledTimes(1); expect(fake.runJob).not.toHaveBeenCalled();
});

it.each(["inputPolicyHash", "fullReviewPolicyHash", "comparisonPolicyHash"] as const)("rejects mismatched actual DB %s before claims or fixture callbacks", async field => {
  const value = options(); value.manifest[field] = "b".repeat(64);
  await expect(runFixtureReviewReplay(value)).rejects.toThrow("replay_settings_mismatch");
  expect(fake.runJob).not.toHaveBeenCalled(); expect(value.fixture).not.toHaveBeenCalled();
  expect(fake.drain).toHaveBeenCalledWith(run); expect(fake.close).toHaveBeenCalledTimes(1);
});

it.each(["first", "second", "fallbacks"] as const)("rejects an exact-model mismatch in the %s pool even when canonical identity matches", async pool => {
  const value = options();
  const model = pool === "first" ? value.manifest.models.first : value.manifest.models[pool][0];
  model.model = `[MLX] ${model.model}`;
  await expect(runFixtureReviewReplay(value)).rejects.toThrow("replay_settings_mismatch");
  expect(fake.runJob).not.toHaveBeenCalled(); expect(value.fixture).not.toHaveBeenCalled();
});

it("preserves the configured order of second-review voter slots", async () => {
  const value = options(); value.manifest.models.second.reverse();
  await expect(runFixtureReviewReplay(value)).rejects.toThrow("replay_settings_mismatch");
  expect(fake.runJob).not.toHaveBeenCalled();
});

it("rechecks actual settings before a second claim after the first tick changes policy", async () => {
  const changed = settings(); changed.reviewConcurrency++;
  fake.settings.mockResolvedValueOnce(settings()).mockResolvedValueOnce(changed);
  await expect(runFixtureReviewReplay(options())).rejects.toThrow("replay_settings_mismatch");
  expect(fake.runJob).toHaveBeenCalledTimes(1);
  expect(fake.drain).toHaveBeenCalledWith(run); expect(fake.close).toHaveBeenCalledTimes(1);
});

it("snapshots prepared inputs before opening either owned connection", async () => {
  const value = options(); value.inputs[0].input = { validUntil: new Date(reference) } as ReviewInput;
  fake.open.mockImplementation(async () => { value.inputs[0].input.validUntil.setUTCFullYear(2026); return rawDatabase; });
  await runFixtureReviewReplay(value);
  const prepared = fake.prepare.mock.calls[0][1];
  expect(prepared[0].input.validUntil).toEqual(new Date(reference));
  expect(fake.transport.mock.calls[0][0].inputs).toBe(prepared);
});

it("requires an owned root database scope instead of borrowing an enclosing scope", async () => {
  fake.currentDb.mockReturnValue({});
  await expect(runFixtureReviewReplay(options())).rejects.toThrow("replay_runner_scope_conflict");
  expect(fake.open).not.toHaveBeenCalled(); expect(fake.runJob).not.toHaveBeenCalled();
});

it("rejects inherited stale database scopes before opening a new owner", async () => {
  fake.currentDb.mockImplementation(() => { throw new Error("replay_database_scope_closed"); });
  await expect(runFixtureReviewReplay(options())).rejects.toThrow("replay_database_scope_closed");
  expect(fake.open).not.toHaveBeenCalled();
});

it("bounds a blocked handler with the manifest wall duration and drains before returning", async () => {
  vi.useFakeTimers();
  let observedSignal: AbortSignal | undefined;
  fake.runJob.mockImplementation(async (_name: string, _handler: unknown, options: { signal?: AbortSignal }) => {
    observedSignal = options.signal;
    if (!options.signal) return { status: "completed", done: true, durationMs: 0 };
    await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
    return { status: "skipped", reason: "stopping" };
  });
  const pending = runFixtureReviewReplay(options());
  await vi.advanceTimersByTimeAsync(0);
  expect(observedSignal).toBeInstanceOf(AbortSignal);
  expect(observedSignal!.aborted).toBe(false);
  expect(fake.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(9_999);
  expect(observedSignal!.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).resolves.toMatchObject({ jobs: [{ result: { status: "skipped", reason: "stopping" } }] });
  expect(fake.runJob).toHaveBeenCalledTimes(1);
  expect(fake.traces.slice(-3)).toEqual(["drain", "inspect", "close-raw"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("starts the run deadline before awaiting ledger start and retains caller cancellation", async () => {
  vi.useFakeTimers();
  const caller = new AbortController();
  fake.start.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 8_000)); });
  fake.runJob.mockImplementation(async (_name: string, _handler: unknown, options: { signal?: AbortSignal }) => {
    if (!options.signal) return { status: "completed", done: true, durationMs: 0 };
    await new Promise<void>(resolve => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
    return { status: "skipped", reason: "stopping" };
  });
  const pending = runFixtureReviewReplay({ ...options(), signal: caller.signal });
  await vi.advanceTimersByTimeAsync(8_000);
  const signal = fake.runJob.mock.calls[0]?.[2].signal as AbortSignal;
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(signal.aborted).toBe(true);
  await pending;
  expect(caller.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("forwards caller cancellation through the bounded run signal", async () => {
  const caller = new AbortController();
  fake.runJob.mockImplementation(async (_name: string, _handler: unknown, options: { signal: AbortSignal }) => {
    caller.abort();
    expect(options.signal.aborted).toBe(true);
    return { status: "skipped", reason: "stopping" };
  });
  await runFixtureReviewReplay({ ...options(), signal: caller.signal });
  expect(fake.runJob).toHaveBeenCalledTimes(1);
});

it("captures caller cancellation before awaited connection admission", async () => {
  const caller = new AbortController();
  const value = { ...options(), signal: caller.signal };
  fake.open.mockImplementation(async () => {
    value.signal = new AbortController().signal;
    caller.abort();
    return rawDatabase;
  });
  fake.runJob.mockImplementation(async (_name: string, _handler: unknown, options: { signal: AbortSignal }) => {
    expect(options.signal.aborted).toBe(true);
    return { status: "skipped", reason: "stopping" };
  });
  await runFixtureReviewReplay(value);
  expect(fake.runJob).toHaveBeenCalledTimes(1);
});

it("keeps the wall timer until owned raw DB close has completed", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  fake.close.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); });
  const pending = runFixtureReviewReplay(options());
  await vi.advanceTimersByTimeAsync(0);
  expect(fake.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  release(); await pending;
  expect(vi.getTimerCount()).toBe(0);
});
