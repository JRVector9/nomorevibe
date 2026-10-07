import { describe, expect, it, vi } from "vitest";
import { createSharedStore, sharedKey, type SharedClient } from "@/lib/cache/shared";

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
