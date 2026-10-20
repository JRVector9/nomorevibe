import { afterEach, expect, it, vi } from "vitest";
const guard = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => vi.fn());
vi.mock("@/lib/net/ssrf", () => ({ assertPublicUrl: guard }));
vi.mock("@/lib/net/http-transport", () => ({ nativeHttpFetch: request, legacyHttpDispatcher: vi.fn() }));
const { safeFetch, PageFetchError } = await import("@/lib/net/fetch");
afterEach(() => { vi.restoreAllMocks(); guard.mockReset(); request.mockReset(); });

it("bounds an unsettled initial DNS guard by the total deadline", async () => {
  const deadline = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  guard.mockReturnValue(new Promise(() => {}));
  const pending = safeFetch("https://example.test", "background", { retryTransientErrors: true });
  deadline.abort(new DOMException("deadline", "TimeoutError"));
  await expect(pending).rejects.toMatchObject({ reason: "timeout" });
  expect(request).not.toHaveBeenCalled();
});

it("external abort bounds the redirect guard, and late rejection stays observed", async () => {
  let reject!: (error: Error) => void;
  guard.mockResolvedValueOnce({ ok: true }).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
  request.mockResolvedValue(new Response(null, { status: 302, headers: { location: "/next" } }));
  const caller = new AbortController();
  const pending = safeFetch("https://example.test", "background", { signal: caller.signal });
  await vi.waitFor(() => expect(guard).toHaveBeenCalledTimes(2));
  caller.abort();
  expect(await pending).toBeNull();
  reject(new Error("late DNS error"));
  await Promise.resolve();
  expect(request).toHaveBeenCalledTimes(1);
});

it("never starts a guard or HTTP for an already aborted caller", async () => {
  const caller = new AbortController(); caller.abort();
  expect(await safeFetch("https://example.test", "interactive", { signal: caller.signal })).toBeNull();
  expect(guard).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
});

it("preserves transient SSRF errors and unsafe URL rejection", async () => {
  guard.mockResolvedValueOnce({ ok: false, transient: true, reason: "dns_failed" });
  await expect(safeFetch("https://example.test", "background", { retryTransientErrors: true })).rejects.toBeInstanceOf(PageFetchError);
  guard.mockResolvedValueOnce({ ok: false, reason: "private" });
  expect(await safeFetch("https://example.test", "background")).toBeNull();
  expect(request).not.toHaveBeenCalled();
});
