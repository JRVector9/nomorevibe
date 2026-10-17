import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { Agent, request } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { judgeBudget, type BudgetEvidence } from "@/lib/operations/pipeline-capacity-budget";
import { attachLiveCapacityLabels, compareLiveCapacityRuns, judgeLiveCapacity, reportLiveCapacityWindow,
  type LiveCapacityArtifact, type LiveCapacityReport } from "@/lib/operations/pipeline-capacity-live";
import { attachFixedInputLabels, compareFixedInputRuns, fixedInputSetHash, reportFixedInputRun, sha256,
  type FixedInputRunResult } from "@/lib/operations/pipeline-replay-fixed-input";
import { installReplayEgressGuard, startReplayModelMeter } from "@/lib/operations/pipeline-replay-model-meter";
import { mergeWithDefaults } from "@/lib/crawl/settings";

/**
 * F1 판정 무결성 RED 모음. 모든 fixture는 수정 전(origin/main) artifact·결과 모양이다 — 수정 전 코드에서는 각 사례가 거짓 passed(또는
 * 거짓 verified·무거절)가 되고, 수정 뒤에는 결함별 이유 코드로 막혀야 한다. 정확한 이유 목록(새 모양 fixture)은 각 모듈 테스트가 본다.
 */
const hash = "a".repeat(64), WINDOW = 1_800_000;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 17) + ms).toISOString();
const model = (name: string) => ({ provider: "abcllm" as const, model: name, canonicalModel: name });
/** 이전 모양의 운영 구간: 출처 없음. finals건이 구간 앞쪽 spanMs 안에 고르게 거절로 끝난다(AI1 완료가 곧 최종). */
function live(finals: number, options: { spanMs?: number; ai2Calls?: number; ai2Failed?: number; open?: boolean } = {}): LiveCapacityArtifact {
  const span = options.spanMs ?? WINDOW, step = Math.floor(span / (finals + 1));
  const attempts = Array.from({ length: finals }, (_, index) => ({ id: index + 1, candidateId: index + 1, inputHash: hash, state: "succeeded" as const,
    failure: null, provider: "abcllm", model: "first", policyHash: hash, promptVersion: "p1", rulesVersion: "r1", reusedFromAttemptId: null,
    decision: "reject" as const, reReview: false, readyMs: (index + 1) * step - 11_000, startedMs: (index + 1) * step - 1_000,
    completedMs: (index + 1) * step, inputTokens: 990, outputTokens: 10 }));
  return { version: 1, scope: "live_window", runId: "live-red", revision: "9e13341", schema: { appliedMigrations: 97, absentTables: [] },
    window: { startedAt: at(0), endedAt: at(WINDOW), durationMs: WINDOW, collectedAt: at(WINDOW + 60_000), collectedAfterEndMs: 60_000 },
    database: { target: "primary", inRecovery: false, readOnly: true, isolation: "repeatable read", replicaCaughtUp: null, writeXidAssigned: false },
    identity: { promptVersion: "p1", rulesVersion: "r1", inputPolicyHash: hash, comparisonPolicyHash: hash, fullReviewPolicyHash: hash,
      reviewMode: "enforce", secondGateRequired: true, concurrency: 2, settingsUpdatedMs: -3_600_000,
      models: { first: model("first"), second: [model("second")], fallbacks: [] } },
    stageModes: (["ai1", "ai2", "fetch"] as const).map(stage => ({ stage, mode: "legacy" as const, epoch: 1, changedSinceStart: false })),
    modelCapacity: { mode: options.open ? "open" : "disabled", changedSinceStart: false },
    attempts, votes: [], candidates: attempts.map(row => ({ id: row.candidateId, state: "rejected" as const, decidedBy: "auto" as const, appliedAttemptId: row.id })),
    ai2Calls: { chains: options.ai2Calls ?? 0, calls: options.ai2Calls ?? 0, failed: options.ai2Failed ?? 0, unattributedChains: 0 },
    readiness: { witnesses: 3, sampleCandidateIds: [] },
    ...(options.open ? { ledger: { startedAt: at(-3_600_000), humanDecisionRefusals: 0, lateWritesRefused: 0 } } : {}),
    safety: options.open ? { duplicatePublications: 0, humanDecisionOverrides: 0, leaseViolations: 0 }
      : { duplicatePublications: 0, humanDecisionOverrides: "unverified", leaseViolations: "unverified" },
    budget: options.open ? { status: "verified", source: "model_capacity_ledger", calls: finals, chargedTokens: 1_000 * finals, reportedCalls: finals,
      boundCalls: 0, concurrency: { limit: 4, peak: 2 } } : { status: "unverified" }, quality: null } as LiveCapacityArtifact;
}
const label = (value: LiveCapacityArtifact, count = value.attempts.length) => attachLiveCapacityLabels(value,
  value.attempts.slice(0, count).map(row => ({ candidateId: row.candidateId, inputHash: row.inputHash, expected: "reject" as const })));
/** 수정 전 테스트와 같은 방식: 보고서의 budget·안전 칸만 검증됨으로 채운다(최종 하나당 호출 3·토큰 3,000, 선언 한도 4). */
const proven = (report: LiveCapacityReport): LiveCapacityReport => ({ ...report, budgetEvidence: "verified",
  budget: { status: "verified", source: "model_capacity_ledger", calls: 3 * report.finals.newCandidates, chargedTokens: 3_000 * report.finals.newCandidates,
    reportedCalls: 3 * report.finals.newCandidates, boundCalls: 0, concurrency: { limit: 4, peak: 2 } },
  safety: { ...report.safety, humanDecisionOverrides: { status: "verified", count: 0 }, leaseViolations: { status: "verified", count: 0 } } });
const judge = (before: LiveCapacityArtifact, after: LiveCapacityArtifact) =>
  judgeLiveCapacity(proven(reportLiveCapacityWindow(before)), proven(reportLiveCapacityWindow(after)));
function blocked(result: { status: string; reasons: string[] }, reason: string) {
  expect(result.status).not.toBe("passed");
  expect(result.reasons).toContain(reason);
}

describe("F1 RED: live judgement", () => {
  it("#1 never judges quality on two different label samples", () => {
    const result = judge(label(live(40, { ai2Calls: 90 })), label(live(80, { ai2Calls: 80 })));
    expect(result.quality).not.toBe("passed");
    blocked(result, "quality_label_set_mismatch");
  });
  it("#6 needs at least 30 unique baseline finals", () => {
    blocked(judge(label(live(10, { ai2Calls: 90 })), label(live(20, { ai2Calls: 80 }), 10)), "baseline_finals_below_minimum");
  });
  it("#6 needs at least 30 labels even on the same sample", () => {
    const result = judge(label(live(40, { ai2Calls: 90 }), 10), label(live(80, { ai2Calls: 80 }), 10));
    expect(result.quality).not.toBe("passed");
    blocked(result, "quality_labels_below_minimum");
  });
  it("#6 refuses a baseline whose workers sat idle for more than 5 minutes", () => {
    // 기준선 40건이 구간 앞 20분 안에 모두 끝났다: 준비 증인이 있는데 마지막 10분 동안 AI1 호출이 없다.
    blocked(judge(label(live(40, { spanMs: 1_200_000, ai2Calls: 90 })), label(live(80, { ai2Calls: 80 }), 40)), "baseline_worker_idle");
  });
  it("#6 refuses a degraded baseline above the 5% technical failure cap", () => {
    // 기준선 10/130 = 7.7%, 후보 13/160 = 8.1%(기준+1%p 안). 망가진 기준선 대비 '악화 없음'은 증거가 아니다.
    blocked(judge(label(live(40, { ai2Calls: 90, ai2Failed: 10 })), label(live(80, { ai2Calls: 80, ai2Failed: 13 }), 40)),
      "baseline_failure_rate_above_cap");
  });
  it("#7 refuses live artifacts without a recorded source", () => {
    const result = compareLiveCapacityRuns(label(live(40, { open: true })), label(live(80, { open: true }), 40));
    blocked(result, "artifact_source_unrecorded");
  });
});

const verifiedBudget = (limit: number, peak = 1): BudgetEvidence =>
  ({ status: "verified", source: "model_capacity_ledger", calls: 30, chargedTokens: 30_000, reportedCalls: 30, boundCalls: 0, concurrency: { limit, peak } });
describe("F1 RED: concurrency budget", () => {
  it("#2 does not pass two runs declared with different concurrency limits", () => {
    blocked(judgeBudget({ budget: verifiedBudget(8), finals: 10 }, { budget: verifiedBudget(4, 4), finals: 10 }, true), "budget_limit_mismatch");
  });
});

/** 이전 모양의 replay 결과(조건·출처 기록 없음). finals건이 30분에 고르게 거절로 끝난다. */
function replay(options: { runId: string; mode: "legacy" | "items"; finals: number; items?: number; declared?: number | null; ledgerLimit?: number }): FixedInputRunResult {
  const start = "2026-10-20T00:00:00.000Z", end = "2026-10-20T00:30:00.000Z", { finals } = options, step = Math.floor(1_790_000 / finals);
  const items = Array.from({ length: options.items ?? 120 }, (_, index) => ({ ordinal: index + 1, inputHash: sha256(`input-${index + 1}`) }));
  const attempts = Array.from({ length: finals }, (_, index) => ({ id: index + 1, candidateId: index + 1, inputHash: sha256(`input-${index + 1}`),
    state: "succeeded" as const, failure: null, provider: "abcllm", model: "[MLX] gpt-oss-120b", policyHash: sha256("policy"), promptVersion: "p",
    rulesVersion: "r", reusedFromAttemptId: null, decision: "reject" as const, reReview: false, readyMs: -3_600_000,
    startedMs: 1_000 + index * step, completedMs: 1_500 + index * step, inputTokens: 18_000, outputTokens: 80 }));
  const items_ = options.mode === "items";
  return { version: 1, scope: "fixed_input_replay_run", runId: options.runId, mode: options.mode, revision: "abcdef1", artifactSha256: sha256("artifact"),
    manifestSha256: sha256(options.runId), inputSetHash: fixedInputSetHash(items), inputs: { loaded: items.length, items, excluded: { notReviewable: 0, inputDrift: 0 } },
    window: { anchorAt: "2026-10-19T23:55:00.000Z", startedAt: start, endedAt: end, durationMs: 1_800_000, collectionStartedAt: start },
    stop: { reason: "window_end", atOffsetMs: 1_800_000, drainMs: 1_000, drainExceeded: false },
    meter: { calls: finals, refused: 0, upstreamFailed: 0, indeterminate: 0, maxInFlight: 2, usageKnownCalls: finals, reportedInputTokens: 18_000 * finals,
      reportedOutputTokens: 80 * finals, chargedTokens: 18_080 * finals, egressRejected: 0, upstreamReportedCalls: finals, upstreamReportedTokens: 18_080 * finals,
      models: [{ model: "[MLX] gpt-oss-120b", calls: finals }], usageProvenance: "reported_unverified" },
    budget: { declaredConcurrentCalls: options.declared === undefined ? 4 : options.declared, callsAtStop: finals },
    writes: { products: 0, publishRuns: 0 }, failures: [],
    live: { version: 1, scope: "live_window", runId: options.runId, revision: "abcdef1", schema: { appliedMigrations: 97, absentTables: [] },
      window: { startedAt: start, endedAt: end, durationMs: 1_800_000, collectedAt: "2026-10-20T00:31:00.000Z", collectedAfterEndMs: 60_000 },
      database: { target: "primary", inRecovery: false, readOnly: true, isolation: "repeatable read", replicaCaughtUp: null, writeXidAssigned: false },
      identity: { promptVersion: "p", rulesVersion: "r", inputPolicyHash: sha256("policy"), comparisonPolicyHash: sha256("comparison"), fullReviewPolicyHash: sha256("full"),
        reviewMode: "enforce", secondGateRequired: true, concurrency: 2, settingsUpdatedMs: -300_000,
        models: { first: { provider: "abcllm", model: "[MLX] gpt-oss-120b", canonicalModel: "gpt-oss-120b" }, second: [], fallbacks: [] } },
      stageModes: (["ai1", "ai2", "fetch"] as const).map(stage => ({ stage, mode: items_ && stage !== "fetch" ? "items" as const : "legacy" as const,
        epoch: 1, changedSinceStart: false })),
      modelCapacity: { mode: items_ ? "open" : "disabled", changedSinceStart: false },
      attempts, votes: [], candidates: attempts.map(row => ({ id: row.candidateId, state: "rejected" as const, decidedBy: "auto" as const, appliedAttemptId: row.id })),
      ai2Calls: { chains: 0, calls: 0, failed: 0, unattributedChains: 0 }, readiness: { witnesses: 5, sampleCandidateIds: [] },
      ledger: { startedAt: "2026-10-19T23:00:00.000Z", humanDecisionRefusals: 0, lateWritesRefused: 0 },
      safety: { duplicatePublications: 0, humanDecisionOverrides: 0, leaseViolations: 0 },
      budget: items_ ? { status: "verified", source: "model_capacity_ledger", calls: finals, chargedTokens: 18_080 * finals, reportedCalls: finals, boundCalls: 0,
        concurrency: { limit: options.ledgerLimit ?? 4, peak: 2 } } : { status: "unverified" }, quality: null } } as FixedInputRunResult;
}
function labeledPair(baseline: FixedInputRunResult, candidate: FixedInputRunResult, count?: number) {
  const template = compareFixedInputRuns(baseline, candidate).labelTemplate, labels = template.slice(0, count ?? template.length)
    .map(row => ({ ...row, expected: "reject" as const }));
  return [attachFixedInputLabels(baseline, labels), attachFixedInputLabels(candidate, labels)] as const;
}
describe("F1 RED: fixed-input replay", () => {
  it("#1 judges quality only on the full labelTemplate", () => {
    // 두 실행이 같은 라벨 20건(같은 hash)을 붙였지만 공통 최종 40건(labelTemplate)의 일부다.
    const [baseline, candidate] = labeledPair(replay({ runId: "legacy-a", mode: "legacy", finals: 40 }), replay({ runId: "items-a", mode: "items", finals: 100 }), 20);
    const result = compareFixedInputRuns(baseline, candidate);
    expect(result.quality).not.toBe("passed");
    blocked(result, "quality_label_template_mismatch");
  });
  it("#3 does not compare runs that never recorded their upstream and manifest conditions", () => {
    const [baseline, candidate] = labeledPair(replay({ runId: "legacy-a", mode: "legacy", finals: 40 }), replay({ runId: "items-a", mode: "items", finals: 100 }));
    blocked(compareFixedInputRuns(baseline, candidate), "replay_conditions_unrecorded");
  });
  it("#2 keeps an item budget unverified without a matching manifest concurrency declaration", () => {
    expect(reportFixedInputRun(replay({ runId: "items-a", mode: "items", finals: 100, declared: null })).budget)
      .toMatchObject({ status: "unverified", issues: expect.arrayContaining(["concurrency_limit_undeclared"]) });
    expect(reportFixedInputRun(replay({ runId: "items-b", mode: "items", finals: 100, declared: 4, ledgerLimit: 8 })).budget)
      .toMatchObject({ status: "unverified", issues: expect.arrayContaining(["concurrency_limit_declaration_mismatch"]) });
  });
  it("#8 never reports unobservable replay safety slots as verified zero", () => {
    const report = reportFixedInputRun(replay({ runId: "legacy-a", mode: "legacy", finals: 40 }));
    expect(report.safety).toEqual({ duplicatePublications: { status: "not_applicable" }, humanDecisionOverrides: { status: "not_applicable" },
      leaseViolations: { status: "verified", count: 0 } });
  });
});

describe("F1 RED: replay egress", () => {
  const servers: Server[] = [], releases: (() => Promise<void>)[] = [];
  afterEach(async () => {
    while (releases.length) await releases.pop()!();
    while (servers.length) await new Promise<void>(resolve => servers.pop()!.close(() => resolve()));
  });
  async function server() {
    const seen: string[] = [];
    const value = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.end("{}"); });
    await new Promise<void>(resolve => value.listen(0, "127.0.0.1", () => resolve()));
    servers.push(value);
    return { origin: `http://127.0.0.1:${(value.address() as AddressInfo).port}`, seen };
  }
  it("#9 counts a request sent with an explicit dispatcher around the global guard", async () => {
    const upstream = await server(), outside = await server();
    const meter = await startReplayModelMeter({ upstream: upstream.origin, limits: { maxCalls: 10, maxTokens: 1_000, perCallTokenUpperBound: 100 },
      onStop: () => {} });
    let rejected = 0;
    const release = installReplayEgressGuard(upstream.origin, meter, () => { rejected++; });
    const agent = new Agent();
    releases.push(async () => { await release(); await meter.close(); await agent.close(); });
    // README 표본 갱신처럼 SSRF Agent를 명시해 보내면 전역 관문을 지나지 않는다.
    const response = await request(`${outside.origin}/owner/repo/HEAD/README.md`, { dispatcher: agent });
    await response.body.text();
    expect(outside.seen).toEqual(["GET /owner/repo/HEAD/README.md"]);
    expect(rejected).toBe(1);
  });
  it("#9 refuses an artifact whose README sample is not this code's version before any load or call", async () => {
    const { fixedInputPreflight } = await import("@/lib/operations/pipeline-replay-model-runner");
    const settings = JSON.parse(JSON.stringify(mergeWithDefaults({ enabled: true, reviewMode: "enforce", firstReview: { provider: "abcllm", model: "m" },
      secondReview: { enabled: true, voters: [{ provider: "abcllm", model: "s" }], fallbacks: [], sampleRate: 0 } }))) as Record<string, unknown>;
    const artifact = { version: 1, scope: "fixed_input_replay", export: { revision: "abcdef1", exportedAt: "2026-10-17T00:00:00.000Z",
      from: "2026-10-13T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z", seed: "s", requested: 1, population: 1, examined: 1, selected: 1,
      exclusions: { modelChanged: 0, documentChanged: 0, scanChanged: 0, readmeMissing: 0, headroom: 0, inputDrift: 0, oversize: 0 },
      firstReviewer: { provider: "abcllm", model: "m" }, inputPolicyHash: sha256("policy") }, settings,
      inputs: [{ ordinal: 1, repo: "owner/repo", production: { candidateId: 7, attemptId: 9, inputHash: sha256("i"), decision: "approve",
        provider: "abcllm", model: "m" }, anchorAt: "2026-10-13T01:00:00.000Z", inputHash: sha256("i"),
        document: { repoMeta: {}, productUrl: "https://example.com", pageStatus: 200, pageMeta: { readmeSample: "# old", readmeSampleVersion: "2020-01-01.1" },
          fetchedAgeUs: 1_000_000 }, scan: null, observations: [] }] };
    const manifest = { version: 1, runId: "legacy-a", mode: "legacy", artifactSha256: sha256("artifact"), upstream: "https://abcllm-api.brut.bot",
      durationMs: 1_800_000, limits: { maxCalls: 800, maxTokens: 800 * 32_768, perCallTokenUpperBound: 32_768, maxWallMs: 2_700_000 } };
    expect(() => fixedInputPreflight(manifest, artifact, { ABCLLM_BASE_URL: "https://abcllm-api.brut.bot", ABCLLM_API_KEY: "k" }))
      .toThrow("replay_readme_sample_version_mismatch");
  });
});

it("#5 offers an operator CLI for the 0097 recorder marker that refuses to run without its explicit database URL", () => {
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/ops/pipeline-evidence-marker.ts", "--revision=abcdef1", "--operator=f1"],
    { encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: "test" }, timeout: 20_000 });
  expect(run.status).toBe(1);
  expect(run.stderr.trim()).toBe(JSON.stringify({ code: "explicit_PIPELINE_CONTROL_DATABASE_URL_required" }));
}, 30_000);
