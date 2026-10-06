import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 홈 윗줄·리더보드 집계는 요청마다 쿼리 여럿을 돌린다. 창은 KST 0시에 닫힌 완료 구간이라 같은 날에는
 * 바뀔 것이 거의 없으므로 KST 날짜·집계 버전으로 잠깐 재사용한다.
 *
 * DB 는 쿼리 수만 세는 가짜로 바꾼다 — 캐시가 무엇을 다시 부르는지만 본다.
 */
const { select, execute, findFirst } = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn(), findFirst: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select, execute, query: { crawlSettings: { findFirst } } }, onReplica: <T>(load: () => Promise<T>) => load() }));

import { getHomePulse } from "@/lib/domain/products/home-pulse";

/** drizzle 쿼리 빌더 흉내 — 어떤 메서드를 이어 불러도 자신을 돌려주고, 기다리면 빈 행을 준다 */
function emptyQuery() {
  const query: Record<string, unknown> = {};
  for (const method of ["from", "where", "innerJoin", "groupBy", "limit"]) query[method] = () => query;
  query.then = (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve([]).then(resolve, reject);
  return query;
}

/** 분야·태어남, 새 버전 합계, 활발한 프로젝트, 설정 — 관찰 사실 공개가 꺼진 기본값이라 도구는 세지 않는다 */
const QUERIES_PER_PULSE = 4;
const queries = () => select.mock.calls.length + execute.mock.calls.length + findFirst.mock.calls.length;

beforeEach(() => {
  for (const mock of [select, execute, findFirst]) mock.mockReset();
  select.mockImplementation(emptyQuery);
  execute.mockResolvedValue([]);
  findFirst.mockResolvedValue(undefined);
});

// 캐시는 모듈에 남으므로 테스트마다 다른 KST 날짜를 쓴다
describe("홈 상단 집계 캐시", () => {
  it("같은 KST 날짜·집계 버전이면 1분 안의 요청은 다시 집계하지 않는다", async () => {
    const first = await getHomePulse(new Date("2026-09-01T10:00:00+09:00"));
    const second = await getHomePulse(new Date("2026-09-01T10:00:59+09:00"));

    expect(queries()).toBe(QUERIES_PER_PULSE);
    expect(second).toEqual(first);
  });

  it("동시에 들어온 요청은 한 번만 집계한다", async () => {
    const now = new Date("2026-09-02T10:00:00+09:00");
    await Promise.all([getHomePulse(now), getHomePulse(now), getHomePulse(now)]);

    expect(queries()).toBe(QUERIES_PER_PULSE);
  });

  it("KST 날짜가 바뀌면 1분이 안 지나도 새 창으로 다시 집계한다", async () => {
    const before = await getHomePulse(new Date("2026-09-03T23:59:50+09:00"));
    const after = await getHomePulse(new Date("2026-09-04T00:00:05+09:00"));

    expect(queries()).toBe(QUERIES_PER_PULSE * 2);
    expect(after.asOf.getTime() - before.asOf.getTime()).toBe(86_400_000);
  });

  it("1분이 지나면 다시 집계한다 — 차단·검증 같은 상태 변화가 오래 남지 않게", async () => {
    await getHomePulse(new Date("2026-09-05T10:00:00+09:00"));
    await getHomePulse(new Date("2026-09-05T10:01:00+09:00"));

    expect(queries()).toBe(QUERIES_PER_PULSE * 2);
  });

  it("1분이 지나면 지난 값을 바로 주고 뒤에서 새로 집계한다 — 만료 순간의 요청이 1초 넘게 기다리지 않게", async () => {
    let finish: (value: never) => void = () => {};
    const slow = vi.fn((now: Date) => new Promise<never>((resolve) => { finish = resolve; void now; }));
    const fresh = await getHomePulse(new Date("2026-09-07T10:00:00+09:00"));
    const stale = await getHomePulse(new Date("2026-09-07T10:01:00+09:00"), slow);
    expect(stale).toEqual(fresh);
    expect(slow).toHaveBeenCalledTimes(1);
    // 새로 집계하는 동안 들어온 요청은 같은 지난 값을 받고, 집계를 겹쳐 부르지 않는다
    await getHomePulse(new Date("2026-09-07T10:01:01+09:00"), slow);
    expect(slow).toHaveBeenCalledTimes(1);
    finish({ ...fresh, total: 42 } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await getHomePulse(new Date("2026-09-07T10:01:02+09:00"), slow)).total).toBe(42);
  });

  it("뒤에서 집계하다 실패하면 지난 값을 그대로 두고 다음 요청이 다시 시도한다", async () => {
    const fresh = await getHomePulse(new Date("2026-09-08T10:00:00+09:00"));
    const failing = vi.fn(async () => { throw new Error("db down"); });
    expect(await getHomePulse(new Date("2026-09-08T10:01:00+09:00"), failing)).toEqual(fresh);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await getHomePulse(new Date("2026-09-08T10:01:01+09:00"), failing)).toEqual(fresh);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("실패는 담아 두지 않는다 — 다음 요청이 다시 집계한다", async () => {
    execute.mockRejectedValueOnce(new Error("db down"));
    await expect(getHomePulse(new Date("2026-09-06T10:00:00+09:00"))).rejects.toThrow("db down");
    const calls = queries();

    await expect(getHomePulse(new Date("2026-09-06T10:00:01+09:00"))).resolves.toMatchObject({ total: 0 });
    expect(queries() - calls).toBe(QUERIES_PER_PULSE);
  });
});
