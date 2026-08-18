import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiscoveryBoards } from "@/components/DiscoveryBoards";
import { MarketStats } from "@/components/MarketStats";
import { RankingTable } from "@/components/RankingTable";
import { SeasonPolicy } from "@/components/SeasonPolicy";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import type { ProductListItem } from "@/lib/domain/products/view";
import type { RankingListItem, SeasonSummary } from "@/lib/domain/ranking/view";

function product(slug: string, overrides: Partial<ProductListItem> = {}): ProductListItem {
  return {
    slug,
    name: `제품 ${slug}`,
    tagline: "소개",
    category: "Dev",
    builder: null,
    builderClaim: "reported",
    stack: [],
    ogImage: null,
    listedAt: new Date("2026-08-18T00:00:00.000Z"),
    status: "verified",
    unclaimed: false,
    ...overrides,
  };
}

function ranked(slug: string, overrides: Partial<RankingListItem> = {}): RankingListItem {
  return {
    ...product(slug),
    rank: 7,
    validClicks: 42,
    changePercent: null,
    cooldownFactorBasisPoints: 3500,
    previousRank: null,
    ...overrides,
  };
}

describe("ranking table", () => {
  it("renders the stored rank, new change state, and cooldown warning", () => {
    const html = renderToStaticMarkup(createElement(RankingTable, {
      items: [ranked("stored-rank")],
      windowHours: 24,
    }));

    expect(html).toContain(">7<");
    expect(html).not.toContain(">1<");
    expect(html).toContain("신규");
    expect(html).toContain("35%");
    expect(html).toContain("text-down");
    expect(html).toContain("첫 시즌");
  });

  it("renders the configured trend window and previous rank", () => {
    const html = renderToStaticMarkup(createElement(RankingTable, {
      items: [ranked("prior", {
        changePercent: 24,
        cooldownFactorBasisPoints: 10_000,
        previousRank: 2,
      })],
      windowHours: 48,
    }));

    expect(html).toContain("48h 변동률");
    expect(html).toContain("+24%");
    expect(html).toContain("지난 시즌 2위");
  });

  it("uses lifetime labels without seasonal placeholders in all-time mode", () => {
    const html = renderToStaticMarkup(createElement(RankingTable, {
      items: [ranked("lifetime", {
        cooldownFactorBasisPoints: 10_000,
        changePercent: null,
        previousRank: null,
      })],
      windowHours: 24,
      mode: "all-time",
    }));

    expect(html).toContain("누적 클릭");
    expect(html).not.toContain("이번 시즌 클릭");
    expect(html).not.toContain("변동률");
    expect(html).not.toContain("순위 반영");
    expect(html).not.toContain("신규");
    expect(html).not.toContain("첫 시즌");
  });

  it("keeps trust and downtime visible in product identity", () => {
    const html = renderToStaticMarkup(createElement(RankingTable, {
      items: [ranked("down", { health: { down: true, since: null } })],
      windowHours: 24,
    }));

    expect(html).toContain("✓ 검증됨");
    expect(html).toContain("응답 없음");
  });

  it("shows core metrics in the narrow table and stacks secondary season state", () => {
    const html = renderToStaticMarkup(createElement(RankingTable, {
      items: [ranked("mobile")],
      windowHours: 24,
    }));

    expect(html).toContain("min-w-full sm:min-w-[760px]");
    expect(html).toContain("hidden sm:table-cell");
    expect(html).toContain("sm:hidden");
    expect(html).toContain("클릭");
    expect(html).toContain("24h 변동률");
  });
});

describe("season policy", () => {
  it("shows the locked season period and valid-click methodology", () => {
    const season: SeasonSummary = {
      key: "2026-W33",
      cadence: "weekly",
      startsAt: new Date("2026-08-09T15:00:00.000Z"),
      endsAt: new Date("2026-08-16T15:00:00.000Z"),
      isTransition: true,
      effectiveLaunchWindowDays: 21,
      policy: {
        ...DEFAULT_RANKING_POLICY,
        trend: {
          ...DEFAULT_RANKING_POLICY.trend,
          windowHours: 48,
          minimumPreviousClicks: 8,
        },
      },
      refreshedAt: new Date("2026-08-16T15:05:00.000Z"),
      state: "closed",
    };

    const html = renderToStaticMarkup(createElement(SeasonPolicy, { season }));

    expect(html).toContain("2026. 08. 10. 00:00");
    expect(html).toContain("2026. 08. 17. 00:00");
    expect(html).toContain("KST");
    expect(html).toContain("확정 참가 기간");
    expect(html).toContain("21일");
    expect(html).toContain("봇 제외");
    expect(html).toContain("방문자·제품별 10분 중복 제외");
    expect(html).toContain("48시간");
    expect(html).toContain("이전 8클릭 이상");
    expect(html).toContain("전환 시즌");
    expect(html).toContain("마지막 집계");
  });

  it("keeps the administrator policy-only view compatible", () => {
    const html = renderToStaticMarkup(createElement(SeasonPolicy, {
      policy: DEFAULT_RANKING_POLICY,
    }));

    expect(html).toContain("출시 참가 기간");
    expect(html).toContain("28일");
    expect(html).not.toContain("마지막 집계");
  });
});

describe("discovery boards", () => {
  it("links every product internally and marks unclaimed discoveries", () => {
    const boards = {
      weekly: [ranked("weekly")],
      trending: [ranked("trend", { changePercent: 50 })],
      verifiedNew: [product("verified")],
      discoveredNew: [product("seeded", { status: "seeded", unclaimed: true })],
    };
    const html = renderToStaticMarkup(createElement(DiscoveryBoards, {
      boards,
      now: new Date("2026-08-19T00:00:00.000Z"),
    }));

    expect(html).toContain('href="/p/weekly"');
    expect(html).toContain('href="/p/trend"');
    expect(html).toContain('href="/p/verified"');
    expect(html).toContain('href="/p/seeded"');
    expect(html).not.toContain('href="http');
    expect(html).toContain("미클레임");
  });
});

describe("market stats", () => {
  it("shows the configured adjacent-window click change", () => {
    const html = renderToStaticMarkup(createElement(MarketStats, {
      stats: {
        products: 10,
        newThisWeek: 2,
        clicks24h: 12,
        clicksChangePercent: 50,
        verified: 8,
      },
      windowHours: 48,
    }));

    expect(html).toContain("유효 클릭 48h");
    expect(html).toContain("▲ 50%");
  });

  it("omits the percentage when the previous window is unqualified", () => {
    const html = renderToStaticMarkup(createElement(MarketStats, {
      stats: {
        products: 10,
        newThisWeek: 0,
        clicks24h: 12,
        clicksChangePercent: null,
        verified: 8,
      },
      windowHours: 24,
    }));

    expect(html).toContain("유효 클릭 24h");
    expect(html).not.toMatch(/[▲▼] \d+%/);
  });
});
