import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 서버 발신 방문 분석을 붙인 주소(PR C) — /go 와 설치 스크립트. DB·실제 GA 는 부르지 않는다.
 * GA 가 켜져 있고 응답이 멈춰도 이동(302)·본문·시간은 그대로여야 한다.
 */
const mocks = vi.hoisted(() => ({ findBySlug: vi.fn(), recordClick: vi.fn() }));
vi.mock("@/lib/domain/products/repository", () => ({ findBySlug: mocks.findBySlug }));
vi.mock("@/lib/domain/products/clicks", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/clicks")>(), recordClick: mocks.recordClick,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => new Headers() }));

const { GET: go } = await import("@/app/go/[slug]/route");
const { GET: installScript } = await import("@/app/install.sh/route");

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const GA_COOKIE = "_ga=GA1.1.1234567890.1760000000";
const product = { id: 1, slug: "app", url: "https://app.example/", status: "verified", accessMode: "website" };

/** GA 가 답하지 않는다 — 상한(signal)이 끊을 때까지 매달린다 */
const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
}));

const visit = (headers: Record<string, string>, query = "") =>
  go(new Request(`https://nomorevibe.test/go/app${query}`, { headers }), { params: Promise.resolve({ slug: "app" }) });
const sentEvents = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).events[0]);

beforeEach(() => {
  fetchMock.mockClear();
  mocks.findBySlug.mockReset().mockResolvedValue(product);
  mocks.recordClick.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("GA_MEASUREMENT_ID", "G-TEST123");
  vi.stubEnv("GA_API_SECRET", "test-api-secret_ABC");
  vi.stubEnv("LOG_LEVEL", "error");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("/go — outbound_visit", () => {
  it("GA 가 멈춰 있어도 같은 302 로 바로 보낸다", async () => {
    const started = performance.now();
    const response = await visit({ "user-agent": CHROME, cookie: GA_COOKIE }, "?via=card");
    const elapsed = performance.now() - started;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(product.url);
    expect(elapsed).toBeLessThan(500);
    expect(mocks.recordClick).toHaveBeenCalledWith("app", expect.any(String));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentEvents()).toEqual([{ name: "outbound_visit", params: { product_slug: "app", link_kind: "site", via: "card", id_source: "ga_cookie" } }]);
  });

  it("봇은 세지 않는다 — 이동은 그대로", async () => {
    for (const ua of ["Slackbot-LinkExpanding 1.0", "Mozilla/5.0 (compatible; Googlebot/2.1)", "curl/8.7.1"]) {
      const response = await visit({ "user-agent": ua, cookie: GA_COOKIE });
      expect(response.status, ua).toBe(302);
      expect(response.headers.get("location")).toBe(product.url);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.recordClick).not.toHaveBeenCalled();
  });

  it("분석을 끈 브라우저(_ga 없음)·GPC 는 보내지 않는다 — DB 클릭은 그대로 센다", async () => {
    expect((await visit({ "user-agent": CHROME })).status).toBe(302);
    expect((await visit({ "user-agent": CHROME, cookie: GA_COOKIE, "sec-gpc": "1" })).status).toBe(302);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.recordClick).toHaveBeenCalledTimes(2);
  });

  it("GA 가 꺼져 있으면 아무것도 보내지 않는다", async () => {
    vi.stubEnv("GA_API_SECRET", "");
    expect((await visit({ "user-agent": CHROME, cookie: GA_COOKIE })).status).toBe(302);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("설치형·GitHub 주소는 repo, via 는 짧은 코드만 싣는다", async () => {
    mocks.findBySlug.mockResolvedValue({ ...product, url: "https://github.com/acme/app", accessMode: "installable" });
    await visit({ "user-agent": CHROME, cookie: GA_COOKIE }, "?via=me%40example.com");
    expect(sentEvents()).toEqual([{ name: "outbound_visit", params: { product_slug: "app", link_kind: "repo", id_source: "ga_cookie" } }]);
  });

  it("없거나 차단된 제품은 첫 화면으로 — 보내지 않는다", async () => {
    mocks.findBySlug.mockResolvedValue({ ...product, status: "banned" });
    const response = await visit({ "user-agent": CHROME, cookie: GA_COOKIE });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://nomorevibe.test/");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("/install.sh — skill_script_download", () => {
  const download = (ua: string) => installScript(new Request("https://nomorevibe.test/install.sh", { headers: { "user-agent": ua } }));

  it("curl 은 받은 쪽의 갈래만 싣고, 본문은 그대로 준다", async () => {
    const response = await download("curl/8.7.1");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("#!/bin/sh");
    expect(sentEvents()).toEqual([{ name: "skill_script_download", params: { script: "install_sh", agent_class: "curl", id_source: "random" } }]);
    expect(JSON.stringify(fetchMock.mock.calls[0][1])).not.toContain("curl/8.7.1");
  });

  it("크롤러와 쿠키 없는 브라우저는 보내지 않는다", async () => {
    expect((await download("Mozilla/5.0 (compatible; bingbot/2.0)")).status).toBe(200);
    expect((await download(CHROME)).status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
