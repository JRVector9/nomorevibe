import { assertPublicUrl } from "./ssrf";
import { nativeHttpFetch, legacyHttpDispatcher } from "./http-transport";
import { sharedHttpEnabled, HttpOriginPermitError } from "./http-origin-policy";
export { HttpOriginPermitError } from "./http-origin-policy";

export const FETCH_TIMEOUT_MS = 10_000;
const MAX_BACKGROUND_FETCH_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB

const cappedTimeoutSources = new WeakMap<AbortSignal, AbortSignal>();

function cappedRequestSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  const signal = AbortSignal.any([caller, timeout]);
  // Native any follows sources lazily. Preserve an expired source through GC
  // until the request/body's composite signal is no longer reachable.
  cappedTimeoutSources.set(signal, timeout);
  return signal;
}

/**
 * 외부 페이지에 보내는 기본 헤더.
 *
 * 언어를 밝히지 않으면 지역화하는 사이트가 서버의 위치(한국)를 보고 한국어 판을 준다 — ClickHouse 가
 * "빠른 오픈소스 OLAP DBMS"라는 이름으로, zuse.sh 가 한국어 소개로 올라왔다(2026-10-02 운영, 페이지만
 * 한국어고 저장소는 영어인 제품 69건). 제품의 기준 언어는 영어 판으로 둔다. 한국어 판만 있는 사이트는
 * 어차피 한국어가 온다.
 */
export const DEFAULT_HEADERS = {
  "user-agent": "NoMoreVibe/1.0 (+https://nomorevibe.app)",
  "accept-language": "en-US,en;q=0.9",
} as const;

export type FetchResult = { finalUrl: string; response: Response };

/** The crawler opts into bounded retries; interactive callers retain null/page results. */
type PageFetchOptions = {
  retryTransientErrors?: boolean;
  signal?: AbortSignal;
  /** Explicit asynchronous confirmation only; one total deadline, bounded to 60 seconds. */
  backgroundTimeoutMs?: number;
};

export class PageFetchError extends Error {
  readonly name = "PageFetchError";
  constructor(readonly reason: "timeout" | "transport" | "http", message: string,
    readonly status?: number, readonly retryAt?: Date) {
    super(message);
  }
}

function permanentTransportFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const errors = [error, "cause" in error ? error.cause : null];
  return errors.some(item => item && typeof item === "object" && (
    "code" in item && ["ENOTFOUND", "ERR_INVALID_URL", "ERR_INVALID_PROTOCOL", "ERR_UNSUPPORTED_PROTOCOL"].includes(String(item.code))
    || "message" in item && String(item.message).startsWith("사설 IP 차단:")
  ));
}

function retryAfterAt(value: string | null): Date | undefined {
  if (!value?.trim()) return undefined;
  const milliseconds = /^\d+$/.test(value.trim()) ? Date.now() + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(milliseconds) && milliseconds > Date.now() && Number.isFinite(new Date(milliseconds).getTime())
    ? new Date(milliseconds) : undefined;
}

export type CappedRequest = (
  url: string,
  init: {
    redirect: "manual";
    signal: AbortSignal;
    headers: Record<string, string>;
  },
) => Promise<Response>;

export type CappedFetchFailure =
  | { ok: false; reason: "too_large" }
  | { ok: false; reason: "unsafe_url" }
  | { ok: false; reason: "timeout" }
  | { ok: false; reason: "http"; status: number };

export type CappedFetchResult =
  | {
      ok: true;
      status: number;
      finalUrl: string;
      headers: Headers;
      body: Buffer;
      /** Present only when the caller explicitly requests a bounded prefix. */
      truncated?: boolean;
    }
  | CappedFetchFailure;

async function defaultRequest(
  url: string,
  init: Parameters<CappedRequest>[1],
): Promise<Response> {
  if (sharedHttpEnabled()) return (await import("./origin-permits")).requestOriginHop(url, init);
  return (await nativeHttpFetch(url, { ...init, dispatcher: legacyHttpDispatcher() })) as unknown as Response;
}

function timedOut(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    ((error as { name?: unknown }).name === "TimeoutError" ||
      (error as { name?: unknown }).name === "AbortError"),
  );
}

async function cancelUnusedBody(response: Response): Promise<boolean> {
  // Cleanup failure must not replace the response's original outcome.
  try {
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

export async function readBodyStrictlyCapped(
  response: Response,
  maxBytes: number,
): Promise<Buffer | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      await cancelUnusedBody(response);
      return null;
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readBodyPrefix(response: Response, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { body: Buffer.alloc(0), truncated: false };
  if (maxBytes === 0) {
    await reader.cancel().catch(() => {});
    return { body: Buffer.alloc(0), truncated: true };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { body: Buffer.concat(chunks), truncated: false };
    const remaining = maxBytes - total;
    if (value.length > remaining) {
      // Copy only the retained prefix, without holding the oversized chunk's buffer.
      if (remaining > 0) chunks.push(Buffer.from(value.subarray(0, remaining)));
      await reader.cancel().catch(() => {});
      return { body: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(value);
    total += value.length;
    if (total === maxBytes) {
      // The retained excerpt is complete; do not wait for an unread response tail.
      await reader.cancel().catch(() => {});
      return { body: Buffer.concat(chunks), truncated: true };
    }
  }
}

/**
 * 외부 증거 수집용 fetch. 모든 redirect hop과 실제 연결에서 SSRF 정책을 적용하고,
 * 선언된 Content-Length와 실제 stream 양쪽을 같은 상한으로 검증한다.
 */
export async function fetchCapped(
  url: string,
  options: {
    maxBytes: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    headers?: Record<string, string>;
    /** Read a bounded excerpt instead of rejecting an oversized body. */
    allowTruncatedBody?: boolean;
    /** The caller has a cached representation for a conditional 304 response. */
    acceptNotModified?: boolean;
    /** 테스트 전용 주입점. 프로덕션 기본 요청은 연결 시점 DNS도 재검사한다. */
    request?: CappedRequest;
  },
): Promise<CappedFetchResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
  if (options.request && sharedHttpEnabled()) throw new HttpOriginPermitError("custom_transport");
  const request = options.request ?? defaultRequest;
  const headers = {
    ...DEFAULT_HEADERS,
    ...options.headers,
  };
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guard = await assertPublicUrl(current);
    if (!guard.ok) return { ok: false, reason: "unsafe_url" };

    let response: Response;
    try {
      response = await request(current, {
        redirect: "manual",
        signal: cappedRequestSignal(options.signal, options.timeoutMs ?? FETCH_TIMEOUT_MS),
        headers,
      });
    } catch (error) {
      if (error instanceof HttpOriginPermitError) throw error;
      if (timedOut(error)) return { ok: false, reason: "timeout" };
      return { ok: false, reason: "http", status: 0 };
    }

    if (response.status === 304 && options.acceptNotModified) {
      return { ok: true, status: 304, finalUrl: current, headers: response.headers, body: Buffer.alloc(0) };
    }
    if (response.status >= 300 && response.status < 400) {
      if (!await cancelUnusedBody(response)) {
        return { ok: false, reason: "http", status: response.status };
      }
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "http", status: response.status };
      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, reason: "unsafe_url" };
      }
      continue;
    }
    if (!response.ok) {
      await cancelUnusedBody(response);
      return { ok: false, reason: "http", status: response.status };
    }

    let body: Buffer | null;
    let truncated: boolean | undefined;
    try {
      if (options.allowTruncatedBody) {
        const prefix = await readBodyPrefix(response, options.maxBytes);
        body = prefix.body;
        truncated = prefix.truncated;
      } else {
        body = await readBodyStrictlyCapped(response, options.maxBytes);
      }
    } catch (error) {
      if (error instanceof HttpOriginPermitError) throw error;
      if (timedOut(error)) return { ok: false, reason: "timeout" };
      return { ok: false, reason: "http", status: 0 };
    }
    if (body === null) return { ok: false, reason: "too_large" };
    return {
      ok: true,
      status: response.status,
      finalUrl: current,
      headers: response.headers,
      body,
      ...(truncated === undefined ? {} : { truncated }),
    };
  }
  return { ok: false, reason: "http", status: 310 };
}

/**
 * 누가 기다리는가 — 기한과 서버 예절이 둘 다 여기서 갈린다.
 *
 * - "interactive"(기본): 메이커가 기다리는 등록·검증. 리다이렉트마다 새 10초. 느린 302가
 *   두 번 이어져도(6초+6초) 정상 사이트이므로 받아야 한다 — 전체 10초로 묶었더니 그런
 *   사이트의 등록이 "접속 불가"로 거절됐다(codex가 재현). 한 번에 한 사이트만 여니 줄은 필요 없다.
 * - "background": 수집·생존 확인처럼 여러 사이트를 동시에 여는 잡. 요청 전체(모든 hop + 본문)에
 *   10초 하나라 동시 칸을 오래 붙잡지 않고, **같은 origin에는 hop 단위로 한 번에 하나**만 보낸다.
 *   부르는 쪽은 처음 주소의 origin으로만 줄을 세울 수 있어, 서로 다른 세 주소가 같은 서버로
 *   302하면 그 서버에 셋이 동시에 갔다(codex 실측 3). 느린 사이트를 한 번 놓쳐도 다음 바퀴가 본다.
 *   비동기 재확인은 backgroundTimeoutMs로 전체 기한을 최대 60초까지 명시할 수 있다.
 */
export type FetchMode = "interactive" | "background";

/**
 * origin 하나에 한 번에 하나 — 자리를 얻으면 놓는 함수를 돌려준다.
 *
 * 줄에서 기다리는 것도 기한(signal)에 끊긴다. 앞 요청이 늦으면 뒤 요청이 자기 10초를 넘겨서도
 * 계속 기다렸다(codex 재현: 100ms 기한에 152ms). 기다리다 끊긴 자리는 앞이 끝나는 대로 곧장
 * 넘긴다 — 줄이 거기서 멈추지 않게 하고, 앞 요청의 자리를 대신 풀지 않는다.
 * 프로세스 안에서만 지킨다(역할별 워커는 서로 다른 프로세스다).
 */
const originTails = new Map<string, Promise<void>>();
export async function acquireOrigin(origin: string, signal: AbortSignal): Promise<() => void> {
  const before = originTails.get(origin) ?? Promise.resolve();
  let open!: () => void;
  const mine = new Promise<void>((resolve) => { open = resolve; });
  const tail = before.then(() => mine);
  originTails.set(origin, tail);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    open();
    if (originTails.get(origin) === tail) originTails.delete(origin);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      before.then(() => { signal.removeEventListener("abort", onAbort); resolve(); });
    });
  } catch (error) {
    void before.then(release);
    throw error;
  }
  return release;
}

/**
 * 마지막 응답의 본문이 끝날 때 자리를 놓는다.
 *
 * 헤더에서 놓으면 같은 서버로 모인 세 요청의 본문이 동시에 흘러, 동시 요청을 막는 서버에서
 * 200·429·429가 났다(codex 재현). 본문이 끝나거나·취소되거나·오류가 나면 놓는다.
 * 기한은 본문 취소를 요청한다. 진행 중 read와 실제 취소가 정산된 뒤에 자리를 놓는다 — 취소가 거절돼도
 * 정산 뒤에는 놓는다. 실제 undici 는 기한에 본문을 먼저 오류로 만들어 그 뒤의 취소가 늘 거절되고,
 * 거절에 자리를 남기면 그 origin 의 background 요청이 프로세스가 끝날 때까지 막혔다(R4). 이 자리는
 * 프로세스 안의 예절 줄이라 외부 증거 없이 놓아도 된다(공유 permit 은 origin-permits 가 따로 정산한다).
 */
function releaseWhenBodyEnds(res: Response, release: () => void, signal: AbortSignal): Response {
  // 본문을 가질 수 없는 상태 코드는 새 Response로 감쌀 수 없다 — 곧장 놓는다
  if (!res.body || [101, 204, 205, 304].includes(res.status)) {
    release();
    return res;
  }
  const reader = res.body.getReader();
  let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let cancellation: Promise<void> | undefined;
  let cancelling = false;
  let aborted = false;
  let abortReason: unknown;
  let released = false;
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (released) return;
    released = true;
    signal.removeEventListener("abort", onAbort);
    release();
  };
  const cancel = (reason: unknown): Promise<void> => {
    if (cancellation) return cancellation;
    cancelling = true;
    const pendingRead = reading;
    // Install the shared Promise before calling cancel: it can wake a pending
    // read before its underlying cancellation has finished.
    const settled = async () => { await pendingRead?.catch(() => {}); finish(); };
    // 거절도 정산이다 — 자리를 놓고 원래 거절은 부른 쪽에 그대로 준다
    cancellation = Promise.resolve().then(() => reader.cancel(reason))
      .then(settled, async (error: unknown) => { await settled(); throw error; });
    void cancellation.catch(() => {});
    return cancellation;
  };
  const onAbort = () => {
    aborted = true;
    abortReason = signal.reason;
    void cancel(abortReason);
    bodyController.error(abortReason);
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) { bodyController = controller; },
    async pull(controller) {
      if (cancelling) return;
      const pendingRead = reader.read();
      reading = pendingRead;
      try {
        const { done, value } = await pendingRead;
        if (aborted) {
          controller.error(abortReason);
        } else if (done) {
          if (!cancelling) finish();
          controller.close();
        } else if (!cancelling) {
          controller.enqueue(value);
        }
      } catch (error) {
        if (!cancelling) finish();
        controller.error(aborted ? abortReason : error);
      } finally {
        if (reading === pendingRead) reading = undefined;
      }
    },
    cancel,
  });
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Bound the caller's wait; this does not cancel the underlying DNS lookup, which may settle later.
 * Both settlement paths stay observed, and each wait removes its abort listener. */
function awaitGuard<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(signal.reason); };
    work.then(value => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(signal.reason); else resolve(value);
    }, error => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.aborted ? signal.reason : error);
    });
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * SSRF-안전 fetch — 리다이렉트를 수동으로 추적하며 매 hop마다 정책을 다시 적용한다.
 * (redirect:"follow"는 검증 없이 사설망으로 향하는 302를 그대로 따라가므로 쓰지 않는다)
 */
export async function safeFetch(url: string, mode: FetchMode = "interactive", options: PageFetchOptions = {}): Promise<FetchResult | null> {
  const background = mode === "background";
  const backgroundTimeoutMs = options.backgroundTimeoutMs ?? FETCH_TIMEOUT_MS;
  if (options.backgroundTimeoutMs !== undefined && (!background || !Number.isSafeInteger(backgroundTimeoutMs)
    || backgroundTimeoutMs < 1 || backgroundTimeoutMs > MAX_BACKGROUND_FETCH_TIMEOUT_MS)) {
    throw new RangeError("backgroundTimeoutMs requires background mode and an integer between 1 and 60000");
  }
  const total = background ? cappedRequestSignal(options.signal, backgroundTimeoutMs) : null;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const signal = total ?? cappedRequestSignal(options.signal, FETCH_TIMEOUT_MS);
    let release: (() => void) | null = null;
    let res: Response;
    try {
      signal.throwIfAborted();
      const guard = await awaitGuard(assertPublicUrl(current), signal);
      signal.throwIfAborted();
      if (!guard.ok) {
        if (options.retryTransientErrors && guard.transient) throw new PageFetchError("transport", guard.reason);
        return null;
      }
      // 백그라운드는 hop마다 목적지 origin의 자리를 잡는다 (acquireOrigin 참고)
      if (background && !sharedHttpEnabled()) release = await acquireOrigin(new URL(current).origin, signal);
      signal.throwIfAborted();
      res = await defaultRequest(current, { redirect: "manual", signal, headers: DEFAULT_HEADERS });
    } catch (error) {
      release?.();
      if (error instanceof HttpOriginPermitError || error instanceof PageFetchError) throw error;
      if (options.retryTransientErrors && !permanentTransportFailure(error)) {
        throw new PageFetchError(timedOut(error) ? "timeout" : "transport",
          error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      }
      return null;
    }

    if (options.retryTransientErrors && (res.status === 408 || res.status === 429 || res.status >= 500 && res.status <= 599)) {
      const retryAt = retryAfterAt(res.headers.get("retry-after"));
      // 정리가 끝나면(실패여도) 자리를 놓는다 — 원래 상태·Retry-After 는 그대로
      await cancelUnusedBody(res);
      release?.();
      throw new PageFetchError("http", `HTTP ${res.status}`, res.status, retryAt);
    }

    // Some origins return nonstandard codes (e.g. 999). Preserve that failure
    // status without passing it to the stricter Response constructor below.
    if (res.status < 200 || res.status > 599) {
      await cancelUnusedBody(res);
      release?.();
      return { finalUrl: current, response: res };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location) {
        // 따라갈 응답의 본문은 읽지 않는다. 닫지 않으면 연결이 풀로 돌아가지 않는다.
        // 다음 hop 전에 자리를 놓아야 같은 서버로 돌아오는 사슬이 스스로를 기다리지 않는다.
        // 정리가 실패하면 다음 hop 은 보내지 않지만, 자리는 정리가 끝난 뒤 놓는다
        const cleaned = await cancelUnusedBody(res);
        release?.();
        if (!cleaned) return null;
        try {
          current = new URL(location, current).toString();
        } catch {
          return null;
        }
        continue;
      }
    }
    return { finalUrl: current, response: release ? releaseWhenBodyEnds(res, release, signal) : res };
  }
  return null; // 리다이렉트 한도 초과
}

/** 응답 본문을 크기 상한까지만 읽는다 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    chunks.push(value);
    if (total >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks);
}

/**
 * 대상 페이지를 안전하게 가져온다 (SSRF 가드 + 타임아웃 + 크기 상한).
 *
 * finalUrl을 함께 돌려준다. 리다이렉트가 있으면 입력 URL과 다르고, 중복 판정의
 * 기준은 최종 도착지여야 한다 — 그러지 않으면 같은 사이트가 두 주소로 등록된다.
 *
 * 닿지 않으면 null이지만, 헤더를 받은 뒤 본문이 끊기거나 기한을 넘기면 예외로 알린다.
 * 둘은 다른 일이다 — null은 "죽은 주소"로 저장돼 판정이 거르고, 예외는 부른 쪽이 항목별
 * 실패로 다시 시도한다(수집 잡). 본문 실패를 null로 뭉개면 한 번 끊긴 페이지가 영영 죽은
 * 것으로 판정된다.
 */
export async function fetchPage(
  url: string,
  mode: FetchMode = "interactive",
  options: PageFetchOptions = {},
): Promise<{ status: number; html: string; finalUrl: string } | null> {
  const fetched = await safeFetch(url, mode, options);
  if (!fetched) return null;
  const body = await readBodyCapped(fetched.response, MAX_HTML_BYTES);
  return {
    status: fetched.response.status,
    html: body.toString("utf-8"),
    finalUrl: fetched.finalUrl,
  };
}
