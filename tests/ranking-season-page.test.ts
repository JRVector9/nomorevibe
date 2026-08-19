import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RankingListItem, SeasonSummary } from "@/lib/domain/ranking/view";
import {
  DEFAULT_RANKING_POLICY,
  UNIQUE_FIRST_RANKING_POLICY,
} from "@/lib/domain/ranking/policy";

const { getSeasonByKey, notFound } = vi.hoisted(() => ({
  getSeasonByKey: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/lib/domain/ranking/view", () => ({ getSeasonByKey }));
vi.mock("next/navigation", () => ({ notFound }));

import RankingSeasonPage, { dynamic } from "@/app/rankings/[key]/page";

const season: SeasonSummary = {
  key: "2026-W33",
  cadence: "weekly",
  startsAt: new Date("2026-08-09T15:00:00.000Z"),
  endsAt: new Date("2026-08-16T15:00:00.000Z"),
  isTransition: false,
  effectiveLaunchWindowDays: 28,
  policy: DEFAULT_RANKING_POLICY,
  refreshedAt: new Date("2026-08-16T15:05:00.000Z"),
  state: "closed",
};

const item: RankingListItem = {
  slug: "history-one",
  name: "History One",
  tagline: "역사 제품",
  category: "Dev",
  builder: null,
  builderClaim: "reported",
  stack: [],
  ogImage: null,
  listedAt: new Date("2026-08-01T00:00:00.000Z"),
  status: "verified",
  unclaimed: false,
  rank: 1,
  validClicks: 42,
  uniqueVisitors: 0,
  recentUniqueVisitors: 0,
  previousUniqueVisitors: 0,
  scoreMode: "valid_visits",
  changePercent: 25,
  cooldownFactorBasisPoints: 7_500,
  previousRank: 2,
};

beforeEach(() => {
  getSeasonByKey.mockReset();
  notFound.mockClear();
});

describe("ranking season page", () => {
  it("renders a stored season with its trend window", async () => {
    getSeasonByKey.mockResolvedValue({ season, items: [item] });

    const page = await RankingSeasonPage({
      params: Promise.resolve({ key: season.key }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(createElement(() => page));

    expect(dynamic).toBe("force-dynamic");
    expect(getSeasonByKey).toHaveBeenCalledWith("2026-W33");
    expect(html).toContain("2026-W33 랭킹");
    expect(html).toContain("24h 유효 방문 변동률");
    expect(html).toContain("History One");
  });

  it("renders unique-first labels from the stored season policy", async () => {
    getSeasonByKey.mockResolvedValue({
      season: { ...season, policy: UNIQUE_FIRST_RANKING_POLICY },
      items: [{
        ...item,
        uniqueVisitors: 17,
        recentUniqueVisitors: 6,
        previousUniqueVisitors: 4,
        scoreMode: "unique_visitors",
        changePercent: 50,
      }],
    });

    const page = await RankingSeasonPage({
      params: Promise.resolve({ key: season.key }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(createElement(() => page));

    expect(html).toContain("고유 유입자");
    expect(html).toContain("유효 방문 42");
    expect(html).toContain("24h 고유 유입자 변동률");
    expect(html).toContain("+50%");
  });

  it("uses notFound for an unknown season", async () => {
    getSeasonByKey.mockResolvedValue(null);

    await expect(RankingSeasonPage({
      params: Promise.resolve({ key: "missing" }),
      searchParams: Promise.resolve({}),
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalledOnce();
  });
});
