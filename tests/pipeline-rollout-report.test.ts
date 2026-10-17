import { describe, expect, it } from "vitest";
import { modelCapacityPolicyHash, type ModelCapacityPolicy } from "@/lib/llm/capacity";
import { formatPipelineObservation, integrateModelSlots, modelRequestIntervals, parsePipelineObservation, reportPipelineObservation,
  type PipelineObservation, type PipelineSnapshot, type SlotRequest } from "@/lib/operations/pipeline-observation";
import { formatDrillReport, reportDrill, type DrillArtifact } from "@/lib/operations/dr/drill-report";
import { parseReportCliArgs } from "../scripts/pipeline-rollout-report";

const HOUR = 3_600_000, DAY = 24 * HOUR;
const at = (ms: number) => new Date(Date.UTC(2026, 9, 17) + ms).toISOString();
const policy: ModelCapacityPolicy = { version: 1, globalLimit: 2, providerLimits: { acct: 2 }, groupLimits: { g: 2 }, poolLimits: { reviewer: 2, text: 1 },
  weights: { first: 1, second: 1, background: 1 }, maxWaiting: 8, queueTtlMs: 600_000, reservationTtlMs: 600_000,
  routes: [{ routeId: "r", provider: "p", model: "m", providerBudgetId: "acct", groupId: "g" }] };
const policyHash = modelCapacityPolicyHash(policy);
const request = (values: Partial<SlotRequest>): SlotRequest => ({ routeId: "r", class: "first", pool: "reviewer", providerBudgetId: "acct", groupId: "g",
  policyHash, waitFromMs: null, waitToMs: null, activeFromMs: null, activeToMs: null, ...values });

describe("modelRequestIntervals", () => {
  it("turns ledger transitions into one waiting and one active interval", () => {
    expect(modelRequestIntervals([{ toState: "waiting", atMs: 100 }, { toState: "reserved", atMs: 400 }, { toState: "dispatched", atMs: 450 },
      { toState: "indeterminate", atMs: 900 }, { toState: "settled", atMs: 1_500 }], { queueUntilMs: 10_000, reservedUntilMs: 1_000 }))
      .toEqual({ waitFromMs: 100, waitToMs: 400, activeFromMs: 400, activeToMs: 1_500 });
  });
  it("ends waiting at queue_until and an undispatched reservation at reserved_until even before the lazy expiry event", () => {
    expect(modelRequestIntervals([{ toState: "waiting", atMs: 0 }, { toState: "withdrawn", atMs: 9_000 }], { queueUntilMs: 5_000, reservedUntilMs: null }))
      .toEqual({ waitFromMs: 0, waitToMs: 5_000, activeFromMs: null, activeToMs: null });
    expect(modelRequestIntervals([{ toState: "waiting", atMs: 0 }, { toState: "reserved", atMs: 10 }], { queueUntilMs: 5_000, reservedUntilMs: 70 }))
      .toEqual({ waitFromMs: 0, waitToMs: 10, activeFromMs: 10, activeToMs: 70 });
  });
  it("keeps an open waiting or dispatched interval open (null) when no deadline passed", () => {
    expect(modelRequestIntervals([{ toState: "waiting", atMs: -50 }], { queueUntilMs: Number.POSITIVE_INFINITY, reservedUntilMs: null }))
      .toEqual({ waitFromMs: -50, waitToMs: null, activeFromMs: null, activeToMs: null });
    expect(modelRequestIntervals([{ toState: "waiting", atMs: 0 }, { toState: "reserved", atMs: 5 }, { toState: "dispatched", atMs: 6 }],
      { queueUntilMs: 100, reservedUntilMs: 20 })).toEqual({ waitFromMs: 0, waitToMs: 5, activeFromMs: 5, activeToMs: null });
  });
});

describe("integrateModelSlots", () => {
  it("returns zero totals for an empty window", () => {
    expect(integrateModelSlots([], policy, HOUR)).toEqual({ policyKnown: true, durationMs: HOUR, scopes: [],
      all: { waitingMs: 0, freeWhileWaitingMs: 0, fullWhileWaitingMs: 0, unknownWhileWaitingMs: 0, busyMs: 0 } });
  });
  it("splits waiting time into free-slot waiting and saturated waiting and clips intervals that cross the window edges", () => {
    // 두 슬롯(전역 2) 중 하나는 구간 전부터 점유, 다른 하나는 [200, 700) 점유. 대기 요청은 구간 전 -100부터 900까지.
    const rows = [request({ activeFromMs: -1_000, activeToMs: null }), request({ activeFromMs: 200, activeToMs: 700, class: "second" }),
      request({ waitFromMs: -100, waitToMs: 900, activeFromMs: 900, activeToMs: 1_200 })];
    const result = integrateModelSlots(rows, policy, 1_000);
    expect(result.all).toEqual({ waitingMs: 900, freeWhileWaitingMs: 400, fullWhileWaitingMs: 500, unknownWhileWaitingMs: 0, busyMs: 1_000 });
    expect(result.scopes).toEqual([
      { routeId: "r", class: "first", waitingMs: 900, freeWhileWaitingMs: 400, fullWhileWaitingMs: 500, unknownWhileWaitingMs: 0, busyMs: 1_000 },
      { routeId: "r", class: "second", waitingMs: 0, freeWhileWaitingMs: 0, fullWhileWaitingMs: 0, unknownWhileWaitingMs: 0, busyMs: 500 },
    ]);
  });
  it("counts a waiting text request as saturated when only its pool limit is full", () => {
    const rows = [request({ class: "background", pool: "text", activeFromMs: 0, activeToMs: 1_000 }),
      request({ class: "background", pool: "text", waitFromMs: 0, waitToMs: 600 })];
    expect(integrateModelSlots(rows, policy, 1_000).all).toMatchObject({ freeWhileWaitingMs: 0, fullWhileWaitingMs: 600 });
  });
  it("puts waiting time under unknown when the request policy differs from the current policy or no policy is readable", () => {
    const rows = [request({ waitFromMs: 0, waitToMs: 300, policyHash: "c".repeat(64) })];
    expect(integrateModelSlots(rows, policy, 1_000).all).toMatchObject({ waitingMs: 300, unknownWhileWaitingMs: 300, freeWhileWaitingMs: 0 });
    expect(integrateModelSlots([request({ waitFromMs: 0, waitToMs: 300 })], null, 1_000))
      .toMatchObject({ policyKnown: false, all: { unknownWhileWaitingMs: 300 } });
  });
  it("ignores intervals entirely outside the window", () => {
    const rows = [request({ waitFromMs: -500, waitToMs: 0 }), request({ activeFromMs: 1_000, activeToMs: 2_000 })];
    expect(integrateModelSlots(rows, policy, 1_000).all).toEqual({ waitingMs: 0, freeWhileWaitingMs: 0, fullWhileWaitingMs: 0,
      unknownWhileWaitingMs: 0, busyMs: 0 });
  });
});

const database = { name: "nomorevibe", oid: "16384", target: "primary" as const, inRecovery: false, readOnly: true as const,
  isolation: "repeatable read" as const, writeXidAssigned: false as const };
const state = (epoch: number, owner: string, runs: number) => ({
  roles: [{ role: "reviewer", epoch, ownerInstanceId: owner, ownerBootId: `${owner}-boot` }],
  jobs: [{ name: "crawl-agent-review", runs, processedVersion: runs }],
  controls: { stageModes: [{ stage: "ai1", mode: "legacy", epoch: 1 }], modelCapacity: { mode: "open", epoch: 2, revision: 3 },
    jobBatch: { mode: "legacy", epoch: 1 }, writerFence: { state: "active", writerEpoch: 1 } } });
const snapshot = (capturedMs: number): PipelineSnapshot => ({ version: 1, scope: "pipeline_snapshot", capturedAt: at(capturedMs), database, ...state(4, "m3", 10) });
function observation(): PipelineObservation {
  return { version: 1, scope: "pipeline_observation", runId: "obs", revision: "10238904",
    window: { startedAt: at(0), endedAt: at(DAY), durationMs: DAY, collectedAt: at(DAY + 60_000), collectedAfterEndMs: 60_000 },
    database: { ...database, replicaCaughtUp: null }, schema: { appliedMigrations: 97, absentTables: ["pipeline_evidence_events"] },
    baseline: snapshot(-60_000), current: state(6, "mini", 1_450),
    jobs: [{ name: "crawl-agent-review", role: "reviewer", lastRunMs: DAY + 30_000, lastSuccessMs: DAY - 5_000, failingAtCollection: false }],
    acks: { rows: [{ role: "reviewer", job: "crawl-agent-review", instanceId: "mini-reviewer", host: "mini", recordedMs: DAY - 5_000 }], invalid: 0 },
    readback: [{ role: "reviewer", stage: "crawl-agent-review", rows: 1_200 }],
    ai1: { calls: 1_000, technicalFailures: 12, cancelled: 3 },
    ledger: { status: "absent", startedAt: null, counts: null }, duplicatePublications: 0,
    fenceEvents: [], modelLedger: { control: { mode: "open", changedSinceStart: false, policyHash, policy },
      events: [{ routeId: "r", class: "first", kind: "dispatch_started", count: 40 }, { routeId: "r", class: "first", kind: "dispatch_indeterminate", count: 2 },
        { routeId: "r", class: "first", kind: "dispatch_settled", count: 37 }],
      openAtCollection: [{ routeId: "r", class: "first", state: "indeterminate", count: 1 }],
      requests: [request({ waitFromMs: 0, waitToMs: 1_000, activeFromMs: 1_000, activeToMs: 2_000 })] } };
}

describe("reportPipelineObservation", () => {
  it("derives handoffs and run counts only from a baseline captured before the window start", () => {
    const report = reportPipelineObservation(observation());
    expect(report.coverage).toEqual({ fromMs: -60_000, toMs: DAY + 60_000 });
    expect(report.roles[0]).toMatchObject({ role: "reviewer", owner: "mini", epoch: 6, handoff: { status: "verified", epochDelta: 2, ownerChanged: true },
      jobs: [{ name: "crawl-agent-review", ranInWindow: null, succeededInWindow: true, runsDelta: 1_440 }],
      acks: [{ instanceId: "mini-reviewer", latestInWindow: true }], readback: [{ stage: "crawl-agent-review", rows: 1_200 }] });
    const late = { ...observation(), baseline: snapshot(1) };
    expect(reportPipelineObservation(late).roles[0]).toMatchObject({ handoff: { status: "unverified" }, jobs: [{ runsDelta: null }] });
    expect(reportPipelineObservation(late).evidenceIssues).toContain("baseline_after_window_start");
    expect(reportPipelineObservation({ ...observation(), baseline: null }).evidenceIssues).toContain("baseline_missing");
  });
  it("keeps human-decision and lease safety unverified without a covering 0097 ledger and flags a verified violation", () => {
    const report = reportPipelineObservation(observation());
    expect(report.safety).toEqual({ duplicatePublications: { status: "verified", count: 0 }, humanDecisionOverrides: { status: "unverified" },
      leaseViolations: { status: "unverified" } });
    expect(report.stageFailures.slice(0, 2)).toEqual([{ stage: "ai1", status: "verified", calls: 1_000, failed: 12, rate: .012 },
      { stage: "ai2", status: "unverified", calls: null, failed: null, rate: null }]);
    expect(report.evidenceIssues).toEqual(expect.arrayContaining(["table_absent:pipeline_evidence_events", "evidence_ledger_absent"]));
    expect(report.violations).toEqual([]);
    const covered = { ...observation(), schema: { appliedMigrations: 97, absentTables: [] }, duplicatePublications: 1,
      ledger: { status: "covered" as const, startedAt: at(-HOUR), counts: { humanDecisionOverrides: 0, leaseViolations: 2, humanDecisionRefusals: 4,
        lateWritesRefused: 1, ai2Calls: 50, ai2Failed: 1, ai2Chains: 45 } } };
    const checked = reportPipelineObservation(covered);
    expect(checked.violations).toEqual(["duplicatePublications", "leaseViolations"]);
    expect(checked.stageFailures[1]).toEqual({ stage: "ai2", status: "verified", calls: 50, failed: 1, rate: .02 });
  });
  it("reports model ledger counts and slot integrals per route/class", () => {
    const report = reportPipelineObservation(observation());
    expect(report.modelLedger?.routes).toEqual([{ routeId: "r", class: "first", queued: 0, reserved: 0, dispatched: 40, settled: 37,
      indeterminate: 2, released: 0, withdrawn: 0, indeterminateRate: .05 }]);
    expect(report.slots?.all).toEqual({ waitingMs: 1_000, freeWhileWaitingMs: 1_000, fullWhileWaitingMs: 0, unknownWhileWaitingMs: 0, busyMs: 1_000 });
    expect(formatPipelineObservation(report)).toContain("## 슬롯 대기 적분");
  });
  it("rejects artifacts whose window arithmetic or ledger shape is inconsistent", () => {
    expect(() => parsePipelineObservation({ ...observation(), window: { ...observation().window, collectedAfterEndMs: 1 } }))
      .toThrow("observation_artifact_mismatch");
    expect(() => parsePipelineObservation({ ...observation(), ledger: { status: "covered", startedAt: at(0), counts: null } }))
      .toThrow("observation_artifact_mismatch");
  });
});

const instance = "m3-reviewer";
function drill(): DrillArtifact {
  return { version: 1, scope: "dr_drill", promotionId: "2f1e3b0c-1d6a-4f53-9c8e-1b2a3c4d5e6f", collectedAt: at(10 * HOUR),
    database: { name: "nomorevibe", oid: "16384", inRecovery: false, readOnly: true, writeXidAssigned: false },
    promotion: { state: "promoted", fromEpoch: 1, toEpoch: 2, snapshotAt: at(0), sealedAt: at(HOUR), promotedAt: at(2 * HOUR) },
    failure: { at: at(5 * 60_000), provenance: "operator_declared" },
    writers: { required: [instance], stops: [{ instanceId: instance, stoppedAt: at(7 * 60_000), skewBoundMs: 1_000, method: "control_plane_stopped" }] },
    firstJobSuccessAfterPromotionMs: 90_000, evidence: [] };
}

describe("reportDrill", () => {
  it("computes RPO and RTO from the sealed snapshot, the declared failure, writer stops and promotion", () => {
    expect(reportDrill(drill())).toMatchObject({ rpoMs: 300_000, writeWindowMs: 420_000, maxSkewMs: 1_000,
      rtoPromotionMs: 2 * HOUR - 300_000, rtoFirstJobSuccessAtMostMs: 2 * HOUR - 300_000 + 90_000, unknown: {}, issues: [] });
  });
  it("leaves values unknown when their evidence is missing instead of estimating", () => {
    const report = reportDrill({ ...drill(), failure: null, writers: { required: [instance, "mini-reviewer"], stops: drill().writers.stops },
      firstJobSuccessAfterPromotionMs: null });
    expect(report).toMatchObject({ rpoMs: null, writeWindowMs: null, rtoPromotionMs: null, rtoFirstJobSuccessAtMostMs: null,
      unknown: { rpo: "failure_time_undeclared", writeWindow: "writer_stop_evidence_missing", rtoPromotion: "failure_time_undeclared",
        rtoFirstJobSuccess: "failure_time_undeclared" } });
    const sealed = reportDrill({ ...drill(), promotion: { ...drill().promotion, state: "sealed", promotedAt: null }, firstJobSuccessAfterPromotionMs: null });
    expect(sealed.unknown).toEqual({ rtoPromotion: "promotion_not_completed", rtoFirstJobSuccess: "promotion_not_completed" });
    expect(reportDrill({ ...drill(), firstJobSuccessAfterPromotionMs: null }).unknown).toEqual({ rtoFirstJobSuccess: "no_job_success_after_promotion" });
    expect(reportDrill({ ...drill(), writers: { required: [], stops: [] } }).unknown).toEqual({ writeWindow: "writer_instances_undeclared" });
  });
  it("flags impossible orderings instead of reporting negative durations", () => {
    expect(reportDrill({ ...drill(), failure: { at: at(-60_000), provenance: "operator_declared" } }))
      .toMatchObject({ rpoMs: 0, issues: ["snapshot_after_failure"] });
    const early = reportDrill({ ...drill(), failure: { at: at(3 * HOUR), provenance: "operator_declared" } });
    expect(early).toMatchObject({ rtoPromotionMs: null, unknown: { rtoPromotion: "promotion_before_failure" } });
    expect(early.issues).toContain("promotion_before_failure");
    expect(() => reportDrill({ ...drill(), promotion: { ...drill().promotion, toEpoch: 3 } })).toThrow("dr_drill_artifact_mismatch");
    expect(formatDrillReport(reportDrill(drill()))).toContain("RPO");
  });
});

describe("parseReportCliArgs", () => {
  it("accepts the documented commands with defaults and rejects unknown, duplicate or missing options", () => {
    expect(parseReportCliArgs(["snapshot", "--output=/tmp/a.json"])).toEqual({ command: "snapshot", output: "/tmp/a.json", target: "primary" });
    expect(parseReportCliArgs(["observe", "--run=obs", "--end=2026-10-17T00:00:00.000Z", "--output=o.json"]))
      .toEqual({ command: "observe", runId: "obs", endedAt: "2026-10-17T00:00:00.000Z", output: "o.json", hours: 24, baseline: null, target: "primary" });
    expect(parseReportCliArgs(["observe", "--run=obs", "--end=2026-10-17T00:00:00.000Z", "--output=o.json", "--hours=0.5", "--baseline=b.json",
      "--target=replica"])).toMatchObject({ hours: .5, baseline: "b.json", target: "replica" });
    expect(parseReportCliArgs(["dr-drill", "--promotion=2f1e3b0c-1d6a-4f53-9c8e-1b2a3c4d5e6f", "--output=d.json"]))
      .toEqual({ command: "dr-drill", promotionId: "2f1e3b0c-1d6a-4f53-9c8e-1b2a3c4d5e6f", output: "d.json", failureAt: null, target: "primary" });
    expect(parseReportCliArgs(["report", "--artifact=a.json", "--json"])).toEqual({ command: "report", artifact: "a.json", json: true });
    expect(() => parseReportCliArgs(["observe", "--run=obs", "--output=o.json"])).toThrow("report_cli_missing_end");
    expect(() => parseReportCliArgs(["observe", "--run=obs", "--end=2026-10-17T00:00:00Z", "--output=o.json"])).toThrow("report_cli_invalid_end");
    expect(() => parseReportCliArgs(["report", "--artifact=a", "--artifact=b"])).toThrow("report_cli_duplicate_option");
    expect(() => parseReportCliArgs(["report", "--artifact=a", "--apply"])).toThrow("report_cli_unknown_option");
    expect(() => parseReportCliArgs(["delete"])).toThrow("report_cli_unknown_command");
    expect(() => parseReportCliArgs(["dr-drill", "--promotion=x", "--output=d.json"])).toThrow("report_cli_invalid_promotion");
  });
});
