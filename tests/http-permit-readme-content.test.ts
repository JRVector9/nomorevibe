import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpOriginPermitError } from "@/lib/net/http-origin-policy";
const mock = vi.hoisted(() => ({ github: vi.fn(), raw: vi.fn(), set: vi.fn() }));
vi.mock("@/lib/crawl/github", () => ({ githubRequest: mock.github }));
vi.mock("@/lib/net/fetch", () => ({ fetchCapped: mock.raw }));
vi.mock("@/lib/db", () => ({ onPrimary: (load: () => unknown) => load() }));
vi.mock("@/lib/cache/shared", () => ({ sharedStore: { get: async () => null, set: mock.set } }));
import { getReadmeContent } from "@/lib/domain/products/readme-content";
beforeEach(() => {
  vi.resetAllMocks();
  mock.github.mockImplementation(async (path: string) => ({ ok: true, status: 200, value: path.endsWith("/readme")
    ? { download_url: "https://raw.githubusercontent.com/acme/app/main/README.md", html_url: "https://github.com/acme/app/blob/main/README.md" }
    : { private: false, html_url: "https://github.com/acme/app", default_branch: "main" } }));
});
it("permit holds do not become local/shared negative README cache entries", async () => {
  const blocked = new HttpOriginPermitError("unavailable");
  mock.raw.mockRejectedValueOnce(blocked).mockResolvedValueOnce({ ok: true, status: 200, body: Buffer.from("# Actual README") });
  await expect(getReadmeContent("https://github.com/acme/app")).rejects.toBe(blocked);
  expect(mock.set).not.toHaveBeenCalled();
  expect(await getReadmeContent("https://github.com/acme/app")).toMatchObject({ state: "available", markdown: "# Actual README" });
  expect(mock.raw).toHaveBeenCalledTimes(2);
});
it("an ordinary failed README download retains the existing unavailable cache", async () => {
  mock.raw.mockRejectedValue(new Error("connection reset"));
  expect(await getReadmeContent("https://github.com/acme/app")).toMatchObject({ state: "unavailable" });
  expect(await getReadmeContent("https://github.com/acme/app")).toMatchObject({ state: "unavailable" });
  expect(mock.raw).toHaveBeenCalledTimes(1);
});

afterEach(() => vi.useRealTimers());
it("the README deadline cannot win a race and cache a permit wait as site failure", async () => {
  vi.useFakeTimers();
  const blocked = new HttpOriginPermitError("waiting_aborted");
  mock.raw.mockImplementation(async (_url, options) => new Promise((_, reject) => {
    options.signal.addEventListener("abort", () => reject(blocked), { once: true });
  }));
  const observed = getReadmeContent("https://github.com/acme/app").then(value => value, error => error);
  await vi.advanceTimersByTimeAsync(8_000);
  expect(await observed).toBe(blocked);
  expect(mock.set).not.toHaveBeenCalled();
});

// R4: 8초 상한은 신호를 받지 않는 GitHub 호출(githubRequest)도 묶어야 한다 — 상한을 지운 뒤 매달린 메타데이터 요청이 화면 읽기를 끝없이 붙잡았다.
it("a hung GitHub request still ends at the README deadline as an unavailable result", async () => {
  vi.useFakeTimers();
  mock.github.mockImplementation(() => new Promise(() => {}));
  const box: { state: string; value?: unknown } = { state: "pending" };
  void getReadmeContent("https://github.com/acme/hung").then(value => Object.assign(box, { state: "fulfilled", value }), (error: unknown) => Object.assign(box, { state: "rejected", value: error }));
  // 기한(8초)에 abort, 상한 거절은 그다음 타이머 차례(+1ms)다
  await vi.advanceTimersByTimeAsync(8_001);
  expect(box).toEqual({ state: "fulfilled", value: { state: "unavailable", sourceUrl: "https://github.com/acme/hung#readme" } });
  expect(mock.raw).not.toHaveBeenCalled();
});
