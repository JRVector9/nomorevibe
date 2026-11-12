import { beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => ({
  conveyor: vi.fn(), progress: vi.fn(), observation: vi.fn(), audit: vi.fn(), jobs: vi.fn(), versions: vi.fn(), connections: vi.fn(), ranks: vi.fn(),
  executions: vi.fn(), inbox: vi.fn(), overview: vi.fn(), adminView: vi.fn(), sql: [] as string[], ledger: vi.fn(), warn: vi.fn(),
}));
vi.mock("@/lib/cache/shared", () => ({ sharedStore: null }));
vi.mock("@/lib/db/pool", () => ({ withDbDeadline: (_deadline: number, load: () => Promise<unknown>) => load() }));
vi.mock("@/lib/db", () => ({
  onPrimary: (load: () => Promise<unknown>) => load(),
  db: { transaction: async (work: (tx: unknown) => Promise<unknown>, options: unknown) => {
    read.sql.push(`options:${JSON.stringify(options)}`);
    return work({ execute: async (query: { queryChunks: { value?: string[] }[] }) => {
      const text = query.queryChunks.flatMap(chunk => chunk.value ?? []).join("");
      read.sql.push(text);
      return text.includes("SET LOCAL") ? [] : read.ledger();
    } });
  } },
}));
vi.mock("@/lib/observability/logger", () => ({ logger: { warn: read.warn } }));
vi.mock("@/lib/crawl/audit-policy", () => ({ openBacklogStats: read.audit }));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: async () => ({ enabled: true }) }));
vi.mock("@/lib/jobs/runner", () => ({ listJobStates: read.jobs }));
vi.mock("@/lib/operations/admin-ai-tasks-repository", () => ({ listAiConnections: read.connections, listAiTaskRows: read.ranks, readAiTasksAdminView: read.adminView }));
vi.mock("@/lib/operations/admin-ai-task-execution", () => ({ readAiTaskExecutionAdminViews: read.executions }));
vi.mock("@/lib/operations/admin-job-control", () => ({ adminJobControlVersions: read.versions }));
vi.mock("@/lib/operations/admin-models-repository", () => ({ readAdminModelsObservation: read.observation }));
vi.mock("@/lib/operations/conveyor", () => ({ readConveyor: read.conveyor }));
vi.mock("@/lib/operations/inbox", () => ({ sharedInbox: read.inbox }));
vi.mock("@/lib/operations/shared-reads", () => ({ sharedHumanQueueOverview: read.overview }));
vi.mock("@/lib/operations/worker-progress-query", () => ({ readWorkerProgress: read.progress }));

const conveyor = { measuredAt: "2026-11-12T00:00:00.000Z", stations: [], human: null, holdsByReason: [] };
const paused = new Date(Date.now() + 100 * 365 * 86_400_000);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  read.sql.length = 0;
  read.conveyor.mockResolvedValue(conveyor);
  read.progress.mockResolvedValue({ stages: [{ role: "reviewer", stage: "intro-check", job: "product-intro-check", reason: "paused", alarm: false, waiting: 12,
    oldestMinutes: 3, completed5m: 0, lane: "x", skipBlock: { reason: "all_skipped", code: "agent_review_all_skipped", detail: "running=2", streak: 3 } }],
    liveness: [{ role: "text", reason: "present", alarm: false }] });
  read.observation.mockResolvedValue({ error: null, mode: "draining", controlUpdatedAt: "2026-11-11T23:00:00.000Z", devicesRead: true,
    devices: [{ deviceId: "d1", active: 1, limitSlots: 2, models: [{ model: "m1", active: 1, waiting: 0 }] }] });
  read.audit.mockResolvedValue({ open: 5, held: 1, overdue: 2, oldestWaitDays: 9 });
  read.jobs.mockResolvedValue([{ name: "product-intro-check", notBefore: paused, lastRunAt: new Date("2026-11-03T17:02:32.000Z") },
    { name: "crawl-fetch", notBefore: null, lastRunAt: null }]);
  read.versions.mockResolvedValue({ "product-intro-check": 41 });
  read.connections.mockResolvedValue([{ id: "c1", label: "one", kind: "api", cliTool: null, deviceId: "d1", capacitySlots: 2, enabled: true,
    models: [{ id: "m1", maxModelLen: null }], cliModels: [], manualModels: ["m1", "m2"], allowedTasks: ["reason-translate"], keySetAt: null, keyValidDays: null,
    updatedAt: "2026-11-11T00:00:00.000Z", baseUrl: "https://example.invalid", hasKey: true }]);
  read.ranks.mockResolvedValue([{ task: "reason-translate", slot: 1, rank: 1, connectionId: "c1", model: "m1", enabled: true, options: {}, updatedAt: "x" }]);
  read.executions.mockResolvedValue([{ task: "publish-classify", slot: 1, mode: "workload_pool", members: [{ connectionId: "c1", model: "m1" }] },
    { task: "first-review", slot: 1, mode: "fallback", members: [{ connectionId: "c1", model: "m1" }] }]);
  read.inbox.mockResolvedValue({ fetchedAt: "x", results: { takedown: { ok: true, data: { count: 2, overdue: 1, items: [] } } } });
  read.overview.mockResolvedValue({ agreed: { approve: 3, reject: 1 } });
  read.ledger.mockResolvedValue([{ routeId: "reason-translate", groupId: "d1", model: "m1", calls: 7, settled: "6", avgSeconds: "2.5", noResult: 1 }]);
});

describe("console home read", () => {
  it("maps the existing admin reads into the task rule inputs without calling the writing admin view", async () => {
    const { readConsoleHome } = await import("@/lib/operations/console-home-read");
    const data = await readConsoleHome();
    expect(read.adminView).not.toHaveBeenCalled();
    expect(read.progress).toHaveBeenCalledWith(expect.any(Date), { includeText: true });
    expect(read.observation).toHaveBeenCalledWith({ throughput: false });
    expect(data.conveyor).toBe(conveyor);
    expect(data.inputs).toMatchObject({
      admission: { mode: "draining", since: "2026-11-11T23:00:00.000Z" }, devices: [{ deviceId: "d1", active: 1, models: [{ model: "m1", active: 1 }] }],
      takedown: { count: 2, overdue: 1 }, agreed: { approve: 3, reject: 1 }, audit: { open: 5, overdue: 2, oldestWaitDays: 9 },
      jobs: [{ name: "product-intro-check", paused: true, lastRunAt: "2026-11-03T17:02:32.000Z" }, { name: "crawl-fetch", paused: false, lastRunAt: null }],
      connections: [{ id: "c1", models: ["m1", "m2"], allowedTasks: ["reason-translate"], keySetAt: null }],
      ranks: [{ task: "reason-translate", slot: 1, rank: 1, connectionId: "c1", model: "m1", enabled: true }],
      pools: [{ task: "publish-classify", slot: 1, connectionId: "c1", model: "m1" }],
      ledger: [{ routeId: "reason-translate", groupId: "d1", model: "m1", calls: 7, settled: 6, avgSeconds: 2.5, noResult: 1 }],
      progress: { stages: [{ stage: "intro-check", job: "product-intro-check", reason: "paused", waiting: 12,
        skipBlock: { reason: "all_skipped", code: "agent_review_all_skipped", detail: "running=2" } }], liveness: [{ role: "text", reason: "present" }] },
    });
    expect(data.inputs.connections![0]).not.toHaveProperty("baseUrl");
    expect(data.jobControls).toEqual({ "product-intro-check": { paused: true, notBefore: paused.toISOString(), version: 41 } });
    // 24시간 장부 — 읽기 전용 거래, 3초 상한, 색인이 있는 시각 창
    expect(read.sql[0]).toContain('"accessMode":"read only"');
    expect(read.sql[1]).toContain("statement_timeout = '3s'");
    expect(read.sql[2]).toMatch(/state = 'settled' AND settled_at >= transaction_timestamp\(\) - interval '24 hours'/);
    expect(read.sql[2]).toContain("'gateway_http_rejected', 'gateway_not_started'");
  });

  it("keeps every other input when one read fails", async () => {
    read.progress.mockRejectedValue(new Error("review_stage_modes_missing"));
    read.ledger.mockRejectedValue(new Error("timeout"));
    read.connections.mockRejectedValue(new Error("down"));
    read.versions.mockRejectedValue(new Error("down"));
    read.observation.mockResolvedValue({ error: "운영 DB 실측을 읽지 못했습니다.", mode: null, devices: [], devicesRead: false });
    const { readConsoleHome } = await import("@/lib/operations/console-home-read");
    const data = await readConsoleHome();
    expect(data.inputs).toMatchObject({ progress: null, ledger: null, connections: null, admission: null, devices: null,
      takedown: { count: 2, overdue: 1 }, audit: { open: 5, overdue: 2, oldestWaitDays: 9 } });
    expect(data.inputs.ranks).toHaveLength(1);
    // 제어 판을 못 읽으면 그 자리 재개를 내지 않는다
    expect(data.jobControls).toEqual({});
    expect(read.warn.mock.calls.map(([event]) => event).sort()).toEqual(["console.capacity_unavailable", "console.connections_unavailable",
      "console.job_versions_unavailable", "console.ledger_unavailable", "console.progress_unavailable"]);
  });

  it("shares the heavy counts through the cache instead of recounting per render", async () => {
    const { readConsoleHome } = await import("@/lib/operations/console-home-read");
    await readConsoleHome();
    await readConsoleHome();
    expect(read.progress).toHaveBeenCalledTimes(1);
    expect(read.ledger).toHaveBeenCalledTimes(1);
    expect(read.observation).toHaveBeenCalledTimes(1);
    expect(read.audit).toHaveBeenCalledTimes(1);
  });
});
