import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSharedStore, createValkeyRoutes, sharedKey, type SharedClient } from "@/lib/cache/shared";
import { networkRoutes } from "@/lib/db/network-route";

/**
 * 웹 6대가 함께 쓰는 두 번째 캐시 층(Valkey, 2026-10-07). Valkey 가 없거나 실패해도 읽기를 막지 않는다.
 */
function fakeClient() {
  const data = new Map<string, { value: Buffer; px: number }>();
  const client: SharedClient & { data: typeof data } = {
    data,
    get: vi.fn(async (key: string) => data.get(key)?.value ?? null),
    set: vi.fn(async (key: string, value: Buffer, options: { PX: number }) => { data.set(key, { value, px: options.PX }); return "OK"; }),
  };
  return client;
}

describe("Valkey 공유 캐시", () => {
  it("넣은 값을 날짜까지 그대로 돌려주고, 만료까지 남은 시간으로 지운다", async () => {
    let now = 1_000;
    const client = fakeClient();
    const store = createSharedStore({ client: () => client, release: "abc1234", now: () => now });
    const value = { slug: "a", listedAt: new Date("2026-10-01T00:00:00Z"), tags: ["x"] };

    store.set("list:k", value, 31_000);
    await Promise.resolve();
    const [[key, , options]] = (client.set as ReturnType<typeof vi.fn>).mock.calls;
    expect(key).toBe(sharedKey("abc1234", "list:k"));
    expect(options).toEqual({ PX: 30_000 });

    const got = await store.get<typeof value>("list:k");
    expect(got?.expiresAt).toBe(31_000);
    expect(got?.value.listedAt).toBeInstanceOf(Date);
    expect(got?.value).toEqual(value);

    now = 31_000;
    expect(await store.get("list:k")).toBeNull();
  });

  it("릴리스가 다르면 열쇠가 달라 배포 사이 값이 섞이지 않는다", () => {
    expect(sharedKey("aaa", "k")).not.toBe(sharedKey("bbb", "k"));
    expect(sharedKey("aaa", "k")).toMatch(/^nmv:memo:aaa:[0-9a-f]{40}$/);
  });

  it("연결이 없거나 명령이 실패하면 없는 것으로 치고, 기록은 1분에 한 번만 남긴다", async () => {
    let now = 0;
    const warn = vi.fn();
    const failing: SharedClient = {
      get: vi.fn(async () => { throw new Error("timeout"); }),
      set: vi.fn(async () => { throw new Error("OOM command not allowed"); }),
    };
    const store = createSharedStore({ client: () => failing, release: "r", now: () => now, warn });

    expect(await store.get("k")).toBeNull();
    expect(await store.get("k")).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    now = 60_000;
    store.set("k", 1, 90_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(warn).toHaveBeenCalledTimes(2);

    const offline = createSharedStore({ client: () => null, release: "r" });
    expect(await offline.get("k")).toBeNull();
    expect(() => offline.set("k", 1, Date.now() + 1_000)).not.toThrow();
  });
});

/** 연결 상태만 흉내 — node-redis 처럼 isReady 와 error 이벤트를 가진다 */
class FakeValkey extends EventEmitter {
  isReady = false;
  constructor(readonly url: string) { super(); }
}

describe("Valkey 연결 경로(2026-10-17)", () => {
  afterEach(() => { (globalThis as { nomorevibeNetworkRoutes?: unknown }).nomorevibeNetworkRoutes = undefined; });
  const URL_TS = "redis://nmv:pw@100.99.209.55:6380/0";

  function opener() {
    const opened: FakeValkey[] = [];
    return { opened, open: vi.fn((url: string) => { const client = new FakeValkey(url); opened.push(client); return client; }) };
  }

  it("대신 주소가 없으면 지금처럼 연결 하나만 열고 경로를 관측에 올리지 않는다", () => {
    const { opened, open } = opener();
    const routes = createValkeyRoutes(URL_TS, undefined, open);
    expect(open).toHaveBeenCalledOnce();
    expect(opened[0].listenerCount("error")).toBe(0);
    expect(routes.client()).toBeNull();
    opened[0].isReady = true;
    expect(routes.client()).toBe(opened[0]);
    expect(networkRoutes()).toEqual({});
  });

  it("먼저 연결이 실패했을 때만 둘째 연결을 열고, 준비된 쪽 하나로만 명령을 보낸다", () => {
    const { opened, open } = opener();
    const routes = createValkeyRoutes(URL_TS, "192.168.50.18:6380", open);
    expect(open).toHaveBeenCalledOnce();
    expect(routes.client()).toBeNull();
    expect(networkRoutes()).toEqual({ valkey: null });

    opened[0].emit("error", new Error("ECONNREFUSED"));
    opened[0].emit("error", new Error("ECONNREFUSED"));
    expect(open).toHaveBeenCalledTimes(2);
    expect(opened[1].url).toBe("redis://nmv:pw@192.168.50.18:6380/0");
    opened[1].isReady = true;
    expect(routes.client()).toBe(opened[1]);
    expect(networkRoutes()).toEqual({ valkey: "lan" });

    // 먼저 연결이 다시 서면 그쪽으로 돌아간다(node-redis 는 끊긴 연결을 스스로 다시 붙인다)
    opened[0].isReady = true;
    expect(routes.client()).toBe(opened[0]);
    expect(networkRoutes()).toEqual({ valkey: "tailscale" });
  });

  it("설정이 틀리면 연결을 열기 전에 멈춘다", () => {
    const { open } = opener();
    expect(() => createValkeyRoutes(URL_TS, "192.168.50.18", open)).toThrow("Invalid VALKEY_FALLBACK_HOST: expected host:port");
    expect(open).not.toHaveBeenCalled();
  });
});
