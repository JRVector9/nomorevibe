import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  rankingEntries,
  rankingPolicyRevisions,
  rankingSeasons,
} from "@/lib/db/schema";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

describe("ranking schema", () => {
  it("stores a ranked season and permits only one scheduled policy and active season", async () => {
    const [revision] = await db.insert(rankingPolicyRevisions).values({
      values: DEFAULT_RANKING_POLICY,
      state: "applied",
      createdBy: "test",
      appliedAt: new Date(),
    }).returning();

    const [season] = await db.insert(rankingSeasons).values({
      key: "2026-W34",
      cadence: "weekly",
      startsAt: new Date("2026-08-16T15:00:00Z"),
      endsAt: new Date("2026-08-23T15:00:00Z"),
      state: "active",
      policyRevisionId: revision.id,
      policySnapshot: DEFAULT_RANKING_POLICY,
      effectiveLaunchWindowDays: 28,
      isTransition: false,
    }).returning();

    await db.insert(rankingEntries).values({
      seasonId: season.id,
      slug: "product",
      validClicks: 10,
      cooldownFactorBasisPoints: 3500,
      scoreUnits: 35_000,
      rank: 1,
      recentClicks: 3,
      previousClicks: 2,
      changePercent: 50,
    });

    await db.insert(rankingPolicyRevisions).values({
      values: DEFAULT_RANKING_POLICY,
      state: "scheduled",
      createdBy: "test",
    });
    await expect(db.insert(rankingPolicyRevisions).values({
      values: DEFAULT_RANKING_POLICY,
      state: "scheduled",
      createdBy: "test",
    })).rejects.toThrow();

    await expect(db.insert(rankingSeasons).values({
      key: "2026-W35",
      cadence: "weekly",
      startsAt: new Date("2026-08-23T15:00:00Z"),
      endsAt: new Date("2026-08-30T15:00:00Z"),
      state: "active",
      policyRevisionId: revision.id,
      policySnapshot: DEFAULT_RANKING_POLICY,
      effectiveLaunchWindowDays: 28,
      isTransition: false,
    })).rejects.toThrow();

    expect(await db.select().from(rankingEntries)).toHaveLength(1);
  });
});
