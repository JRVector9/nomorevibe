import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { ThroughputStage } from "@/lib/operations/throughput-model";

/**
 * 역할 감독의 제 역할 읽기(readRoleProgress, 2026-11-21): 역할마다 어느 조각을 부르고 어느 조각을 부르지 않는지 고정한다.
 * 전체 읽기(readWorkerProgress — 배포 관문·감시·콘솔)는 모든 조각을 예전 인자 그대로 부른다.
 * 같은 DB 상태에서 두 읽기의 값이 같은지는 tests/integration/role-progress-read.test.ts 가 본다.
 */
const fixture = vi.hoisted(() => {
  const NOW = new Date("2026-11-21T00:00:00.000Z");
  const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
  return {
    NOW, at,
    capacity: { mode: "disabled" as "disabled" | "open" | "draining" | null },
    reviewModes: ["ai1", "ai2"].map(stage => ({ stage, mode: "legacy", drainingFrom: null })),
    admissionBlocks: [] as Array<{ job: string; routeId: string; groupId: string; scope: "device" }>,
    observationFilters: [] as SQL[],
    transactions: 0,
    evidenceRows: ["evidence", "agent-evidence", "ai-level"].map(key => ({ key, waiting: 0, oldest: null, completed: 0, progress: 0, errors: 0,
      deferred: 0, provider_errors: 0, error_age: null })),
  };
});
const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(), listJobStates: vi.fn(), readJobBatchMode: vi.fn(), readAgentScanMode: vi.fn(), readCapacity: vi.fn(),
  readAdmissionBlocks: vi.fn(), pipelineThroughput: vi.fn(), readUptimeSplitStage: vi.fn(), readTextStageProgress: vi.fn(),
  readPublisherDrain: vi.fn(), hasActiveRoleJob: vi.fn(), readMaintenanceUptime: vi.fn(), readTextProgress: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ db: {
  // 근거 집계만 이 트랜잭션을 쓴다(처리량은 아래에서 통째로 가짜다)
  transaction: async (load: (tx: { execute: () => Promise<unknown> }) => Promise<unknown>) => {
    fixture.transactions++;
    return load({ execute: async () => fixture.evidenceRows });
  },
  select: () => ({ from: (table: unknown) => ({ where: async (filter: SQL) => {
    const { pipelineStageModes } = await import("@/lib/db/schema");
    if (table === pipelineStageModes) return fixture.reviewModes;
    fixture.observationFilters.push(filter);
    return ["scheduler", "crawler", "reviewer", "publisher", "maintenance", "text"]
      .map(role => ({ key: `service:${role}:test`, value: { status: "running" }, observedAt: fixture.NOW }));
  } }) }),
} }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/lib/jobs/runner", () => ({ listJobStates: mocks.listJobStates }));
vi.mock("@/lib/jobs/batch-repository", async original => ({ ...await original<object>(), readJobBatchMode: mocks.readJobBatchMode }));
vi.mock("@/lib/domain/evidence/agents/claim-control", async original => ({ ...await original<object>(), readAgentScanMode: mocks.readAgentScanMode }));
vi.mock("@/lib/llm/capacity-repository", async original => ({ ...await original<object>(), readModelCapacityControlObservation: mocks.readCapacity }));
vi.mock("@/lib/operations/capacity-admission-block", async original => ({ ...await original<object>(), readCapacityAdmissionBlocks: mocks.readAdmissionBlocks }));
vi.mock("@/lib/operations/throughput", async original => ({ ...await original<object>(), pipelineThroughput: mocks.pipelineThroughput }));
vi.mock("@/lib/operations/uptime-split-repository", () => ({ readUptimeSplitStage: mocks.readUptimeSplitStage }));
vi.mock("@/lib/operations/text-stage-progress", () => ({ readTextStageProgress: mocks.readTextStageProgress }));
vi.mock("@/lib/operations/publisher-drain-progress", () => ({ readPublisherClassificationDrain: mocks.readPublisherDrain }));
vi.mock("@/lib/jobs/control", async original => ({ ...await original<object>(), hasActiveRoleJob: mocks.hasActiveRoleJob }));
vi.mock("@/lib/operations/maintenance-progress", async original => ({ ...await original<object>(), readMaintenanceUptimeProgress: mocks.readMaintenanceUptime }));
vi.mock("@/lib/operations/text-progress", async original => ({ ...await original<object>(), readTextProgress: mocks.readTextProgress }));

import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { CAPACITY_ADMISSION_BLOCK_JOBS } from "@/lib/operations/capacity-admission-block";
import { progressStageRole, TEXT_PROGRESS_STAGE_JOBS, type ProgressStageKey } from "@/lib/operations/worker-progress";
import { readRoleProgress, readWorkerProgress, ROLE_PROGRESS_STAGES, type RoleStageProgress } from "@/lib/operations/worker-progress-query";
import { checkRoleProgress } from "@/scripts/role-worker";

const settings = { ...DEFAULT_CRAWL_SETTINGS, enabled: true };
const stage = (key: ThroughputStage["key"], extra: Partial<ThroughputStage> = {}): ThroughputStage => ({ key, label: key, unit: "건",
  completed1m: 0, completed5m: 0, progress5m: 0, waiting: 0, oldestMinutes: null, enabled: true, errors5m: 0, queueNote: "", detail: "",
  status: "idle", ...extra });
let throughputStages: ThroughputStage[];
const job = (name: string, extra: Record<string, unknown> = {}) => ({ name, nextScheduledAt: fixture.at(-1), notBefore: null, lockedAt: null,
  leaseToken: null, cursor: null, lastError: null, ...extra });
const dialect = new PgDialect();
/** 관측 읽기의 조건에 실린 값(키·접두어) */
const observationParams = () => fixture.observationFilters.map(filter => dialect.sqlToQuery(filter).params);

afterEach(() => { vi.useRealTimers(); });
beforeEach(() => {
  // 감독(checkRoleProgress)은 지금 시각으로 읽는다 — 관측의 신선도 판정이 fixture 시각과 맞게 시계만 고정한다
  vi.useFakeTimers({ now: fixture.NOW, toFake: ["Date"] });
  fixture.capacity.mode = "disabled";
  fixture.admissionBlocks = [];
  fixture.observationFilters.length = 0;
  fixture.transactions = 0;
  throughputStages = (["fetch", "judge", "first", "second", "publish"] as const).map(key => stage(key));
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getSettings.mockResolvedValue(settings);
  mocks.listJobStates.mockResolvedValue([job("crawl-fetch"), job("second-review"), job("crawl-publish")]);
  mocks.readJobBatchMode.mockResolvedValue({ mode: "legacy", writerContractVersion: 0 });
  mocks.readAgentScanMode.mockResolvedValue({ mode: "legacy", drainingFrom: null });
  mocks.readCapacity.mockImplementation(async () => {
    if (!fixture.capacity.mode) throw new Error("model_capacity_control_missing");
    return { mode: fixture.capacity.mode };
  });
  mocks.readAdmissionBlocks.mockImplementation(async () => fixture.admissionBlocks);
  mocks.pipelineThroughput.mockImplementation(async (_settings: unknown, now: Date, only?: readonly string[]) => ({ measuredAt: now.toISOString(),
    stages: throughputStages.filter(row => !only || only.includes(row.key)) }));
  mocks.readUptimeSplitStage.mockResolvedValue(null);
  mocks.readTextStageProgress.mockResolvedValue([]);
  mocks.readPublisherDrain.mockResolvedValue(false);
  mocks.hasActiveRoleJob.mockResolvedValue(false);
});

describe("역할마다 읽는 조각", () => {
  it("단계 목록은 그 역할이 맡는 텍스트 아닌 단계 전부다", () => {
    const keys: ProgressStageKey[] = ["fetch", "judge", "first", "second", "publish", "evidence", "agent-evidence", "ai-level", "uptime",
      ...Object.keys(TEXT_PROGRESS_STAGE_JOBS) as ProgressStageKey[]];
    for (const role of ["crawler", "reviewer", "publisher"] as const)
      expect([...ROLE_PROGRESS_STAGES[role]].sort(), role).toEqual(keys
        .filter(key => progressStageRole(key) === role && !Object.hasOwn(TEXT_PROGRESS_STAGE_JOBS, key)).sort());
    // 접수 막힘이 끄는 잡은 모두 reviewer 단계의 잡이다 — 다른 역할은 그 집계를 읽지 않아도 판정이 같다
    expect([...CAPACITY_ADMISSION_BLOCK_JOBS].sort()).toEqual(["crawl-agent-review", "second-review"]);
  });

  it("crawler: 수집 처리량·근거 집계·제 관측만 — 접수 막힘·응답 점검·텍스트·발행 drain 은 읽지 않는다", async () => {
    fixture.capacity.mode = "draining";
    const report = await readRoleProgress("crawler", fixture.NOW) as RoleStageProgress;
    expect(mocks.pipelineThroughput.mock.calls).toEqual([[settings, fixture.NOW, ["fetch"]]]);
    expect(fixture.transactions).toBe(1);
    expect(observationParams()).toEqual([["scheduler", "crawler", "service:scheduler:%", "service:crawler:%", "agent-scan:%"]]);
    for (const unread of [mocks.readAdmissionBlocks, mocks.readUptimeSplitStage, mocks.readTextStageProgress, mocks.readPublisherDrain])
      expect(unread).not.toHaveBeenCalled();
    for (const control of [mocks.getSettings, mocks.listJobStates, mocks.readJobBatchMode, mocks.readAgentScanMode, mocks.readCapacity])
      expect(control).toHaveBeenCalledOnce();
    expect(report.stages.map(row => row.stage)).toEqual(["fetch", "evidence", "agent-evidence", "ai-level"]);
    expect(report.liveness.map(row => row.role)).toEqual(["scheduler", "crawler"]);
    expect(report).not.toHaveProperty("overall");
  });

  it("reviewer: 심사 세 단계의 처리량·접수 막힘·제 잡의 건너뜀 관측만 — 근거 집계·응답 점검은 읽지 않는다", async () => {
    fixture.capacity.mode = "draining";
    const report = await readRoleProgress("reviewer", fixture.NOW) as RoleStageProgress;
    expect(mocks.pipelineThroughput.mock.calls).toEqual([[settings, fixture.NOW, ["judge", "first", "second"]]]);
    expect(mocks.readAdmissionBlocks).toHaveBeenCalledOnce();
    expect(fixture.transactions).toBe(0);
    expect(observationParams()).toEqual([["scheduler", "reviewer", "job:crawl-agent-review", "job:second-review",
      "service:scheduler:%", "service:reviewer:%"]]);
    for (const unread of [mocks.readUptimeSplitStage, mocks.readTextStageProgress, mocks.readPublisherDrain]) expect(unread).not.toHaveBeenCalled();
    expect(report.stages.map(row => row.stage)).toEqual(["judge", "first", "second"]);
    expect(report.liveness.map(row => row.role)).toEqual(["scheduler", "reviewer"]);
  });

  it("publisher: 발행 처리량과, 용량 DRAIN 일 때만 발행 분류 drain 관측", async () => {
    const report = await readRoleProgress("publisher", fixture.NOW) as RoleStageProgress;
    expect(mocks.pipelineThroughput.mock.calls).toEqual([[settings, fixture.NOW, ["publish"]]]);
    expect(observationParams()).toEqual([["scheduler", "publisher", "service:scheduler:%", "service:publisher:%"]]);
    expect(fixture.transactions).toBe(0);
    for (const unread of [mocks.readAdmissionBlocks, mocks.readUptimeSplitStage, mocks.readTextStageProgress, mocks.readPublisherDrain])
      expect(unread).not.toHaveBeenCalled();
    expect(report.stages.map(row => row.stage)).toEqual(["publish"]);
    fixture.capacity.mode = "draining";
    await readRoleProgress("publisher", fixture.NOW);
    expect(mocks.readPublisherDrain).toHaveBeenCalledOnce();
  });

  it.each(["maintenance", "text"] as const)("%s: scheduler 판정에 드는 것만 — 설정·처리량·근거·응답 점검을 읽지 않고 단계 칸이 없다", async role => {
    fixture.capacity.mode = "draining";
    const report = await readRoleProgress(role, fixture.NOW);
    expect(report).toEqual({ measuredAt: fixture.NOW.toISOString(), role, scheduler: { role: "scheduler", reason: "scheduled", alarm: false, overdueJobs: [] } });
    expect(observationParams()).toEqual([["scheduler", "service:scheduler:%"]]);
    expect(fixture.transactions).toBe(0);
    for (const unread of [mocks.getSettings, mocks.pipelineThroughput, mocks.readAdmissionBlocks, mocks.readUptimeSplitStage,
      mocks.readTextStageProgress, mocks.readPublisherDrain]) expect(unread).not.toHaveBeenCalled();
    for (const control of [mocks.listJobStates, mocks.readJobBatchMode, mocks.readAgentScanMode, mocks.readCapacity]) expect(control).toHaveBeenCalledOnce();
  });

  it("전체 읽기는 모든 조각을 예전 인자로 부르고 관측 표를 통째로 읽는다", async () => {
    fixture.capacity.mode = "draining";
    const report = await readWorkerProgress(fixture.NOW);
    expect(mocks.pipelineThroughput.mock.calls).toEqual([[settings, fixture.NOW]]);
    expect(fixture.transactions).toBe(1);
    expect(observationParams()).toEqual([["defer:%", "job-tally:%", "discovery-progress:%"]]);
    for (const read of [mocks.getSettings, mocks.readAdmissionBlocks, mocks.readUptimeSplitStage, mocks.readTextStageProgress, mocks.readPublisherDrain])
      expect(read).toHaveBeenCalledOnce();
    expect(mocks.readTextStageProgress).toHaveBeenCalledWith({ reuseReasonOnly: false });
    expect(report.stages.map(row => row.stage)).toEqual(["fetch", "judge", "first", "second", "publish", "evidence", "agent-evidence", "ai-level"]);
    expect(report.liveness).toHaveLength(6);
    expect(report.overall).toBe("ok");
  });
});

describe("판정을 넓히지 않는다", () => {
  const stalledSecond = () => { throughputStages = throughputStages.map(row => row.key === "second" ? stage("second", { waiting: 4, oldestMinutes: 30 }) : row); };

  it("접수 막힘은 reviewer 읽기에서도 재시작을 끈다(전체 읽기와 같은 단계)", async () => {
    stalledSecond();
    fixture.capacity.mode = "open";
    fixture.admissionBlocks = [{ job: "second-review", routeId: "second-review", groupId: "alpha", scope: "device" }];
    const full = await readWorkerProgress(fixture.NOW, { includeText: false });
    const mine = await readRoleProgress("reviewer", fixture.NOW) as RoleStageProgress;
    expect(mine.stages).toEqual(full.stages.filter(row => row.role === "reviewer"));
    expect(mine.stages.find(row => row.stage === "second")).toMatchObject({ reason: "no_progress", alarm: true, restartEligible: false,
      admissionBlock: { reason: "capacity", scope: "device" } });
    expect(await checkRoleProgress("reviewer")).toBe(false);
    fixture.admissionBlocks = [];
    expect(await checkRoleProgress("reviewer")).toMatchObject({ kind: "stage", job: "second-review", restartEligible: true });
  });

  it.each(["crawler", "reviewer", "publisher", "maintenance", "text"] as const)("%s: control 행이 없거나 읽지 못하면 판정을 내지 않는다", async role => {
    fixture.capacity.mode = null;
    await expect(readRoleProgress(role, fixture.NOW)).rejects.toThrow("model_capacity_control_missing");
    fixture.capacity.mode = "disabled";
    fixture.reviewModes = fixture.reviewModes.filter(row => row.stage !== "ai2");
    try { await expect(readRoleProgress(role, fixture.NOW)).rejects.toThrow("review_stage_modes_missing"); }
    finally { fixture.reviewModes = ["ai1", "ai2"].map(name => ({ stage: name, mode: "legacy", drainingFrom: null })); }
    for (const [mock, code] of [[mocks.readAgentScanMode, "agent_scan_control_missing"], [mocks.readJobBatchMode, "job_batch_control_missing"],
      [mocks.listJobStates, "jobs_unreadable"]] as const) {
      mock.mockRejectedValueOnce(new Error(code));
      await expect(readRoleProgress(role, fixture.NOW)).rejects.toThrow(code);
    }
  });

  it("읽기로 한 단계가 보고서에서 빠지면 판정을 내지 않는다", async () => {
    throughputStages = throughputStages.filter(row => row.key !== "second");
    await expect(readRoleProgress("reviewer", fixture.NOW)).rejects.toThrow("role_progress_stage_missing");
    await expect(checkRoleProgress("reviewer")).rejects.toThrow("role_progress_stage_missing");
  });

  it("제 조각의 실패는 던지고, 읽지 않는 조각의 실패는 그 역할의 판정을 막지 않는다", async () => {
    mocks.pipelineThroughput.mockRejectedValueOnce(new Error("throughput_timeout"));
    await expect(readRoleProgress("publisher", fixture.NOW)).rejects.toThrow("throughput_timeout");
    // 응답 점검 장부를 못 읽으면 전체 읽기는 통째로 실패한다 — 그 장부를 읽지 않는 역할 읽기는 제 몫을 낸다
    mocks.readUptimeSplitStage.mockRejectedValue(new Error("uptime_readback_timeout"));
    await expect(readWorkerProgress(fixture.NOW, { includeText: false })).rejects.toThrow("uptime_readback_timeout");
    for (const role of ["crawler", "reviewer", "publisher", "maintenance", "text"] as const)
      await expect(readRoleProgress(role, fixture.NOW)).resolves.toMatchObject({ role, scheduler: { reason: "scheduled" } });
  });
});

describe("역할 감독의 15초 판정(checkRoleProgress)", () => {
  it("versioned batch 후보는 아무것도 읽지 않는다", async () => {
    expect(await checkRoleProgress("crawler", 1)).toBe(false);
    expect(mocks.listJobStates).not.toHaveBeenCalled();
    expect(mocks.hasActiveRoleJob).not.toHaveBeenCalled();
  });

  it.each(["maintenance", "text"] as const)("%s: 도는 잡이 있으면 읽지 않고, 없으면 scheduler 판정만 읽어 제 정체 규칙에 넘긴다", async role => {
    const uptime = { waiting: true, oldestMinutes: 12, persistedWithin5m: false, inBackoff: false, jobError: false, splitHeld: false };
    const text = { oldestReadyMinutes: 25, persistedWithin10m: false, inBackoff: false, providerError: false, admissionHeld: false };
    mocks.readMaintenanceUptime.mockResolvedValue(uptime);
    mocks.readTextProgress.mockResolvedValue(text);
    mocks.hasActiveRoleJob.mockResolvedValueOnce(true);
    expect(await checkRoleProgress(role)).toBe(false);
    expect(mocks.listJobStates).not.toHaveBeenCalled();
    expect(await checkRoleProgress(role)).toMatchObject({ kind: "stage", reason: "no_progress", restartEligible: true,
      ...(role === "maintenance" ? { job: "uptime-ping", age: 12 } : { job: null, age: 25 }) });
    for (const unread of [mocks.getSettings, mocks.pipelineThroughput, mocks.readUptimeSplitStage, mocks.readAdmissionBlocks])
      expect(unread).not.toHaveBeenCalled();
    // scheduler 가 예약을 밀지 못하면(예약 모름) 정체로 보지 않는다
    mocks.listJobStates.mockResolvedValue([job("crawl-fetch", { nextScheduledAt: null })]);
    expect(await checkRoleProgress(role)).toBe(false);
  });

  it("crawler·reviewer·publisher 는 제 역할 읽기 하나로 단계 정체를 고른다", async () => {
    throughputStages = throughputStages.map(row => row.key === "publish" ? stage("publish", { waiting: 2, oldestMinutes: 45 }) : row);
    expect(await checkRoleProgress("publisher")).toEqual({ kind: "stage", reason: "no_progress", job: "crawl-publish", lane: "crawl-publish",
      age: 45, wait: 2, progress: 0, restartEligible: true });
    expect(await checkRoleProgress("crawler")).toBe(false);
    expect(await checkRoleProgress("reviewer")).toBe(false);
    expect(mocks.pipelineThroughput.mock.calls.map(call => call[2])).toEqual([["publish"], ["fetch"], ["judge", "first", "second"]]);
    expect(mocks.hasActiveRoleJob).not.toHaveBeenCalled();
  });
});
