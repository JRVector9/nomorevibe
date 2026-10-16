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
