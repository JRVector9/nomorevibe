import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import type { ProductListItem } from "@/lib/domain/products/view";
import type { RankingListItem, SeasonSummary } from "@/lib/domain/ranking/view";

const {
  categoryCounts,
  listBuilders,
  getAllTimeRanking,
  getCurrentSeason,
  getSeasonRanking,
  getUnclaimedList,
  getVerifiedList,
  getPublicList,
  getHomePulse,
} = vi.hoisted(() => ({
  categoryCounts: vi.fn(),
  listBuilders: vi.fn(),
  getAllTimeRanking: vi.fn(),
  getCurrentSeason: vi.fn(),
  getSeasonRanking: vi.fn(),
  getUnclaimedList: vi.fn(),
  getVerifiedList: vi.fn(),
  getPublicList: vi.fn(),
  getHomePulse: vi.fn(),
}));

vi.mock("@/lib/domain/products/repository", () => ({ categoryCounts, listBuilders }));
vi.mock("@/lib/domain/products/view", () => ({ getUnclaimedList, getVerifiedList, getPublicList }));
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

import HomePage, { needsUnclaimedFill } from "@/app/page";

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

async function render(
  params: Record<string, string | string[] | undefined> = {},
): Promise<string> {
  return renderToStaticMarkup(await HomePage({ searchParams: Promise.resolve(params) }));
}

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentSeason.mockResolvedValue(season);
  getUnclaimedList.mockResolvedValue([]);
  getVerifiedList.mockResolvedValue([]);
  getPublicList.mockResolvedValue([]);
  getAllTimeRanking.mockResolvedValue([]);
  getSeasonRanking.mockResolvedValue({ season, items: [] });
  listBuilders.mockResolvedValue([]);
  categoryCounts.mockResolvedValue({});
  getHomePulse.mockResolvedValue({
    asOf: new Date("2026-09-08T00:00:00+09:00"),
    timezone: "Asia/Seoul",
    methodVersion: "1.0",
    launches: { current: 0, previous: 0, change: null, days: [] },
    tools: { total: 0, reported: 0, coverage: null, rows: [] },
    interestReady: false,
    categories: [],
    updates: { projects: 0, releases: 0 },
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
    categoryCounts.mockResolvedValue({ Dev: 25 });

    const html = await render();

    expect(getUnclaimedList).not.toHaveBeenCalled();
    expect(html).not.toContain("주인을 기다리는 제품");
  });

  it("검증 제품이 모자라면 구획을 붙인다", async () => {
    getSeasonRanking.mockResolvedValue({ season, items: [ranked("verified-one", 1)] });
    categoryCounts.mockResolvedValue({ Dev: 3 });
    getUnclaimedList.mockResolvedValue([product("seeded-one")]);

    const html = await render();

    expect(getUnclaimedList).toHaveBeenCalled();
    expect(html).toContain("주인을 기다리는 제품");
    expect(html).toContain("seeded-one");
  });

  it("필터가 걸려 목록이 비어도 전역 검증 수가 충분하면 붙이지 않는다", async () => {
    categoryCounts.mockResolvedValue({ Dev: 25 });

    const html = await render({ category: "Finance" });

    expect(getUnclaimedList).not.toHaveBeenCalled();
    expect(html).toContain("조건에 맞는 제품이 없습니다");
  });
});

/**
 * 아래에 제품이 나열되는데 위에서 "없습니다"라고 하면 화면이 스스로를 반박한다.
 * 커밋 cb64f25가 세운 불변식이다.
 */
describe("빈 화면 문구", () => {
  it("중복 쿼리 값은 첫 값만 사용하고 500을 내지 않는다", async () => {
    await render({ builder: ["Codex", "Claude"] });

    expect(getSeasonRanking).toHaveBeenCalledWith(expect.objectContaining({ builder: "Codex" }));
  });

  it("정렬을 명시하지 않은 검색은 순위가 아니라 공개 목록 전체에서 찾는다", async () => {
    getVerifiedList.mockResolvedValue([product("searched-project")]);

    const html = await render({ q: "searched" });

    expect(getVerifiedList).toHaveBeenCalled();
    expect(getSeasonRanking).not.toHaveBeenCalled();
    expect(html).toContain("searched-project");
  });

  it("미클레임 목록이 붙으면 등록부터 하라고 말하지 않는다", async () => {
    categoryCounts.mockResolvedValue({});
    getUnclaimedList.mockResolvedValue([product("seeded-one")]);

    const html = await render({ sort: "recent" });

    expect(html).not.toContain("아직 등록된 제품이 없습니다");
    expect(html).toContain("seeded-one");
  });

  it("필터로 걸러진 화면에서도 미클레임이 있으면 없다고 말하지 않는다", async () => {
    categoryCounts.mockResolvedValue({});
    getUnclaimedList.mockResolvedValue([product("seeded-one")]);

    const html = await render({ sort: "recent", category: "Finance" });

    expect(html).not.toContain("조건에 맞는 제품이 없습니다");
    expect(html).toContain("seeded-one");
  });

  it("보여줄 제품이 하나도 없을 때는 그대로 등록을 안내한다", async () => {
    categoryCounts.mockResolvedValue({});

    const html = await render({ sort: "recent" });

    expect(html).toContain("아직 등록된 제품이 없습니다");
  });

  it("순위가 비었다는 설명은 미클레임 목록과 함께 남는다", async () => {
    categoryCounts.mockResolvedValue({});
    getUnclaimedList.mockResolvedValue([product("seeded-one")]);

    const html = await render();

    expect(html).toContain("아직 순위에 오른 제품이 없습니다");
    expect(html).toContain("주인을 기다리는 제품");
  });
});

describe("구획 제목", () => {
  it("미클레임 구획을 발견 보드 제목과 섞지 않는다", async () => {
    categoryCounts.mockResolvedValue({});
    getUnclaimedList.mockResolvedValue([product("seeded-one")]);

    const html = await render();

    expect(html).not.toContain("새로 발견됨");
    expect(html).toContain("주인을 기다리는 제품");
  });
});
