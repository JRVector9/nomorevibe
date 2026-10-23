import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const read = vi.hoisted(() => ({ replica: vi.fn(), home: vi.fn(), queue: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/db", () => ({ readReplicaOnly: read.replica }));
vi.mock("@/lib/cache/shared", () => ({ sharedStore: null }));
vi.mock("@/lib/domain/products/korean-taglines", () => ({ homeListSlugs: read.home, koreanTaglineQueue: read.queue }));
vi.mock("@/lib/observability/logger", () => ({ logger: { warn: read.warn } }));

const value = { eligible: 10, done: 4, ready: 3, retryScheduled: 2, blocked: 1, lastHour: 2,
  measuredAt: "2026-10-23T18:00:00.000Z" };
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  read.replica.mockImplementation(async (load: (replica: unknown) => Promise<unknown>) => ({ ok: true, value: await load({}) }));
  read.home.mockResolvedValue(["home-one"]);
  read.queue.mockResolvedValue(value);
});
afterEach(() => vi.useRealTimers());

describe("한국어 번역 상태 읽기", () => {
  it("복제본 범위에서 같은 홈 목록을 사용하고 동시 읽기와 30초 반복을 공유한다", async () => {
    const { readKoreanTranslationQueue } = await import("@/lib/operations/korean-translation");
    expect(await Promise.all([readKoreanTranslationQueue(), readKoreanTranslationQueue()])).toEqual([
      { ok: true, value }, { ok: true, value },
    ]);
    expect(await readKoreanTranslationQueue()).toEqual({ ok: true, value });
    expect(read.replica).toHaveBeenCalledTimes(3);
    expect(read.home).toHaveBeenCalledTimes(1);
    expect(read.queue).toHaveBeenCalledExactlyOnceWith(["home-one"]);
  });
  it("복제본이 없거나 밀렸으면 주DB 조회 없이 보류한다", async () => {
    const { readKoreanTranslationQueue } = await import("@/lib/operations/korean-translation");
    read.replica.mockResolvedValue({ ok: false, reason: "lagging" });
    expect(await readKoreanTranslationQueue()).toEqual({ ok: false, reason: "lagging" });
    expect(read.home).not.toHaveBeenCalled();
    expect(read.queue).not.toHaveBeenCalled();
  });
  it("읽기 실패를 0으로 바꾸거나 실패값을 캐시하지 않는다", async () => {
    const { readKoreanTranslationQueue } = await import("@/lib/operations/korean-translation");
    read.queue.mockRejectedValueOnce(new Error("query_timeout"));
    expect(await readKoreanTranslationQueue()).toEqual({ ok: false, reason: "error" });
    expect(await readKoreanTranslationQueue()).toEqual({ ok: true, value });
    expect(read.queue).toHaveBeenCalledTimes(2);
  });
  it("홈 목록 읽기가 끝나지 않아도 3초 뒤 이 칸만 보류한다", async () => {
    vi.useFakeTimers();
    const { readKoreanTranslationQueue } = await import("@/lib/operations/korean-translation");
    read.home.mockReturnValue(new Promise(() => {}));
    const result = readKoreanTranslationQueue();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toEqual({ ok: false, reason: "error" });
    expect(read.queue).not.toHaveBeenCalled();
  });
  it("복제본 건강 확인 자체가 끝나지 않아도 전체 읽기를 3초로 제한한다", async () => {
    vi.useFakeTimers();
    const { readKoreanTranslationQueue } = await import("@/lib/operations/korean-translation");
    read.replica.mockReturnValue(new Promise(() => {}));
    const result = readKoreanTranslationQueue();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await result).toEqual({ ok: false, reason: "error" });
    expect(read.home).not.toHaveBeenCalled();
  });
});
