import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 홈 상단 집계는 요청마다 SQL 6개를 돌린다. 창은 KST 0시에 닫힌 완료 구간이라 같은 날에는
 * 바뀔 것이 거의 없으므로 KST 날짜·집계 버전으로 잠깐 재사용한다.
 *
 * DB 는 쿼리 수만 세는 가짜로 바꾼다 — 캐시가 무엇을 다시 부르는지만 본다.
 */
const { select } = vi.hoisted(() => ({ select: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { select } }));

import { getHomePulse } from "@/lib/domain/products/home-pulse";

/** drizzle 쿼리 빌더 흉내 — 어떤 메서드를 이어 불러도 자신을 돌려주고, 기다리면 빈 행을 준다 */
function emptyQuery() {
  const query: Record<string, unknown> = {};
  for (const method of ["from", "where", "innerJoin", "groupBy", "limit"]) query[method] = () => query;
  query.then = (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve([]).then(resolve, reject);
  return query;
}

const QUERIES_PER_PULSE = 6;

beforeEach(() => {
  select.mockReset();
  select.mockImplementation(emptyQuery);
});

// 캐시는 모듈에 남으므로 테스트마다 다른 KST 날짜를 쓴다
describe("홈 상단 집계 캐시", () => {
  it("같은 KST 날짜·집계 버전이면 1분 안의 요청은 다시 집계하지 않는다", async () => {
    const first = await getHomePulse(new Date("2026-09-01T10:00:00+09:00"));
    const second = await getHomePulse(new Date("2026-09-01T10:00:59+09:00"));

    expect(select).toHaveBeenCalledTimes(QUERIES_PER_PULSE);
    expect(second).toEqual(first);
  });

  it("동시에 들어온 요청은 한 번만 집계한다", async () => {
    const now = new Date("2026-09-02T10:00:00+09:00");
    await Promise.all([getHomePulse(now), getHomePulse(now), getHomePulse(now)]);

    expect(select).toHaveBeenCalledTimes(QUERIES_PER_PULSE);
  });

  it("KST 날짜가 바뀌면 1분이 안 지나도 새 창으로 다시 집계한다", async () => {
    const before = await getHomePulse(new Date("2026-09-03T23:59:50+09:00"));
    const after = await getHomePulse(new Date("2026-09-04T00:00:05+09:00"));

    expect(select).toHaveBeenCalledTimes(QUERIES_PER_PULSE * 2);
    expect(after.asOf.getTime() - before.asOf.getTime()).toBe(86_400_000);
  });

  it("1분이 지나면 다시 집계한다 — 차단·검증 같은 상태 변화가 오래 남지 않게", async () => {
    await getHomePulse(new Date("2026-09-05T10:00:00+09:00"));
    await getHomePulse(new Date("2026-09-05T10:01:00+09:00"));

    expect(select).toHaveBeenCalledTimes(QUERIES_PER_PULSE * 2);
  });

  it("실패는 담아 두지 않는다 — 다음 요청이 다시 집계한다", async () => {
    select.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    await expect(getHomePulse(new Date("2026-09-06T10:00:00+09:00"))).rejects.toThrow("db down");
    const calls = select.mock.calls.length;

    await expect(getHomePulse(new Date("2026-09-06T10:00:01+09:00"))).resolves.toMatchObject({ total: 0 });
    expect(select.mock.calls.length - calls).toBe(QUERIES_PER_PULSE);
  });
});
