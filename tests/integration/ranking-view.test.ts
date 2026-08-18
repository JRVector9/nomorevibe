import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  clickEvents,
  productClickDaily,
  productHealth,
  products,
  rankingEntries,
  rankingPolicyRevisions,
  rankingSeasons,
} from "@/lib/db/schema";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import {
  RANKING_STALE_MS,
  getAllTimeRanking,
  getCurrentSeason,
  getDiscoveryBoards,
  getRankingAdminState,
  getSeasonHistory,
  getSeasonRanking,
} from "@/lib/domain/ranking/view";
import { getVerifiedList } from "@/lib/domain/products/view";
import { ensureSchema, resetTables } from "./setup";

const NOW = new Date("2026-08-18T03:00:00.000Z");
const POLICY = {
  ...DEFAULT_RANKING_POLICY,
  boards: { ...DEFAULT_RANKING_POLICY.boards, discoveredNewLimit: 4 },
};

async function insertProduct(
  slug: string,
  category: "Productivity" | "Dev" | "Design" | "Finance" | "Other",
  status: "verified" | "seeded" = "verified",
) {
  await db.insert(products).values({
    slug,
    url: `https://${slug}.test`,
    name: slug.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
    tagline: `${slug} 소개`,
    description: "설명",
    category,
    stack: [],
    status,
    source: status === "seeded" ? "crawler" : "skill",
    verifiedAt: status === "verified" ? new Date("2026-08-10T00:00:00.000Z") : null,
    createdAt: new Date("2026-08-17T00:00:00.000Z"),
    verifyToken: `nmv_verify_${slug}`,
    editTokenHash: "x".repeat(64),
  });
}

async function materializeRanking() {
  await insertProduct("rank-one", "Other");
  await insertProduct("rank-two", "Dev");
  await insertProduct("rank-three", "Design");
  await insertProduct("seeded-find", "Dev", "seeded");

  const [revision] = await db.insert(rankingPolicyRevisions).values({
    values: POLICY,
    state: "applied",
    createdBy: "test",
    createdAt: NOW,
    appliedAt: NOW,
  }).returning();
  const [previous] = await db.insert(rankingSeasons).values({
    key: "2026-W33",
    cadence: "weekly",
    startsAt: new Date("2026-08-09T15:00:00.000Z"),
    endsAt: new Date("2026-08-16T15:00:00.000Z"),
    state: "closed",
    policyRevisionId: revision.id,
    policySnapshot: POLICY,
    effectiveLaunchWindowDays: 28,
    isTransition: false,
    refreshedAt: new Date("2026-08-16T15:00:00.000Z"),
    closedAt: new Date("2026-08-16T15:00:00.000Z"),
  }).returning();
  const [active] = await db.insert(rankingSeasons).values({
    key: "2026-W34",
    cadence: "weekly",
    startsAt: new Date("2026-08-16T15:00:00.000Z"),
    endsAt: new Date("2026-08-23T15:00:00.000Z"),
    state: "active",
    policyRevisionId: revision.id,
    policySnapshot: POLICY,
    effectiveLaunchWindowDays: 28,
    isTransition: false,
    refreshedAt: NOW,
  }).returning();

  await db.insert(rankingEntries).values([
    {
      seasonId: previous.id,
      slug: "rank-two",
      validClicks: 25,
      cooldownFactorBasisPoints: 10_000,
      scoreUnits: 250_000,
      rank: 1,
      recentClicks: 8,
      previousClicks: 8,
      changePercent: 0,
      finalizedAt: previous.endsAt,
    },
    {
      seasonId: previous.id,
      slug: "rank-one",
      validClicks: 20,
      cooldownFactorBasisPoints: 10_000,
      scoreUnits: 200_000,
      rank: 2,
      recentClicks: 8,
      previousClicks: 8,
      changePercent: 0,
      finalizedAt: previous.endsAt,
    },
    {
      seasonId: active.id,
      slug: "rank-one",
      validClicks: 30,
      cooldownFactorBasisPoints: 10_000,
      scoreUnits: 300_000,
      rank: 1,
      recentClicks: 2,
      previousClicks: 1,
      changePercent: null,
    },
    {
      seasonId: active.id,
      slug: "rank-two",
      validClicks: 20,
      cooldownFactorBasisPoints: 8_000,
      scoreUnits: 160_000,
      rank: 2,
      recentClicks: 12,
      previousClicks: 8,
      changePercent: 50,
    },
    {
      seasonId: active.id,
      slug: "rank-three",
      validClicks: 10,
      cooldownFactorBasisPoints: 10_000,
      scoreUnits: 100_000,
      rank: 3,
      recentClicks: 10,
      previousClicks: 8,
      changePercent: 25,
    },
  ]);
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  await db.delete(clickEvents);
  await db.delete(productClickDaily);
  await db.delete(productHealth);
  await resetTables();
});

describe("ranking read models", () => {
  it("keeps global ranks when category and query filters narrow a season", async () => {
    await materializeRanking();

    const dev = await getSeasonRanking({ seasonKey: "2026-W34", category: "Dev", limit: 10 });
    expect(dev.items.map((item) => item.rank)).toEqual([2]);
    expect(dev.items[0]).toMatchObject({
      validClicks: 20,
      cooldownFactorBasisPoints: 8_000,
      previousRank: 1,
    });

    const searched = await getSeasonRanking({
      seasonKey: "2026-W34",
      query: "Rank Two",
      limit: 10,
    });
    expect(searched.items.map((item) => item.rank)).toEqual([2]);
  });

  it("excludes an unqualified percentage from trending", async () => {
    await materializeRanking();

    const trending = await getSeasonRanking({
      seasonKey: "2026-W34",
      order: "trending",
      limit: 10,
    });

    expect(trending.items.map((item) => [item.slug, item.changePercent])).toEqual([
      ["rank-two", 50],
      ["rank-three", 25],
    ]);
  });

  it("shows seeded products only on the discovery board", async () => {
    await materializeRanking();

    const boards = await getDiscoveryBoards();
    expect(boards.discoveredNew.map((item) => item.slug)).toContain("seeded-find");
    expect(boards.weekly.map((item) => item.slug)).not.toContain("seeded-find");
    expect(boards.trending.map((item) => item.slug)).not.toContain("seeded-find");
    expect(boards.verifiedNew.map((item) => item.slug)).not.toContain("seeded-find");
    expect((await getVerifiedList(10)).map((item) => item.slug)).not.toContain("seeded-find");
  });

  it("returns current and closed season summaries without discarding snapshots", async () => {
    await materializeRanking();

    expect(await getCurrentSeason()).toMatchObject({
      key: "2026-W34",
      state: "active",
      policy: POLICY,
    });
    expect((await getSeasonHistory()).map((season) => season.key)).toEqual(["2026-W33"]);
    expect(RANKING_STALE_MS).toBe(2 * 60 * 60 * 1000);
  });

  it("builds all-time verified ranks from daily totals in one product set", async () => {
    await materializeRanking();
    const today = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
    await db.insert(productClickDaily).values([
      { slug: "rank-one", day: today, clicks: 10 },
      { slug: "rank-two", day: today, clicks: 15 },
      { slug: "seeded-find", day: today, clicks: 100 },
    ]);

    const items = await getAllTimeRanking({ limit: 10 });
    expect(items.map((item) => [item.slug, item.rank, item.validClicks])).toEqual([
      ["rank-two", 1, 15],
      ["rank-one", 2, 10],
    ]);
    expect(items.every((item) => item.cooldownFactorBasisPoints === 10_000)).toBe(true);
  });

  it("returns an admin preview and handles a missing season safely", async () => {
    expect(await getSeasonRanking({ limit: 10 })).toEqual({ season: null, items: [] });

    await materializeRanking();
    const state = await getRankingAdminState(NOW);
    expect(state.active?.key).toBe("2026-W34");
    expect(state.scheduled).toBeNull();
    expect(state.revisions).toHaveLength(1);
    expect(state.preview.map((item) => item.slug).sort()).toEqual([
      "rank-one",
      "rank-three",
      "rank-two",
    ]);
  });
});
