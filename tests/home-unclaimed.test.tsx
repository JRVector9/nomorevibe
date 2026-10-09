import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 검색 기록은 응답 뒤에 적는다(next/server after). 여기는 요청 바깥이라 그 예약이 던진다 —
 * 삼켜 두고, 무엇이 적히는지는 통합 테스트(tests/integration/search-log.test.ts)가 본다.
 */
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  after: () => {},
}));
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import type { ProductListItem } from "@/lib/domain/products/view";
import type { RankingListItem, SeasonSummary } from "@/lib/domain/ranking/view";

const {
  categoryCounts,
  countProducts,
  getAllTimeRanking,
  getCurrentSeason,
  getSeasonRanking,
  getUnclaimedList,
  getVerifiedList,
  getPublicList,
  getHomePulse,
  getCrawlSettings,
  getPublicListBySlugs,
  searchRelevance,
  relevanceWindow,
  popularSearches,
} = vi.hoisted(() => ({
  popularSearches: vi.fn(),
  getPublicListBySlugs: vi.fn(),
  searchRelevance: vi.fn(),
  relevanceWindow: vi.fn(),
  categoryCounts: vi.fn(),
  countProducts: vi.fn(),
  getAllTimeRanking: vi.fn(),
  getCurrentSeason: vi.fn(),
  getSeasonRanking: vi.fn(),
  getUnclaimedList: vi.fn(),
  getVerifiedList: vi.fn(),
  getPublicList: vi.fn(),
  getHomePulse: vi.fn(),
  getCrawlSettings: vi.fn(),
}));

vi.mock("@/lib/crawl/settings", () => ({ getSettings: getCrawlSettings }));

// HomeContent starts these independent loads too; never reach a database from a unit test.
vi.mock("@/lib/news/repository", () => ({ listHomeNews: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/domain/products/popular", () => ({ getPopularGroups: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/domain/products/repository", () => ({ categoryCounts, countProducts, RISING_MAX_STARS: 2000 }));
// 0건 화면의 추천 검색어는 검색 기록(DB)에서 읽는다 — 화면 조합만 본다
vi.mock("@/lib/domain/products/search-log", () => ({ recordSearch: vi.fn(), popularSearches }));
// 검색어 해석은 DB 로 어간을 뽑고 넓힐지 센다 — 이 화면 테스트는 목록 조합만 보므로 친 그대로 넘긴다
vi.mock("@/lib/domain/products/search-translation", () => ({
  resolveSearchQuery: async (query?: string) => ({ queries: query ? [query] : [], translated: null }),
  normalizeQuery: (query: string) => query.trim().toLowerCase(),
}));
// 관련도순 검색(섞기·재정렬)은 모델 서버와 DB 를 부른다 — 화면 조합만 본다
vi.mock("@/lib/domain/products/relevance", () => ({ searchRelevance, relevanceWindow }));
vi.mock("@/lib/domain/products/view", () => ({
  getUnclaimedList,
  getVerifiedList,
  getPublicList,
  getPublicListBySlugs,
  getNewThisWeek: vi.fn().mockResolvedValue([]),
  NEW_THIS_WEEK_MIN_STARS: 50,
}));
vi.mock("@/lib/domain/products/home-pulse", async () => {
  const actual = await vi.importActual<typeof import("@/lib/domain/products/home-pulse")>(
    "@/lib/domain/products/home-pulse",
  );
  return { ...actual, getHomePulse };
});
vi.mock("@/lib/domain/ranking/view", () => ({
  getAllTimeRanking,
  getCurrentSeason,
  getSeasonRanking,
}));

import HomePage, { HomeContent, fallbackSort, generateMetadata, needsUnclaimedFill, searchSuggestions } from "@/app/page";

const season: SeasonSummary = {
  key: "2026-W34",
  cadence: "weekly",
  startsAt: new Date("2026-08-16T15:00:00.000Z"),
  endsAt: new Date("2026-08-23T15:00:00.000Z"),
  isTransition: false,
  effectiveLaunchWindowDays: 28,
  policy: DEFAULT_RANKING_POLICY,
  refreshedAt: new Date("2026-08-20T00:00:00.000Z"),
  state: "active",
};

function product(slug: string): ProductListItem {
  return {
    slug,
    name: slug,
    tagline: `${slug} 태그라인`,
    taglineSource: "maker" as const,
    category: "Dev",
    builder: null,
    builderClaim: "guessed",
    stack: [],
    ogImage: null,
    makerName: null,
    repoUrl: null,
    listedAt: new Date("2026-08-20T00:00:00.000Z"),
    status: "seeded",
    unclaimed: true,
  };
}

function ranked(slug: string, rank: number): RankingListItem {
  return {
    ...product(slug),
    status: "verified",
    unclaimed: false,
    builderClaim: "reported",
    rank,
    validClicks: 10,
    uniqueVisitors: 5,
    recentUniqueVisitors: 2,
    previousUniqueVisitors: 1,
    scoreMode: "valid_visits",
    changePercent: null,
    cooldownFactorBasisPoints: 10_000,
    previousRank: null,
  };
}

/** 목록 화면 — 페이지는 목록을 Suspense 로 흘려 보내므로(골격 먼저) 내용은 HomeContent 가 그린 것을 본다 */
async function render(
  params: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  return renderToStaticMarkup(await HomeContent({ params }));
}

/** 페이지 그대로 — 리다이렉트와 먼저 나가는 골격(Suspense fallback) */
async function renderPage(params: Record<string, string | string[] | undefined> = {}): Promise<string> {
  return renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve(params) }));
}

/** 분야 화면(/c/[category])처럼 — 분야는 주소 경로에서 정식 값으로 온다 */
const renderScreen = render;

beforeEach(() => {
  vi.clearAllMocks();
  getCrawlSettings.mockResolvedValue({ agentEvidence: { displayObservedFacts: true } });
  getCurrentSeason.mockResolvedValue(season);
  getUnclaimedList.mockResolvedValue([]);
  getVerifiedList.mockResolvedValue([]);
  getPublicList.mockResolvedValue([]);
  searchRelevance.mockResolvedValue({ head: [], total: 0, semantic: false, reranked: false, plan: [], translated: null });
  relevanceWindow.mockResolvedValue([]);
  getPublicListBySlugs.mockResolvedValue([]);
  getAllTimeRanking.mockResolvedValue([]);
  getSeasonRanking.mockResolvedValue({ season, items: [] });
  categoryCounts.mockResolvedValue({});
  countProducts.mockResolvedValue(0);
  popularSearches.mockResolvedValue([]);
  getHomePulse.mockResolvedValue({
    asOf: new Date("2026-09-08T00:00:00+09:00"),
    timezone: "Asia/Seoul",
    methodVersion: "2.0",
    born: { current: 0, previous: 0, change: null },
    updates: { projects: 0, releases: 0 },
    active: [],
    categories: [],
    tools: null,
    total: 0,
  });
});

/**
 * 미클레임 구획이 붙는 기준은 "검증된 제품이 몇 개 모였느냐"다.
 *
 * 목록 길이로 재면 안 된다 — 시즌 순위는 leaderboard.limit(기본 10)에서 잘리고 그 상한은
 * minimumProducts(기본 20) 이하로 강제되므로(policy.ts) 조건이 늘 참이 된다.
 */
describe("미클레임 구획을 붙이는 기준", () => {
  it("정책 기본값에서 순위 목록 길이로는 절대 빠지지 않는다", () => {
    const { limit } = DEFAULT_RANKING_POLICY.leaderboard;
    const { minimumProducts } = DEFAULT_RANKING_POLICY.eligibility;
    expect(limit).toBeLessThanOrEqual(minimumProducts);
    expect(needsUnclaimedFill(limit, minimumProducts)).toBe(true);

    expect(needsUnclaimedFill(minimumProducts - 1, minimumProducts)).toBe(true);
    expect(needsUnclaimedFill(minimumProducts, minimumProducts)).toBe(false);
  });

  it("검증 제품이 차오르면 순위가 10개로 잘려도 구획이 빠진다", async () => {
    const { limit } = DEFAULT_RANKING_POLICY.leaderboard;
    getSeasonRanking.mockResolvedValue({
      season,
      items: Array.from({ length: limit }, (_, index) => ranked(`ranked-${index}`, index + 1)),
    });
    countProducts.mockResolvedValue(25);

    const html = await render();

    expect(getUnclaimedList).not.toHaveBeenCalled();
    // 공개 목록은 첫 화면 급상승 띠 한 번뿐 — 피드는 순위로 채운다
    expect(getPublicList).toHaveBeenCalledTimes(1);
    expect(getPublicList).toHaveBeenCalledWith(5, { sort: "rising", rising: true });
    expect(html).toContain("ranked-0");
    expect(html).not.toContain("주인을 기다리는 프로젝트");
  });

  /**
   * 검증 제품이 0인 동안 기본 탭이 늘 "아직 순위에 오른 제품이 없습니다"였다(2026-10-02 운영, 공개 25,757건).
   * 그동안은 순위 대신 스타가 는 공개 목록을 보여준다 — 그 목록이 곧 미클레임 제품이라 구획을 따로 붙이지 않는다.
   */
  it("검증 제품이 모자라면 추천 탭은 순위 대신 스타가 는 목록을 보여주고 구획을 붙이지 않는다", async () => {
    getSeasonRanking.mockResolvedValue({ season, items: [ranked("verified-one", 1)] });
    // 스타가 는 제품 8개 — 앞 5개는 급상승 띠가 보여 주고 피드는 나머지 3개를 센다
    countProducts.mockResolvedValue(8);
    getPublicList.mockResolvedValue([product("rising-one")]);

    const html = await render();

    expect(getPublicList).toHaveBeenCalledWith(3, expect.objectContaining({ sort: "rising", rising: true, excludeDown: true }));
    expect(getSeasonRanking).not.toHaveBeenCalled();
    expect(getUnclaimedList).not.toHaveBeenCalled();
    expect(html).toContain("rising-one");
    expect(html).toContain("지금 뜨는 3개");
    // 순위가 서기 전 '추천' 탭은 스타가 는 목록이라 이름도 '지금 뜨는'(UX-35)
    expect(html).toMatch(/aria-selected="true"[^>]*>지금 뜨는</);
    expect(html).toContain('href="/?metric=rising"');
    expect(html).not.toContain("주인을 기다리는 프로젝트");
    expect(html).not.toContain("아직 순위에 오른 프로젝트가 없습니다");
  });

  it("관심 많은 순도 검증 제품이 모자라면 스타 많은 순 공개 목록으로 대신한다", async () => {
    countProducts.mockResolvedValue(5);
    getPublicList.mockResolvedValue([product("starred-one")]);

    const html = await render({ sort: "all-time" });

    // 목록은 화면 분량으로 받아 개수까지만 쓴다 — 개수를 기다리지 않고 함께 받는다(app/page.tsx)
    expect(getPublicList).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ sort: "stars" }));
    expect(getPublicList.mock.calls.find(([, options]) => options.sort === "stars")?.[1].rising).toBeUndefined();
    expect(getAllTimeRanking).not.toHaveBeenCalled();
    expect(html).toContain("starred-one");
    expect(html).toContain("스타 많은 순 5개");
  });

  it("스타가 는 제품이 하나도 없으면 순위가 아니라 스타 확인 이야기를 한다", async () => {
    const html = await render();

    expect(html).toContain("아직 스타 변화를 확인한 프로젝트가 없습니다");
    expect(html).not.toContain("아직 순위에 오른 프로젝트가 없습니다");
  });

  it("대체 목록은 검증 제품이 모자랄 때 추천·관심 많은 순에만 있다", () => {
    const { minimumProducts } = DEFAULT_RANKING_POLICY.eligibility;
    expect(fallbackSort("weekly", 0, minimumProducts)).toBe("rising");
    expect(fallbackSort("all-time", minimumProducts - 1, minimumProducts)).toBe("stars");
    expect(fallbackSort("recent", 0, minimumProducts)).toBeNull();
    expect(fallbackSort("trending", 0, minimumProducts)).toBeNull();
    expect(fallbackSort("weekly", minimumProducts, minimumProducts)).toBeNull();
  });

  it("필터가 걸려 목록이 비어도 전역 검증 수가 충분하면 붙이지 않는다", async () => {
    countProducts.mockResolvedValue(25);

    const html = await renderScreen({ category: "Finance" });

    expect(getUnclaimedList).not.toHaveBeenCalled();
    expect(html).toContain("조건에 맞는 프로젝트가 없습니다");
  });
});

/**
 * 아래에 제품이 나열되는데 위에서 "없습니다"라고 하면 화면이 스스로를 반박한다.
 * 커밋 cb64f25가 세운 불변식이다.
 */
describe("빈 화면 문구", () => {
  it("도구 흔적 필터는 목록·개수와 순위에 전달하고 첫 중복값만 쓰며 급상승 띠는 숨긴다", async () => {
    countProducts.mockResolvedValue(25);
    await render({ observedTool: ["Claude Code", "Codex"] });
    expect(getSeasonRanking).toHaveBeenCalledWith(expect.objectContaining({ observedTool: "Claude Code" }));
    expect(countProducts).toHaveBeenCalledWith(expect.objectContaining({ statuses: ["verified", "seeded"], observedTool: "Claude Code" }));
    expect(getPublicList).not.toHaveBeenCalled();

    await render({ sort: "recent", observedTool: "Codex" });
    expect(getPublicList).toHaveBeenCalledWith(9, expect.objectContaining({ observedTool: "Codex" }));
  });

  it("관찰 사실 공개가 꺼져 있으면 직접 입력한 흔적 필터도 적용하지 않는다", async () => {
    getCrawlSettings.mockResolvedValue({ agentEvidence: { displayObservedFacts: false } });
    countProducts.mockResolvedValue(25);
    const html = await render({ observedTool: "Codex", sort: "recent" });
    expect(getCrawlSettings).toHaveBeenCalledOnce();
    expect(getPublicList.mock.calls.every(([, options]) => options.observedTool === undefined)).toBe(true);
    expect(html).not.toContain("observedTool=");
  });
  it("중복 쿼리 값은 첫 값만 사용하고 500을 내지 않는다", async () => {
    countProducts.mockResolvedValue(25);

    await render({ builder: ["Codex", "Claude"] });

    expect(getSeasonRanking).toHaveBeenCalledWith(expect.objectContaining({ builder: "Codex" }));
  });

  it("검색어가 있으면 결과를 기다리지 않고 틀과 '찾는 중'부터 보낸다", async () => {
    getPublicList.mockResolvedValue([product("searched-project")]);

    const html = await renderPage({ q: "searched" });

    expect(html).toContain("“searched” 검색 결과");
    expect(html).toContain("찾는 중입니다");
    expect(html).not.toContain("searched-project");
  });

  it("검색어가 없어도 목록은 카드 9장 골격부터 보낸다(UX-38) — 경로의 loading.tsx 없이 페이지 안에서", async () => {
    getPublicList.mockResolvedValue([product("listed-project")]);

    const html = await renderPage({ sort: "recent" });

    expect(html.match(/class="skeleton-card"/g)).toHaveLength(9);
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("listed-project");
  });

  it("정렬을 명시하지 않은 검색은 순위가 아니라 공개 목록 전체를 관련도순(섞기·재정렬)으로 찾는다", async () => {
    searchRelevance.mockResolvedValue({ head: ["searched-project", "second"], total: 2, semantic: true, reranked: true, plan: ["searched"], translated: null });
    relevanceWindow.mockImplementation(async (ranked: { head: string[] }, _plan: unknown, _filters: unknown, start: number, count: number) =>
      ranked.head.slice(start, start + count));
    getPublicListBySlugs.mockImplementation(async (slugs: string[]) => slugs.map(product));

    // 결과는 스트리밍되는 쪽(HomeContent)에서 그린다
    const html = renderToStaticMarkup(await HomeContent({ params: { q: "searched" } }));

    expect(searchRelevance).toHaveBeenCalledWith("searched", expect.objectContaining({ queries: ["searched"] }),
      { category: undefined, builder: undefined, observedTool: undefined }, expect.any(Function));
    expect(getPublicList).not.toHaveBeenCalled();
    expect(getVerifiedList).not.toHaveBeenCalled();
    expect(getSeasonRanking).not.toHaveBeenCalled();
    // 전체 수는 낱말 검색 수가 아니라 섞은 결과의 수다
    expect(countProducts).not.toHaveBeenCalledWith(expect.objectContaining({ query: ["searched"] }));
    expect(html).toContain("searched-project");
    expect(html.indexOf("searched-project")).toBeLessThan(html.indexOf("second"));
  });

  it("다른 정렬을 고른 검색은 지금처럼 낱말 검색으로 거른다", async () => {
    countProducts.mockResolvedValue(1);
    getPublicList.mockResolvedValue([product("recent-match")]);

    const html = renderToStaticMarkup(await HomeContent({ params: { q: "searched", sort: "recent" } }));

    expect(searchRelevance).not.toHaveBeenCalled();
    expect(getPublicList).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ query: ["searched"], sort: "recent" }));
    expect(html).toContain("recent-match");
  });

  it("최신 탭은 수집 제품을 포함한 공개 목록을 사용한다", async () => {
    categoryCounts.mockResolvedValue({ Other: 1_119 });
    getPublicList.mockResolvedValue([product("seeded-project")]);

    const html = await render({ sort: "recent" });

    expect(getPublicList).toHaveBeenCalled();
    expect(getVerifiedList).not.toHaveBeenCalled();
    expect(html).toContain("seeded-project");
  });

  it("최신 탭의 카테고리와 공개 개수에는 수집 제품을 포함한다", async () => {
    categoryCounts.mockResolvedValue({ Other: 1_119 });

    await render({ sort: "recent" });

    expect(categoryCounts).toHaveBeenCalledWith({ statuses: ["verified", "seeded"], excludeDown: true });
  });

  it("공개 목록에 수집 제품이 있으면 등록부터 하라고 말하지 않는다", async () => {
    categoryCounts.mockResolvedValue({});
    countProducts.mockResolvedValue(1);
    getPublicList.mockResolvedValue([product("seeded-one")]);

    const html = await render({ sort: "recent" });

    expect(html).not.toContain("아직 등록된 프로젝트가 없습니다");
    expect(html).toContain("seeded-one");
  });

  it("필터로 걸러진 화면에서도 수집 제품이 있으면 없다고 말하지 않는다", async () => {
    categoryCounts.mockResolvedValue({});
    countProducts.mockResolvedValue(1);
    getPublicList.mockResolvedValue([product("seeded-one")]);

    const html = await renderScreen({ sort: "recent", category: "Finance" });

    expect(html).not.toContain("조건에 맞는 프로젝트가 없습니다");
    expect(html).toContain("seeded-one");
  });

  it("보여줄 제품이 하나도 없을 때는 그대로 등록을 안내한다", async () => {
    categoryCounts.mockResolvedValue({});

    const html = await render({ sort: "recent" });

    expect(html).toContain("아직 등록된 프로젝트가 없습니다");
  });

  it("순위가 비었다는 설명은 미클레임 목록과 함께 남는다", async () => {
    categoryCounts.mockResolvedValue({});
    getUnclaimedList.mockResolvedValue([product("seeded-one")]);

    // 추천·관심 많은 순은 대체 목록으로 채워지므로 순위 설명이 남는 곳은 급상승뿐이다
    const html = await render({ sort: "trending" });

    expect(html).toContain("아직 순위에 오른 프로젝트가 없습니다");
    expect(html).toContain("주인을 기다리는 프로젝트");
  });
});

/**
 * 추천 탭에서 카테고리 드롭다운이 "모든 카테고리" 하나만 남아 있었다.
 * 개수를 검증분으로만 셌는데 검증 제품이 0이라 모든 카테고리가 0으로 떨어졌고,
 * 필터가 개수 0인 것을 지웠다. 화면에는 시드 제품이 나열되는 중이었다.
 */
describe("카테고리 필터", () => {
  it("추천 탭에서도 고를 수 있는 카테고리가 뜬다", async () => {
    getSeasonRanking.mockResolvedValue({ season, items: [] });
    categoryCounts.mockResolvedValue({ Dev: 12 });
    getPublicList.mockResolvedValue([product("seeded-one")]);

    const html = await render();

    expect(categoryCounts).toHaveBeenCalledWith({ statuses: ["verified", "seeded"], excludeDown: true });
    expect(html).toContain('href="/c/dev"');
  });
});

/**
 * 상단 집계·도구 목록과 제품 목록은 서로의 결과를 쓰지 않는다. 차례로 기다리면 첫 화면이
 * 집계 6개 쿼리가 끝날 때까지 목록 조회를 시작하지도 못한다.
 */
describe("조회 순서", () => {
  it("목록 조회가 상단 집계를 기다리지 않는다", async () => {
    const pulse = await getHomePulse();
    let releasePulse: (value: unknown) => void = () => {};
    getHomePulse.mockReturnValue(new Promise((resolve) => { releasePulse = resolve; }));
    getSeasonRanking.mockResolvedValue({ season, items: [ranked("verified-one", 1)] });
    countProducts.mockResolvedValue(25);

    const rendering = render();
    await vi.waitFor(() => {
      expect(getSeasonRanking).toHaveBeenCalled();
      expect(categoryCounts).toHaveBeenCalled();
    });
    releasePulse(pulse);

    expect(await rendering).toContain("verified-one");
  });

  it("집계가 실패해도 목록은 그대로 뜬다", async () => {
    getHomePulse.mockRejectedValue(new Error("pulse down"));
    getSeasonRanking.mockResolvedValue({ season, items: [ranked("verified-one", 1)] });
    countProducts.mockResolvedValue(25);

    const html = await render();

    expect(html).toContain("verified-one");
  });

  it("목록과 집계가 함께 실패해도 처리되지 않은 거부 없이 안내를 낸다", async () => {
    getHomePulse.mockRejectedValue(new Error("pulse down"));
    getCurrentSeason.mockRejectedValue(new Error("db down"));

    const html = await render();

    expect(html).toContain("일시적으로 목록을 불러올 수 없습니다");
  });
});

/**
 * 2026-10-06 한 화면 상한(198)만 두었더니 "더 보기 (198 / 33692)"에서 더 늘지 않았다 — 공개 목록 대부분에 닿을 길이 없었다.
 * 상한을 넘으면 앞을 접고(shownWindow) 그다음 구간만 받아 그린다. 한 번에 받는 수는 늘 198 이하다.
 */
describe("끝까지 닿는 목록", () => {
  const TOTAL = 33_692;
  function catalogue() {
    countProducts.mockImplementation(async (options: { statuses: string[] }) =>
      options.statuses.length === 1 && options.statuses[0] === "verified" ? 0 : TOTAL);
    const page = (limit: number, options: { offset?: number } = {}) =>
      Array.from({ length: Math.min(limit, TOTAL - (options.offset ?? 0)) }, (_, i) => product(`p-${(options.offset ?? 0) + i + 1}`));
    getPublicList.mockImplementation(async (limit: number, options: { offset?: number } = {}) => page(limit, options));
    getUnclaimedList.mockImplementation(async (limit: number, options: { offset?: number } = {}) => page(limit, options));
  }

  it("198개를 넘기면 앞을 접고 다음 구간만 받는다", async () => {
    catalogue();

    const html = await render({ sort: "recent", shown: "207" });

    expect(getPublicList).toHaveBeenCalledWith(198, expect.objectContaining({ sort: "recent", offset: 9 }));
    expect(html).toContain("앞의 9개는 접었습니다");
    expect(html).toContain('href="/?sort=recent"');
    expect(html).toContain("p-10 태그라인");
    expect(html).toContain("p-207 태그라인");
    expect(html).not.toContain("p-9 태그라인");
    expect(html).toContain("프로젝트 더 보기 (207 / 33,692)");
    expect(html).toContain('href="/?sort=recent&amp;shown=216"');
  });

  it("마지막 항목까지 닿고 거기서 더 보기가 사라진다", async () => {
    catalogue();

    const html = await render({ sort: "recent", shown: String(TOTAL + 50) });

    expect(getPublicList).toHaveBeenCalledWith(198, expect.objectContaining({ offset: TOTAL - 198 }));
    expect(html).toContain(`p-${TOTAL} 태그라인`);
    expect(html).not.toContain("프로젝트 더 보기");
  });

  it("급상승 띠가 앞 다섯을 가져간 추천 목록도 띠 다음부터 창을 민다", async () => {
    catalogue();

    await render({ shown: "207" });

    expect(getPublicList).toHaveBeenCalledWith(198, expect.objectContaining({ sort: "rising", offset: 5 + 9 }));
  });

  it("주인을 기다리는 제품 목록도 같은 창으로 끝까지 닿는다", async () => {
    catalogue();

    const html = await render({ sort: "trending", shown: "207" });

    expect(getUnclaimedList).toHaveBeenCalledWith(198, expect.objectContaining({ offset: 9 }));
    expect(html).toContain("앞의 9개는 접었습니다");
  });

  it("198개 이하는 예전처럼 앞에서부터 다 그린다", async () => {
    catalogue();

    const html = await render({ sort: "recent", shown: "18" });

    expect(getPublicList).toHaveBeenCalledWith(18, expect.objectContaining({ offset: 0 }));
    expect(html).not.toContain("접었습니다");
    expect(html).toContain("프로젝트 더 보기 (18 / 33,692)");
  });
});

describe("구획 제목", () => {
  it("미클레임 구획을 발견 보드 제목과 섞지 않는다", async () => {
    categoryCounts.mockResolvedValue({});
    getUnclaimedList.mockResolvedValue([product("seeded-one")]);

    const html = await render({ sort: "trending" });

    expect(html).not.toContain("새로 발견됨");
    expect(html).toContain("주인을 기다리는 프로젝트");
  });

  it("첫 화면에 급상승 띠가 오고 피드는 그다음 항목부터 이어진다", async () => {
    categoryCounts.mockResolvedValue({ Dev: 3 });
    // 검증 0 · 맞는 제품 20 — 급상승이 띠(5)를 채우고도 남아야 띠와 피드가 나뉜다. 검증 수를 먼저 센다(app/page.tsx)
    countProducts.mockResolvedValueOnce(0).mockResolvedValueOnce(20);
    const rising = ["r1", "r2", "r3", "r4", "r5", "r6"].map(product);
    getPublicList.mockImplementation(async (limit: number, options: { offset?: number } = {}) => rising.slice(options.offset ?? 0, (options.offset ?? 0) + limit));
    const html = await render({});
    expect(html.indexOf("지금 뜨는 프로젝트")).toBeLessThan(html.indexOf("발견할 가치가 있는 프로젝트"));
    expect(getPublicList).toHaveBeenCalledWith(5, expect.objectContaining({ sort: "rising", rising: true }));
    expect(getPublicList).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ sort: "rising", offset: 5 }));
  });
});

describe("분야 주소·검색 상태 (UX-12·24·35·39·40)", () => {
  it("옛 주소 ?category= 는 대소문자를 가리지 않고 /c/<분야> 로 보낸다 — 다른 조건은 따라간다", async () => {
    await expect(renderPage({ category: "finance", sort: "recent" })).rejects.toMatchObject({ digest: expect.stringContaining("/c/finance?sort=recent") });
    await expect(renderPage({ category: "Finance" })).rejects.toMatchObject({ digest: expect.stringContaining("/c/finance") });
    expect(getPublicList).not.toHaveBeenCalled();
  });

  it("분야 화면은 그 분야 제목을 h1 으로 두고, 필터 없는 전체 기준의 아래 홈 구획은 숨긴다", async () => {
    countProducts.mockResolvedValue(25);
    categoryCounts.mockResolvedValue({ Dev: 3, Finance: 1, Profile: 9 });
    getSeasonRanking.mockResolvedValue({ season, items: [ranked("finance-one", 1)] });

    const html = await renderScreen({ category: "Finance" });

    expect(html).toContain('<h1 id="projects-title" class="row-title">금융 프로젝트</h1>');
    expect(html).toContain("금융 1개");
    expect(html).not.toContain("AI로 만든 것들이");
    expect(html).not.toContain("많이 쓰이는 프로젝트");
    expect(html).not.toContain("무엇으로 만들었나");
    expect(html).not.toContain("이번 주 가장 활발한");
    // 개인 프로필은 분야 알약에 없다(계약 C3)
    expect(html).not.toContain("개인프로필");
  });

  it("검색어로 0건이면 찾아볼 말 여섯과 분야를 주고, 초기화 링크는 결과 줄에 하나만 둔다", async () => {
    popularSearches.mockResolvedValue(["meeting notes", "가계부"]);
    categoryCounts.mockResolvedValue({ Dev: 9_157, Finance: 285, Profile: 2_577 });
    searchRelevance.mockResolvedValue({ head: [], total: 0, semantic: true, reranked: false, plan: [], translated: null });

    const html = renderToStaticMarkup(await HomeContent({ params: { q: "zzqxqzvbn" } }));

    expect(html).toContain("“zzqxqzvbn”에 맞는 프로젝트가 없습니다");
    expect(html).toContain("이런 검색어는 어떠세요");
    // 기록에서 고른 말이 먼저, 겹치는 말은 한 번, 모자라면 정해 둔 말로 채워 여섯
    expect(html.match(/href="\/\?q=/g)).toHaveLength(6);
    expect(html.indexOf("meeting notes")).toBeLessThan(html.indexOf("회의록 요약"));
    expect(html).toContain('href="/c/dev"');
    expect(html).toContain('href="/c/finance"');
    expect(html).not.toContain('href="/c/profile"');
    expect(html).not.toContain("전체 보기");
    expect(html.match(/필터 초기화/g)).toHaveLength(1);
    expect(html).toContain("관련 결과 0개");
  });

  it("추천 검색어는 지금 친 말과 대소문자·빈칸만 다른 말을 빼고 여섯까지", () => {
    expect(searchSuggestions(["Todo  App", "todo app", "가계부"], "TODO app")).toEqual(["가계부", "회의록 요약", "PDF 합치기", "할 일 관리", "이미지 생성", "코드 리뷰"]);
    expect(searchSuggestions(["a1", "a2", "a3", "a4", "a5", "a6", "a7"], undefined)).toEqual(["a1", "a2", "a3", "a4", "a5", "a6"]);
  });

  it("관련도순 검색은 섞은 수라 '관련 결과 약 n개'로, 더 보기도 같은 표기로 쓴다", async () => {
    searchRelevance.mockResolvedValue({ head: ["a"], total: 1_779, semantic: true, reranked: true, plan: ["calender"], translated: null });
    relevanceWindow.mockResolvedValue(["a"]);
    getPublicListBySlugs.mockResolvedValue([product("a")]);

    const html = renderToStaticMarkup(await HomeContent({ params: { q: "calender" } }));

    expect(html).toContain("관련 결과 약 1,800개");
    expect(html).toContain("프로젝트 더 보기 (1 / 약 1,800)");
    expect(html).not.toContain("1779");
  });

  it("탭 제목은 검색어로 정한다(UX-39)", async () => {
    // 검색 결과는 색인하지 않는다 — 검색어마다 얇은 목록이 끝없이 생긴다(분야는 /c/ 정식 주소가 맡는다)
    expect(await generateMetadata({ searchParams: Promise.resolve({ q: "가계부" }) }))
      .toEqual({ title: "“가계부” 검색 결과 — nomorevibe", robots: { index: false, follow: true } });
    expect(await generateMetadata({ searchParams: Promise.resolve({}) })).toEqual({ title: "nomorevibe — AI로 만든 것들, 세상에 나오다." });
  });
});
