import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedStore } from "@/lib/cache/shared";

/**
 * 1분 집계 캐시를 웹 여러 대가 같이 쓴다 — 요청이 닿는 웹마다 숫자가 앞뒤로 흔들리지 않게(Valkey, lib/cache/shared.ts).
 * 수동 새로고침(fresh)은 인스턴스당 1분에 3번까지 두 층을 건너뛰고, 새로 센 값을 두 층에 다시 쓴다.
 */
const mocks = vi.hoisted(() => ({ replica: vi.fn() }));
vi.mock("@/lib/db", () => ({
  readReplicaOnly: mocks.replica,
  db: new Proxy({}, { get: () => { throw new Error("primary db touched"); } }),
}));

import { freshBudget, sharedLoader } from "@/lib/operations/shared-cache";
import { replicaCache } from "@/lib/operations/replica-cache";

let clock = 0;
const now = () => clock;
/** Valkey 대신 — 만료 시각을 지닌 값 */
function fakeStore(): SharedStore & { values: Map<string, { value: unknown; expiresAt: number }> } {
  const values = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    values,
    async get<T>(key: string) {
      const hit = values.get(key);
      return hit && hit.expiresAt > clock ? { value: hit.value as T, expiresAt: hit.expiresAt } : null;
    },
    set(key, value, expiresAt) { values.set(key, { value, expiresAt }); },
  };
}
const stamp = (seconds: number) => new Date(Date.UTC(2026, 9, 21, 0, 0, seconds)).toISOString();

beforeEach(() => {
  clock = 1_000_000;
  vi.clearAllMocks();
  mocks.replica.mockImplementation(async (load: (replica: unknown) => Promise<unknown>) => ({ ok: true, value: await load({}) }));
});

describe("새로고침의 분당 상한", () => {
  it("1분에 limit 번까지만, 1분이 지나면 다시", () => {
    const allow = freshBudget(3, now);
    expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false]);
    clock += 60_000;
    expect(allow()).toBe(true);
  });
});

describe("1분 집계 캐시(sharedLoader)", () => {
  it("한 웹이 센 값을 다른 웹이 그대로 쓰고, 그 만료를 따른다", async () => {
    const store = fakeStore();
    const webA = sharedLoader<{ n: number }>({ namespace: "t", ttlMs: 60_000, store, now });
    const webB = sharedLoader<{ n: number }>({ namespace: "t", ttlMs: 60_000, store, now });
    const loadA = vi.fn(async () => ({ n: 1 })), loadB = vi.fn(async () => ({ n: 2 }));
    expect(await webA("k", loadA)).toEqual({ n: 1 });
    clock += 30_000;
    expect(await webB("k", loadB)).toEqual({ n: 1 });
    expect(loadB).not.toHaveBeenCalled();
    clock += 31_000;
    expect(await webB("k", loadB)).toEqual({ n: 2 });
  });

  it("새로고침은 두 층을 건너뛰고 다시 써서 다른 웹도 새 값을 본다 — 1분에 3번까지", async () => {
    const store = fakeStore();
    const webA = sharedLoader<{ n: number }>({ namespace: "t", ttlMs: 60_000, store, now });
    const webB = sharedLoader<{ n: number }>({ namespace: "t", ttlMs: 60_000, store, now });
    let n = 0;
    const load = vi.fn(async () => ({ n: ++n }));
    await webB("k", load);
    for (let index = 0; index < 5; index++) { clock += 1_000; await webA("k", load, true); }
    // 처음 하나 + 새로고침 셋. 넷째부터는 담긴 값
    expect(load).toHaveBeenCalledTimes(4);
    expect(await webB("k", vi.fn(async () => ({ n: 99 })))).toEqual({ n: 4 });
  });

  it("Valkey 가 없으면 인스턴스 캐시로 — 같은 값, 실패는 담지 않고, 동시에 부르면 한 번만 센다", async () => {
    const get = sharedLoader<{ n: number }>({ namespace: "t", ttlMs: 60_000, store: null, now });
    const first = await get("k", async () => ({ n: 1 }));
    expect(await get("k", async () => ({ n: 2 }))).toBe(first);
    await expect(get("other", async () => { throw new Error("db"); })).rejects.toThrow("db");
    expect(await get("other", async () => ({ n: 3 }))).toEqual({ n: 3 });
    const slow = vi.fn(async () => ({ n: 4 }));
    await Promise.all([get("same", slow), get("same", slow), get("same", slow, true)]);
    expect(slow).toHaveBeenCalledTimes(1);
  });
});

describe("복제본 캐시의 나눠 쓰는 층(replicaCache shared)", () => {
  it("다른 웹이 읽은 값을 쓰고, DB 시각이 더 이른 값으로 담긴 값을 덮지 않는다", async () => {
    const store = fakeStore();
    const options = { event: "test.read", ttlMs: 60_000, bypass: true, perMinute: 3, now, shared: { store, namespace: "t" } };
    const webA = replicaCache<{ at: string; n: number }>(options);
    const webB = replicaCache<{ at: string; n: number }>(options);
    expect(await webA("k", async () => ({ at: stamp(10), n: 1 }))).toEqual({ ok: true, value: { at: stamp(10), n: 1 } });
    const loadB = vi.fn(async () => ({ at: stamp(20), n: 2 }));
    expect(await webB("k", loadB)).toEqual({ ok: true, value: { at: stamp(10), n: 1 } });
    expect(loadB).not.toHaveBeenCalled();
    // A 의 새로고침이 새 값을 두 층에 쓰면, B 는 제 캐시가 아직 유효해도 새 값을 본다
    clock += 5_000;
    expect(await webA("k", async () => ({ at: stamp(30), n: 3 }), true)).toMatchObject({ value: { n: 3 } });
    expect(await webB("k", loadB)).toMatchObject({ value: { at: stamp(30), n: 3 } });
    // 나눠 쓰는 층에 더 이른 값이 남아 있어도(다른 웹이 늦게 썼다) 담긴 값이 뒤로 가지 않는다
    store.set("t:k", { at: stamp(5), n: 0 }, clock + 60_000);
    expect(await webB("k", loadB)).toMatchObject({ value: { at: stamp(30), n: 3 } });
  });

  it("보류(복제본 못 읽음)는 나누지 않는다", async () => {
    const store = fakeStore();
    const read = replicaCache<{ at: string }>({ event: "test.read", ttlMs: 60_000, bypass: false, now, shared: { store, namespace: "t" } });
    mocks.replica.mockResolvedValueOnce({ ok: false, reason: "lagging" });
    expect(await read("k", async () => ({ at: stamp(1) }))).toEqual({ ok: false, reason: "lagging" });
    expect(store.values.size).toBe(0);
  });

  it("나눠 쓰는 층이 없으면(store null) 지금처럼 인스턴스 캐시만", async () => {
    const read = replicaCache<{ at: string }>({ event: "test.read", ttlMs: 60_000, bypass: true, perMinute: 3, now, shared: { store: null, namespace: "t" } });
    const load = vi.fn(async () => ({ at: stamp(clock / 1000) }));
    await read("k", load);
    clock += 10_000;
    await read("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    await read("k", load, true);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
