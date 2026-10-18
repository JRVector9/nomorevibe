import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControlSnapshot, ModelEnv } from "@/lib/operations/pipeline-control";

const mocks = vi.hoisted(() => ({
  readReplicaOnly: vi.fn(), onReplica: vi.fn(), onPrimary: vi.fn(), readControlSnapshot: vi.fn(), warn: vi.fn(),
}));
const REPLICA = { marker: "replica" };
vi.mock("@/lib/db", () => ({ db: { marker: "primary-proxy" }, readReplicaOnly: mocks.readReplicaOnly, onReplica: mocks.onReplica, onPrimary: mocks.onPrimary }));
vi.mock("@/lib/operations/pipeline-control-repository", () => ({ readControlSnapshot: mocks.readControlSnapshot }));
vi.mock("@/lib/observability/logger", () => ({ logger: { warn: mocks.warn, info: vi.fn(), error: vi.fn() } }));

import { readModelRouteStatus } from "@/lib/operations/model-route-status";
import { formatControlStatus, statusRouteContracts } from "@/lib/operations/pipeline-control";

const MODELS: ModelEnv = { crawlReview: "env-ai1", translate: "tr", tagline: "tg", profile: "pf", verify: "vf", introCheck: "intro" };
type Stage = ControlSnapshot["stages"][number];
const stage = (name: "ai1" | "ai2", extra: Partial<Stage> = {}): Stage => ({ stage: name, mode: "legacy", drainingFrom: null, epoch: 1, contract: 1,
  live: 0, unsettled: 0, legacyJobLive: false, consumers: 0, ...extra });
const SNAPSHOT: ControlSnapshot = { now: "2026-10-18T00:44:02.000Z", fence: { state: "active", writerEpoch: 1 },
  stages: [stage("ai1"), stage("ai2", { mode: "draining", drainingFrom: "legacy", live: 2, legacyJobLive: true, consumers: 1 })],
  capacity: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, waiting: 0, reserved: 0, dispatched: 0, indeterminate: 0, oldGeneration: 0 },
  http: { mode: "disabled", epoch: 1, revision: 1, policy: null, policyHash: null, reserved: 0, dispatched: 0, indeterminate: 0 },
  batch: { mode: "legacy", drainingFrom: null, epoch: 1, contract: 0, policy: null, policyHash: null, liveJobs: 3, liveRoles: 5, liveItems: 0, liveSources: 0 },
  recentInstances: [], reviewSettings: { firstReview: { provider: "abcllm", model: "ai1-gw" } }, auditCampaign: null };

beforeEach(() => { vi.clearAllMocks(); });

/**
 * 모델 경로 계약·전환 진행은 운영 CLI(status)에만 있었다(ops-v8 PR8). 관리자 화면도 같은 readback·같은 판정을 쓰되,
 * 새로 읽는 값이라 복제본에서만 읽는다 — 못 읽으면 null(화면 "보류")이고 주 DB 로 넘기지 않는다.
 */
describe("모델 경로 계약 읽기", () => {
  it("CLI 와 같은 readback 을 복제본 전용으로만 읽는다", async () => {
    mocks.readReplicaOnly.mockImplementation(async (load: (replica: unknown) => Promise<unknown>) => ({ ok: true, value: await load(REPLICA) }));
    mocks.readControlSnapshot.mockResolvedValue(SNAPSHOT);
    const status = await readModelRouteStatus(MODELS);
    expect(mocks.readReplicaOnly).toHaveBeenCalledTimes(1);
    expect(mocks.readControlSnapshot).toHaveBeenCalledWith(REPLICA);
    expect(mocks.onReplica).not.toHaveBeenCalled();
    expect(mocks.onPrimary).not.toHaveBeenCalled();
    expect(status).toEqual({ ok: true, value: { at: SNAPSHOT.now, routes: statusRouteContracts(SNAPSHOT, MODELS), stages: SNAPSHOT.stages,
      batch: SNAPSHOT.batch, capacity: SNAPSHOT.capacity } });
  });

  it("복제본에서 못 읽으면 그 까닭으로 보류한다", async () => {
    mocks.readReplicaOnly.mockResolvedValue({ ok: false, reason: "lagging" });
    expect(await readModelRouteStatus(MODELS)).toEqual({ ok: false, reason: "lagging" });
    expect(mocks.readControlSnapshot).not.toHaveBeenCalled();
  });

  it("복제본에서 읽다 던진 오류(문장 시간 초과 57014 등)도 보류로 돌려주고 남긴다", async () => {
    mocks.readReplicaOnly.mockImplementation(async (load: (replica: unknown) => Promise<unknown>) => ({ ok: true, value: await load(REPLICA) }));
    mocks.readControlSnapshot.mockRejectedValue(Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" }));
    expect(await readModelRouteStatus(MODELS)).toEqual({ ok: false, reason: "error" });
    expect(mocks.warn).toHaveBeenCalledWith("operations.model_routes_unavailable", expect.anything());
  });

  it("CLI status 출력과 같은 route 판정이다", () => {
    const text = formatControlStatus(SNAPSHOT, MODELS);
    for (const row of statusRouteContracts(SNAPSHOT, MODELS)) expect(text).toContain(row.routeId);
    expect(statusRouteContracts(SNAPSHOT, MODELS)).toContainEqual({ routeId: "crawl-agent-review", provider: "abcllm", model: "ai1-gw", status: "unmapped" });
  });
});
