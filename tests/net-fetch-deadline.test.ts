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

const signalsOf = () => fetchMock.mock.calls.map(([, init]) => (init as { signal: AbortSignal }).signal);

it("백그라운드 잡은 리다이렉트를 따라가도 기한이 요청 하나에 하나다", async () => {
  fetchMock
    .mockResolvedValueOnce(response(301, "https://example.com/a"))
    .mockResolvedValueOnce(response(302, "https://example.com/b"))
    .mockResolvedValueOnce(response(200));

  const result = await safeFetch("https://example.com/", "background");

  expect(result?.finalUrl).toBe("https://example.com/b");
  expect(signalsOf()).toHaveLength(3);
  expect(new Set(signalsOf()).size).toBe(1);
});

/**
 * 전체 10초로 묶었더니 느린 302가 두 번 이어지는(6초+6초) 정상 사이트의 **메이커 등록**이
 * "접속 불가"로 거절됐다(codex가 재현). 등록·검증은 메이커가 기다리는 경로라 hop마다 새로
 * 잰다 — 기본값이 그쪽이어야 부르는 곳이 잊어도 회귀하지 않는다.
 */
it("기본값은 hop마다 새 기한이다 — 등록·검증이 느린 리다이렉트를 거절하지 않게", async () => {
  fetchMock
    .mockResolvedValueOnce(response(302, "https://example.com/a"))
    .mockResolvedValueOnce(response(200));

  await safeFetch("https://example.com/");

  expect(signalsOf()).toHaveLength(2);
  expect(new Set(signalsOf()).size).toBe(2);
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

/**
 * 부르는 쪽(uptime·수집)은 처음 주소의 origin으로만 줄을 세운다. 서로 다른 세 주소가 같은
 * 서버로 302하면 그 서버에 셋이 동시에 갔다(codex 실측 3) — 429를 받으면 정상 사이트를 거부하거나
 * 죽었다고 센다. 백그라운드는 hop마다 목적지 origin의 자리를 잡는다.
 */
const sharedRedirects = () => {
  let inFlight = 0;
  let peak = 0;
  fetchMock.mockImplementation(async (url: string) => {
    const { hostname } = new URL(url);
    if (hostname !== "shared.test") return response(302, `https://shared.test/${hostname}`);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return response(200);
  });
  return () => peak;
};
const three = ["https://a.test/", "https://b.test/", "https://c.test/"];

it("백그라운드는 리다이렉트로 모인 같은 서버에 한 번에 하나만 보낸다", async () => {
  const peak = sharedRedirects();

  const results = await Promise.all(three.map((url) => safeFetch(url, "background")));

  expect(results.every((r) => r?.response.status === 200)).toBe(true);
  expect(peak()).toBe(1);
});

it("사람이 기다리는 경로는 줄을 세우지 않는다 — 위 테스트가 동시성을 실제로 잡는다는 대조", async () => {
  const peak = sharedRedirects();

  await Promise.all(three.map((url) => safeFetch(url)));

  expect(peak()).toBe(3);
});

it("같은 서버로 되돌아오는 사슬이 스스로를 기다리지 않는다", async () => {
  fetchMock
    .mockResolvedValueOnce(response(302, "https://example.com/a"))
    .mockResolvedValueOnce(response(302, "https://example.com/b"))
    .mockResolvedValueOnce(response(200));

  const result = await safeFetch("https://example.com/", "background");

  expect(result?.finalUrl).toBe("https://example.com/b");
});
