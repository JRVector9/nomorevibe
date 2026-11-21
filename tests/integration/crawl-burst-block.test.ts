import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { eq, like, or } from "drizzle-orm";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { operationsAudit, rateLimits, runtimeSettings } from "@/lib/db/schema";
import { setCrawlBurstStoreForTest } from "@/lib/http/crawl-burst";
import { CRAWL_BURST_DEFAULTS, DETAIL_API_DEFAULTS, CRAWL_PROHIBITED_MESSAGE, crawlBurstKey, detailBurstKey, detailReadKey } from "@/lib/http/crawl-burst-policy";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { CRAWL_BURST_RELEASE_ACTION, crawlBurstStatus, releaseCrawlBurst, saveCrawlBurstSettings } from "@/lib/operations/crawl-burst-ops";
import { readRuntimeSettingsRow } from "@/lib/operations/runtime-settings";
import { RATE_LIMIT_BLOCKED_COUNT } from "@/lib/rate-limit";
import { proxy } from "@/proxy";
import { auditFloor, auditRowsAfter, ensureSchema, TEST_DATABASE_URL } from "./setup";

/**
 * 과다 호출 30분 차단 — 실제 Postgres(55435 방식)에서 rate_limits 한 행의 창·차단·풀림과 runtime_settings 저장 반영을 잰다.
 * 단위 시험(tests/crawl-burst-block.test.ts)은 같은 의미를 메모리로 본다. operations_audit 는 지우지 않는다(감사 바닥만 잰다).
 */
vi.mock("server-only", () => ({}));

const IP = "198.51.100.61";
const OTHER = "198.51.100.62";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const LIMIT = CRAWL_BURST_DEFAULTS.burstLimit;

const page = (path: string, ip = IP) => proxy(new NextRequest(`https://nomorevibe.com${path}`, { headers: { "user-agent": BROWSER, "x-forwarded-for": ip } }));
const api = (path: string, ip = IP) => guardPublicApiRead(new Request(`https://nomorevibe.com${path}`, { headers: { "user-agent": BROWSER, "x-forwarded-for": ip } }), "test");
const row = async (ip = IP) => (await db.select().from(rateLimits).where(eq(rateLimits.key, crawlBurstKey(ip))))[0];

let originalSettings: unknown;
beforeAll(async () => {
  ensureSchema();
  originalSettings = (await readRuntimeSettingsRow()).values;
});
/** 저장 문서에서 publicApi.burst* 만 뺀다 — 이 시험은 코드 기본값에서 시작한다(다른 키는 그대로) */
function withoutBurstKeys(values: unknown): Record<string, unknown> {
  const doc = { ...(values as Record<string, unknown> ?? {}) };
  const group = { ...(doc.publicApi as Record<string, unknown> ?? {}) };
  for (const key of Object.keys(group)) if (key.startsWith("burst") || key.startsWith("detail")) delete group[key];
  if (Object.keys(group).length) doc.publicApi = group; else delete doc.publicApi;
  return doc;
}
beforeEach(async () => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  await db.update(runtimeSettings).set({ values: withoutBurstKeys(originalSettings) }).where(eq(runtimeSettings.id, 1));
  await db.delete(rateLimits).where(or(like(rateLimits.key, "burst:%"), like(rateLimits.key, "detail-burst:%"), like(rateLimits.key, "detail-read:%")));
  await db.delete(rateLimits).where(like(rateLimits.key, "api-read:%"));
  setCrawlBurstStoreForTest(null);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await db.update(runtimeSettings).set({ values: originalSettings as Record<string, unknown> }).where(eq(runtimeSettings.id, 1));
  setCrawlBurstStoreForTest(null);
});

describe("실제 한도 표 — 창·차단·풀림", () => {
  it(`화면 + API 를 한 통에 세고, ${LIMIT}번까지 받고 다음에 30분 차단(Retry-After≈1800)`, async () => {
    for (let i = 0; i < LIMIT / 2; i += 1) expect((await page(`/p/app-${i}`)).status, `page ${i}`).not.toBe(429);
    for (let i = 0; i < LIMIT / 2; i += 1) expect(await api(`/api/products/app-${i}/feedback`), `api ${i}`).toBeNull();
    expect((await row())?.count).toBe(LIMIT);
    const blocked = await page("/p/app-x");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBe(1800);
    // 문장마다 span 으로 감싼다(줄이 문장 사이에서 끊기게) — 태그를 걷어 낸 글자가 지시 원문 그대로다
    expect((await blocked.text()).replace(/<[^>]+>/g, "")).toContain(CRAWL_PROHIBITED_MESSAGE);
    const stored = await row();
    expect(stored.count).toBe(RATE_LIMIT_BLOCKED_COUNT);
    expect(stored.resetAt.getTime() - Date.now()).toBeGreaterThan(1_795_000);
    // 막힌 동안: API 도 같은 키로 막히고, 남은 초가 Retry-After, count 는 더 오르지 않는다(integer 열)
    const apiBlocked = await api("/api/products/app-x/reactions");
    expect(apiBlocked?.status).toBe(429);
    expect(Number(apiBlocked!.headers.get("retry-after"))).toBeGreaterThanOrEqual(1795);
    expect(Number(apiBlocked!.headers.get("retry-after"))).toBeLessThanOrEqual(1800);
    expect(await apiBlocked!.json()).toMatchObject({ error: "crawling_prohibited" });
    expect((await row()).count).toBe(RATE_LIMIT_BLOCKED_COUNT);
    // 다른 IP 는 그대로
    expect((await page("/", OTHER)).status).not.toBe(429);
  });

  it("30분이 지나면 풀리고 1부터 다시 센다", async () => {
    for (let i = 0; i <= LIMIT; i += 1) await page("/");
    expect((await page("/")).status).toBe(429);
    // 차단 시각을 30분 전으로 옮긴다(시계를 기다리지 않는다)
    await db.update(rateLimits).set({ resetAt: new Date(Date.now() - 1_000) }).where(eq(rateLimits.key, crawlBurstKey(IP)));
    expect((await page("/")).status).not.toBe(429);
    expect((await row()).count).toBe(1);
  });

  it("창(10초)이 지나면 센 수가 사라진다 — 느린 사람은 쌓이지 않는다", async () => {
    for (let i = 0; i < LIMIT; i += 1) await page("/");
    await db.update(rateLimits).set({ resetAt: new Date(Date.now() - 1_000) }).where(eq(rateLimits.key, crawlBurstKey(IP)));
    for (let i = 0; i < LIMIT; i += 1) expect((await page("/")).status).not.toBe(429);
  });

  it("정적 자원은 행을 만들지 않는다", async () => {
    for (const path of ["/_next/static/x.js", "/favicon.ico", "/api/og-cache/a.b.webp", "/api/media/abc", "/p/app/share-card.png", "/robots.txt"]) {
      for (let i = 0; i < LIMIT; i += 1) await page(path);
    }
    expect(await row()).toBeUndefined();
  });
});

describe("관리자 설정(runtime_settings) 반영과 운영 도구", () => {
  it("저장한 기준 수·창·차단 시간을 다음 읽기부터 쓴다(감사 줄 runtime-settings-save)", async () => {
    const floor = await auditFloor();
    const saved = await saveCrawlBurstSettings({ burstLimit: 3, burstWindowSeconds: 60, burstBlockSeconds: 300 }, "test:crawl-burst");
    expect(saved.ok).toBe(true);
    expect(await auditRowsAfter(floor, "runtime-settings-save")).toEqual(expect.arrayContaining([expect.objectContaining({ target: "runtime_settings:publicApi" })]));
    setCrawlBurstStoreForTest(null); // 30초 설정 캐시를 비운다(운영에서는 30초 안에 읽는다)
    for (let i = 0; i < 3; i += 1) expect((await page("/")).status).not.toBe(429);
    const blocked = await page("/");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBe(300);
    expect((await crawlBurstStatus())).toMatchObject({ settings: { burstLimit: 3, burstWindowSeconds: 60, burstBlockSeconds: 300 }, blockedNow: 1 });
    // 범위 밖은 저장되지 않는다
    expect(await saveCrawlBurstSettings({ burstBlockSeconds: 10 }, "test:crawl-burst")).toMatchObject({ ok: false, issues: ["runtime_settings_invalid:publicApi.burstBlockSeconds"] });
    // 0 = 끔
    expect((await saveCrawlBurstSettings({ burstLimit: 0, detailBurstLimit: 0 }, "test:crawl-burst")).ok).toBe(true);
    setCrawlBurstStoreForTest(null);
    for (let i = 0; i < 20; i += 1) expect((await page("/", OTHER)).status).not.toBe(429);
    expect(await row(OTHER)).toBeUndefined();
  });

  it("수동 해제는 그 IP 행을 지우고 operations_audit 에 crawl-burst-release 한 줄(주소 끝은 가림)", async () => {
    for (let i = 0; i <= LIMIT; i += 1) await page("/");
    expect((await page("/")).status).toBe(429);
    const floor = await auditFloor();
    const result = await releaseCrawlBurst(IP, "test:crawl-burst");
    expect(result).toMatchObject({ released: true, target: "crawl_burst:198.51.100.x" });
    const [audit] = await db.select().from(operationsAudit).where(eq(operationsAudit.id, result.auditId));
    expect(audit).toMatchObject({ action: CRAWL_BURST_RELEASE_ACTION, target: "crawl_burst:198.51.100.x", ok: true });
    expect(audit.id).toBeGreaterThan(floor);
    expect(JSON.stringify(audit.detail)).not.toContain(IP);
    expect((await page("/")).status).not.toBe(429);
    await expect(releaseCrawlBurst("not-an-ip", "test:crawl-burst")).rejects.toThrow("ip_required");
  });
});


describe("상세 세 API 실제 경로와 DB 키", () => {
  async function detail(n: number) {
    const route = ["details", "readme", "timeline"][n % 3];
    const request = new Request(`https://nomorevibe.com/api/products/missing-${n}/${route}`, { headers: { "user-agent": BROWSER, "x-forwarded-for": IP } });
    const context = { params: Promise.resolve({ slug: `missing-${n}` }) };
    if (route === "details") return (await import("@/app/api/products/[slug]/details/route")).GET(request, context);
    if (route === "readme") return (await import("@/app/api/products/[slug]/readme/route")).GET(request, context);
    return (await import("@/app/api/products/[slug]/timeline/route")).GET(request, context);
  }
  it("61번째 상세만 429, 최소 스킬 응답은 상세 키를 세지 않음; 공통 300 키도 유지", async () => {
    expect((await saveCrawlBurstSettings({ detailBurstLimit: 0 }, "test:detail-limits")).ok).toBe(true);
    setCrawlBurstStoreForTest(null);
    for (let i = 0; i < 60; i++) expect((await detail(i)).status).toBe(404);
    const minimum = await import("@/app/api/products/[slug]/route");
    expect((await minimum.GET(new Request("https://nomorevibe.com/api/products/missing-skill", { headers: { "user-agent": "nomorevibe-skill/1", "x-forwarded-for": IP } }), { params: Promise.resolve({ slug: "missing-skill" }) })).status).toBe(404);
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, detailReadKey(IP))))[0].count).toBe(60);
    const limited = await detail(60);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(590);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await db.select().from(rateLimits).where(eq(rateLimits.key, `api-read:${IP}`)))[0].count).toBe(62);
    await db.update(rateLimits).set({ count: 300 }).where(eq(rateLimits.key, `api-read:${IP}`));
    expect((await api("/api/products/x/reactions"))?.status).toBe(429);
  });
  it("20번째에 공유 burst 키를 30분 막고 release는 상세 두 창도 함께 지움", async () => {
    for (let i = 0; i < 19; i++) expect((await detail(i)).status).toBe(404);
    expect((await detail(19)).status).toBe(429);
    expect((await row()).count).toBe(RATE_LIMIT_BLOCKED_COUNT);
    expect((await row()).resetAt.getTime() - Date.now()).toBeGreaterThan(1_795_000);
    expect((await page("/p/missing" )).status).toBe(429);
    expect((await api("/api/products/x/reactions"))?.status).toBe(429);
    expect((await crawlBurstStatus()).settings).toMatchObject(DETAIL_API_DEFAULTS);
    await releaseCrawlBurst(IP, "test:detail-limits");
    for (const key of [crawlBurstKey(IP), detailReadKey(IP), detailBurstKey(IP)]) expect(await db.select().from(rateLimits).where(eq(rateLimits.key, key))).toEqual([]);
    expect((await detail(20)).status).toBe(404);
  });
  it("설정 저장·status에서 상세 값 확인, 공통 기준은 그대로", async () => {
    expect((await saveCrawlBurstSettings({ detailReadLimit: 2, detailReadWindowSeconds: 60, detailBurstLimit: 0, detailBurstWindowSeconds: 3 }, "test:detail-limits")).ok).toBe(true);
    setCrawlBurstStoreForTest(null);
    expect((await crawlBurstStatus()).settings).toMatchObject({ ...CRAWL_BURST_DEFAULTS, detailReadLimit: 2, detailReadWindowSeconds: 60, detailBurstLimit: 0, detailBurstWindowSeconds: 3 });
    expect((await detail(0)).status).toBe(404);
    expect((await detail(1)).status).toBe(404);
    expect((await detail(2)).status).toBe(429);
  });
});


it("실제 CLI set detail·status: 시험 DB에서 저장·조회하고 공통 값은 유지", () => {
  const cli = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "scripts/crawl-burst.ts", ...args], {
    env: { PATH: process.env.PATH, DATABASE_URL: TEST_DATABASE_URL, LOG_LEVEL: "error", NODE_ENV: "test" }, timeout: 15_000, encoding: "utf8",
  }));
  expect(cli("set", "detail", "0", "600", "0", "10", "test:cli-detail")).toMatchObject({ detailReadLimit: 0, detailBurstLimit: 0 });
  expect(cli("status").settings).toEqual({ ...CRAWL_BURST_DEFAULTS, ...DETAIL_API_DEFAULTS, detailReadLimit: 0, detailBurstLimit: 0 });
});
