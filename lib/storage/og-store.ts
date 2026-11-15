import { createHash } from "node:crypto";
import { AwsV4Signer } from "aws4fetch";

/**
 * 제품 대표 그림(OG·썸네일) 저장소 — S3 호환 MinIO 버킷(2026-11-15 운영자 결정).
 *
 * 그림 바이트가 Postgres(og_images, 약 9.8만 행·9GB)에 있어 11-15 공유 DB 볼륨이 가득 찼다. 새 그림은 버킷의 `og/<slug>` 에 두고,
 * 읽기는 버킷 먼저·없으면 DB(옮기는 동안과 직후). 환경변수 OG_STORE_* 다섯이 모두 있을 때만 켜진다 — 하나라도 없으면 지금처럼 DB 만 쓴다
 * (배포 순서와 무관하게 안전하다).
 *
 * 워커도 이 모듈을 읽는다 — `server-only` 를 붙이지 않는다. 비밀 키는 서명에만 쓰고 오류·로그에는 동작과 HTTP 상태만 남긴다.
 */

/** 한 요청의 기한 — 응답 본문을 다 받을 때까지 */
export const OG_STORE_TIMEOUT_MS = 5_000;
/** 받는 그림의 상한 — 등록 그림 상한(5MB, og.ts)보다 조금 크다. 넘으면 우리가 넣은 것이 아니다 */
export const OG_STORE_MAX_BYTES = 6 * 1024 * 1024;

export const OG_STORE_ENV_KEYS = [
  "OG_STORE_ENDPOINT", "OG_STORE_BUCKET", "OG_STORE_ACCESS_KEY", "OG_STORE_SECRET_KEY", "OG_STORE_REGION",
] as const;

export type OgStoreConfig = { endpoint: string; bucket: string; accessKey: string; secretKey: string; region: string };
export type OgObject = { data: Buffer; contentType: string };
export type OgObjectHead = { size: number; etag: string | null; contentType: string | null };
export type OgStoreOperation = "get" | "head" | "put" | "delete";

export interface OgObjectStore {
  /** 없으면 null. 저장소가 답하지 않거나 거절하면 OgStoreError */
  get(slug: string): Promise<OgObject | null>;
  head(slug: string): Promise<OgObjectHead | null>;
  /** ifAbsent: 이미 있으면 덮지 않고 "exists"(옮기기 스크립트 — 앱이 새로 쓴 것을 옛 DB 바이트로 덮지 않게) */
  put(slug: string, object: OgObject, options?: { ifAbsent?: boolean }): Promise<"stored" | "exists">;
  /** 없는 것을 지워도 성공이다 */
  delete(slug: string): Promise<void>;
}

/** 저장소 실패 — 메시지는 동작·이유(http_<상태>·timeout·network)만. 주소·키·서명을 담지 않는다 */
export class OgStoreError extends Error {
  readonly name = "OgStoreError";
  constructor(readonly operation: OgStoreOperation, readonly reason: string) {
    super(`og_store_${operation}_${reason}`);
  }
}

/** 버킷도 DB 도 그림을 내놓지 못했다(버킷 오류 + DB 에 없음) — 404 가 아니라 잠시 뒤 다시(503, 캐시 금지) */
export class OgImageUnavailableError extends Error {
  readonly name = "OgImageUnavailableError";
  constructor() {
    super("og_image_unavailable");
  }
}

const SLUG = /^[a-z0-9-]{1,80}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

/** 객체 열쇠 — 공개 주소(/api/og-cache/<slug>)가 받는 slug 만 */
export function ogObjectKey(slug: string): string {
  return `og/${slug}`;
}

/** 다섯 값이 모두 있고 모양이 맞을 때만 설정이다. 아니면 null(지금처럼 DB) */
export function ogStoreConfig(env: Record<string, string | undefined> = process.env): OgStoreConfig | null {
  const [endpoint, bucket, accessKey, secretKey, region] = OG_STORE_ENV_KEYS.map((key) => env[key]?.trim() ?? "");
  if (!endpoint || !bucket || !accessKey || !secretKey || !region) return null;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.search || url.hash) return null;
  if (!BUCKET.test(bucket)) return null;
  return { endpoint: url.origin + url.pathname.replace(/\/+$/, ""), bucket, accessKey, secretKey, region };
}

/** 몇 개가 비었는지만(이름) — 값은 말하지 않는다 */
export function ogStoreMissingKeys(env: Record<string, string | undefined> = process.env): string[] {
  return OG_STORE_ENV_KEYS.filter((key) => !env[key]?.trim());
}

function failureReason(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError" ? "timeout" : "network";
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

function etagOf(response: Response): string | null {
  const value = response.headers.get("etag");
  return value ? value.replace(/^W\//, "").replace(/^"|"$/g, "") : null;
}

/** 본문을 상한까지만 받는다 — content-length 를 믿지 않고 받은 만큼 센다 */
async function readCapped(response: Response, operation: OgStoreOperation): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > OG_STORE_MAX_BYTES) {
    await discard(response);
    throw new OgStoreError(operation, "too_large");
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > OG_STORE_MAX_BYTES) {
      await reader.cancel().catch(() => {});
      throw new OgStoreError(operation, "too_large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/** S3 API(경로 방식, SigV4). fetchImpl 은 시험용 */
export function createOgObjectStore(config: OgStoreConfig, fetchImpl: typeof fetch = (...args) => fetch(...args)): OgObjectStore {
  const signingCache = new Map<string, ArrayBuffer>();

  async function call(operation: OgStoreOperation, slug: string, init: { method: string; headers?: Record<string, string>; body?: Buffer },
    handle: (response: Response) => Promise<unknown>): Promise<unknown> {
    if (!SLUG.test(slug)) throw new OgStoreError(operation, "invalid_slug");
    const url = `${config.endpoint}/${config.bucket}/${ogObjectKey(slug)}`;
    const signal = AbortSignal.timeout(OG_STORE_TIMEOUT_MS);
    let response: Response;
    try {
      const signed = await new AwsV4Signer({
        url, method: init.method, headers: init.headers,
        accessKeyId: config.accessKey, secretAccessKey: config.secretKey, service: "s3", region: config.region, cache: signingCache,
      }).sign();
      response = await fetchImpl(signed.url, {
        method: signed.method, headers: signed.headers,
        // 복사본(ArrayBuffer 위의 Uint8Array) — Buffer 는 공유 풀 위일 수 있어 fetch 본문 형식에 맞지 않는다. 그림 하나라 비용은 작다
        body: init.body ? new Uint8Array(init.body) : undefined,
        redirect: "error", cache: "no-store", signal,
      });
    } catch (error) {
      throw new OgStoreError(operation, failureReason(error));
    }
    try {
      return await handle(response);
    } catch (error) {
      if (error instanceof OgStoreError) throw error;
      throw new OgStoreError(operation, failureReason(error));
    }
  }

  return {
    async get(slug) {
      return call("get", slug, { method: "GET" }, async (response) => {
        if (response.status === 404) {
          await discard(response);
          return null;
        }
        if (response.status !== 200) {
          await discard(response);
          throw new OgStoreError("get", `http_${response.status}`);
        }
        const contentType = response.headers.get("content-type")?.split(";")[0].trim() || "application/octet-stream";
        const data = await readCapped(response, "get");
        if (data.length === 0) throw new OgStoreError("get", "empty");
        return { data, contentType };
      }) as Promise<OgObject | null>;
    },

    async head(slug) {
      return call("head", slug, { method: "HEAD" }, async (response) => {
        await discard(response);
        if (response.status === 404) return null;
        if (response.status !== 200) throw new OgStoreError("head", `http_${response.status}`);
        return {
          size: Number(response.headers.get("content-length") ?? NaN),
          etag: etagOf(response),
          contentType: response.headers.get("content-type")?.split(";")[0].trim() || null,
        };
      }) as Promise<OgObjectHead | null>;
    },

    async put(slug, object, options = {}) {
      if (object.data.length === 0 || object.data.length > OG_STORE_MAX_BYTES) throw new OgStoreError("put", "invalid_size");
      const headers: Record<string, string> = {
        "content-type": object.contentType,
        // 서명에 본문 해시를 넣는다 — 저장소가 받은 바이트를 이 해시로 확인한다(중간에 바뀐 바이트는 거절)
        "x-amz-content-sha256": createHash("sha256").update(object.data).digest("hex"),
        "content-md5": createHash("md5").update(object.data).digest("base64"),
      };
      if (options.ifAbsent) headers["if-none-match"] = "*";
      return call("put", slug, { method: "PUT", headers, body: object.data }, async (response) => {
        await discard(response);
        if (response.status === 200) return "stored";
        // 412: 이미 있다. 409: 같은 열쇠에 다른 쓰기가 진행 중 — 둘 다 덮지 않은 것이다
        if (options.ifAbsent && (response.status === 412 || response.status === 409)) return "exists";
        throw new OgStoreError("put", `http_${response.status}`);
      }) as Promise<"stored" | "exists">;
    },

    async delete(slug) {
      await call("delete", slug, { method: "DELETE" }, async (response) => {
        await discard(response);
        if (response.status === 204 || response.status === 200 || response.status === 404) return;
        throw new OgStoreError("delete", `http_${response.status}`);
      });
    },
  };
}

let override: OgObjectStore | null | undefined;
let current: { signature: string; store: OgObjectStore } | null = null;

/** 이 프로세스의 저장소 — 설정이 없으면 null(지금처럼 DB). 같은 설정이면 같은 객체를 다시 쓴다 */
export function ogObjectStore(): OgObjectStore | null {
  if (override !== undefined) return override;
  const config = ogStoreConfig();
  if (!config) {
    current = null;
    return null;
  }
  // 비밀 키는 해시로만 비교한다(메모리에도 원문 열쇠 문자열을 하나 더 만들지 않는다)
  const signature = [config.endpoint, config.bucket, config.accessKey, config.region,
    createHash("sha256").update(config.secretKey).digest("hex")].join("\n");
  if (current?.signature !== signature) current = { signature, store: createOgObjectStore(config) };
  return current.store;
}

/** 시험: 가짜 저장소를 끼운다(null = 꺼짐, undefined = 환경변수로 되돌림) */
export function setOgObjectStoreForTests(store: OgObjectStore | null | undefined): void {
  override = store;
}
