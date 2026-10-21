import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 운영센터 개편 v8 PR6 — 흐름 상세 탭의 새 숫자 읽기.
 * 모델 자리 24h(+1시간) 60초(새로고침이 분당 3번까지 건너뛴다) · 7일 10분(새로고침도 건너뛰지 않는다) · 미룬 이유 15초(새로고침이 건너뛰고 다시 쓴다).
 * 모두 복제본 전용이고 실패는 보류. 탭은 지금 숫자를 레일·장부·처리 지표와 같은 렌더의 cache() 결과로 나눠 쓴다.
 */
const mocks = vi.hoisted(() => ({
  replica: vi.fn(), deferrals: vi.fn(),
  flow: vi.fn(), control: vi.fn(), completions: vi.fn(), hourly: vi.fn(), split: vi.fn(), evidence: vi.fn(),
  memo: new Map<unknown, unknown>(),
  clock: { now: 1_000_000 },
}));
vi.mock("@/lib/db", () => ({
  readReplicaOnly: mocks.replica,
  db: new Proxy({}, { get: () => { throw new Error("primary db touched"); } }),
  onReplica: () => { throw new Error("primary fallback used"); },
}));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  cache: <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    if (!mocks.memo.has(fn)) mocks.memo.set(fn, fn(...args));
    return mocks.memo.get(fn) as R;
  },
}));
vi.mock("@/lib/jobs/deferral-observation", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/jobs/deferral-observation")>(), readJobDeferrals: mocks.deferrals }));
vi.mock("@/lib/operations/pipeline", () => ({ pipelineFlow: mocks.flow }));
vi.mock("@/lib/operations/pipeline-control-status", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/operations/pipeline-control-status")>(), readPipelineControlStatus: mocks.control }));
vi.mock("@/lib/operations/pipeline-completions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/operations/pipeline-completions")>(), readPipelineCompletions: mocks.completions }));
vi.mock("@/lib/operations/dashboard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/operations/dashboard")>(), hourlyThroughput: mocks.hourly }));

import { DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
import { readDeferrals, readModelSlotWeek, readModelSlotWindows } from "@/lib/operations/flow-reads";
import { buildPipelineControlStatus } from "@/lib/operations/pipeline-control-status";
import { buildPipelineCompletions } from "@/lib/operations/pipeline-completions";
import { resolveModelSlots } from "@/lib/operations/stage-registry";
import { completionsOnce, controlStatusOnce, flowOnce, hourlyOnce } from "@/app/(operator)/admin/status/render-reads";
import { FlowDetailSlot } from "@/app/(operator)/admin/status/FlowDetail";

const slots = resolveModelSlots(DEFAULT_CRAWL_SETTINGS, {});
const stamp = (seconds: number) => new Date(Date.UTC(2026, 9, 18, 0, 0, seconds)).toISOString();
/** 복제본 실행기 — 문장마다 같은 행을 돌려준다 */
function replicaWith(rows: unknown[]) {
  const execute = vi.fn(async () => rows);
  const transaction = vi.fn(async (load: (tx: unknown) => Promise<unknown>) => load({ execute }));
  mocks.replica.mockImplementation(async (load: (replica: unknown) => Promise<unknown>) => ({ ok: true, value: await load({ execute, transaction }) }));
  return transaction;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memo.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 1, 0, 0)));
});

describe("모델 자리 24h · 7일", () => {
  it("24h(+1시간)는 복제본 전용 60초 캐시 — 새로고침은 분당 3번까지만 건너뛴다", async () => {
    const transaction = replicaWith([{ at: stamp(1), slots: [{ slot: "first", observed: "m", calls1h: 3, failed1h: 1, calls: 9, failed: 2, agree1h: null, agree: null }] }]);
    const first = await readModelSlotWindows(slots);
    expect(first).toMatchObject({ ok: true, value: { at: stamp(1), window: "24h", rows: [{ slot: "first", calls1h: 3, failed: 2 }] } });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 1, 0, 59)));
    await readModelSlotWindows(slots);
    expect(transaction).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 1, 1, 1)));
    await readModelSlotWindows(slots);
    expect(transaction).toHaveBeenCalledTimes(2);
    // 새로고침 — 이 1분 안의 읽기(01:01:01)와 합쳐 셋까지. 넷째는 담긴 값
    for (const second of [2, 3, 4]) {
      vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 1, 1, second)));
      await readModelSlotWindows(slots, true);
    }
    expect(transaction).toHaveBeenCalledTimes(4);
  });

  it("7일은 10분 캐시, 복제본을 못 읽으면 보류", async () => {
    const transaction = replicaWith([{ at: stamp(2), slots: [] }]);
    await readModelSlotWeek(slots);
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 1, 9, 0)));
    await readModelSlotWeek(slots);
    expect(transaction).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 1, 20, 0)));
    mocks.replica.mockResolvedValueOnce({ ok: false, reason: "lagging" });
    await expect(readModelSlotWeek(slots)).resolves.toEqual({ ok: false, reason: "lagging" });
  });
});

describe("미룬 이유(defer:<job>)", () => {
  const ready = (at: string, count: number) => ({ state: "ready", at, jobs: [{ job: "second-review", reason: "model_capacity", lastDeferredAt: at, lastHour: count, lastHourByReason: { model_capacity: count } }] });

  it("복제본 범위 안에서 읽고, 15초 캐시를 새로고침이 건너뛰어 다시 쓴다", async () => {
    replicaWith([]);
    mocks.deferrals.mockImplementationOnce(async (run: (load: () => Promise<unknown>) => Promise<unknown>) => { await run(async () => null); return ready(stamp(10), 1); })
      .mockImplementationOnce(async () => ready(stamp(20), 4));
    expect(await readDeferrals(false)).toMatchObject({ ok: true, value: { at: stamp(10), jobs: [{ lastHour: 1 }] } });
    expect(mocks.replica).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 1, 0, 5)));
    expect(await readDeferrals(true)).toMatchObject({ value: { at: stamp(20), jobs: [{ lastHour: 4 }] } });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 1, 0, 10)));
    // 자동 갱신 — 새로고침이 다시 쓴 값
    expect(await readDeferrals(false)).toMatchObject({ value: { at: stamp(20) } });
    expect(mocks.deferrals).toHaveBeenCalledTimes(2);
  });

  it("읽기 실패(복제본 없음·읽기 오류)는 보류", async () => {
    mocks.replica.mockResolvedValueOnce({ ok: false, reason: "no_replica" });
    await expect(readDeferrals(true)).resolves.toEqual({ ok: false, reason: "no_replica" });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 18, 1, 5, 0)));
    replicaWith([]);
    mocks.deferrals.mockResolvedValueOnce({ state: "held", reason: "read_failed" });
    await expect(readDeferrals(true)).resolves.toEqual({ ok: false, reason: "error" });
  });
});

describe("흐름 상세 탭의 지금 숫자 — 같은 렌더의 cache() 결과", () => {
  it("탭이 레일·장부·처리 지표·타일과 같은 읽기를 한 번만 쓴다", async () => {
    replicaWith([{ at: stamp(3), slots: [], signals: [] }]);
    mocks.deferrals.mockResolvedValue({ state: "ready", at: stamp(3), jobs: [] });
    mocks.flow.mockResolvedValue({ stages: [], bottleneck: null, published: 0 });
    mocks.control.mockResolvedValue(buildPipelineControlStatus(null, null));
    mocks.completions.mockResolvedValue(buildPipelineCompletions(null));
    mocks.hourly.mockResolvedValue({ measuredAt: stamp(0), points: [] });
    const inputs = { settings: DEFAULT_CRAWL_SETTINGS, jobStates: [], jobBatch: null, throughput: null, models: null, attention: null,
      overview: { stages: { human: 0, agreed: 0 }, decided24h: null, wait: null },
      ops: { fetchedAt: stamp(0), observations: [], held: 0 } } as never;
    const derived = { health: null, workerProgress: null, quota: null } as never;
    // 전체 현황 조각들이 같은 렌더에서 먼저 읽는다
    await Promise.all([flowOnce(), controlStatusOnce(), completionsOnce(), hourlyOnce()]);
    await FlowDetailSlot({ inputs, derived, actions: [], fresh: false });
    expect(mocks.flow).toHaveBeenCalledTimes(1);
    expect(mocks.control).toHaveBeenCalledTimes(1);
    expect(mocks.completions).toHaveBeenCalledTimes(1);
    expect(mocks.hourly).toHaveBeenCalledTimes(1);
  });
});
