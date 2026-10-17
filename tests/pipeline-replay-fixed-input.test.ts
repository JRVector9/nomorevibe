import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { assertIsolatedReplayDatabase, attachFixedInputLabels, compareFixedInputRuns, fixedInputSetHash, formatFixedInputCliError,
  parseFixedInputArtifact, parseFixedInputRunManifest, reportFixedInputRun, sha256, type FixedInputRunResult } from "@/lib/operations/pipeline-replay-fixed-input";
import { installReplayEgressGuard, startReplayModelMeter } from "@/lib/operations/pipeline-replay-model-meter";

const H = (seed: string) => sha256(seed);
const LOCAL = "postgres://nomorevibe:nomorevibe@127.0.0.1:55606/nomorevibe_test";

describe("isolated replay database guard", () => {
  it("accepts only one loopback nomorevibe_test URL with no override or shared service", () => {
    expect(assertIsolatedReplayDatabase(LOCAL, {})).toBe(LOCAL);
    for (const url of ["postgres://nomorevibe:secret@db.example.com:5432/nomorevibe", "postgres://u:p@100.99.209.55:6432/nomorevibe",
      "postgres://u:p@127.0.0.1:5432/nomorevibe", "postgres://u:p@evil.example@127.0.0.1:5432/nomorevibe_test",
      "postgres://u:p@127.0.0.1:5432/nomorevibe_test?host=db.example.com", "mysql://u:p@127.0.0.1/nomorevibe_test"]) {
      expect(() => assertIsolatedReplayDatabase(url, {})).toThrow("local_test_database_required");
    }
    expect(() => assertIsolatedReplayDatabase(undefined, {})).toThrow("explicit_TEST_DATABASE_URL_required");
    expect(() => assertIsolatedReplayDatabase(LOCAL, { PGHOST: "db.example.com" })).toThrow("database_override_rejected");
    expect(() => assertIsolatedReplayDatabase(LOCAL, { DATABASE_URL: "postgres://u:p@db.example.com/nomorevibe" })).toThrow("database_url_mismatch");
    expect(() => assertIsolatedReplayDatabase(LOCAL, { READ_DATABASE_URL: "postgres://replica" })).toThrow("replica_database_rejected");
    expect(() => assertIsolatedReplayDatabase(LOCAL, { VALKEY_URL: "redis://cache" })).toThrow("external_service_url_rejected");
    expect(() => assertIsolatedReplayDatabase(LOCAL, { MIGRATION_DATABASE_URL: "postgres://direct" })).toThrow("external_service_url_rejected");
  });
});

const manifest = (patch: Record<string, unknown> = {}) => ({ version: 1, runId: "legacy-a", mode: "legacy", artifactSha256: H("artifact"),
  upstream: "https://abcllm-api.brut.bot", durationMs: 1_800_000,
  limits: { maxCalls: 800, maxTokens: 800 * 32_768, perCallTokenUpperBound: 32_768, maxWallMs: 2_700_000 }, ...patch });
describe("run manifest", () => {
  it("binds call, token and wall limits before any execution", () => {
    expect(parseFixedInputRunManifest(manifest()).upstream).toBe("https://abcllm-api.brut.bot");
    expect(() => parseFixedInputRunManifest(manifest({ limits: { maxCalls: 800, maxTokens: 800 * 32_768 - 1, perCallTokenUpperBound: 32_768,
      maxWallMs: 2_700_000 } }))).toThrow("planned_token_budget_exceeded");
    expect(() => parseFixedInputRunManifest(manifest({ limits: { maxCalls: 800, maxTokens: 800 * 32_768, perCallTokenUpperBound: 32_768,
      maxWallMs: 1_800_000 } }))).toThrow("wall_limit_below_window");
    expect(() => parseFixedInputRunManifest(manifest({ durationMs: 1_799_999 }))).toThrow("replay_window_under_30_minutes");
    expect(() => parseFixedInputRunManifest(manifest({ mode: "items" }))).toThrow("invalid_replay_mode");
    for (const upstream of ["http://abcllm-api.brut.bot", "https://abcllm-api.brut.bot/v1", "https://user:pw@abcllm-api.brut.bot", "https://x.test/?a=1"])
      expect(() => parseFixedInputRunManifest(manifest({ upstream }))).toThrow("invalid_replay_upstream");
    expect(parseFixedInputRunManifest(manifest({ upstream: "http://127.0.0.1:4100" })).upstream).toBe("http://127.0.0.1:4100");
  });
});

describe("model meter and egress guard", () => {
  const servers: Server[] = [], releases: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (releases.length) await releases.pop()!();
    while (servers.length) await new Promise<void>(resolve => servers.pop()!.close(() => resolve()));
  });
  async function upstream(usage: (index: number) => unknown, extra: (index: number) => Record<string, unknown> = () => ({})) {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = ""; req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""} ${body}`);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ object: "chat.completion", usage: usage(seen.length), ...extra(seen.length) }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    servers.push(server);
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }
  async function meter(limits: { maxCalls: number; maxTokens: number; perCallTokenUpperBound: number }, usage: (index: number) => unknown,
    extra?: (index: number) => Record<string, unknown>) {
    const target = await upstream(usage, extra), stops: string[] = [];
    const started = await startReplayModelMeter({ upstream: target.origin, limits, onStop: reason => stops.push(reason) });
    let rejected = 0;
    const release = installReplayEgressGuard(target.origin, started, () => { rejected++; });
    releases.push(async () => { await release(); await started.close(); });
    const call = () => fetch(`${target.origin}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer k" }, body: '{"model":"m"}' });
    return { target, started, stops, call, rejected: () => rejected };
  }
  it("forwards through the meter, stops at the call cap and never sends the refused call upstream", async () => {
    const { target, started, stops, call } = await meter({ maxCalls: 2, maxTokens: 200, perCallTokenUpperBound: 100 },
      () => ({ prompt_tokens: 30, completion_tokens: 10 }));
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(503);
    expect(target.seen).toEqual(["POST /v1/chat/completions Bearer k {\"model\":\"m\"}", "POST /v1/chat/completions Bearer k {\"model\":\"m\"}"]);
    expect(stops).toEqual(["call_cap"]);
    expect(started.stats()).toMatchObject({ calls: 2, refused: 1, usageKnownCalls: 2, reportedInputTokens: 60, reportedOutputTokens: 20,
      chargedTokens: 80, models: [{ model: "m", calls: 2 }], usageProvenance: "reported_unverified" });
  });
  it("charges the full per-call bound when usage is unknown and stops at the token cap", async () => {
    const { target, started, stops, call } = await meter({ maxCalls: 10, maxTokens: 250, perCallTokenUpperBound: 100 }, () => undefined);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(503);
    expect(target.seen).toHaveLength(2);
    expect(stops).toEqual(["token_cap"]);
    expect(started.stats()).toMatchObject({ calls: 2, chargedTokens: 200, usageKnownCalls: 0 });
  });
  it("stops when reported usage contradicts the per-call bound", async () => {
    const { stops, started, call } = await meter({ maxCalls: 10, maxTokens: 1_000, perCallTokenUpperBound: 100 },
      () => ({ prompt_tokens: 90, completion_tokens: 20 }));
    expect((await call()).status).toBe(200);
    expect(stops).toEqual(["per_call_bound_exceeded"]);
    expect(started.stats().chargedTokens).toBe(110);
  });
  it("counts upstream-reported usage only with the native provenance and consistent totals (PR01b-9)", async () => {
    const usage = [{ prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 }, { prompt_tokens: 30, completion_tokens: 10, total_tokens: 41 },
      { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 }, { prompt_tokens: 30, completion_tokens: 10 }];
    const provenance = ["upstream_reported", "upstream_reported", "gateway_estimated", "upstream_reported"];
    const { started, call } = await meter({ maxCalls: 10, maxTokens: 1_000, perCallTokenUpperBound: 100 }, index => usage[index - 1],
      index => ({ usage_provenance: provenance[index - 1] }));
    for (let index = 0; index < 4; index++) expect((await call()).status).toBe(200);
    expect(started.stats()).toMatchObject({ calls: 4, usageKnownCalls: 4, chargedTokens: 160, upstreamReportedCalls: 1, upstreamReportedTokens: 40,
      usageProvenance: "reported_unverified" });
  });
  it("rejects every other origin, method and path in-process before any connection", async () => {
    const { target, call, rejected } = await meter({ maxCalls: 10, maxTokens: 1_000, perCallTokenUpperBound: 100 }, () => undefined);
    const other = await upstream(() => undefined);
    await expect(fetch(`${other.origin}/v1/chat/completions`, { method: "POST", body: "{}" })).rejects.toThrow();
    await expect(fetch(`${target.origin}/v1/models`)).rejects.toThrow();
    await expect(fetch(`${target.origin}/v1/embeddings`, { method: "POST", body: "{}" })).rejects.toThrow();
    await expect(fetch("https://api.github.com/repos/a/b")).rejects.toThrow();
    expect(other.seen).toEqual([]); expect(target.seen).toEqual([]);
    expect(rejected()).toBe(4);
    expect((await call()).status).toBe(200);
  });
});

/** 30분 구간·준비 증인·강제 모드의 최소 결과. 거절 결정은 AI2 관문 없이 AI1 완료가 곧 최종이다. */
function result(options: { runId: string; mode: "legacy" | "items"; finals: number; items?: number; readyMs?: number }): FixedInputRunResult {
  const start = "2026-10-20T00:00:00.000Z", end = "2026-10-20T00:30:00.000Z";
  const items = Array.from({ length: options.items ?? 40 }, (_, index) => ({ ordinal: index + 1, inputHash: H(`input-${index + 1}`) }));
  const attempts = Array.from({ length: options.finals }, (_, index) => ({ id: index + 1, candidateId: index + 1, inputHash: H(`input-${index + 1}`),
    state: "succeeded" as const, failure: null, provider: "abcllm", model: "[MLX] gpt-oss-120b", policyHash: H("policy"), promptVersion: "p",
    rulesVersion: "r", reusedFromAttemptId: null, decision: "reject" as const, reReview: false, readyMs: options.readyMs ?? -3_600_000,
    startedMs: 1_000 + index * 10_000, completedMs: 1_500 + index * 10_000, inputTokens: 18_000, outputTokens: 80 }));
  return { version: 1, scope: "fixed_input_replay_run", runId: options.runId, mode: options.mode, revision: "abcdef1", artifactSha256: H("artifact"),
    manifestSha256: H(options.runId), inputSetHash: fixedInputSetHash(items), inputs: { loaded: items.length, items, excluded: { notReviewable: 0, inputDrift: 0 } },
    window: { anchorAt: "2026-10-19T23:55:00.000Z", startedAt: start, endedAt: end, durationMs: 1_800_000, collectionStartedAt: start },
    stop: { reason: "window_end", atOffsetMs: 1_800_000, drainMs: 1_000, drainExceeded: false },
    meter: { calls: options.finals, refused: 0, upstreamFailed: 0, indeterminate: 0, maxInFlight: 2, usageKnownCalls: options.finals,
      reportedInputTokens: 18_000 * options.finals, reportedOutputTokens: 80 * options.finals, chargedTokens: 18_080 * options.finals,
      egressRejected: 0, models: [{ model: "[MLX] gpt-oss-120b", calls: options.finals }], usageProvenance: "reported_unverified" },
    writes: { products: 0, publishRuns: 0 }, failures: [],
    live: { version: 1, scope: "live_window", runId: options.runId, revision: "abcdef1", schema: { appliedMigrations: 93, absentTables: [] },
      window: { startedAt: start, endedAt: end, durationMs: 1_800_000, collectedAt: "2026-10-20T00:31:00.000Z", collectedAfterEndMs: 60_000 },
      database: { target: "primary", inRecovery: false, readOnly: true, isolation: "repeatable read", replicaCaughtUp: null, writeXidAssigned: false },
      identity: { promptVersion: "p", rulesVersion: "r", inputPolicyHash: H("policy"), comparisonPolicyHash: H("comparison"), fullReviewPolicyHash: H("full"),
        reviewMode: "enforce", secondGateRequired: true, concurrency: 2, settingsUpdatedMs: -300_000,
        models: { first: { provider: "abcllm", model: "[MLX] gpt-oss-120b", canonicalModel: "gpt-oss-120b" },
          second: [{ provider: "abcllm", model: "[supa] Qwen3.8-27B-NVFP4", canonicalModel: "[supa] qwen3.8-27b-nvfp4" }], fallbacks: [] } },
      stageModes: (["ai1", "ai2", "fetch"] as const).map(stage => ({ stage, mode: options.mode === "items" && stage !== "fetch" ? "items" as const : "legacy" as const,
        epoch: 1, changedSinceStart: false })),
      modelCapacity: { mode: options.mode === "items" ? "open" : "disabled", changedSinceStart: false },
      attempts, votes: [], candidates: attempts.map(row => ({ id: row.candidateId, state: "rejected" as const, decidedBy: "auto" as const, appliedAttemptId: row.id })),
      ai2Calls: { chains: 0, calls: 0, failed: 0, unattributedChains: 0 }, readiness: { witnesses: 5, sampleCandidateIds: [] },
      safety: { duplicatePublications: 0, humanDecisionOverrides: "unverified", leaseViolations: "unverified" }, budget: { status: "unverified" }, quality: null } };
}
describe("fixed-input report and judgment", () => {
  it("measures replay latency from AI1 start and applies the live 2x rule with replay evidence", () => {
    const baseline = result({ runId: "legacy-a", mode: "legacy", finals: 10 }), candidate = result({ runId: "items-a", mode: "items", finals: 25 });
    expect(reportFixedInputRun(baseline).latencyMs.endToEnd.p95).toBe(500);
    const compared = compareFixedInputRuns(baseline, candidate);
    expect(compared).toMatchObject({ performance: "passed", quality: "incomplete", safety: "incomplete", status: "incomplete", ratio: 2.5,
      numericThresholds: { doubled: true, latencyNotWorse: true, technicalFailureWithinOnePoint: true }, modes: { baseline: "legacy", candidate: "items" } });
    expect(compared.reasons).toEqual(expect.arrayContaining(["quality_unverified", "human_decision_override_unverified", "lease_violation_unverified",
      "budget_evidence_unverified"]));
    expect(compared.labelTemplate).toHaveLength(10);
    const labels = compared.labelTemplate.map(row => ({ ...row, expected: "reject" as const }));
    const labeled = compareFixedInputRuns(attachFixedInputLabels(baseline, labels), attachFixedInputLabels(candidate, labels));
    expect(labeled).toMatchObject({ performance: "passed", quality: "passed", status: "incomplete" });
    expect(() => attachFixedInputLabels(baseline, [{ candidateId: 99, inputHash: H("input-99"), expected: "reject" }])).toThrow("replay_label_unknown_input");
  });
  it("never compares different input sets, early stops, public writes or a non-legacy baseline", () => {
    const baseline = result({ runId: "legacy-a", mode: "legacy", finals: 10 });
    const other = result({ runId: "items-b", mode: "items", finals: 25, items: 39 });
    expect(compareFixedInputRuns(baseline, other)).toMatchObject({ performance: "incomplete", status: "incomplete" });
    expect(compareFixedInputRuns(baseline, other).reasons).toContain("replay_input_set_mismatch");
    const stopped = { ...result({ runId: "items-c", mode: "items", finals: 25 }), stop: { reason: "call_cap", atOffsetMs: 900_000, drainMs: 0, drainExceeded: false } };
    expect(compareFixedInputRuns(baseline, stopped).reasons).toContain("replay_stopped_early");
    const written = { ...result({ runId: "items-d", mode: "items", finals: 25 }), writes: { products: 1, publishRuns: 0 } };
    expect(compareFixedInputRuns(baseline, written).reasons).toContain("replay_public_write_detected");
    expect(compareFixedInputRuns(result({ runId: "items-e", mode: "items", finals: 10 }), result({ runId: "items-f", mode: "items", finals: 25 })).reasons)
      .toContain("replay_baseline_not_legacy");
    expect(compareFixedInputRuns(baseline, result({ runId: "items-g", mode: "items", finals: 19 }))).toMatchObject({ performance: "failed", status: "failed" });
  });
  it("rejects a result whose input set hash or ordinals do not match", () => {
    const base = result({ runId: "legacy-a", mode: "legacy", finals: 3 });
    expect(() => reportFixedInputRun({ ...base, inputSetHash: H("other") })).toThrow("fixed_input_result_mismatch");
  });
});

const artifact = () => ({ version: 1, scope: "fixed_input_replay", export: { revision: "abcdef1", exportedAt: "2026-10-17T00:00:00.000Z",
  from: "2026-10-13T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z", seed: "s", requested: 1, population: 1, examined: 1, selected: 1,
  exclusions: { modelChanged: 0, documentChanged: 0, scanChanged: 0, readmeMissing: 0, headroom: 0, inputDrift: 0, oversize: 0 },
  firstReviewer: { provider: "abcllm", model: "[MLX] gpt-oss-120b" }, inputPolicyHash: H("policy") }, settings: {},
  inputs: [{ ordinal: 1, repo: "owner/repo", production: { candidateId: 7, attemptId: 9, inputHash: H("i"), decision: "approve",
    provider: "abcllm", model: "[MLX] gpt-oss-120b" }, anchorAt: "2026-10-13T01:00:00.000Z", inputHash: H("i"),
    document: { repoMeta: {}, productUrl: "https://example.com", pageStatus: 200, pageMeta: {}, fetchedAgeUs: 1_000_000 }, scan: null, observations: [] }] });
describe("fixed-input artifact and CLI boundary", () => {
  it("keeps ordinals, unique repositories and production input parity", () => {
    expect(parseFixedInputArtifact(artifact()).inputs).toHaveLength(1);
    const drift = artifact(); drift.inputs[0].inputHash = H("other");
    expect(() => parseFixedInputArtifact(drift)).toThrow("fixed_input_artifact_mismatch");
    expect(formatFixedInputCliError(new Error("consumer_mode_blocked"))).toBe("consumer_mode_blocked");
    expect(formatFixedInputCliError(new Error("Failed query: select secret"))).toBe("capacity_operation_failed");
  });
  function cli(args: (directory: string) => string[], env: Record<string, string>) {
    const directory = mkdtempSync(join(tmpdir(), "nomorevibe-fixed-input-")), body = JSON.stringify(artifact());
    try {
      writeFileSync(join(directory, "artifact.json"), body, { mode: 0o600 });
      writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest({ artifactSha256: sha256(body) })), { mode: 0o600 });
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(PG|DATABASE_URL$|READ_DATABASE_URL$|TEST_DATABASE_URL$|MIGRATION_DATABASE_URL$|VALKEY_URL$|FIXED_INPUT_SOURCE_DATABASE_URL$|NODE_OPTIONS$)/.test(key)));
      return spawnSync(process.execPath, ["--import", "tsx", "scripts/pipeline-replay-fixed-input.ts", ...args(directory)], {
        cwd: process.cwd(), encoding: "utf8", timeout: 20_000, env: { ...inherited, NODE_ENV: "test", ...env } });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }
  it.each([
    ["postgres://nomorevibe:secret@db.example.com:5432/nomorevibe", {}, "local_test_database_required"],
    [LOCAL, { READ_DATABASE_URL: "postgres://u:p@replica.example.com/nomorevibe" }, "replica_database_rejected"],
    [LOCAL, { PGHOST: "db.example.com" }, "database_override_rejected"],
  ] as const)("run refuses %s before importing the driver or app", (url, extra, code) => {
    const child = cli(directory => ["run", join(directory, "manifest.json"), join(directory, "artifact.json"), join(directory, "out.json")],
      { TEST_DATABASE_URL: url, ...extra });
    expect(child.status).toBe(1);
    expect(child.stderr.trim()).toBe(code);
    expect(child.stdout).toBe("");
    expect(child.stderr).not.toContain("secret");
  });
  it("export requires one explicit read-only source URL", () => {
    const child = cli(directory => ["export", "2026-10-13T00:00:00.000Z", "2026-10-14T00:00:00.000Z", "s", "10", join(directory, "out.json")], {});
    expect(child.status).toBe(1);
    expect(child.stderr.trim()).toBe("explicit_FIXED_INPUT_SOURCE_DATABASE_URL_required");
  });
});

/** PR01b-9: 0097 장부가 구간을 덮고 안전 지표가 0이며, legacy는 계량기·items는 장부로 budget을 증명한 결과. */
function proven(options: { runId: string; mode: "legacy" | "items"; finals: number }): FixedInputRunResult {
  const value = result(options), { finals } = options;
  value.meter = { ...value.meter, upstreamReportedCalls: finals, upstreamReportedTokens: 18_080 * finals };
  value.budget = { declaredConcurrentCalls: options.mode === "legacy" ? 4 : null, callsAtStop: finals };
  value.live = { ...value.live, ledger: { startedAt: "2026-10-19T23:00:00.000Z", humanDecisionRefusals: 0, lateWritesRefused: 0 },
    safety: { duplicatePublications: 0, humanDecisionOverrides: 0, leaseViolations: 0 },
    budget: options.mode === "items" ? { status: "verified", source: "model_capacity_ledger", calls: finals, chargedTokens: 18_080 * finals,
      reportedCalls: finals, boundCalls: 0, concurrency: { limit: 4, peak: 2 } } : value.live.budget };
  return value;
}
function labeledPair(baseline: FixedInputRunResult, candidate: FixedInputRunResult) {
  const labels = compareFixedInputRuns(baseline, candidate).labelTemplate.map(row => ({ ...row, expected: "reject" as const }));
  return [attachFixedInputLabels(baseline, labels), attachFixedInputLabels(candidate, labels)] as const;
}
describe("fixed-input budget evidence (PR01b-9)", () => {
  it("proves a legacy baseline from the meter and an item candidate from the ledger, and can pass end to end", () => {
    const [baseline, candidate] = labeledPair(proven({ runId: "legacy-a", mode: "legacy", finals: 10 }), proven({ runId: "items-a", mode: "items", finals: 25 }));
    expect(reportFixedInputRun(baseline).budget).toEqual({ status: "verified", source: "replay_meter", calls: 10, chargedTokens: 180_800,
      reportedCalls: 10, boundCalls: 0, concurrency: { limit: 4, peak: 2 } });
    expect(reportFixedInputRun(candidate).budget).toMatchObject({ status: "verified", source: "model_capacity_ledger", calls: 25 });
    expect(compareFixedInputRuns(baseline, candidate)).toMatchObject({ status: "passed", performance: "passed", quality: "passed", safety: "passed",
      budgetEvidence: "verified", budget: { status: "passed", ratios: { callsPerFinal: 1, tokensPerFinal: 1 } }, reasons: [] });
  });
  it.each([
    ["the declared common budget", (base: FixedInputRunResult) => { base.budget = { declaredConcurrentCalls: null, callsAtStop: 10 }; }, ["concurrency_limit_undeclared"]],
    ["upstream usage on one baseline call", (base: FixedInputRunResult) => { base.meter.upstreamReportedCalls = 9; }, ["usage_unreported_without_bound"]],
    // 이전 결과에는 정지 순간 호출 수도 선언 한도도 없다.
    ["the budget record of an old result", (base: FixedInputRunResult) => { delete base.budget; }, ["concurrency_limit_undeclared", "replay_budget_unrecorded"]],
  ] as const)("is incomplete when only %s is missing", (_name, mutate, issues) => {
    const base = proven({ runId: "legacy-a", mode: "legacy", finals: 10 }); mutate(base);
    expect(reportFixedInputRun(base).budget).toEqual({ status: "unverified", source: "replay_meter", issues });
    const [baseline, candidate] = labeledPair(base, proven({ runId: "items-a", mode: "items", finals: 25 }));
    expect(compareFixedInputRuns(baseline, candidate)).toMatchObject({ status: "incomplete", performance: "passed", quality: "passed", safety: "passed",
      reasons: ["budget_evidence_unverified"] });
  });
  it("cross-checks item ledger evidence against the meter and refuses inconsistent budget records", () => {
    const items = proven({ runId: "items-a", mode: "items", finals: 25 });
    items.meter = { ...items.meter, calls: 26 }; items.budget = { declaredConcurrentCalls: null, callsAtStop: 26 };
    expect(reportFixedInputRun(items).budget).toMatchObject({ status: "unverified", issues: ["meter_calls_outside_ledger"] });
    expect(() => reportFixedInputRun({ ...items, budget: { declaredConcurrentCalls: null, callsAtStop: 27 } })).toThrow("fixed_input_result_mismatch");
    expect(() => reportFixedInputRun({ ...items, meter: { ...items.meter, upstreamReportedCalls: 27 } })).toThrow("fixed_input_result_mismatch");
    expect(() => parseFixedInputRunManifest(manifest({ budget: { maxConcurrentCalls: 0 } }))).toThrow();
    expect(parseFixedInputRunManifest(manifest({ budget: { maxConcurrentCalls: 4 } })).budget).toEqual({ maxConcurrentCalls: 4 });
  });
});
