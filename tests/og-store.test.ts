import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ og: vi.fn() }));
vi.mock("@/lib/domain/products/repository", () => ({ getOgImage: mocks.og }));
vi.mock("@/lib/domain/products/detail-view", () => ({ getProductIdentity: async (slug: string) => ({ slug }) }));
vi.mock("@/lib/domain/products/public-reads", () => ({ publicRead: (_kind: string, _key: unknown[], load: () => Promise<unknown>) => load() }));
// 표지는 보호 주소(<slug>.<열쇠>)로만 나간다 — lib/domain/products/cover-url.ts. 열쇠는 이 시험 비밀에서 만든다
process.env.VISITOR_HASH_SECRET = "test-visitor-hash-secret-0123456789abcdef";

import { GET } from "@/app/api/og-cache/[slug]/route";
import { OG_DELETE_PURGE, purgesLists } from "@/lib/cdn/purge";
import { coverKey } from "@/lib/domain/products/cover-url";
import {
  createOgObjectStore, OG_STORE_MAX_BYTES, OgImageUnavailableError, ogObjectKey, ogStoreConfig, ogStoreMissingKeys, OgStoreError,
} from "@/lib/storage/og-store";

/**
 * 대표 그림 버킷(S3 호환 MinIO, 2026-11-15) — 설정, 서명된 요청 모양, 실패가 비밀 없이 이유만 남기는지, 공개 경로의 503.
 */
const SECRET = "very-secret-key-value";
const env = {
  OG_STORE_ENDPOINT: "http://100.64.0.1:9000/", OG_STORE_BUCKET: "nomorevibe-og", OG_STORE_ACCESS_KEY: "nomorevibe-og",
  OG_STORE_SECRET_KEY: SECRET, OG_STORE_REGION: "us-east-1",
};
const config = ogStoreConfig(env)!;

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  });
  return { calls, impl: impl as unknown as typeof fetch };
}
const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);

describe("버킷 설정", () => {
  it("다섯 값이 모두 있을 때만 켜지고, 끝의 / 는 뗀다", () => {
    expect(config).toEqual({ endpoint: "http://100.64.0.1:9000", bucket: "nomorevibe-og", accessKey: "nomorevibe-og",
      secretKey: SECRET, region: "us-east-1" });
    for (const key of Object.keys(env)) {
      expect(ogStoreConfig({ ...env, [key]: "" })).toBeNull();
      expect(ogStoreMissingKeys({ ...env, [key]: " " })).toEqual([key]);
    }
    expect(ogStoreConfig({})).toBeNull();
  });

  it("주소·버킷 모양이 틀리면 꺼진 것으로 본다(사용자 정보·쿼리가 든 주소도)", () => {
    expect(ogStoreConfig({ ...env, OG_STORE_ENDPOINT: "not a url" })).toBeNull();
    expect(ogStoreConfig({ ...env, OG_STORE_ENDPOINT: "ftp://host:9000" })).toBeNull();
    expect(ogStoreConfig({ ...env, OG_STORE_ENDPOINT: "http://user:pw@host:9000" })).toBeNull();
    expect(ogStoreConfig({ ...env, OG_STORE_ENDPOINT: "http://host:9000/?x=1" })).toBeNull();
    expect(ogStoreConfig({ ...env, OG_STORE_BUCKET: "Bad_Bucket" })).toBeNull();
  });

  it("객체 열쇠는 og/<slug>", () => {
    expect(ogObjectKey("easyread")).toBe("og/easyread");
  });
});

describe("S3 요청", () => {
  it("쓰기는 경로 방식 주소에 본문 해시를 서명하고 형식을 싣는다 — 비밀 키는 어디에도 실리지 않는다", async () => {
    const { calls, impl } = fakeFetch(() => new Response(null, { status: 200 }));
    const data = Buffer.from("png-bytes");
    expect(await createOgObjectStore(config, impl).put("easyread", { data, contentType: "image/png" })).toBe("stored");
    const [call] = calls;
    expect(call.url).toBe("http://100.64.0.1:9000/nomorevibe-og/og/easyread");
    expect(call.init.method).toBe("PUT");
    expect(header(call, "content-type")).toBe("image/png");
    expect(header(call, "x-amz-content-sha256")).toBe(createHash("sha256").update(data).digest("hex"));
    expect(header(call, "content-md5")).toBe(createHash("md5").update(data).digest("base64"));
    expect(header(call, "if-none-match")).toBeNull();
    expect(header(call, "authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=nomorevibe-og\/\d{8}\/us-east-1\/s3\/aws4_request, /);
    expect(JSON.stringify([...new Headers(call.init.headers)])).not.toContain(SECRET);
    expect(Buffer.from(call.init.body as Uint8Array).toString()).toBe("png-bytes");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.redirect).toBe("error");
  });

  it("ifAbsent 는 If-None-Match:* 로 쓰고, 이미 있으면(412·409) 덮지 않은 것으로 돌려준다", async () => {
    for (const status of [412, 409]) {
      const { calls, impl } = fakeFetch(() => new Response("exists", { status }));
      expect(await createOgObjectStore(config, impl).put("a", { data: Buffer.from("x"), contentType: "image/png" }, { ifAbsent: true }))
        .toBe("exists");
      expect(header(calls[0], "if-none-match")).toBe("*");
    }
    const { impl } = fakeFetch(() => new Response("exists", { status: 412 }));
    // ifAbsent 가 아닌데 412 면 실패다
    await expect(createOgObjectStore(config, impl).put("a", { data: Buffer.from("x"), contentType: "image/png" }))
      .rejects.toThrow("og_store_put_http_412");
  });

  it("읽기: 있으면 바이트와 형식, 없으면(404) null, 그 밖은 동작·상태만 담은 오류", async () => {
    const hit = fakeFetch(() => new Response(Buffer.from("webp-bytes"), { status: 200, headers: { "content-type": "image/webp" } }));
    expect(await createOgObjectStore(config, hit.impl).get("a")).toEqual({ data: Buffer.from("webp-bytes"), contentType: "image/webp" });
    expect(hit.calls[0].init.method).toBe("GET");
    expect(header(hit.calls[0], "x-amz-content-sha256")).toBe("UNSIGNED-PAYLOAD");

    const miss = fakeFetch(() => new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 }));
    expect(await createOgObjectStore(config, miss.impl).get("a")).toBeNull();

    const denied = fakeFetch(() => new Response(`<Error><Code>AccessDenied</Code><Key>${SECRET}</Key></Error>`, { status: 403 }));
    const error = await createOgObjectStore(config, denied.impl).get("a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OgStoreError);
    expect((error as Error).message).toBe("og_store_get_http_403");
  });

  it("네트워크·기한 실패도 이유 하나로 — 주소나 원래 메시지를 싣지 않는다", async () => {
    const network = fakeFetch(() => { throw new TypeError(`fetch failed http://100.64.0.1:9000 ${SECRET}`); });
    await expect(createOgObjectStore(config, network.impl).get("a")).rejects.toThrow(/^og_store_get_network$/);
    const timeout = fakeFetch(() => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); });
    await expect(createOgObjectStore(config, timeout.impl).delete("a")).rejects.toThrow(/^og_store_delete_timeout$/);
  });

  it("상한보다 큰 본문은 받지 않는다(선언된 길이도, 실제로 흐른 바이트도)", async () => {
    const declared = fakeFetch(() => new Response("x", { status: 200, headers: { "content-length": String(OG_STORE_MAX_BYTES + 1) } }));
    await expect(createOgObjectStore(config, declared.impl).get("a")).rejects.toThrow("og_store_get_too_large");
    const streamed = fakeFetch(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(OG_STORE_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    }), { status: 200 }));
    await expect(createOgObjectStore(config, streamed.impl).get("a")).rejects.toThrow("og_store_get_too_large");
  });

  it("HEAD 는 크기·ETag(따옴표 없이)·형식, 지우기는 없는 것도 성공", async () => {
    const head = fakeFetch(() => new Response(null, { status: 200, headers: { "content-length": "9", etag: '"abc123"', "content-type": "image/png" } }));
    expect(await createOgObjectStore(config, head.impl).head("a")).toEqual({ size: 9, etag: "abc123", contentType: "image/png" });
    for (const status of [204, 404]) {
      const del = fakeFetch(() => new Response(null, { status }));
      await expect(createOgObjectStore(config, del.impl).delete("a")).resolves.toBeUndefined();
      expect(del.calls[0].init.method).toBe("DELETE");
    }
    const failing = fakeFetch(() => new Response(null, { status: 500 }));
    await expect(createOgObjectStore(config, failing.impl).delete("a")).rejects.toThrow("og_store_delete_http_500");
  });

  it("공개 주소가 받지 않는 slug 는 요청하지 않는다", async () => {
    const { calls, impl } = fakeFetch(() => new Response(null, { status: 200 }));
    await expect(createOgObjectStore(config, impl).get("../etc")).rejects.toThrow("og_store_get_invalid_slug");
    await expect(createOgObjectStore(config, impl).put("Bad", { data: Buffer.from("x"), contentType: "image/png" }))
      .rejects.toThrow("og_store_put_invalid_slug");
    expect(calls).toHaveLength(0);
  });
});

describe("지우기 줄", () => {
  it("그림 지우기 줄만으로는 목록을 지우지 않는다", () => {
    expect(purgesLists([OG_DELETE_PURGE])).toBe(false);
    expect(purgesLists([OG_DELETE_PURGE, "banned"])).toBe(true);
  });
});

describe("공개 경로", () => {
  const call = (slug: string) => GET(new Request(`https://nomorevibe.test/api/og-cache/${slug}.${coverKey(slug)}`),
    { params: Promise.resolve({ slug: `${slug}.${coverKey(slug)}` }) });

  it("버킷이 답하지 않고 DB 에도 없으면 503 — 엣지·브라우저가 담아 두지 않는다", async () => {
    mocks.og.mockRejectedValueOnce(new OgImageUnavailableError());
    const response = await call("store-down");
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
    expect(response.headers.get("cache-tag")).toBeNull();
  });

  it("없는 그림은 지금처럼 404", async () => {
    mocks.og.mockResolvedValueOnce(null);
    expect((await call("missing")).status).toBe(404);
  });
});
