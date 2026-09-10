import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * safeFetch의 기한과 리다이렉트 응답 정리.
 *
 * 수집 잡이 페이지를 동시에 받게 되면서 둘 다 처리량에 바로 걸린다. hop마다 새 10초 타이머를
 * 걸면 리다이렉트 다섯 번에 60초까지 한 칸을 붙잡고, 따라간 3xx의 본문을 닫지 않으면 연결이
 * 풀로 돌아가지 않는다.
 */

const fetchMock = vi.fn();
vi.mock("undici", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
  Agent: class {
    constructor(public options?: unknown) {}
  },
}));

const { safeFetch } = await import("@/lib/net/fetch");

const response = (status: number, location?: string, body: unknown = null) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h === "location" ? (location ?? null) : null) },
    body,
  }) as unknown as Response;

beforeEach(() => {
  // 가드의 DNS 조회는 tests/ssrf.test.ts가 따로 잰다 — 여기서는 hop 처리만 본다
  process.env.ALLOW_PRIVATE_URLS = "1";
  fetchMock.mockReset();
});
afterEach(() => {
  delete process.env.ALLOW_PRIVATE_URLS;
});

it("리다이렉트를 따라가도 기한은 요청 하나에 하나다", async () => {
  fetchMock
    .mockResolvedValueOnce(response(301, "https://example.com/a"))
    .mockResolvedValueOnce(response(302, "https://example.com/b"))
    .mockResolvedValueOnce(response(200));

  const result = await safeFetch("https://example.com/");

  expect(result?.finalUrl).toBe("https://example.com/b");
  const signals = fetchMock.mock.calls.map(([, init]) => (init as { signal: AbortSignal }).signal);
  expect(signals).toHaveLength(3);
  expect(new Set(signals).size).toBe(1);
});

it("따라간 리다이렉트 응답의 본문은 닫는다", async () => {
  const cancel = vi.fn().mockResolvedValue(undefined);
  fetchMock
    .mockResolvedValueOnce(response(302, "/landing", { cancel }))
    .mockResolvedValueOnce(response(200));

  const result = await safeFetch("https://example.com/start");

  expect(result?.finalUrl).toBe("https://example.com/landing");
  expect(cancel).toHaveBeenCalledOnce();
});
