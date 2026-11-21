import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import type { SeasonSummary } from "@/lib/domain/ranking/view";

/**
 * 카드 API 의 목록들(/api/product-cards?list=home·active·rising-page·new-page, 2026-11-15 공개 HTML 이름·요약만) — 서버 HTML 에 없는
 * 첫 쪽 뒤 카드·활발한 목록의 채울 값을 화면 JS 가 받는다. 화면과 같은 읽기·같은 조건으로 잘라 주는지, 카드가 그리는 칸만 주는지,
 * 공개 쪽 제한을 화면과 같게 지키는지 본다. 관문(403·429·no-store)은 tests/public-html-payload-api.test.ts 가 본다.
 * DB 는 부르지 않는다 — 한도 표와 목록 읽기만 바꿔 끼운다.
 */
const mocks = vi.hoisted(() => ({
  rateLimitWindow: vi.fn(),
  getPublicList: vi.fn(),
  getUnclaimedList: vi.fn(),
  getNewThisWeek: vi.fn(),
  countNewThisWeek: vi.fn(),
  countProducts: vi.fn(),
  getCurrentSeason: vi.fn(),
  getSeasonRanking: vi.fn(),
  getStarGrowthPage: vi.fn(),
  getHomePulse: vi.fn(),
}));
vi.mock("@/lib/rate-limit", async (original) => ({
  ...await original<typeof import("@/lib/rate-limit")>(),
  rateLimitWindow: mocks.rateLimitWindow,
}));
vi.mock("@/lib/domain/products/view", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/view")>(),
  getPublicList: mocks.getPublicList,
  getUnclaimedList: mocks.getUnclaimedList,
  getNewThisWeek: mocks.getNewThisWeek,
  countNewThisWeek: mocks.countNewThisWeek,
}));
vi.mock("@/lib/domain/products/repository", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/repository")>(),
  countProducts: mocks.countProducts,
}));
vi.mock("@/lib/domain/ranking/view", async (original) => ({
  ...await original<typeof import("@/lib/domain/ranking/view")>(),
  getCurrentSeason: mocks.getCurrentSeason,
  getSeasonRanking: mocks.getSeasonRanking,
}));
vi.mock("@/lib/domain/products/star-growth", () => ({ getStarGrowthPage: mocks.getStarGrowthPage }));
vi.mock("@/lib/domain/products/home-pulse", async (original) => ({
  ...await original<typeof import("@/lib/domain/products/home-pulse")>(),
  getHomePulse: mocks.getHomePulse,
}));
vi.mock("@/lib/crawl/settings", () => ({ getSettings: vi.fn().mockResolvedValue({ agentEvidence: { displayObservedFacts: true } }) }));

const cardsModule = await import("@/app/api/product-cards/route");
/** 경로 매개변수가 없는 route — withRoute 의 둘째 인자는 빈 params */
const GET = (query: string) => {
  const headers = new Headers({ "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "x-forwarded-for": "198.51.100.23" });
  return cardsModule.GET(new Request(`https://nomorevibe.test/api/product-cards?${query}`, { headers }), { params: Promise.resolve({}) } as never);
};
const items = async (query: string) => {
  const response = await GET(query);
  expect(response.status, query).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const text = await response.text();
  // 카드가 그리는 칸만 — 저장소 주소·메이커·내부 id·상태는 없다
  for (const key of ['"repoUrl":', '"makerName":', '"status":', '"unclaimed":', '"builderClaim":', '"stack":']) expect(text, query).not.toContain(key);
  expect(text).not.toMatch(/"id":\d/);
  return (JSON.parse(text) as { items: Record<string, unknown>[] }).items;
};

const row = (slug: string) => ({
  id: 7, slug, name: slug.toUpperCase(), tagline: `${slug} tool`, taglineSource: "maker", taglineKo: null, category: "Dev", accessMode: "website",
  builder: "x", builderClaim: "guessed", stack: ["Go"], ogImage: null, makerName: "m", repoUrl: `https://github.com/acme/${slug}`, repoRenamedTo: null,
  listedAt: new Date("2026-11-01T00:00:00Z"), status: "seeded", unclaimed: true, stars: 10, starsAt: null, starsPrevious: null, starsPreviousAt: null, aiLevel: 2,
});
const rows = (count: number, offset = 0) => Array.from({ length: count }, (_, index) => row(`p-${offset + index + 1}`));

const season: SeasonSummary = {
  key: "2026-W46", cadence: "weekly", startsAt: new Date("2026-11-08T15:00:00Z"), endsAt: new Date("2026-11-15T15:00:00Z"), isTransition: false,
  effectiveLaunchWindowDays: 28, policy: DEFAULT_RANKING_POLICY, refreshedAt: new Date("2026-11-14T00:00:00Z"), state: "active",
};

beforeEach(() => {
  vi.stubEnv("TRUSTED_PROXY_HOPS", "1");
  vi.stubEnv("TRUST_CF_CONNECTING_IP", "0");
  vi.stubEnv("PUBLIC_LIST_MAX_PAGES", "100");
  mocks.rateLimitWindow.mockReset().mockResolvedValue({ allowed: true, count: 1, retryAfterSeconds: 600 });
  mocks.getPublicList.mockReset().mockImplementation(async (limit: number, options: { offset?: number } = {}) => rows(limit, options.offset ?? 0));
  mocks.getUnclaimedList.mockReset().mockImplementation(async (limit: number, options: { offset?: number } = {}) => rows(limit, options.offset ?? 0));
  mocks.countProducts.mockReset().mockResolvedValue(30);
  mocks.getCurrentSeason.mockReset().mockResolvedValue(season);
  mocks.getSeasonRanking.mockReset().mockResolvedValue({ items: rows(30) });
  mocks.getStarGrowthPage.mockReset().mockImplementation(async (options: { page?: string; pageSize: number }) => {
    const page = Number(options.page ?? 1);
    return { items: rows(3, (page - 1) * options.pageSize), page, pageSize: options.pageSize, pages: 4, total: 50, offset: 0 };
  });
  mocks.countNewThisWeek.mockReset().mockResolvedValue(40);
  mocks.getNewThisWeek.mockReset().mockImplementation(async (limit: number, _start: unknown, _end: unknown, offset = 0) => rows(Math.min(limit, 40 - offset), offset));
  mocks.getHomePulse.mockReset().mockResolvedValue({
    active: Array.from({ length: 7 }, (_, index) => ({ slug: `a-${index}`, name: `Active ${index}`, category: "Dev", releases: 70 - index, stars: 1_000 + index, ogImage: null })),
  });
});

describe("list=home — 홈·분야 더 보기(?shown=)의 첫 쪽 뒤 카드", () => {
  it("화면과 같은 목록(기본 AI 탭)을 같은 구간으로 읽어 이름까지 준다", async () => {
    const list = await items("list=home&offset=9&limit=9&locale=ko");
    expect(list.map((item) => item.slug)).toEqual(rows(9, 9).map((item) => item.slug));
    expect(list[0]).toMatchObject({ slug: "p-10", name: "P-10", owner: { login: "acme", profileUrl: "https://github.com/acme" } });
    expect(mocks.getPublicList).toHaveBeenCalledWith(9, expect.objectContaining({ sort: "recent", aiLevels: [1, 2, 3], offset: 9 }));
  });

  it("정렬·분야·도구 거르기를 화면처럼 다시 정하고, 검색어(?q=)는 받지 않는다", async () => {
    await items("list=home&sort=all-time&category=dev&observedTool=Codex&q=secret&offset=9&limit=9");
    expect(mocks.getPublicList).toHaveBeenCalledWith(9, expect.objectContaining({ sort: "stars", category: "Dev", observedTool: "Codex", query: [], aiLevels: undefined, offset: 9 }));
  });

  it("주인을 기다리는 목록(section=unclaimed)은 그 목록의 같은 구간", async () => {
    await items("list=home&sort=trending&offset=9&limit=5&section=unclaimed");
    expect(mocks.getUnclaimedList).toHaveBeenCalledWith(5, expect.objectContaining({ offset: 9 }));
    expect(mocks.getPublicList).not.toHaveBeenCalled();
  });

  it("순위 목록은 화면처럼 검증 수만큼 한 번에 읽고 구간을 자른다", async () => {
    const list = await items("list=home&sort=trending&offset=9&limit=9");
    expect(list.map((item) => item.slug)).toEqual(rows(9, 9).map((item) => item.slug));
    expect(mocks.getSeasonRanking).toHaveBeenCalledWith(expect.objectContaining({ seasonKey: season.key, limit: 30, order: "trending" }));
  });

  it("구간 모양이 틀렸거나 한 번에 화면 창(198)을 넘기거나 공개 쪽 제한을 넘으면 400 — 읽지 않는다", async () => {
    for (const query of ["offset=-1&limit=9", "offset=abc&limit=9", "offset=9&limit=0", "offset=9&limit=199", "offset=9", "offset=900&limit=9"]) {
      const response = await GET(`list=home&${query}`);
      expect(response.status, query).toBe(400);
    }
    expect(mocks.getPublicList).not.toHaveBeenCalled();
  });
});

describe("list=active — 홈 '이번 주 가장 활발한' 다섯의 채울 값", () => {
  it("다섯까지, 아이콘·분야·스타·새 버전 수만 — 이름은 서버 HTML 에 있으므로 주지 않는다", async () => {
    const response = await GET("list=active");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { items: list } = await response.json();
    expect(list).toHaveLength(5);
    expect(list[0]).toEqual({ slug: "a-0", category: "Dev", stars: 1_000, ogImage: null, releases: 70 });
    expect(JSON.stringify(list)).not.toContain("Active");
  });
});

describe("list=rising-page — /rising 한 쪽", () => {
  it("그 쪽 회차 목록에 쪽 안 순위를 붙인다 — 쪽·회차 값을 그대로 넘긴다", async () => {
    const list = await items("list=rising-page&page=2&cycle=2026-11-15T07:00:00.000Z&locale=ko");
    expect(list.map((item) => [item.slug, item.rank])).toEqual([["p-16", 16], ["p-17", 17], ["p-18", 18]]);
    expect(mocks.getStarGrowthPage).toHaveBeenCalledWith({ pageSize: 15, page: "2", cycle: "2026-11-15T07:00:00.000Z" });
  });

  it("공개 쪽 제한을 넘거나 모양이 틀린 쪽은 400", async () => {
    for (const page of ["abc", "0", "101"]) expect((await GET(`list=rising-page&page=${page}`)).status, page).toBe(400);
    expect(mocks.getStarGrowthPage).not.toHaveBeenCalled();
  });
});

describe("list=new-page — /?new=1 한 쪽", () => {
  it("이번 주 새로 나온 목록을 15개씩, 쪽 위치에서 읽는다", async () => {
    const list = await items("list=new-page&page=2&locale=ko");
    expect(list.map((item) => item.slug)).toEqual(rows(15, 15).map((item) => item.slug));
    expect(mocks.getNewThisWeek).toHaveBeenCalledWith(15, expect.any(Date), expect.any(Date), 15);
  });

  it("없는 쪽은 화면처럼 첫 쪽, 공개 쪽 제한을 넘거나 모양이 틀린 쪽은 400", async () => {
    expect((await items("list=new-page&page=9")).map((item) => item.slug)[0]).toBe("p-1");
    expect(mocks.getNewThisWeek).toHaveBeenLastCalledWith(15, expect.any(Date), expect.any(Date), 0);
    mocks.getNewThisWeek.mockClear();
    for (const page of ["abc", "101"]) expect((await GET(`list=new-page&page=${page}`)).status, page).toBe(400);
    expect(mocks.getNewThisWeek).not.toHaveBeenCalled();
  });
});
