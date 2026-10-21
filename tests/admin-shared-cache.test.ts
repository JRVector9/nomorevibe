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

import { freshBudget, sharedLoader, sharedStale } from "@/lib/operations/shared-cache";
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

describe("1분 집계 캐시 — 숫자가 뒤로 가지 않게", () => {
  it("나눠 쓰는 층의 값이 이 웹이 쥔 값보다 먼저 센 것이면 받지 않는다", async () => {
    const store = fakeStore();
    const web = sharedLoader<{ n: number }>({ namespace: "t", ttlMs: 60_000, store, now });
    await web("k", async () => ({ n: 2 }), true);
    // 다른 웹이 더 일찍 센 값을 늦게 써 넣었다
    store.set("t:k", { v: { n: 1 }, measuredAt: clock - 30_000 }, clock + 60_000);
    expect(await web("k", vi.fn(async () => ({ n: 9 })))).toEqual({ n: 2 });
    // 더 늦게 센 값은 받는다
    store.set("t:k", { v: { n: 3 }, measuredAt: clock + 1 }, clock + 60_000);
    expect(await web("k", vi.fn(async () => ({ n: 9 })))).toEqual({ n: 3 });
  });
});

describe("기다리지 않는 공유 값(sharedStale) — 메뉴 배지", () => {
  it("처음엔 null 을 주고 뒤에서 센다 · ttl 동안 그대로 · 지나면 지난 값을 주며 한 번만 다시 센다 · stale 넘으면 null", async () => {
    const store = fakeStore();
    const badge = sharedStale<number>({ namespace: "b", ttlMs: 30_000, staleMs: 300_000, store, now });
    const load = vi.fn(async () => 7);
    expect(await badge.get("k", load)).toBeNull();
    await badge.settled("k");
    expect(await badge.get("k", load)).toBe(7);
    clock += 29_000;
    expect(await badge.get("k", load)).toBe(7);
    expect(load).toHaveBeenCalledTimes(1);
    clock += 2_000;
    load.mockResolvedValue(8);
    expect(await Promise.all([badge.get("k", load), badge.get("k", load)])).toEqual([7, 7]);
    await badge.settled("k");
    expect(load).toHaveBeenCalledTimes(2);
    expect(await badge.get("k", load)).toBe(8);
    clock += 300_000;
    load.mockRejectedValue(new Error("db"));
    expect(await badge.get("k", load)).toBeNull();
  });

  it("다른 웹이 세는 중(표시)이면 다시 세지 않고, 그 웹이 쓴 값을 받는다 — ttl 에 한 번", async () => {
    const store = fakeStore();
    const webA = sharedStale<number>({ namespace: "b", ttlMs: 30_000, staleMs: 300_000, store, now });
    const webB = sharedStale<number>({ namespace: "b", ttlMs: 30_000, staleMs: 300_000, store, now });
    const loadA = vi.fn(async () => 1), loadB = vi.fn(async () => 2);
    await webA.get("k", loadA); await webA.settled("k");
    expect(await webB.get("k", loadB)).toBe(1);
    clock += 31_000;
    // A 가 다시 세기를 맡았다(표시) — 같은 때 B 는 세지 않는다
    await webA.get("k", loadA); await webA.settled("k");
    await webB.get("k", loadB); await webB.settled("k");
    expect(loadA).toHaveBeenCalledTimes(2);
    expect(loadB).not.toHaveBeenCalled();
    // 운영센터가 막 센 값을 넣으면 다른 웹도 그 값을 본다
    webA.put("k", 5);
    expect(await webB.get("k", loadB)).toBe(5);
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
