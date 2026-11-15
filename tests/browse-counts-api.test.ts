import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import type { SeasonSummary } from "@/lib/domain/ranking/view";

/**
 * 공개 수·분야별 수·AI 수 API(/api/browse-counts, 2026-11-15 공개 HTML 이름·요약만) — 서버 HTML 에서 뺀 수를 화면 JS 가 받는다.
 * 홈·/popular 화면과 같은 읽기·같은 조건으로 세는지, 공개 API 읽기 관문을 거치는지, 엣지·브라우저에 담지 않는지 본다.
 * DB 는 부르지 않는다 — 한도 표와 수 읽기만 바꿔 끼운다.
 */
const mocks = vi.hoisted(() => ({
  rateLimitWindow: vi.fn(),
  aiLevelCounts: vi.fn(),
  categoryCounts: vi.fn(),
  countProducts: vi.fn(),
  getHomePulse: vi.fn(),
  getPopularPage: vi.fn(),
  getPopularFacets: vi.fn(),
  getCurrentSeason: vi.fn(),
  getSeasonRanking: vi.fn(),
  getPublicList: vi.fn(),
}));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...await original<typeof import("@/lib/rate-limit")>(),
  rateLimitWindow: mocks.rateLimitWindow,
}));
vi.mock("@/lib/domain/products/repository", () => ({
  aiLevelCounts: mocks.aiLevelCounts, categoryCounts: mocks.categoryCounts, countProducts: mocks.countProducts, RISING_MAX_STARS: 2000,
}));
vi.mock("@/lib/domain/products/home-pulse", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/home-pulse")>(),
  getHomePulse: mocks.getHomePulse,
}));
vi.mock("@/lib/domain/products/popular", () => ({ getPopularPage: mocks.getPopularPage, getPopularFacets: mocks.getPopularFacets }));
vi.mock("@/lib/domain/ranking/view", () => ({ getCurrentSeason: mocks.getCurrentSeason, getSeasonRanking: mocks.getSeasonRanking }));
vi.mock("@/lib/domain/products/view", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/view")>(),
  getPublicList: mocks.getPublicList,
  getUnclaimedList: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: vi.fn().mockResolvedValue({ agentEvidence: { displayObservedFacts: true } }) }));

const countsModule = await import("@/app/api/browse-counts/route");
/** 경로 매개변수가 없는 route — withRoute 의 둘째 인자는 빈 params */
const GET = (req: Request) => countsModule.GET(req, { params: Promise.resolve({}) } as never);

const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
function request(query = "", init: { ua?: string; headers?: Record<string, string> } = {}) {
  const headers = new Headers(init.headers);
  headers.set("user-agent", init.ua ?? BROWSER);
  headers.set("x-forwarded-for", "198.51.100.23");
  return new Request(`https://nomorevibe.test/api/browse-counts${query ? `?${query}` : ""}`, { headers });
}

const season: SeasonSummary = {
  key: "2026-W46", cadence: "weekly", startsAt: new Date("2026-11-08T15:00:00Z"), endsAt: new Date("2026-11-15T15:00:00Z"), isTransition: false,
  effectiveLaunchWindowDays: 28, policy: DEFAULT_RANKING_POLICY, refreshedAt: new Date("2026-11-14T00:00:00Z"), state: "active",
};

beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  vi.stubEnv("TRUST_CF_CONNECTING_IP", "0");
  vi.stubEnv("PUBLIC_LIST_MAX_PAGES", "100");
  mocks.rateLimitWindow.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 600 });
  // 첫째 부름은 공개 전체(알약 차례·공개 수), 둘째는 지금 목록 자격의 분야별 수
  mocks.categoryCounts.mockReset().mockImplementation(async (options: { aiLevels?: unknown; slugs?: unknown }) =>
    options.aiLevels || options.slugs ? { Dev: 7, Data: 2 } : { Dev: 100, Data: 20, Finance: 3 });
  mocks.countProducts.mockReset().mockImplementation(async (options: { statuses: string[] }) => options.statuses.length === 1 ? 30 : 9);
  mocks.aiLevelCounts.mockReset().mockResolvedValue([{ category: "Dev", level: 1, count: 4 }, { category: "Data", level: 1, count: 1 }, { category: "Dev", level: 3, count: 2 }]);
  mocks.getHomePulse.mockReset().mockResolvedValue({ categories: [{ key: "Dev", total: 100, born: 5 }] });
  mocks.getPopularPage.mockReset().mockImplementation(async (_tier: string, _filters: unknown, _sort: string, page = 1) =>
    ({ items: [{ slug: "secret-slug", name: "Secret" }], total: 37, totals: [37, 4, 1, 0], page, pages: 3, pageSize: 15 }));
  mocks.getPopularFacets.mockReset().mockResolvedValue({ categories: [{ category: "Dev", count: 30 }], all: 37, ai: 20, personal: 11 });
  mocks.getCurrentSeason.mockReset().mockResolvedValue(season);
  mocks.getSeasonRanking.mockReset().mockResolvedValue({ items: [{ slug: "ranked-a" }, { slug: "ranked-b" }] });
  mocks.getPublicList.mockReset().mockResolvedValue([]);
});

describe("/api/browse-counts — 공개 API 읽기 관문", () => {
  it.each(["", "part=method", "part=popular&tier=rising"])("%s: 수집 도구·학습 봇·다른 사이트 요청은 403, 한도를 넘으면 429 — 수를 읽지 않는다", async (query) => {
    for (const ua of ["curl/8.7.1", "python-requests/2.32.3", "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"]) {
      expect((await GET(request(query, { ua }))).status).toBe(403);
    }
    expect((await GET(request(query, { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
    mocks.rateLimitWindow.mockResolvedValue({ allowed: false, count: 301, retryAfterSeconds: 120 });
    const limited = await GET(request(query));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("120");
    for (const read of [mocks.categoryCounts, mocks.countProducts, mocks.aiLevelCounts, mocks.getHomePulse, mocks.getPopularPage, mocks.getPopularFacets])
      expect(read).not.toHaveBeenCalled();
  });

  it.each(["", "part=method", "part=popular&tier=rising"])("%s: 엣지·브라우저에 담지 않는다", async (query) => {
    const response = await GET(request(query, { headers: { "sec-fetch-site": "same-origin" } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store");
  });
});

describe("/api/browse-counts — 기본(홈·분야 화면의 수)", () => {
  it("공개 수는 공개 전체의 합, 알약 수는 지금 목록 자격(기본 AI 탭)에서 분야를 뺀 수, 결과 수는 지금 목록의 수", async () => {
    const body = await (await GET(request())).json();
    expect(body).toEqual({ total: 123, counts: { Dev: 7, Data: 2 }, resultCount: 9 });
    expect(mocks.categoryCounts).toHaveBeenCalledWith({ statuses: ["verified", "seeded"], excludeDown: true });
    expect(mocks.categoryCounts).toHaveBeenCalledWith(expect.objectContaining({ statuses: ["verified", "seeded"], aiLevels: [1, 2, 3], category: undefined, excludeDown: true }));
    expect(mocks.countProducts).toHaveBeenCalledWith(expect.objectContaining({ statuses: ["verified", "seeded"], aiLevels: [1, 2, 3], repoChecked: undefined, excludeDown: true }));
    // 홈 화면과 같은 읽기 — 순위 시즌은 읽지 않는다
    expect(mocks.getCurrentSeason).not.toHaveBeenCalled();
  });

  it("분야·정렬 조건을 화면과 같게 — 결과 수는 그 분야, 알약 수는 분야를 뺀 같은 자격", async () => {
    await GET(request("sort=recent&category=Dev"));
    expect(mocks.countProducts).toHaveBeenCalledWith(expect.objectContaining({ category: "Dev", aiLevels: undefined, repoChecked: true }));
    expect(mocks.categoryCounts).toHaveBeenCalledWith(expect.objectContaining({ category: undefined, repoChecked: true }));
    mocks.countProducts.mockClear();
    await GET(request("sort=open"));
    expect(mocks.countProducts).toHaveBeenCalledWith(expect.objectContaining({ hasRepository: true, repoChecked: true }));
  });

  it("순위 탭은 검증 수만큼의 순위 목록으로 센다 — 알약 수도 그 순위 안에서", async () => {
    const body = await (await GET(request("sort=trending"))).json();
    expect(body.resultCount).toBe(2);
    expect(mocks.getSeasonRanking).toHaveBeenCalledWith(expect.objectContaining({ seasonKey: season.key, limit: 30, order: "trending" }));
    expect(mocks.categoryCounts).toHaveBeenCalledWith(expect.objectContaining({ statuses: ["verified"], slugs: ["ranked-a", "ranked-b"] }));
  });
});

describe("/api/browse-counts — part=method(집계 기준 창)", () => {
  it("AI 근거 단계별 전체 수와 분야별 공개 수", async () => {
    const body = await (await GET(request("part=method"))).json();
    expect(body).toEqual({ aiLevels: { 1: 5, 2: 0, 3: 2 }, categories: [{ key: "Dev", total: 100, born: 5 }] });
    expect(mocks.categoryCounts).not.toHaveBeenCalled();
  });

  it("못 읽은 수는 없음으로 — 창은 기준만 보인다", async () => {
    mocks.aiLevelCounts.mockRejectedValue(new Error("db"));
    mocks.getHomePulse.mockRejectedValue(new Error("db"));
    const response = await GET(request("part=method"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ aiLevels: null, categories: [] });
  });
});

describe("/api/browse-counts — part=popular(/popular 의 수)", () => {
  it("구간별 수·지금 목록 수·알약 수만 — 목록 줄(제품)은 돌려주지 않는다", async () => {
    const response = await GET(request("part=popular&tier=rising&personal=1&ai=made&category=dev&sort=rising&page=2"));
    const text = await response.text();
    expect(text).not.toContain("secret-slug");
    expect(JSON.parse(text)).toEqual({ totals: [37, 4, 1, 0], total: 37, facets: { categories: [{ category: "Dev", count: 30 }], all: 37, ai: 20, personal: 11 } });
    // /popular 화면과 같은 읽기
    expect(mocks.getPopularPage).toHaveBeenCalledWith("rising", { personal: true, ai: true, category: "Dev" }, "rising", 2);
    expect(mocks.getPopularFacets).toHaveBeenCalledWith("rising", { personal: true, ai: true, category: "Dev" });
  });

  it("알약 수를 못 읽어도 구간 수는 준다, 공개 쪽 제한을 넘거나 모양이 틀린 쪽은 400", async () => {
    mocks.getPopularFacets.mockRejectedValue(new Error("timeout"));
    expect(await (await GET(request("part=popular&tier=rising"))).json()).toEqual({ totals: [37, 4, 1, 0], total: 37, facets: null });
    mocks.getPopularPage.mockClear();
    for (const page of ["abc", "100000"]) {
      const response = await GET(request(`part=popular&tier=rising&page=${page}`));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.getPopularPage).not.toHaveBeenCalled();
  });
});
