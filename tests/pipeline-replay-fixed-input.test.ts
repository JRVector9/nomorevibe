import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertIsolatedReplayDatabase, attachFixedInputLabels, compareFixedInputRuns, fixedInputRunConditions, fixedInputSetHash, formatFixedInputCliError,
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
  async function upstream(usage: (index: number) => unknown, extra: (index: number) => Record<string, unknown> = () => ({}), delayMs = 0) {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      let body = ""; req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        seen.push(`${req.method} ${req.url} ${req.headers.authorization ?? ""} ${body}`);
        const index = seen.length, answer = () => { if (res.destroyed) return; res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ object: "chat.completion", usage: usage(index), ...extra(index) })); };
        if (delayMs) setTimeout(answer, delayMs).unref(); else answer();
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    servers.push(server);
    return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
  }
  async function meter(limits: { maxCalls: number; maxTokens: number; perCallTokenUpperBound: number }, usage: (index: number) => unknown,
    extra?: (index: number) => Record<string, unknown>, delayMs = 0) {
    const target = await upstream(usage, extra, delayMs), stops: string[] = [];
    const started = await startReplayModelMeter({ upstream: target.origin, limits, onStop: reason => stops.push(reason) });
    let rejected = 0;
    const release = installReplayEgressGuard(target.origin, started, () => { rejected++; });
    releases.push(async () => { await release(); await started.close(); });
    const call = (signal?: AbortSignal) => fetch(`${target.origin}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer k" },
      body: '{"model":"m"}', signal });
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
  // 구간 끝 drain: 호출자(워커)는 정지 신호로 끊어도, 이미 보낸 호출은 drain 상한까지 upstream이 끝나 usage가 남는다.
  const reported = () => ({ prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 }), native = () => ({ usage_provenance: "upstream_reported" });
  async function dropped(started: Awaited<ReturnType<typeof meter>>["started"], call: (signal?: AbortSignal) => Promise<Response>) {
    const caller = new AbortController(), pending = call(caller.signal).then(() => "answered", (error: Error) => error.name);
    await vi.waitFor(() => expect(started.stats().calls).toBe(1));
    return { caller, pending };
  }
  it("cuts a call its caller dropped mid-window at once (no drain)", async () => {
    const { started, call } = await meter({ maxCalls: 10, maxTokens: 1_000, perCallTokenUpperBound: 100 }, reported, native, 1_500);
    const { caller, pending } = await dropped(started, call);
    caller.abort();
    expect(await pending).toBe("AbortError");
    await vi.waitFor(() => expect(started.stats()).toMatchObject({ calls: 1, indeterminate: 1, upstreamReportedCalls: 0, chargedTokens: 100 }));
  });
  it("lets a call in flight at the window end finish upstream within the drain limit, records its usage and sends no new call", async () => {
    const { target, started, call } = await meter({ maxCalls: 10, maxTokens: 1_000, perCallTokenUpperBound: 100 }, reported, native, 300);
    const { caller, pending } = await dropped(started, call);
    const drained = started.drain(Date.now() + 5_000); caller.abort();
    expect(await pending).toBe("AbortError");
    expect(await drained).toMatchObject({ inFlightAtStop: 1, cutAtLimit: 0 });
    expect(started.stats()).toMatchObject({ calls: 1, indeterminate: 0, upstreamFailed: 0, usageKnownCalls: 1, upstreamReportedCalls: 1,
      upstreamReportedTokens: 40, chargedTokens: 40, refused: 0 });
    // 구간 끝 뒤 새 호출은 upstream으로 보내지 않고 거부로 센다(결과에 replay_calls_refused가 붙는다).
    expect((await call()).status).toBe(503);
    expect(target.seen).toHaveLength(1);
    expect(started.stats()).toMatchObject({ calls: 1, refused: 1 });
  });
  it("cuts a call still running at the drain limit as indeterminate", async () => {
    const { started, call } = await meter({ maxCalls: 10, maxTokens: 1_000, perCallTokenUpperBound: 100 }, reported, native, 3_000);
    const { caller, pending } = await dropped(started, call);
    const drained = started.drain(Date.now() + 200); caller.abort();
    expect(await pending).toBe("AbortError");
    expect(await drained).toMatchObject({ inFlightAtStop: 1, cutAtLimit: 1 });
    expect(started.stats()).toMatchObject({ calls: 1, indeterminate: 1, upstreamReportedCalls: 0, chargedTokens: 100 });
  });
});

/**
 * 30분 구간·준비 증인·강제 모드의 최소 결과. 거절 결정은 AI2 관문 없이 AI1 완료가 곧 최종이다.
 * F1: 세대는 구간 전체에 고르게 퍼지고(기준선 워커 공백 검사), manifest 비교 대상과 replay 출처를 싣는다.
 */
function result(options: { runId: string; mode: "legacy" | "items"; finals: number; items?: number; readyMs?: number }): FixedInputRunResult {
  const start = "2026-10-20T00:00:00.000Z", end = "2026-10-20T00:30:00.000Z", step = options.finals ? Math.floor(1_790_000 / options.finals) : 0;
  const items = Array.from({ length: options.items ?? 80 }, (_, index) => ({ ordinal: index + 1, inputHash: H(`input-${index + 1}`) }));
  const attempts = Array.from({ length: options.finals }, (_, index) => ({ id: index + 1, candidateId: index + 1, inputHash: H(`input-${index + 1}`),
    state: "succeeded" as const, failure: null, provider: "abcllm", model: "[MLX] gpt-oss-120b", policyHash: H("policy"), promptVersion: "p",
    rulesVersion: "r", reusedFromAttemptId: null, decision: "reject" as const, reReview: false, readyMs: options.readyMs ?? -3_600_000,
    startedMs: 1_000 + index * step, completedMs: 1_500 + index * step, inputTokens: 18_000, outputTokens: 80 }));
  return { version: 1, scope: "fixed_input_replay_run", runId: options.runId, mode: options.mode, revision: "abcdef1", artifactSha256: H("artifact"),
    manifestSha256: H(options.runId), inputSetHash: fixedInputSetHash(items), inputs: { loaded: items.length, items, excluded: { notReviewable: 0, inputDrift: 0 } },
    window: { anchorAt: "2026-10-19T23:55:00.000Z", startedAt: start, endedAt: end, durationMs: 1_800_000, collectionStartedAt: start },
    stop: { reason: "window_end", atOffsetMs: 1_800_000, drainMs: 1_000, drainExceeded: false },
    meter: { calls: options.finals, refused: 0, upstreamFailed: 0, indeterminate: 0, maxInFlight: 2, usageKnownCalls: options.finals,
      reportedInputTokens: 18_000 * options.finals, reportedOutputTokens: 80 * options.finals, chargedTokens: 18_080 * options.finals,
      egressRejected: 0, models: [{ model: "[MLX] gpt-oss-120b", calls: options.finals }], usageProvenance: "reported_unverified" },
    writes: { products: 0, publishRuns: 0 }, failures: [], conditions: fixedInputRunConditions(parseFixedInputRunManifest(manifest())),
    live: { version: 1, scope: "live_window", runId: options.runId, revision: "abcdef1", schema: { appliedMigrations: 93, absentTables: [] },
      window: { startedAt: start, endedAt: end, durationMs: 1_800_000, collectedAt: "2026-10-20T00:31:00.000Z", collectedAfterEndMs: 60_000 },
      database: { target: "primary", inRecovery: false, readOnly: true, isolation: "repeatable read", replicaCaughtUp: null, writeXidAssigned: false },
      source: { kind: "replay", database: REPLAY_DB },
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
const REPLAY_DB = { systemIdentifier: "7400000000000000009", databaseOid: "16390", databaseName: "nomorevibe_test" };
describe("fixed-input report and judgment", () => {
  it("measures replay latency from AI1 start and applies the live 2x rule with replay evidence", () => {
    const baseline = result({ runId: "legacy-a", mode: "legacy", finals: 30 }), candidate = result({ runId: "items-a", mode: "items", finals: 75 });
    expect(reportFixedInputRun(baseline).latencyMs.endToEnd.p95).toBe(500);
    const compared = compareFixedInputRuns(baseline, candidate);
    expect(compared).toMatchObject({ performance: "passed", quality: "incomplete", safety: "incomplete", status: "incomplete", ratio: 2.5,
      numericThresholds: { doubled: true, latencyNotWorse: true, technicalFailureWithinOnePoint: true }, modes: { baseline: "legacy", candidate: "items" } });
    // F1: replay에는 사람 결정이 없어 그 칸은 not_applicable이다(이전에는 human_decision_override_unverified로 남았다).
    expect(compared.reasons).toEqual(expect.arrayContaining(["quality_unverified", "lease_violation_unverified", "budget_evidence_unverified"]));
    expect(compared.reasons).not.toContain("human_decision_override_unverified");
    expect(compared.labelTemplate).toHaveLength(30);
    const labels = compared.labelTemplate.map(row => ({ ...row, expected: "reject" as const }));
    const labeled = compareFixedInputRuns(attachFixedInputLabels(baseline, labels), attachFixedInputLabels(candidate, labels));
    expect(labeled).toMatchObject({ performance: "passed", quality: "passed", status: "incomplete" });
    expect(() => attachFixedInputLabels(baseline, [{ candidateId: 99, inputHash: H("input-99"), expected: "reject" }])).toThrow("replay_label_unknown_input");
  });
  it("never compares different input sets, early stops, public writes or a non-legacy baseline", () => {
    const baseline = result({ runId: "legacy-a", mode: "legacy", finals: 30 });
    const other = result({ runId: "items-b", mode: "items", finals: 75, items: 79 });
    expect(compareFixedInputRuns(baseline, other)).toMatchObject({ performance: "incomplete", status: "incomplete" });
    expect(compareFixedInputRuns(baseline, other).reasons).toContain("replay_input_set_mismatch");
    const stopped = { ...result({ runId: "items-c", mode: "items", finals: 75 }), stop: { reason: "call_cap", atOffsetMs: 900_000, drainMs: 0, drainExceeded: false } };
    expect(compareFixedInputRuns(baseline, stopped).reasons).toContain("replay_stopped_early");
    const written = { ...result({ runId: "items-d", mode: "items", finals: 75 }), writes: { products: 1, publishRuns: 0 } };
    expect(compareFixedInputRuns(baseline, written).reasons).toContain("replay_public_write_detected");
    expect(compareFixedInputRuns(result({ runId: "items-e", mode: "items", finals: 30 }), result({ runId: "items-f", mode: "items", finals: 75 })).reasons)
      .toContain("replay_baseline_not_legacy");
    expect(compareFixedInputRuns(baseline, result({ runId: "items-g", mode: "items", finals: 59 }))).toMatchObject({ performance: "failed", status: "failed" });
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

/**
 * PR01b-9: 0097 장부가 구간을 덮고 안전 지표가 0이며, legacy는 계량기·items는 장부로 budget을 증명한 결과.
 * F1: items도 장부 심사 한도(4)와 같은 공통 동시 예산을 manifest에 선언한다.
 */
function proven(options: { runId: string; mode: "legacy" | "items"; finals: number }): FixedInputRunResult {
  const value = result(options), { finals } = options;
  value.meter = { ...value.meter, upstreamReportedCalls: finals, upstreamReportedTokens: 18_080 * finals };
  value.budget = { declaredConcurrentCalls: 4, callsAtStop: finals };
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
    const [baseline, candidate] = labeledPair(proven({ runId: "legacy-a", mode: "legacy", finals: 30 }), proven({ runId: "items-a", mode: "items", finals: 75 }));
    expect(reportFixedInputRun(baseline).budget).toEqual({ status: "verified", source: "replay_meter", calls: 30, chargedTokens: 542_400,
      reportedCalls: 30, boundCalls: 0, concurrency: { limit: 4, peak: 2 } });
    expect(reportFixedInputRun(candidate).budget).toMatchObject({ status: "verified", source: "model_capacity_ledger", calls: 75 });
    expect(compareFixedInputRuns(baseline, candidate)).toMatchObject({ status: "passed", performance: "passed", quality: "passed", safety: "passed",
      budgetEvidence: "verified", budget: { status: "passed", ratios: { callsPerFinal: 1, tokensPerFinal: 1 } }, reasons: [] });
  });
  it.each([
    ["the declared common budget", (base: FixedInputRunResult) => { base.budget = { declaredConcurrentCalls: null, callsAtStop: 30 }; }, ["concurrency_limit_undeclared"]],
    ["upstream usage on one baseline call", (base: FixedInputRunResult) => { base.meter.upstreamReportedCalls = 29; }, ["usage_unreported_without_bound"]],
    // 이전 결과에는 정지 순간 호출 수도 선언 한도도 없다.
    ["the budget record of an old result", (base: FixedInputRunResult) => { delete base.budget; }, ["concurrency_limit_undeclared", "replay_budget_unrecorded"]],
  ] as const)("is incomplete when only %s is missing", (_name, mutate, issues) => {
    const base = proven({ runId: "legacy-a", mode: "legacy", finals: 30 }); mutate(base);
    expect(reportFixedInputRun(base).budget).toEqual({ status: "unverified", source: "replay_meter", issues });
    const [baseline, candidate] = labeledPair(base, proven({ runId: "items-a", mode: "items", finals: 75 }));
    expect(compareFixedInputRuns(baseline, candidate)).toMatchObject({ status: "incomplete", performance: "passed", quality: "passed", safety: "passed",
      reasons: ["budget_evidence_unverified"] });
  });
  it("cross-checks item ledger evidence against the meter and refuses inconsistent budget records", () => {
    const items = proven({ runId: "items-a", mode: "items", finals: 75 });
    items.meter = { ...items.meter, calls: 76 }; items.budget = { declaredConcurrentCalls: 4, callsAtStop: 76 };
    expect(reportFixedInputRun(items).budget).toMatchObject({ status: "unverified", issues: ["meter_calls_outside_ledger"] });
    expect(() => reportFixedInputRun({ ...items, budget: { declaredConcurrentCalls: 4, callsAtStop: 77 } })).toThrow("fixed_input_result_mismatch");
    expect(() => reportFixedInputRun({ ...items, meter: { ...items.meter, upstreamReportedCalls: 77 } })).toThrow("fixed_input_result_mismatch");
    expect(() => parseFixedInputRunManifest(manifest({ budget: { maxConcurrentCalls: 0 } }))).toThrow();
    expect(parseFixedInputRunManifest(manifest({ budget: { maxConcurrentCalls: 4 } })).budget).toEqual({ maxConcurrentCalls: 4 });
  });
});

/** 구간 끝 drain 기록: 정지 순간 계량기에 진행 중이던 호출과, drain 상한까지 끝나지 않아 끊은 호출. */
const drain = (patch: Partial<NonNullable<FixedInputRunResult["windowEndDrain"]>> = {}): NonNullable<FixedInputRunResult["windowEndDrain"]> => ({
  limitMs: 180_000, inFlightAtStop: 2, cutAtLimit: 0, waitedMs: 18_000, meterStop: null, accounting: "drain_calls_in_budget_not_in_finals", ...patch });
describe("window-end drain budget", () => {
  it("counts calls that finished during the drain in the budget but never as finals", () => {
    const legacy = proven({ runId: "legacy-a", mode: "legacy", finals: 30 });
    // 정지 순간 진행 중이던 6건이 drain 안에 끝나 usage가 남았다. 최종·처리량은 구간 안 30건 그대로다.
    legacy.meter = { ...legacy.meter, calls: 36, usageKnownCalls: 36, upstreamReportedCalls: 36, upstreamReportedTokens: 18_080 * 36 };
    legacy.budget = { declaredConcurrentCalls: 4, callsAtStop: 36 }; legacy.windowEndDrain = drain();
    const report = reportFixedInputRun(legacy);
    expect(report.finals.newCandidates).toBe(30);
    expect(report.budget).toEqual({ status: "verified", source: "replay_meter", calls: 36, chargedTokens: 18_080 * 36,
      reportedCalls: 36, boundCalls: 0, concurrency: { limit: 4, peak: 2 } });
    expect(report.replay.windowEndDrain).toEqual(drain());
    expect(report.evidenceIssues).not.toContain("replay_calls_refused");
    // drain 호출만큼 최종당 호출·토큰이 그 실행에 불리하게(크게) 잡힌다: 기준선 36/30, 후보 75/75.
    const [baseline, candidate] = labeledPair(legacy, proven({ runId: "items-a", mode: "items", finals: 75 }));
    expect(compareFixedInputRuns(baseline, candidate)).toMatchObject({ status: "passed", budgetEvidence: "verified",
      budget: { status: "passed", baseline: { calls: 36, finals: 30, callsPerFinal: 1.2 }, candidate: { calls: 75, finals: 75, callsPerFinal: 1 } } });
  });
  it("keeps the budget unverified in both modes when the drain limit cut a call", () => {
    const legacy = proven({ runId: "legacy-a", mode: "legacy", finals: 30 });
    legacy.meter = { ...legacy.meter, calls: 36, indeterminate: 1, usageKnownCalls: 35, upstreamReportedCalls: 35, upstreamReportedTokens: 18_080 * 35 };
    legacy.budget = { declaredConcurrentCalls: 4, callsAtStop: 36 }; legacy.windowEndDrain = drain({ cutAtLimit: 1 });
    expect(reportFixedInputRun(legacy).budget).toEqual({ status: "unverified", source: "replay_meter",
      issues: ["usage_unreported_without_bound", "replay_drain_calls_cut"] });
    // 장부는 끊긴 호출을 C로 세어 verified로 두지만, legacy와 같은 규칙으로 미검증이다(완화 금지).
    const items = proven({ runId: "items-a", mode: "items", finals: 75 });
    items.meter = { ...items.meter, indeterminate: 1 }; items.windowEndDrain = drain({ inFlightAtStop: 1, cutAtLimit: 1 });
    expect(reportFixedInputRun(items).budget).toEqual({ status: "unverified", source: "model_capacity_ledger", issues: ["replay_drain_calls_cut"] });
    const [baseline, candidate] = labeledPair(proven({ runId: "legacy-b", mode: "legacy", finals: 30 }), items);
    expect(compareFixedInputRuns(baseline, candidate)).toMatchObject({ status: "incomplete", reasons: ["budget_evidence_unverified"] });
  });
  it("flags a meter cap reached during the drain and refuses inconsistent drain records", () => {
    const legacy = proven({ runId: "legacy-a", mode: "legacy", finals: 30 });
    expect(reportFixedInputRun({ ...legacy, windowEndDrain: drain({ meterStop: "per_call_bound_exceeded" }) }).evidenceIssues)
      .toContain("replay_drain_meter_stop");
    for (const patch of [{ windowEndDrain: drain({ cutAtLimit: 3 }) }, { windowEndDrain: drain({ cutAtLimit: 1 }) },
      { windowEndDrain: drain({ inFlightAtStop: 31 }) }, { stop: { ...legacy.stop, reason: "call_cap" as const }, windowEndDrain: drain() }])
      expect(() => reportFixedInputRun({ ...legacy, ...patch })).toThrow("fixed_input_result_mismatch");
    // 이전 결과(drain 기록 없음)는 그대로 읽고 판정도 바뀌지 않는다.
    expect(reportFixedInputRun(legacy).replay.windowEndDrain).toBeNull();
    expect(reportFixedInputRun(legacy).budget).toMatchObject({ status: "verified", calls: 30 });
  });
});

describe("F1 replay verdict integrity: exact reasons", () => {
  const pair = () => labeledPair(proven({ runId: "legacy-a", mode: "legacy", finals: 30 }), proven({ runId: "items-a", mode: "items", finals: 75 }));
  it.each([
    ["replay_upstream_mismatch", (value: FixedInputRunResult) => { value.conditions = { ...value.conditions!, upstream: "https://other-gateway.example" }; }],
    ["replay_conditions_mismatch", (value: FixedInputRunResult) => { value.conditions = { ...value.conditions!, limits: { ...value.conditions!.limits, maxCalls: 799 } }; }],
    ["replay_conditions_mismatch", (value: FixedInputRunResult) => { value.conditions = { ...value.conditions!,
      secondReviewFallbacks: [{ provider: "abcllm", model: "backup" }] }; }],
    ["replay_conditions_unrecorded", (value: FixedInputRunResult) => { delete value.conditions; }],
    ["artifact_source_unrecorded", (value: FixedInputRunResult) => { delete value.live.source; }],
    ["artifact_source_not_replay", (value: FixedInputRunResult) => { value.live.source = { kind: "live", database: REPLAY_DB }; }],
  ])("is incomplete with only %s", (reason, mutate) => {
    const [baseline, candidate] = pair(); mutate(candidate);
    expect(compareFixedInputRuns(baseline, candidate)).toMatchObject({ status: "incomplete", performance: "incomplete", reasons: [reason] });
  });
  it("does not require two isolated replay databases to be the same database", () => {
    const [baseline, candidate] = pair(); candidate.live.source = { kind: "replay", database: { ...REPLAY_DB, systemIdentifier: "7400000000000000010" } };
    expect(compareFixedInputRuns(baseline, candidate)).toMatchObject({ status: "passed", reasons: [] });
  });
  it("rejects a recorded upstream that is not a normalized secret-free origin", () => {
    const [baseline] = pair();
    for (const upstream of ["https://user:pw@abcllm-api.brut.bot", "https://abcllm-api.brut.bot/v1", "http://abcllm-api.brut.bot", "https://abcllm-api.brut.bot/?k=1"])
      expect(() => reportFixedInputRun({ ...baseline, conditions: { ...baseline.conditions!, upstream } })).toThrow("fixed_input_result_mismatch");
  });
  it("judges quality only when both label samples are exactly the labelTemplate", () => {
    const baseline = proven({ runId: "legacy-a", mode: "legacy", finals: 30 }), candidate = proven({ runId: "items-a", mode: "items", finals: 75 });
    const template = compareFixedInputRuns(baseline, candidate).labelTemplate.map(row => ({ ...row, expected: "reject" as const }));
    // 같은 표본(같은 hash)이지만 labelTemplate 일부만 라벨했다.
    const partial = template.slice(1);
    expect(compareFixedInputRuns(attachFixedInputLabels(baseline, partial), attachFixedInputLabels(candidate, partial)))
      .toMatchObject({ status: "incomplete", quality: "incomplete", performance: "passed", reasons: ["quality_label_template_mismatch"] });
    // 템플릿 밖(후보에만 있는 최종)을 섞은 라벨은 기준선에 붙일 수는 있어도(포함 입력) 기준선 최종이 아니라 평가 불가다.
    const extra = [...template, { candidateId: 40, inputHash: H("input-40"), expected: "reject" as const }];
    expect(compareFixedInputRuns(attachFixedInputLabels(baseline, extra), attachFixedInputLabels(candidate, extra)).quality).toBe("incomplete");
    // 표본이 다르면 같은 템플릿 크기여도 판정하지 않는다.
    const flipped = template.map((row, index) => index ? row : { ...row, expected: "approve" as const });
    expect(compareFixedInputRuns(attachFixedInputLabels(baseline, template), attachFixedInputLabels(candidate, flipped)))
      .toMatchObject({ quality: "incomplete", reasons: ["quality_label_set_mismatch"] });
  });
  it("marks unobservable replay safety slots not_applicable but keeps an observed nonzero count failing", () => {
    const [baseline, candidate] = pair();
    expect(reportFixedInputRun(candidate).safety).toEqual({ duplicatePublications: { status: "not_applicable" },
      humanDecisionOverrides: { status: "not_applicable" }, leaseViolations: { status: "verified", count: 0 } });
    const overridden = structuredClone(candidate); overridden.live.safety = { ...overridden.live.safety, humanDecisionOverrides: 1 };
    expect(compareFixedInputRuns(baseline, overridden)).toMatchObject({ status: "failed", safety: "failed", reasons: ["human_decision_override_detected"] });
    const uncovered = structuredClone(candidate);
    uncovered.live = { ...uncovered.live, ledger: null, safety: { duplicatePublications: 0, humanDecisionOverrides: "unverified", leaseViolations: "unverified" },
      budget: { status: "unverified" } };
    expect(reportFixedInputRun(uncovered).safety).toEqual({ duplicatePublications: { status: "not_applicable" },
      humanDecisionOverrides: { status: "not_applicable" }, leaseViolations: { status: "unverified" } });
  });
  it("keeps the item budget unverified when the manifest declaration differs from the ledger policy limit", () => {
    const items = proven({ runId: "items-a", mode: "items", finals: 75 }); items.budget = { declaredConcurrentCalls: 8, callsAtStop: 75 };
    expect(reportFixedInputRun(items).budget).toEqual({ status: "unverified", source: "model_capacity_ledger", issues: ["concurrency_limit_declaration_mismatch"] });
    items.budget = { declaredConcurrentCalls: null, callsAtStop: 75 };
    expect(reportFixedInputRun(items).budget).toEqual({ status: "unverified", source: "model_capacity_ledger", issues: ["concurrency_limit_undeclared"] });
  });
  it("does not pass a legacy baseline declared with a different common budget", () => {
    const legacy = proven({ runId: "legacy-a", mode: "legacy", finals: 30 }); legacy.budget = { declaredConcurrentCalls: 8, callsAtStop: 30 };
    const [baseline, candidate] = labeledPair(legacy, proven({ runId: "items-a", mode: "items", finals: 75 }));
    expect(compareFixedInputRuns(baseline, candidate)).toMatchObject({ status: "incomplete", budget: { status: "incomplete", reasons: ["budget_limit_mismatch"] },
      reasons: ["budget_limit_mismatch"] });
  });
});
