import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  clickEvents,
  productClickDaily,
  rankingEntries,
  rankingPolicyRevisions,
  rankingSeasons,
} from "@/lib/db/schema";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

describe("unique visit schema", () => {
  it("keeps legacy visits compatible and defaults new counters without starting collection", async () => {
    await db.insert(clickEvents).values([
      { slug: "legacy" },
      { slug: "hashed", visitorHash: "a".repeat(64) },
    ]);

    const events = await db.select().from(clickEvents).orderBy(clickEvents.slug);
    expect(events.map((row) => row.visitorHash)).toEqual(["a".repeat(64), null]);

    const state = await db.query.visitCollectionState.findFirst();
    expect(state?.id).toBe(1);
    expect(state?.uniqueVisitorStartedAt).toBeNull();

    const [daily] = await db.insert(productClickDaily).values({
      slug: "hashed",
      day: "2026-08-19",
    }).returning();
    expect(daily.uniqueVisitors).toBe(0);

    const [revision] = await db.insert(rankingPolicyRevisions).values({
      values: DEFAULT_RANKING_POLICY,
      state: "applied",
      createdBy: "test",
    }).returning();
    const [season] = await db.insert(rankingSeasons).values({
      key: "2026-W34-unique-schema",
      cadence: "weekly",
      startsAt: new Date("2026-08-16T15:00:00Z"),
      endsAt: new Date("2026-08-23T15:00:00Z"),
      state: "active",
      policyRevisionId: revision.id,
      policySnapshot: DEFAULT_RANKING_POLICY,
      effectiveLaunchWindowDays: 28,
    }).returning();
    const [entry] = await db.insert(rankingEntries).values({
      seasonId: season.id,
      slug: "hashed",
      rank: 1,
    }).returning();

    expect(entry.uniqueVisitors).toBe(0);
    expect(entry.recentUniqueVisitors).toBe(0);
    expect(entry.previousUniqueVisitors).toBe(0);
  });
});
