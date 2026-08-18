import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiscoveryBoards } from "@/components/DiscoveryBoards";
import { MarketStats } from "@/components/MarketStats";
import { RankingTable } from "@/components/RankingTable";
import type { ProductListItem } from "@/lib/domain/products/view";
import type { RankingListItem } from "@/lib/domain/ranking/view";

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
