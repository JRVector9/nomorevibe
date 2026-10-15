import { afterEach, beforeEach, expect, it, vi } from "vitest";

const request = vi.hoisted(() => vi.fn());
vi.mock("undici", () => ({ fetch: request, Agent: class {} }));

import { fetchCapped, PageFetchError, readBodyCapped, safeFetch } from "@/lib/net/fetch";

const pending = new Set<Promise<unknown>>();
let deadlines: AbortController[] = [];
const track = <T>(work: Promise<T>): Promise<T> => {
  pending.add(work);
  void work.then(() => pending.delete(work), () => pending.delete(work));
  return work;
};
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const bodyWithFailedCancel = (failure: Error) => new ReadableStream<Uint8Array>({
  cancel() { return Promise.reject(failure); },
});

beforeEach(() => {
  request.mockReset();
  deadlines = [];
  vi.stubEnv("ALLOW_PRIVATE_URLS", "1");
  vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
    const deadline = new AbortController();
    deadlines.push(deadline);
    return deadline.signal;
  });
});

afterEach(async () => {
  try {
    for (const deadline of deadlines) deadline.abort(new Error("fixture cleanup"));
    await Promise.allSettled([...pending]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it("safeFetch does not send another redirect hop after actual body cancellation fails", async () => {
  const failure = new Error("redirect cancellation failed");
  request.mockResolvedValueOnce(new Response(bodyWithFailedCancel(failure), {
    status: 302, headers: { location: "/next" },
  })).mockResolvedValueOnce(new Response(null, { status: 204 }));

  expect(await track(safeFetch("https://b-redirect-failure.test/start"))).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
});

it("fetchCapped retains the redirect status and sends no next hop when cancellation fails", async () => {
  request.mockResolvedValueOnce(new Response(bodyWithFailedCancel(new Error("cleanup failed")), {
    status: 307, headers: { location: "https://b-redirect-target.test/next" },
  })).mockResolvedValueOnce(new Response("unexpected next hop"));

  expect(await track(fetchCapped("https://b-capped-redirect.test/start", { maxBytes: 8, request })))
    .toEqual({ ok: false, reason: "http", status: 307 });
  expect(request).toHaveBeenCalledTimes(1);
});

it("a failed final body cancellation keeps a background follower outside the same origin", async () => {
  const failure = new Error("final cancellation failed");
  request.mockResolvedValueOnce(new Response(bodyWithFailedCancel(failure)))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const fetched = await track(safeFetch("https://b-final-failure.test/first", "background"));
  expect(fetched).not.toBeNull();
  await expect(track(fetched!.response.body!.cancel())).rejects.toBe(failure);

  let followerDone = false;
  const follower = track(safeFetch("https://b-final-failure.test/second", "background")).then(value => {
    followerDone = true;
    return value;
  });
  try {
    await turn();
    expect(request).toHaveBeenCalledTimes(1);
    expect(followerDone).toBe(false);
  } finally {
    for (const deadline of deadlines) deadline.abort(new Error("fixture follower cleanup"));
    await follower;
  }
});

it("successful same-origin redirect cleanup still admits its next hop and preserves the response", async () => {
  const cancelled = vi.fn();
  request.mockResolvedValueOnce(new Response(new ReadableStream({ cancel: cancelled }), {
    status: 302, headers: { location: "/next" },
  })).mockResolvedValueOnce(new Response("landing", { status: 200, headers: { "x-proof": "kept" } }));

  const fetched = await track(safeFetch("https://b-redirect-control.test/start", "background"));
  expect(fetched?.finalUrl).toBe("https://b-redirect-control.test/next");
  expect(fetched?.response.status).toBe(200);
  expect(fetched?.response.headers.get("x-proof")).toBe("kept");
  expect(await track(fetched!.response.text())).toBe("landing");
  expect(cancelled).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(2);
});

it("a retryable HTTP error keeps its original status and Retry-After despite failed cleanup", async () => {
  const retryAt = new Date(Math.ceil((Date.now() + 3_600_000) / 1000) * 1000);
  request.mockResolvedValueOnce(new Response(bodyWithFailedCancel(new Error("HTTP body cleanup failed")), {
    status: 503, headers: { "retry-after": retryAt.toUTCString() },
  }));

  const result = await track(safeFetch("https://b-http-error-control.test/first", "background", {
    retryTransientErrors: true,
  })).catch(error => error);
  expect(result).toBeInstanceOf(PageFetchError);
  expect(result).toMatchObject({ name: "PageFetchError", reason: "http", status: 503, retryAt });
  expect(request).toHaveBeenCalledTimes(1);
});

it("readBodyCapped awaits failed cancellation and retains the actual bytes already read", async () => {
  let entered!: () => void;
  const cancelling = new Promise<void>(resolve => { entered = resolve; });
  let rejectCancel!: (reason: Error) => void;
  const cancelResult = new Promise<void>((_resolve, reject) => { rejectCancel = reject; });
  const failure = new Error("prefix cancel failed");
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("prefix-tail")); },
    cancel() { entered(); return cancelResult; },
  }));
  const reader = response.body!.getReader();
  const nativeCancel = reader.cancel.bind(reader);
  // Observe the original returned Promise without altering its result. The old
  // fire-and-forget implementation must not contaminate the runner with an
  // unhandled rejection after its early-return assertion has already failed.
  vi.spyOn(reader, "cancel").mockImplementation(reason => {
    const result = nativeCancel(reason);
    void result.catch(() => {});
    return result;
  });
  vi.spyOn(response.body!, "getReader").mockReturnValue(reader);
  let returned = false;
  const reading = track(readBodyCapped(response, 3).then(value => {
    returned = true;
    return value;
  }));
  try {
    await cancelling;
    await turn();
    expect(returned).toBe(false);
    rejectCancel(failure);
    expect((await reading).toString()).toBe("prefix-tail");
    expect(reader.cancel).toHaveBeenCalledTimes(1);
  } finally {
    rejectCancel(failure);
    await Promise.allSettled([reading]);
    reader.releaseLock();
  }
});

it("fetchCapped keeps its bounded prefix instead of HTTP zero when cancellation fails", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode("abcdef")); },
    cancel() { throw new Error("bounded prefix cancel failed"); },
  });
  request.mockResolvedValueOnce(new Response(body, { status: 200, headers: { "x-prefix": "kept" } }));
  const result = await track(fetchCapped("https://b-prefix-failure.test/page", {
    maxBytes: 3, allowTruncatedBody: true, request,
  }));
  expect(result).toMatchObject({ ok: true, status: 200, finalUrl: "https://b-prefix-failure.test/page", truncated: true });
  if (!result.ok) throw new Error("expected original prefix result");
  expect(result.body.toString()).toBe("abc");
  expect(result.headers.get("x-prefix")).toBe("kept");
  expect(request).toHaveBeenCalledTimes(1);
});

it("fetchCapped retains too_large instead of HTTP zero after an oversized chunk and failed cancellation", async () => {
  request.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); },
    cancel() { throw new Error("oversize cancel failed"); },
  })));
  expect(await track(fetchCapped("https://b-oversize-failure.test/page", { maxBytes: 3, request })))
    .toEqual({ ok: false, reason: "too_large" });
  expect(request).toHaveBeenCalledTimes(1);
});

it("a failed retryable HTTP cleanup does not admit the next background request", async () => {
  request.mockResolvedValueOnce(new Response(bodyWithFailedCancel(new Error("retry cleanup failed")), {
    status: 429,
  })).mockResolvedValueOnce(new Response(null, { status: 204 }));
  await expect(track(safeFetch("https://b-retry-slot.test/first", "background", {
    retryTransientErrors: true,
  }))).rejects.toMatchObject({ name: "PageFetchError", reason: "http", status: 429 });
  let completed = false;
  const follower = track(safeFetch("https://b-retry-slot.test/second", "background").then(result => {
    completed = true;
    return result;
  }));
  try {
    await turn();
    expect(request).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
  } finally {
    for (const deadline of deadlines) deadline.abort(new Error("fixture retry follower cleanup"));
    await follower;
  }
});

it("a failed background redirect keeps its origin occupied as well as stopping the redirect chain", async () => {
  request.mockResolvedValueOnce(new Response(bodyWithFailedCancel(new Error("redirect slot cleanup failed")), {
    status: 301, headers: { location: "https://b-redirect-slot-next.test/next" },
  })).mockResolvedValue(new Response(null, { status: 204 }));
  const first = await track(safeFetch("https://b-redirect-slot.test/first", "background"));
  let completed = false;
  const follower = track(safeFetch("https://b-redirect-slot.test/second", "background").then(result => {
    completed = true;
    return result;
  }));
  try {
    await turn();
    expect(first).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    expect(completed).toBe(false);
  } finally {
    for (const deadline of deadlines) deadline.abort(new Error("fixture redirect follower cleanup"));
    await follower;
  }
});
