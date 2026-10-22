import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { clickEvents, rateLimits } from "@/lib/db/schema";
import * as repo from "@/lib/domain/products/repository";
import { ensureSchema, resetTables } from "./setup";

/**
 * /go 와 서버 발신 방문 분석(PR C) — 실제 DB. GA 가 켜져 있고 Measurement Protocol 이 답하지 않아도
 * 같은 상태(302)·같은 주소로 바로 보내고, 클릭은 지금처럼 DB 에 센다. GA 로는 아무것도 나가지 않는다(fetch 는 가짜).
 */
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));

const { GET: goGet } = await import("@/app/go/[slug]/route");

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const savedVisitorHashSecret = process.env.VISITOR_HASH_SECRET;

/** 답하지 않는 GA — 보내는 쪽의 시간 상한(signal)이 끊을 때까지 매달린다 */
const slowCollect = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
}));

const go = (slug: string, cookie?: string) => goGet(new Request(`https://nomorevibe.test/go/${slug}?via=card`, {
  headers: { "user-agent": CHROME, ...(cookie ? { cookie } : {}) },
}), { params: Promise.resolve({ slug }) });
const clicks = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(clickEvents))[0].n;

beforeAll(() => {
  process.env.VISITOR_HASH_SECRET = "integration-visitor-hash-secret-32-characters";
  ensureSchema();
});
afterAll(() => {
  if (savedVisitorHashSecret === undefined) delete process.env.VISITOR_HASH_SECRET;
  else process.env.VISITOR_HASH_SECRET = savedVisitorHashSecret;
});
beforeEach(async () => {
  await db.delete(clickEvents);
  await db.delete(rateLimits);
  await resetTables();
  await repo.insert({
    slug: "app", url: "https://app.test/", name: "app", tagline: "소개", description: "설명", category: "Other", stack: [],
    status: "verified", source: "skill", verifyToken: "nmv_verify_app", editTokenHash: "x".repeat(64),
  });
  slowCollect.mockClear();
  vi.stubGlobal("fetch", slowCollect);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("/go 는 GA 를 기다리지 않는다", () => {
  it("GA 가 꺼져 있을 때와 켜져 있고 멈춰 있을 때 같은 302·같은 주소, 클릭은 각각 센다", async () => {
    const off = await go("app", "_ga=GA1.1.1111111111.1760000000");
    expect(off.status).toBe(302);
    expect(slowCollect).not.toHaveBeenCalled();

    vi.stubEnv("GA_MEASUREMENT_ID", "G-TEST123");
    vi.stubEnv("GA_API_SECRET", "test-api-secret_ABC");
    const started = performance.now();
    const on = await go("app", "_ga=GA1.1.2222222222.1760000000");
    const elapsed = performance.now() - started;

    expect(on.status).toBe(off.status);
    expect(on.headers.get("location")).toBe(off.headers.get("location"));
    expect(on.headers.get("location")).toBe("https://app.test/");
    // 상한(1.5초)보다 훨씬 빨리 — 보내기는 응답과 따로 돈다
    expect(elapsed).toBeLessThan(1_000);
    expect(slowCollect).toHaveBeenCalledTimes(1);
    const [url, init] = slowCollect.mock.calls[0];
    expect(url).toMatch(/^https:\/\/www\.google-analytics\.com\/mp\/collect\?measurement_id=G-TEST123&api_secret=/);
    expect(JSON.parse(String(init?.body))).toMatchObject({
      client_id: "2222222222.1760000000",
      events: [{ name: "outbound_visit", params: { product_slug: "app", link_kind: "site", via: "card", id_source: "ga_cookie" } }],
    });
    // 방문자 쿠키가 다르므로(새로 받음) 둘 다 센다 — GA 는 DB 집계에 끼어들지 않는다
    expect(await clicks()).toBe(2);
  });

  it("분석 쿠키가 없는 브라우저는 GA 로 보내지 않고, DB 클릭은 그대로 센다", async () => {
    vi.stubEnv("GA_MEASUREMENT_ID", "G-TEST123");
    vi.stubEnv("GA_API_SECRET", "test-api-secret_ABC");
    const response = await go("app");
    expect(response.status).toBe(302);
    expect(slowCollect).not.toHaveBeenCalled();
    expect(await clicks()).toBe(1);
  });
});
