import { Agent, fetch as undiciFetch } from "undici";
import { lookup as dnsLookup } from "node:dns";
import { assertPublicUrl, isPrivateIp, allowPrivate } from "./ssrf";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * 연결 시점 DNS 검증 — 1차 검사와 실제 연결 사이에 레코드를 바꾸는 DNS 리바인딩을 차단한다.
 *
 * 주의: net.connect의 autoSelectFamily(Node 20+ 기본)는 lookup을 { all: true }로 호출하고
 * 주소 "배열"을 기대한다. 단일 주소 형태로만 응답하면 모든 연결이 ERR_INVALID_IP_ADDRESS로 실패한다.
 */
const ssrfSafeAgent = new Agent({
  connect: {
    lookup(hostname, options, callback) {
      dnsLookup(hostname, { all: true }, (err, addresses) => {
        if (err) return callback(err, "", 4);
        const list = Array.isArray(addresses) ? addresses : [];
        if (list.length === 0 || list.some((a) => isPrivateIp(a.address))) {
          return callback(new Error(`사설 IP 차단: ${hostname}`), "", 4);
        }
        if (options?.all) {
          return (callback as unknown as (e: Error | null, a: typeof list) => void)(null, list);
        }
        callback(null, list[0].address, list[0].family);
      });
    },
  },
});

export type FetchResult = { finalUrl: string; response: Response };

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
    }
  | CappedFetchFailure;

async function defaultRequest(
  url: string,
  init: Parameters<CappedRequest>[1],
): Promise<Response> {
  return (await undiciFetch(url, {
    ...init,
    dispatcher: allowPrivate() ? undefined : ssrfSafeAgent,
  })) as unknown as Response;
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

export async function readBodyStrictlyCapped(
  response: Response,
  maxBytes: number,
): Promise<Buffer | null> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) return null;
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
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
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
    headers?: Record<string, string>;
    /** 테스트 전용 주입점. 프로덕션 기본 요청은 연결 시점 DNS도 재검사한다. */
    request?: CappedRequest;
  },
): Promise<CappedFetchResult> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new Error("maxBytes must be a non-negative safe integer");
  }
  const request = options.request ?? defaultRequest;
  const headers = {
    "user-agent": "NoMoreVibe/1.0 (+https://nomorevibe.app)",
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
        signal: AbortSignal.timeout(options.timeoutMs ?? FETCH_TIMEOUT_MS),
        headers,
      });
    } catch (error) {
      if (timedOut(error)) return { ok: false, reason: "timeout" };
      return { ok: false, reason: "http", status: 0 };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "http", status: response.status };
      try {
        current = new URL(location, current).toString();
      } catch {
        return { ok: false, reason: "unsafe_url" };
      }
      continue;
    }
    if (!response.ok) return { ok: false, reason: "http", status: response.status };

    let body: Buffer | null;
    try {
      body = await readBodyStrictlyCapped(response, options.maxBytes);
    } catch (error) {
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
 */
export type FetchMode = "interactive" | "background";

/**
 * origin 하나에 한 번에 하나.
 *
 * 헤더를 받을 때까지만 자리를 쥔다 — 리다이렉트면 본문을 닫고 다음 hop 전에 놓아야 같은 서버로
 * 튀는 사슬이 스스로를 기다리지 않는다. 마지막 응답의 본문은 부르는 쪽이 자리 없이 읽는다.
 * 프로세스 안에서만 지킨다(역할별 워커는 서로 다른 프로세스다).
 */
const originTails = new Map<string, Promise<void>>();
async function oneAtATimeFor<T>(origin: string, run: () => Promise<T>): Promise<T> {
  const before = originTails.get(origin) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const tail = before.then(() => mine);
  originTails.set(origin, tail);
  await before;
  try {
    return await run();
  } finally {
    release();
    if (originTails.get(origin) === tail) originTails.delete(origin);
  }
}

/**
 * SSRF-안전 fetch — 리다이렉트를 수동으로 추적하며 매 hop마다 정책을 다시 적용한다.
 * (redirect:"follow"는 검증 없이 사설망으로 향하는 302를 그대로 따라가므로 쓰지 않는다)
 */
export async function safeFetch(url: string, mode: FetchMode = "interactive"): Promise<FetchResult | null> {
  const background = mode === "background";
  const total = background ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : null;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guard = await assertPublicUrl(current);
    if (!guard.ok) return null;

    let res: Response;
    try {
      const request = () => undiciFetch(current, {
        redirect: "manual",
        signal: total ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "NoMoreVibe/1.0 (+https://nomorevibe.app)" },
        dispatcher: allowPrivate() ? undefined : ssrfSafeAgent,
      }) as unknown as Promise<Response>;
      res = background ? await oneAtATimeFor(new URL(current).origin, request) : await request();
    } catch {
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { finalUrl: current, response: res };
      // 따라갈 응답의 본문은 읽지 않는다. 닫지 않으면 연결이 풀로 돌아가지 않는다
      await res.body?.cancel().catch(() => {});
      try {
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    return { finalUrl: current, response: res };
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
      reader.cancel();
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
): Promise<{ status: number; html: string; finalUrl: string } | null> {
  const fetched = await safeFetch(url, mode);
  if (!fetched) return null;
  const body = await readBodyCapped(fetched.response, MAX_HTML_BYTES);
  return {
    status: fetched.response.status,
    html: body.toString("utf-8"),
    finalUrl: fetched.finalUrl,
  };
}
