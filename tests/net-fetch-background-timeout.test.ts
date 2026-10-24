import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { guard, request } = vi.hoisted(() => ({ guard: vi.fn(), request: vi.fn() }));
vi.mock("@/lib/net/ssrf", () => ({ assertPublicUrl: guard }));
vi.mock("@/lib/net/http-transport", () => ({ nativeHttpFetch: request, legacyHttpDispatcher: vi.fn() }));
import { acquireOrigin, safeFetch } from "@/lib/net/fetch";

const extended = { backgroundTimeoutMs: 60_000 };
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const timedOut = () => new DOMException("confirmation deadline", "TimeoutError");

beforeEach(() => {
  vi.stubEnv("HTTP_ORIGIN_PERMITS", "0");
  guard.mockResolvedValue({ ok: true });
  request.mockResolvedValue(new Response(null, { status: 204 }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); guard.mockReset(); request.mockReset(); });

it("lets an opted-in confirmation finish after the ordinary ten-second deadline", async () => {
  const ordinary = new AbortController(), confirmation = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => ms === 60_000 ? confirmation.signal : ordinary.signal);
  let finish!: () => void;
  const headers = new Promise<void>(resolve => { finish = resolve; });
  request.mockImplementation(async (_url: string, init: { signal: AbortSignal }) => {
    await headers;
    init.signal.throwIfAborted();
    return new Response("The sleeping service has started.");
  });
  const pending = safeFetch("https://cold-start.test", "background", extended);
  await turn();
  ordinary.abort(timedOut());
  finish();
  const result = await pending;
  expect(await result?.response.text()).toBe("The sleeping service has started.");
  expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000);
});

it("keeps ordinary background and interactive requests at ten seconds", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  await safeFetch("https://ordinary-background.test", "background");
  await safeFetch("https://ordinary-interactive.test");
  expect(timeout.mock.calls).toEqual([[10_000], [10_000]]);
});

it("shares the extended deadline across redirects instead of restarting it", async () => {
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  request.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/next" } }))
    .mockImplementationOnce(async (_url: string, init: { signal: AbortSignal }) => {
      deadline.abort(timedOut());
      init.signal.throwIfAborted();
      return new Response(null, { status: 302, headers: { location: "/never" } });
    });
  expect(await safeFetch("https://redirect-confirmation.test/start", "background", extended)).toBeNull();
  expect(timeout).toHaveBeenCalledExactlyOnceWith(60_000);
  expect(request).toHaveBeenCalledTimes(2);
  expect(request.mock.calls[0][1].signal).toBe(request.mock.calls[1][1].signal);
});

it("bounds the final body by the same extended deadline and releases its origin after cancellation", async () => {
  const deadline = new AbortController(), cancelled = vi.fn();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
  request.mockResolvedValueOnce(new Response(new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from("partial")); },
    cancel: cancelled,
  })));
  const result = await safeFetch("https://body-confirmation.test", "background", extended);
  const reading = result!.response.text().catch(error => error);
  deadline.abort(timedOut());
  expect(await reading).toMatchObject({ name: "TimeoutError" });
  await turn();
  expect(cancelled).toHaveBeenCalledOnce();
  expect(timeout).toHaveBeenNthCalledWith(1, 60_000);
  expect((await safeFetch("https://body-confirmation.test/next", "background"))?.response.status).toBe(204);
});

it("includes initial DNS and origin queue waits in the extended deadline", async () => {
  const dnsDeadline = new AbortController(), queueDeadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(dnsDeadline.signal).mockReturnValueOnce(queueDeadline.signal);
  guard.mockReturnValueOnce(new Promise(() => {}));
  const dns = safeFetch("https://dns-confirmation.test", "background", extended);
  dnsDeadline.abort(timedOut());
  expect(await dns).toBeNull();
  const release = await acquireOrigin("https://queue-confirmation.test", new AbortController().signal);
  try {
    const queued = safeFetch("https://queue-confirmation.test", "background", extended);
    await turn();
    queueDeadline.abort(timedOut());
    expect(await queued).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(timeout.mock.calls).toEqual([[60_000], [60_000]]);
  } finally { release(); }
});

it("lets caller cancellation interrupt confirmation before headers and during the body", async () => {
  const caller = new AbortController(), reason = new Error("worker stopped");
  request.mockImplementationOnce(async (_url: string, init: { signal: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const pending = safeFetch("https://caller-headers.test", "background", { ...extended, signal: caller.signal });
  await turn();
  caller.abort(reason);
  expect(await pending).toBeNull();
  const bodyCaller = new AbortController(), cancelled = vi.fn();
  request.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled })));
  const result = await safeFetch("https://caller-body.test", "background", { ...extended, signal: bodyCaller.signal });
  const reading = result!.response.text().catch(error => error);
  bodyCaller.abort(reason);
  expect(await reading).toBe(reason);
  await turn();
  expect(cancelled).toHaveBeenCalledOnce();
});

it("still rejects an unsafe redirect before sending its next hop", async () => {
  guard.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, reason: "private" });
  request.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }));
  expect(await safeFetch("https://unsafe-confirmation.test", "background", extended)).toBeNull();
  expect(guard).toHaveBeenLastCalledWith("http://127.0.0.1/secret");
  expect(request).toHaveBeenCalledOnce();
});

it.each([0, -1, 1.5, NaN, Infinity, 60_001])("rejects an invalid or unbounded confirmation timeout: %s", async backgroundTimeoutMs => {
  await expect(safeFetch("https://invalid-timeout.test", "background", { backgroundTimeoutMs })).rejects.toThrow(RangeError);
  expect(guard).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("rejects the background-only override on interactive requests", async () => {
  await expect(safeFetch("https://interactive-override.test", "interactive", extended)).rejects.toThrow(RangeError);
  expect(guard).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
