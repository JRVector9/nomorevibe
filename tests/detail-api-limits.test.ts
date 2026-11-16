import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { guardPublicApiRead } from "@/lib/http/anti-scrape";
import { guardCrawlBurst, setCrawlBurstStoreForTest } from "@/lib/http/crawl-burst";
import { CRAWL_BURST_DEFAULTS, DETAIL_API_DEFAULTS, crawlBurstKey, detailBurstKey, detailReadKey } from "@/lib/http/crawl-burst-policy";
import { setSearchBotResolverForTest } from "@/lib/http/search-bot-verify";
import { RATE_LIMIT_BLOCKED_COUNT } from "@/lib/rate-limit";
import { logger } from "@/lib/observability/logger";
import { resolveRuntimeSettings } from "@/lib/operations/runtime-settings-schema";

const IP = "198.51.100.75";
const UA = "Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36";
const routes = ["details", "readme", "timeline"];
const req = (ip = IP, ua = UA, path = "/api/products/x/details") => new NextRequest(`https://nomorevibe.com${path}`, { headers: { "user-agent": ua, "x-forwarded-for": ip } });
function memory() {
  const settings = { ...CRAWL_BURST_DEFAULTS, ...DETAIL_API_DEFAULTS };
  const rows = new Map<string, { count: number; until: number }>();
  let now = Date.now();
  return { settings, rows, advance: (ms: number) => { now += ms; }, store: {
    settings: vi.fn(async () => settings),
    hit: vi.fn(async (key: string, limit: number, ms: number) => {
      let row = rows.get(key);
      if (!row || row.until < now) { row = { count: 0, until: now + ms }; rows.set(key, row); }
      if (row.count < RATE_LIMIT_BLOCKED_COUNT) row.count++;
      return { count: row.count, allowed: row.count <= limit, retryAfterSeconds: Math.max(1, Math.ceil((row.until - now) / 1000)) };
    }),
    block: vi.fn(async (key: string, ms: number) => { rows.set(key, { count: RATE_LIMIT_BLOCKED_COUNT, until: now + ms }); }),
  } };
}
let mem: ReturnType<typeof memory>;
const call = (n: number, ip = IP, ua = UA) => guardPublicApiRead(req(ip, ua, `/api/products/app-${n}/${routes[n % 3]}`), `products.${routes[n % 3]}`);
beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  vi.stubEnv("LOG_LEVEL", "error");
  mem = memory(); setCrawlBurstStoreForTest(mem.store);
  setSearchBotResolverForTest({ reverse: async () => [], lookup: async () => [] });
});
afterEach(() => { vi.unstubAllEnvs(); setCrawlBurstStoreForTest(null); setSearchBotResolverForTest(null); });

describe("상세 IP 합산 한도", () => {
  it("세 경로·여러 slug를 한 통에 합산: 60번 허용, 61번째 429; 스킬 최소 경로는 안 센다", async () => {
    mem.settings.detailBurstLimit = 0;
    for (let i = 0; i < 60; i++) expect(await call(i)).toBeNull();
    expect(await guardPublicApiRead(req(), "products.get")).toBeNull();
    expect(mem.rows.get(detailReadKey(IP))?.count).toBe(60);
    const response = await call(60);
    expect(response?.status).toBe(429);
    expect(response?.headers.get("retry-after")).toBe("600");
    expect(await response?.json()).toEqual({ error: "rate_limited" });
    mem.advance(600_001);
    expect(await call(61)).toBeNull();
  });

  it("19번 허용·20번째 차단, 같은 burst:<ip> 키로 화면과 다른 API도 30분 차단", async () => {
    for (let i = 0; i < 19; i++) expect(await call(i)).toBeNull();
    expect(mem.rows.get(detailBurstKey(IP))?.count).toBe(19);
    const blocked = await call(19);
    expect(blocked?.status).toBe(429);
    expect(blocked?.headers.get("retry-after")).toBe("1800");
    expect(await blocked?.json()).toMatchObject({ error: "crawling_prohibited" });
    expect(mem.store.block).toHaveBeenCalledWith(crawlBurstKey(IP), 1_800_000);
    expect(mem.rows.get(crawlBurstKey(IP))?.count).toBe(RATE_LIMIT_BLOCKED_COUNT);
    expect((await guardCrawlBurst(req(IP, UA, "/p/x"), "page", "page"))?.status).toBe(429);
    expect((await guardPublicApiRead(req(), "products.reactions"))?.status).toBe(429);
    expect(await call(20, "198.51.100.76")).toBeNull();
    mem.advance(1_800_001);
    expect(await call(21)).toBeNull();
  });

  it("10초 창이 지나면 다시 센다; 설정값을 적용하고 각 limit 0이면 그 한도만 끈다", async () => {
    Object.assign(mem.settings, { detailBurstLimit: 3, detailBurstWindowSeconds: 2, detailReadLimit: 0 });
    for (let i = 0; i < 2; i++) expect(await call(i)).toBeNull();
    mem.advance(2_001);
    expect(await call(2)).toBeNull();
    expect(mem.rows.has(detailReadKey(IP))).toBe(false);
    mem.settings.detailBurstLimit = 0;
    mem.store.hit.mockClear();
    for (let i = 0; i < 30; i++) expect(await call(i)).toBeNull();
    expect(mem.store.hit.mock.calls.every(([key]) => key === crawlBurstKey(IP))).toBe(true);
  });

  it("공통 burst를 꺼도 상세 차단은 다른 화면에 유지된다", async () => {
    mem.settings.burstLimit = 0;
    for (let i = 0; i < 20; i++) await call(i);
    expect((await guardCrawlBurst(req(), "page", "page"))?.status).toBe(429);
  });

  it("역방향·정방향 DNS로 확인된 검색 봇만 두 상세 한도를 면제한다", async () => {
    setSearchBotResolverForTest({ reverse: async () => ["crawl.googlebot.com"], lookup: async () => [IP] });
    for (let i = 0; i < 65; i++) expect(await call(i, IP, "Googlebot/2.1")).toBeNull();
    expect(mem.store.block).not.toHaveBeenCalled();
    setSearchBotResolverForTest({ reverse: async () => [], lookup: async () => [] });
    expect((await call(66, IP, "Googlebot/2.1"))?.status).toBe(429);
  });

  it.each(["settings", "hit", "block"] as const)("IP 없음·DB %s 오류에는 통과한다", async (operation) => {
    for (let i = 0; i < 65; i++) expect(await call(i, "127.0.0.1")).toBeNull();
    expect(mem.store.hit).not.toHaveBeenCalled();
    if (operation === "block") for (let i = 0; i < 19; i++) await call(i);
    mem.store[operation].mockRejectedValue(new Error("DB query failed (sensitive IP)"));
    expect(await call(66)).toBeNull();
  });

  it("설정 기본값·0·잘못된 범위 검증", () => {
    expect(resolveRuntimeSettings({}).settings.publicApi).toMatchObject(DETAIL_API_DEFAULTS);
    expect(resolveRuntimeSettings({ publicApi: { detailReadLimit: 0, detailBurstLimit: 0 } }).issues).toEqual([]);
    const bad = resolveRuntimeSettings({ publicApi: { detailReadLimit: -1, detailReadWindowSeconds: 0, detailBurstLimit: 2.5, detailBurstWindowSeconds: 601 } });
    expect(bad.issues).toHaveLength(4);
    expect(bad.settings.publicApi).toMatchObject(DETAIL_API_DEFAULTS);
  });
});


it("차단 첫 초과만 anti_scrape 한 줄, IP·DB 쿼리 오류는 기록하지 않는다", async () => {
  const info = vi.spyOn(logger, "info");
  const warn = vi.spyOn(logger, "warn");
  try {
    for (let i = 0; i < 25; i++) await call(i);
    const blocks = info.mock.calls.filter(([event]) => event === "anti_scrape.detail_burst_blocked");
    expect(blocks).toHaveLength(1);
    expect(JSON.stringify(blocks)).not.toContain(IP);
    mem.store.settings.mockRejectedValue(new Error(`query contains ${IP}`));
    await call(26);
    expect(warn).toHaveBeenCalledWith("anti_scrape.burst_unavailable", { route: "products.timeline" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(IP);
  } finally { info.mockRestore(); warn.mockRestore(); }
});
