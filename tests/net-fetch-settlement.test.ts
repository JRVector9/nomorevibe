import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock("undici", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
  Agent: class {},
}));

import { readBodyCapped, safeFetch } from "@/lib/net/fetch";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(finish => { resolve = finish; });
  return { promise, resolve };
}

const tasks = new Set<Promise<unknown>>();
const unblock = new Set<() => void>();
const savedPrivate = process.env.ALLOW_PRIVATE_URLS;

function task<T>(promise: Promise<T>): Promise<T> {
  tasks.add(promise);
  void promise.catch(() => {});
  return promise;
}

async function drain() {
  const errors: unknown[] = [];
  for (const finish of [...unblock]) {
    try { finish(); unblock.delete(finish); } catch (error) { errors.push(error); }
  }
  const pending = [...tasks];
  await Promise.allSettled(pending);
  for (const promise of pending) tasks.delete(promise);
  if (errors.length) throw new AggregateError(errors, "stream fixture cleanup failed");
}

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

beforeEach(() => {
  process.env.ALLOW_PRIVATE_URLS = "1";
  fetchMock.mockReset();
});
afterEach(async () => {
  try { await drain(); } finally {
    vi.restoreAllMocks();
    if (savedPrivate === undefined) delete process.env.ALLOW_PRIVATE_URLS;
    else process.env.ALLOW_PRIVATE_URLS = savedPrivate;
  }
});
afterAll(drain);

it("keeps the background origin occupied until actual body cancellation settles", async () => {
  const entered = deferred(), finish = deferred();
  unblock.add(finish.resolve);
  let secondStarted = false;
  const original = new ReadableStream<Uint8Array>({
    cancel() { entered.resolve(); return finish.promise; },
  }, { highWaterMark: 0 });
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/first")) return new Response(original);
    secondStarted = true;
    return new Response(null, { status: 204 });
  });

  const fetched = await safeFetch("https://settlement-cancel.test/first", "background");
  expect(fetched).not.toBeNull();
  const cancelling = task(fetched!.response.body!.cancel());
  try {
    await entered.promise;
    const follower = task(safeFetch("https://settlement-cancel.test/second", "background"));
    await turn();
    expect(secondStarted).toBe(false);
    finish.resolve();
    await cancelling;
    expect((await follower)?.response.status).toBe(204);
    expect(secondStarted).toBe(true);
  } finally {
    finish.resolve();
    await drain();
  }
});

it("awaits prefix cancellation before returning the original capped bytes", async () => {
  const entered = deferred(), finish = deferred();
  unblock.add(finish.resolve);
  const original = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(Buffer.from("abcd")); },
    cancel() { entered.resolve(); return finish.promise; },
  }, { highWaterMark: 0 });
  let returned = false;
  const reading = task(readBodyCapped(new Response(original), 4).then(value => {
    returned = true;
    return value;
  }));
  try {
    await entered.promise;
    await turn();
    expect(returned).toBe(false);
    finish.resolve();
    expect(await reading).toEqual(Buffer.from("abcd"));
  } finally {
    finish.resolve();
    await drain();
  }
});

it("keeps abort-triggered read completion from freeing the origin or returning partial success", async () => {
  const enteredRead = deferred(), enteredCancel = deferred(), finish = deferred();
  const deadline = new AbortController();
  const reason = new DOMException("held body deadline", "TimeoutError");
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancellations = 0, secondStarted = false;
  const original = new ReadableStream<Uint8Array>({
    start(value) { controller = value; value.enqueue(Buffer.from("partial")); },
    pull() { enteredRead.resolve(); },
    cancel() { cancellations += 1; enteredCancel.resolve(); return finish.promise; },
  }, { highWaterMark: 0 });
  unblock.add(() => { finish.resolve(); controller.error(reason); });
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/first")) return new Response(original);
    secondStarted = true;
    return new Response(null, { status: 204 });
  });
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
  try {
    const fetched = await safeFetch("https://settlement-abort.test/first", "background");
    timeout.mockRestore();
    expect(fetched).not.toBeNull();
    const reading = task(readBodyCapped(fetched!.response, 1024).then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    ));
    await enteredRead.promise;
    deadline.abort(reason);
    const follower = task(safeFetch("https://settlement-abort.test/second", "background"));
    await turn();
    expect(cancellations).toBe(1);
    expect(secondStarted).toBe(false);
    await enteredCancel.promise;
    finish.resolve();
    const result = await reading;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("abort returned partial success");
    expect(result.error).toBe(reason);
    expect((await follower)?.response.status).toBe(204);
  } finally {
    timeout.mockRestore();
    finish.resolve();
    controller.error(reason);
    await drain();
  }
});

it("cancels and preserves the reason when the signal aborts before wrapper installation", async () => {
  const finish = deferred();
  const deadline = new AbortController();
  const reason = new DOMException("headers deadline", "TimeoutError");
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancellations = 0;
  const original = new ReadableStream<Uint8Array>({
    start(value) { controller = value; },
    cancel() { cancellations += 1; return finish.promise; },
  }, { highWaterMark: 0 });
  unblock.add(() => { finish.resolve(); controller.error(reason); });
  fetchMock.mockImplementation(async () => {
    deadline.abort(reason);
    return new Response(original);
  });
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
  try {
    const fetched = await safeFetch("https://settlement-already-aborted.test/first", "background");
    timeout.mockRestore();
    expect(fetched).not.toBeNull();
    const reading = task(readBodyCapped(fetched!.response, 1024).then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    ));
    await turn();
    expect(cancellations).toBe(1);
    finish.resolve();
    const result = await reading;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("already-aborted body returned success");
    expect(result.error).toBe(reason);
  } finally {
    timeout.mockRestore();
    finish.resolve();
    controller.error(reason);
    await drain();
  }
});

it("calls the actual reader cancellation once when caller cancellation and abort overlap", async () => {
  const entered = deferred(), finish = deferred();
  const deadline = new AbortController();
  let cancellations = 0;
  unblock.add(finish.resolve);
  const original = new ReadableStream<Uint8Array>({
    cancel() { cancellations += 1; entered.resolve(); return finish.promise; },
  }, { highWaterMark: 0 });
  fetchMock.mockResolvedValue(new Response(original));
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
  try {
    const fetched = await safeFetch("https://settlement-overlap.test/first", "background");
    timeout.mockRestore();
    expect(fetched).not.toBeNull();
    const cancelling = task(fetched!.response.body!.cancel());
    await entered.promise;
    deadline.abort(new DOMException("overlapping abort", "AbortError"));
    await turn();
    expect(cancellations).toBe(1);
    finish.resolve();
    await cancelling;
  } finally {
    timeout.mockRestore();
    finish.resolve();
    await drain();
  }
});

it("returns the origin after normal EOF and follows a normally cancelled redirect", async () => {
  let cancellations = 0;
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith("/start")) return new Response(new ReadableStream({
      cancel() { cancellations += 1; },
    }, { highWaterMark: 0 }), { status: 302, headers: { location: "/body" } });
    return new Response("complete", { headers: { "x-control": "kept" } });
  });
  const first = await safeFetch("https://settlement-normal.test/start", "background");
  expect(first?.finalUrl).toBe("https://settlement-normal.test/body");
  expect(first?.response.headers.get("x-control")).toBe("kept");
  expect(await task(readBodyCapped(first!.response, 1024))).toEqual(Buffer.from("complete"));
  const second = await safeFetch("https://settlement-normal.test/body", "background");
  expect(await task(readBodyCapped(second!.response, 1024))).toEqual(Buffer.from("complete"));
  expect(cancellations).toBe(1);
});

it("keeps interactive calls parallel while their actual response bodies remain unread", async () => {
  let requests = 0;
  fetchMock.mockImplementation(async () => { requests += 1; return new Response("body"); });
  const [first, second] = await Promise.all([
    task(safeFetch("https://settlement-interactive.test/first")),
    task(safeFetch("https://settlement-interactive.test/second")),
  ]);
  expect(requests).toBe(2);
  expect(await task(readBodyCapped(first!.response, 1024))).toEqual(Buffer.from("body"));
  expect(await task(readBodyCapped(second!.response, 1024))).toEqual(Buffer.from("body"));
});
