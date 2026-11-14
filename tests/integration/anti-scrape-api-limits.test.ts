import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { rateLimits } from "@/lib/db/schema";
import { blockRateLimitKey, RATE_LIMIT_BLOCKED_COUNT, rateLimitWindow } from "@/lib/rate-limit";
import { GET as productGet } from "@/app/api/products/[slug]/route";
import { GET as trapGet } from "@/app/api/catalog/[[...path]]/route";
import { API_READ_LIMIT, apiReadKey } from "@/lib/http/anti-scrape";
import * as repo from "@/lib/domain/products/repository";
import { ensureSchema, resetTables } from "./setup";

/**
 * 외부 수집 방지 2단계 B — 실제 Postgres(55435)에서 읽기 한도 창·Retry-After·함정 차단을 잰다.
 * 단위 시험(tests/anti-scrape-api.test.ts)은 한도 표를 바꿔 끼우므로, SQL 의 창 계산과 같은 키 차단은 여기서만 보인다.
 */
const IP = "198.51.100.44";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const get = (slug: string, ip = IP) => productGet(new Request(`https://nomorevibe.test/api/products/${slug}`, {
  headers: { "user-agent": BROWSER, "x-forwarded-for": ip },
}), { params: Promise.resolve({ slug }) } as never);

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await resetTables();
  await db.delete(rateLimits);
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  await repo.insert({
    slug: "limit-app", url: "https://limit-app.test", name: "LimitApp", tagline: "한도 시험", description: "설명",
    category: "Other", stack: [], status: "verified", source: "skill", verifyToken: "nmv_verify_limit-app", editTokenHash: "x".repeat(64),
  });
});
afterEach(() => vi.unstubAllEnvs());

describe("rateLimitWindow / blockRateLimitKey", () => {
  it("창 안에서 세고, 넘치면 남은 창 길이를 Retry-After 초로 준다", async () => {
    expect(await rateLimitWindow("t:window", 2, 60_000)).toMatchObject({ allowed: true, count: 1 });
    expect(await rateLimitWindow("t:window", 2, 60_000)).toMatchObject({ allowed: true, count: 2 });
    const third = await rateLimitWindow("t:window", 2, 60_000);
    expect(third).toMatchObject({ allowed: false, count: 3 });
    expect(third.retryAfterSeconds).toBeGreaterThanOrEqual(58);
    expect(third.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  it("지난 창은 1 부터 다시 센다", async () => {
    await db.insert(rateLimits).values({ key: "t:expired", count: 99, resetAt: new Date(Date.now() - 1_000) });
    expect(await rateLimitWindow("t:expired", 2, 60_000)).toMatchObject({ allowed: true, count: 1 });
  });

  it("차단은 같은 키를 차단 시간 동안 한도 밖으로 만들고, 더 긴 창을 줄이지 않는다", async () => {
    await blockRateLimitKey("t:block", 3_600_000);
    const blocked = await rateLimitWindow("t:block", 300, 600_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(3_500);
    await blockRateLimitKey("t:block", 60_000);
    const [row] = await db.select().from(rateLimits).where(eq(rateLimits.key, "t:block"));
    expect(row.resetAt.getTime() - Date.now()).toBeGreaterThan(3_500_000);
    expect(row.count).toBeGreaterThanOrEqual(RATE_LIMIT_BLOCKED_COUNT);
  });
});

describe("공개 제품 API — 실제 DB 한도", () => {
  it(`IP 하나가 ${API_READ_LIMIT}번을 넘으면 429 와 Retry-After, 다른 IP 는 그대로`, async () => {
    await db.insert(rateLimits).values({ key: apiReadKey(IP), count: API_READ_LIMIT - 1, resetAt: new Date(Date.now() + 600_000) });
    expect((await get("limit-app")).status).toBe(200);
    const limited = await get("limit-app");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(500);
    expect((await get("limit-app", "198.51.100.45")).status).toBe(200);
  });

  it("함정 경로를 부른 IP 는 다음 공개 API 읽기부터 429 — 다른 IP 는 그대로", async () => {
    expect((await get("limit-app")).status).toBe(200);
    const trap = await trapGet(new Request("https://nomorevibe.test/api/catalog/export.json", { headers: { "user-agent": BROWSER, "x-forwarded-for": IP } }));
    expect(trap.status).toBe(404);
    const blocked = await get("limit-app");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(3_500);
    expect((await get("limit-app", "198.51.100.45")).status).toBe(200);
  });
});
