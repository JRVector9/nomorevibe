import { describe, expect, it, vi } from "vitest";
import { clearAllMemos, createMemo, memoKey } from "@/lib/cache/memo";

describe("짧은 읽기 캐시", () => {
  it("수명 안에서는 다시 읽지 않고, 동시에 부르면 한 번만 읽는다", async () => {
    let now = 0;
    const memo = createMemo<number>({ ttlMs: 30_000, max: 10, now: () => now });
    const load = vi.fn(async () => 7);

    const [a, b] = await Promise.all([memo.get("k", load), memo.get("k", load)]);
    now = 29_999;
    const c = await memo.get("k", load);

    expect([a, b, c]).toEqual([7, 7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("만료되면 지난 값을 내놓지 않고 다시 읽는다 — 내린 제품이 두 번째 지우기 뒤에 남지 않게", async () => {
    let now = 0;
    const memo = createMemo<string>({ ttlMs: 30_000, max: 10, now: () => now });
    await memo.get("k", async () => "old");
    now = 30_000;
    let finish: (value: string) => void = () => {};
    const reading = memo.get("k", () => new Promise((resolve) => { finish = resolve; }));
    finish("new");

    expect(await reading).toBe("new");
  });

  it("실패는 담지 않는다", async () => {
    const memo = createMemo<number>({ ttlMs: 30_000, max: 10 });
    await expect(memo.get("k", async () => { throw new Error("db down"); })).rejects.toThrow("db down");

    expect(await memo.get("k", async () => 1)).toBe(1);
  });

  it("열쇠 수를 넘으면 오래된 것부터 버린다", async () => {
    const memo = createMemo<number>({ ttlMs: 30_000, max: 2 });
    const load = vi.fn(async () => 1);
    await memo.get("a", load);
    await memo.get("b", load);
    await memo.get("c", load);
    await memo.get("a", load);

    expect(load).toHaveBeenCalledTimes(4);
  });

  it("테스트 사이에는 모두 비운다", async () => {
    const memo = createMemo<number>({ ttlMs: 30_000, max: 10 });
    await memo.get("k", async () => 1);
    clearAllMemos();

    expect(await memo.get("k", async () => 2)).toBe(2);
  });

  it("열쇠는 인자의 값으로 정한다", () => {
    expect(memoKey("list", 9, { sort: "recent", since: new Date("2026-10-01T00:00:00Z") }))
      .toBe('["list",9,{"sort":"recent","since":"2026-10-01T00:00:00.000Z"}]');
    expect(memoKey({ a: 1, b: undefined })).toBe(memoKey({ a: 1 }));
  });
});
