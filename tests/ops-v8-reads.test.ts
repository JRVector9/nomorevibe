import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 운영센터 개편 v8 PR5 — 새 숫자의 읽기 규칙.
 *
 * - 새 숫자는 복제본에서만 읽고(readReplicaOnly), 복제본 문제든 읽다 던진 오류든 "보류"다. 주 DB 로 넘기지 않는다.
 * - 캐시: 흐름 15초·근거 20초는 새로고침(ops_fresh)이 건너뛰고 결과를 캐시에 다시 쓴다. 60초는 분당 상한 안에서 건너뛰고, 10분은 건너뛰지 않는다.
 *   DB 시각이 더 늦은 값을 더 이른 값으로 덮지 않는다(숫자가 뒤로 가지 않는다).
 * - 지금 숫자(pipelineFlow·제어 상태·처리 지표)는 렌더마다 읽되, 같은 렌더 안에서는 React cache() 로 한 번만.
 */
const mocks = vi.hoisted(() => ({
  replica: vi.fn(),
  flow: vi.fn(), control: vi.fn(), completions: vi.fn(), hourly: vi.fn(),
  /** 한 "렌더"의 cache() 저장소 — 테스트마다 비운다 */
  memo: new Map<unknown, unknown>(),
}));
vi.mock("@/lib/db", () => ({
  readReplicaOnly: mocks.replica,
  // 주 DB 를 건드리면 바로 실패한다
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
vi.mock("@/lib/operations/pipeline", () => ({ pipelineFlow: mocks.flow }));
vi.mock("@/lib/operations/pipeline-control-status", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/operations/pipeline-control-status")>(), readPipelineControlStatus: mocks.control }));
vi.mock("@/lib/operations/pipeline-completions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/operations/pipeline-completions")>(), readPipelineCompletions: mocks.completions }));
vi.mock("@/lib/operations/dashboard", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/operations/dashboard")>(), hourlyThroughput: mocks.hourly }));

import { replicaCache } from "@/lib/operations/replica-cache";
import { readSourceSplit } from "@/lib/operations/flow-reads";
import { completionsOnce, controlStatusOnce, flowOnce, hourlyOnce } from "@/app/(operator)/admin/status/render-reads";
import { TransitionCellSlot } from "@/app/(operator)/admin/status/flow-slots";
import { buildPipelineControlStatus } from "@/lib/operations/pipeline-control-status";

const root = path.resolve(__dirname, "..");
const stamp = (seconds: number) => new Date(Date.UTC(2026, 9, 18, 0, 0, seconds)).toISOString();
/** 복제본이 load 를 실행해 준다 — 주 DB 대신 받은 실행기 */
const replicaRuns = () => mocks.replica.mockImplementation(async (load: (replica: unknown) => Promise<unknown>) => ({ ok: true, value: await load({}) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.memo.clear();
});

describe("복제본 전용 캐시", () => {
  let clock = 0;
  const now = () => clock;
  beforeEach(() => { clock = 1_000_000; replicaRuns(); });

  it("복제본에서만 읽고, 복제본이 없거나 밀리면 보류다", async () => {
    const read = replicaCache<{ at: string }>({ event: "test.read", ttlMs: 20_000, bypass: true, now });
    mocks.replica.mockResolvedValueOnce({ ok: false, reason: "no_replica" });
    await expect(read("k", async () => ({ at: stamp(1) }))).resolves.toEqual({ ok: false, reason: "no_replica" });
    expect(mocks.replica).toHaveBeenCalledTimes(1);
  });

  it("복제본 안에서 던진 오류(문장 시간 초과 등)도 보류다", async () => {
    const read = replicaCache<{ at: string }>({ event: "test.read", ttlMs: 20_000, bypass: true, now });
    await expect(read("k", async () => { throw Object.assign(new Error("canceling statement"), { code: "57014" }); }))
      .resolves.toEqual({ ok: false, reason: "error" });
  });

  it("TTL 안에서는 다시 읽지 않고, 지나면 다시 읽는다", async () => {
    const read = replicaCache<{ at: string }>({ event: "test.read", ttlMs: 20_000, bypass: true, now });
    const load = vi.fn(async () => ({ at: stamp(clock / 1000) }));
    await read("k", load);
    clock += 19_000;
    await read("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    clock += 2_000;
    await read("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("새로고침은 15·20초 캐시를 건너뛰고 새 결과를 캐시에 다시 쓴다", async () => {
    const read = replicaCache<{ at: string; n: number }>({ event: "test.read", ttlMs: 20_000, bypass: true, now });
    let n = 0;
    const load = vi.fn(async () => ({ at: stamp(clock / 1000), n: ++n }));
    expect(await read("k", load)).toMatchObject({ ok: true, value: { n: 1 } });
    clock += 5_000;
    expect(await read("k", load, true)).toMatchObject({ ok: true, value: { n: 2 } });
    clock += 5_000;
    // 자동 갱신(쿠키 없음) — 옛 값(1)이 아니라 새로고침이 쓴 값(2)
    expect(await read("k", load)).toMatchObject({ ok: true, value: { n: 2 } });
    expect(load).toHaveBeenCalledTimes(2);
    // 만료는 다시 쓴 시각부터 센다
    clock += 14_000;
    await read("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("새로고침을 받지 않는 캐시(7일 10분)는 새로고침도 건너뛰지 않는다", async () => {
    const read = replicaCache<{ at: string }>({ event: "test.read", ttlMs: 60_000, bypass: false, now });
    const load = vi.fn(async () => ({ at: stamp(clock / 1000) }));
    await read("k", load);
    clock += 1_000;
    await read("k", load, true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("DB 시각이 더 이른 결과로 담긴 값을 덮지 않는다 — 숫자가 뒤로 가지 않는다", async () => {
    const read = replicaCache<{ at: string; n: number }>({ event: "test.read", ttlMs: 20_000, bypass: true, now });
    await read("k", async () => ({ at: stamp(50), n: 2 }));
    clock += 1_000;
    // 새로고침이 더 밀린 복제본에서 옛 시각을 읽어 왔다
    expect(await read("k", async () => ({ at: stamp(40), n: 1 }), true)).toMatchObject({ ok: true, value: { at: stamp(50), n: 2 } });
    expect(await read("k", async () => ({ at: stamp(60), n: 3 }))).toMatchObject({ value: { n: 2 } });
  });

  it("근거처럼 분당 상한이 있으면 새로고침을 거듭해도 그 안에서만 읽는다", async () => {
    const read = replicaCache<{ at: string }>({ event: "test.read", ttlMs: 20_000, bypass: true, perMinute: 3, now });
    const load = vi.fn(async () => ({ at: stamp(clock / 1000) }));
    for (let i = 0; i < 6; i++) { await read("k", load, true); clock += 1_000; }
    expect(load).toHaveBeenCalledTimes(3);
    clock += 60_000;
    await read("k", load, true);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("같은 열쇠를 동시에 부르면 한 번만 읽는다", async () => {
    const read = replicaCache<{ at: string }>({ event: "test.read", ttlMs: 20_000, bypass: true, now });
    const load = vi.fn(async () => ({ at: stamp(1) }));
    await Promise.all([read("k", load), read("k", load), read("k", load, true)]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("들어오는 곳 나눔(GitHub / Show HN)", () => {
  it("복제본 전용 · 60초 캐시 · 새로고침은 건너뛴다 · 실패는 보류(주 DB 로 넘기지 않는다)", async () => {
    const execute = vi.fn(async () => [{ at: stamp(2), signals: [{ signal: "Show HN", count: 23 }, { signal: "bad", count: -1 }] }]);
    const transaction = vi.fn(async (load: (tx: unknown) => Promise<unknown>, config: unknown) => {
      expect(config).toEqual({ accessMode: "read only" });
      return load({ execute });
    });
    mocks.replica.mockImplementation(async (load: (replica: unknown) => Promise<unknown>) => ({ ok: true, value: await load({ transaction }) }));
    const first = await readSourceSplit(new Date(Date.UTC(2026, 9, 18, 0, 10)));
    expect(first).toEqual({ ok: true, value: { at: stamp(2), signals: [{ signal: "Show HN", count: 23 }] } });
    await readSourceSplit(new Date(Date.UTC(2026, 9, 18, 0, 10, 30)));
    expect(transaction).toHaveBeenCalledTimes(1);
    await readSourceSplit(new Date(Date.UTC(2026, 9, 18, 0, 10, 31)), true);
    expect(transaction).toHaveBeenCalledTimes(2);
    // 다음 시가 되면 이번 시 범위가 바뀌어 새로 센다 — 복제본이 내려가 있으면 보류
    mocks.replica.mockResolvedValueOnce({ ok: false, reason: "down" });
    await expect(readSourceSplit(new Date(Date.UTC(2026, 9, 18, 1, 0, 5)))).resolves.toEqual({ ok: false, reason: "down" });
  });
});

describe("같은 렌더 안의 지금 숫자 — React cache() 로 한 번만", () => {
  it("레일·흐름 상세가 pipelineFlow 를, 장부·설정 전환 칸이 제어 상태를, 처리 지표가 처리 지표를 나눠 쓴다", async () => {
    mocks.flow.mockResolvedValue({ stages: [], bottleneck: null, published: 0 });
    mocks.control.mockResolvedValue(buildPipelineControlStatus(null, null));
    mocks.completions.mockResolvedValue({ observedAt: null, stages: [] });
    mocks.hourly.mockResolvedValue({ measuredAt: stamp(0), points: [] });
    await Promise.all([flowOnce(), flowOnce(), controlStatusOnce(), completionsOnce(), completionsOnce(), hourlyOnce(), hourlyOnce()]);
    await TransitionCellSlot();
    expect(mocks.flow).toHaveBeenCalledTimes(1);
    expect(mocks.control).toHaveBeenCalledTimes(1);
    expect(mocks.completions).toHaveBeenCalledTimes(1);
    expect(mocks.hourly).toHaveBeenCalledTimes(1);
  });

  it("다음 렌더(새 요청)는 다시 읽는다 — 지금 숫자에 시간 캐시를 걸지 않는다", async () => {
    mocks.flow.mockResolvedValue({ stages: [], bottleneck: null, published: 0 });
    await flowOnce();
    mocks.memo.clear();
    await flowOnce();
    expect(mocks.flow).toHaveBeenCalledTimes(2);
  });

  it("운영센터 화면은 세 읽기를 cache() 판으로만 부른다", () => {
    const page = readFileSync(path.join(root, "app/(operator)/admin/status/page.tsx"), "utf8");
    expect(page).not.toMatch(/\bpipelineFlow\(|\breadPipelineControlStatus\(|\breadPipelineCompletions\(|\bhourlyThroughput\(/);
    expect(page).toContain("controlStatusOnce()");
    expect(page).toContain("flowOnce()");
    expect(page).toContain("completionsOnce()");
  });
});
