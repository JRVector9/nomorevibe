import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as dns } from "node:dns";

const request = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({ fetch: request, Agent: class {} }));
import { fetchPage } from "@/lib/net/fetch";

const url = "https://app.test";
const retry = { retryTransientErrors: true };
beforeEach(() => {
  process.env.ALLOW_PRIVATE_URLS = "1";
  request.mockReset();
});
afterEach(() => {
  delete process.env.ALLOW_PRIVATE_URLS;
  vi.restoreAllMocks();
});

it.each([new DOMException("request timed out", "TimeoutError"), new TypeError("fetch failed")])
  ("reports transient pre-header errors to the crawler: %s", async error => {
    request.mockRejectedValue(error);
    await expect(fetchPage(url, "background", retry)).rejects.toMatchObject({ name: "PageFetchError",
      reason: error.name === "TimeoutError" ? "timeout" : "transport" });
  });

it.each([408, 429, 500, 503])("retries HTTP %i without reading its body and keeps Retry-After", async status => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const response = new Response("temporary failure", { status, headers: { "retry-after": "900" } });
  const cancel = vi.spyOn(response.body!, "cancel");
  request.mockResolvedValueOnce(response);
  await expect(fetchPage(url, "background", retry)).rejects.toMatchObject({ name: "PageFetchError", reason: "http",
    status, retryAt: new Date(now + 900_000) });
  expect(cancel).toHaveBeenCalledOnce();
});

it("keeps an HTTP-date Retry-After when it is in the future", async () => {
  const retryAt = new Date(Math.ceil((Date.now() + 3_600_000) / 1000) * 1000);
  request.mockResolvedValue(new Response("", { status: 429, headers: { "retry-after": retryAt.toUTCString() } }));
  await expect(fetchPage(url, "background", retry)).rejects.toMatchObject({ retryAt });
});

it("leaves permanent HTTP errors as a page observation", async () => {
  request.mockResolvedValue(new Response("Not Found", { status: 404 }));
  expect(await fetchPage(url, "background", retry)).toMatchObject({ status: 404, html: "Not Found" });
});

it("keeps legacy interactive transport failures as null", async () => {
  request.mockRejectedValue(new TypeError("fetch failed"));
  expect(await fetchPage(url)).toBeNull();
});

it("does not retry unsafe URLs or permanent DNS failures", async () => {
  delete process.env.ALLOW_PRIVATE_URLS;
  expect(await fetchPage("http://169.254.169.254", "background", retry)).toBeNull();
  vi.spyOn(dns, "lookup").mockRejectedValue(Object.assign(new Error("missing domain"), { code: "ENOTFOUND" }));
  expect(await fetchPage(url, "background", retry)).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it("does not retry an unsupported URL protocol", async () => {
  delete process.env.ALLOW_PRIVATE_URLS;
  vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "8.8.8.8", family: 4 }] as never);
  request.mockRejectedValue(new TypeError("unknown scheme"));
  expect(await fetchPage("ftp://app.test", "background", retry)).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

it.each([Object.assign(new Error("DNS missing"), { code: "ENOTFOUND" }), new Error("사설 IP 차단: app.test")])
  ("does not retry a permanent connection-time guard failure: %s", async cause => {
    request.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause }));
    expect(await fetchPage(url, "background", retry)).toBeNull();
  });

it("retries transient DNS resolution failures without making an unsafe request", async () => {
  delete process.env.ALLOW_PRIVATE_URLS;
  vi.spyOn(dns, "lookup").mockRejectedValue(Object.assign(new Error("temporary DNS error"), { code: "EAI_AGAIN" }));
  await expect(fetchPage(url, "background", retry)).rejects.toMatchObject({ name: "PageFetchError", reason: "transport" });
  expect(request).not.toHaveBeenCalled();
});
