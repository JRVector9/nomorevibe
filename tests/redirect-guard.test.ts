import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 리다이렉트 hop별 SSRF 재검증 (1차 리뷰 F2 회귀).
 *
 * 공개 리다이렉트 서비스는 자체 SSRF 보호로 사설 대상 리다이렉트 발급을 거부해서
 * end-to-end 실측이 불가능하다. undici를 목킹해 "공인 → 사설" 302를 직접 만들어 검증한다.
 */

const fetchMock = vi.fn();

vi.mock("undici", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
  Agent: class {
    constructor(public options?: unknown) {}
  },
}));

const response = (status: number, location?: string) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h: string) => (h === "location" ? (location ?? null) : null) },
    body: null,
  }) as unknown as Response;

describe("safeFetch — 리다이렉트 hop마다 SSRF 정책 재적용", () => {
  const saved = process.env.ALLOW_PRIVATE_URLS;

  beforeEach(() => {
    delete process.env.ALLOW_PRIVATE_URLS;
    fetchMock.mockReset();
    vi.resetModules();
  });
  afterEach(() => {
    if (saved !== undefined) process.env.ALLOW_PRIVATE_URLS = saved;
  });

  it("공인 도메인이 메타데이터 IP로 302하면 2번째 hop에서 차단한다", async () => {
    const { safeFetch } = await import("@/lib/net/fetch");
    // 1번째 hop: 공인 도메인 → 302 Location: 메타데이터 엔드포인트
    fetchMock.mockResolvedValueOnce(response(302, "http://169.254.169.254/latest/meta-data/"));

    const result = await safeFetch("https://example.com/redirect");

    expect(result).toBeNull();
    // 사설 대상에는 요청 자체가 나가지 않아야 한다
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://example.com/redirect");
  }, 20_000);

  it("공인 도메인이 사설 IP로 해석되는 호스트로 302해도 차단한다", async () => {
    const { safeFetch } = await import("@/lib/net/fetch");
    fetchMock.mockResolvedValueOnce(response(302, "http://127.0.0.1.nip.io/"));

    const result = await safeFetch("https://example.com/redirect");

    expect(result).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 20_000);

  it("상대경로 Location도 절대경로로 풀어 검증한다", async () => {
    const { safeFetch } = await import("@/lib/net/fetch");
    fetchMock
      .mockResolvedValueOnce(response(302, "/landing"))
      .mockResolvedValueOnce(response(200));

    const result = await safeFetch("https://example.com/start");

    expect(result).not.toBeNull();
    expect(result!.finalUrl).toBe("https://example.com/landing");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("공인 → 공인 리다이렉트는 정상적으로 따라간다", async () => {
    const { safeFetch } = await import("@/lib/net/fetch");
    fetchMock
      .mockResolvedValueOnce(response(301, "https://example.com/final"))
      .mockResolvedValueOnce(response(200));

    const result = await safeFetch("https://example.com/old");

    expect(result!.finalUrl).toBe("https://example.com/final");
    expect(result!.response.status).toBe(200);
  }, 20_000);

  it("리다이렉트 루프는 한도에서 끊는다", async () => {
    const { safeFetch } = await import("@/lib/net/fetch");
    fetchMock.mockResolvedValue(response(302, "https://example.com/loop"));

    const result = await safeFetch("https://example.com/loop");

    expect(result).toBeNull();
    // MAX_REDIRECTS(5) + 최초 요청 = 6회에서 멈춘다 (무한 루프 아님)
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(6);
  }, 20_000);
});
