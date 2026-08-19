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
 * SSRF-안전 fetch — 리다이렉트를 수동으로 추적하며 매 hop마다 정책을 다시 적용한다.
 * (redirect:"follow"는 검증 없이 사설망으로 향하는 302를 그대로 따라가므로 쓰지 않는다)
 */
export async function safeFetch(url: string): Promise<FetchResult | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const guard = await assertPublicUrl(current);
    if (!guard.ok) return null;

    let res: Response;
    try {
      res = (await undiciFetch(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "user-agent": "NoMoreVibe/1.0 (+https://nomorevibe.app)" },
        dispatcher: allowPrivate() ? undefined : ssrfSafeAgent,
      })) as unknown as Response;
    } catch {
      return null;
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) return { finalUrl: current, response: res };
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
 */
export async function fetchPage(
  url: string,
): Promise<{ status: number; html: string; finalUrl: string } | null> {
  const fetched = await safeFetch(url);
  if (!fetched) return null;
  const body = await readBodyCapped(fetched.response, MAX_HTML_BYTES);
  return {
    status: fetched.response.status,
    html: body.toString("utf-8"),
    finalUrl: fetched.finalUrl,
  };
}
