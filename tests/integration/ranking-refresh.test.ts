import { asc, eq, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  clickEvents,
  jobs,
  productClickDaily,
  products,
  rankingEntries,
  rankingPolicyRevisions,
  rankingSeasons,
} from "@/lib/db/schema";
import { schedulePolicy } from "@/lib/domain/ranking/policies";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { refreshRanking } from "@/lib/domain/ranking/refresh";
import { refreshRankings } from "@/lib/jobs/products/ranking-refresh";
import { runJob } from "@/lib/jobs/runner";
import { ensureSchema, resetTables } from "./setup";

const NOW = new Date("2026-08-18T03:00:00.000Z");
const WEEK_END = new Date("2026-08-23T15:00:00.000Z");

async function insertProduct(
  slug: string,
  status: "verified" | "seeded" = "verified",
  verifiedAt = new Date("2026-08-01T00:00:00.000Z"),
) {
  await db.insert(products).values({
    slug,
    url: `https://${slug}.test`,
    name: slug,
    tagline: "소개",
    description: "설명",
    category: "Other",
    stack: [],
    status,
    source: status === "seeded" ? "crawler" : "skill",
    verifyToken: `nmv_verify_${slug}`,
    verifiedAt: status === "verified" ? verifiedAt : null,
    editTokenHash: "x".repeat(64),
  });
}

beforeAll(() => ensureSchema());
beforeEach(async () => {
  vi.useRealTimers();
  await db.delete(clickEvents);
  await db.delete(productClickDaily);
  await db.delete(jobs);
  await resetTables();
});

describe("seasonal ranking refresh", () => {
  it("ranks only verified products, keeps zero-click candidates, and is idempotent", async () => {
    await insertProduct("verified-a");
    await insertProduct("verified-b", "verified", new Date("2026-08-02T00:00:00.000Z"));
    await insertProduct("seeded-one", "seeded");
    await db.insert(clickEvents).values([
      { slug: "verified-a", occurredAt: new Date("2026-08-17T00:00:00.000Z") },
      { slug: "verified-a", occurredAt: new Date("2026-08-18T02:00:00.000Z") },
      { slug: "verified-a", occurredAt: new Date("2026-08-16T14:59:59.000Z") },
      { slug: "seeded-one", occurredAt: new Date("2026-08-18T01:00:00.000Z") },
    ]);

    const first = await refreshRanking(NOW);
    expect(first).toMatchObject({ createdSeason: true, entries: 2 });

    const season = await db.query.rankingSeasons.findFirst();
    expect(season).toMatchObject({
      key: "2026-W34",
      state: "active",
      isTransition: false,
      effectiveLaunchWindowDays: 90,
    });

    const entries = await db.select().from(rankingEntries).orderBy(rankingEntries.rank);
    expect(entries.map((entry) => entry.slug)).toEqual(["verified-a", "verified-b"]);
    expect(entries.map((entry) => entry.validClicks)).toEqual([2, 0]);
    expect(entries.some((entry) => entry.slug === "seeded-one")).toBe(false);

    const second = await refreshRanking(NOW);
    expect(second.createdSeason).toBe(false);
    expect(await db.$count(rankingSeasons)).toBe(1);
    expect(await db.$count(rankingEntries)).toBe(2);
  });

  it("uses the refresh instant, not the process clock, for raw-event retention", async () => {
    await insertProduct("historical", "verified", new Date("2026-04-01T00:00:00.000Z"));
    await db.insert(clickEvents).values({
      slug: "historical",
      occurredAt: new Date("2026-04-06T00:00:00.000Z"),
    });

    await refreshRanking(new Date("2026-04-07T03:00:00.000Z"));

    const [entry] = await db.select().from(rankingEntries);
    expect(entry.validClicks).toBe(1);
  });

  it("expands eligibility to the smallest whole-day window that reaches the minimum", async () => {
    const policy = {
      ...DEFAULT_RANKING_POLICY,
      eligibility: { launchWindowDays: 7, minimumProducts: 3, maximumWindowDays: 30 },
      leaderboard: { limit: 3 },
      cooldown: {
        enabled: true,
        tiers: [{
          rankFrom: 1,
          rankTo: 3,
          factorsBasisPoints: [3500, 5500, 7500, 9000],
        }],
      },
    };
    await db.insert(rankingPolicyRevisions).values({
      values: policy,
      state: "applied",
      createdBy: "test",
      createdAt: NOW,
      appliedAt: NOW,
    });
    await insertProduct("recent", "verified", new Date("2026-08-17T00:00:00.000Z"));
    await insertProduct("older-a", "verified", new Date("2026-08-06T00:00:00.000Z"));
    await insertProduct("older-b", "verified", new Date("2026-08-04T16:00:00.000Z"));

    await refreshRanking(NOW);

    const season = await db.query.rankingSeasons.findFirst();
    expect(season?.effectiveLaunchWindowDays).toBe(12);
    expect(await db.$count(rankingEntries)).toBe(3);
  });

  it("uses KST daily rollups when a missed season is older than raw retention", async () => {
    await insertProduct("archived", "verified", new Date("2026-05-20T00:00:00.000Z"));
    const [revision] = await db.insert(rankingPolicyRevisions).values({
      values: DEFAULT_RANKING_POLICY,
      state: "applied",
      createdBy: "test",
      createdAt: new Date("2026-06-28T15:00:00.000Z"),
      appliedAt: new Date("2026-06-28T15:00:00.000Z"),
    }).returning();
    const [missed] = await db.insert(rankingSeasons).values({
      key: "2026-W27",
      cadence: "weekly",
      startsAt: new Date("2026-06-28T15:00:00.000Z"),
      endsAt: new Date("2026-07-05T15:00:00.000Z"),
      state: "active",
      policyRevisionId: revision.id,
      policySnapshot: DEFAULT_RANKING_POLICY,
      effectiveLaunchWindowDays: 90,
      isTransition: false,
    }).returning();
    await db.insert(productClickDaily).values({
      slug: "archived",
      day: "2026-07-01",
      clicks: 3,
    });

    await refreshRanking(NOW);

    const [finalized] = await db
      .select()
      .from(rankingEntries)
      .where(eq(rankingEntries.seasonId, missed.id));
    expect(finalized).toMatchObject({ validClicks: 3, finalizedAt: missed.endsAt });
  });

  it("applies a scheduled monthly policy once and creates a transition season", async () => {
    await insertProduct("verified-a");
    await db.insert(clickEvents).values({
      slug: "verified-a",
      occurredAt: new Date("2026-08-18T02:00:00.000Z"),
    });
    await refreshRanking(NOW);

    const monthly = {
      ...DEFAULT_RANKING_POLICY,
      season: { ...DEFAULT_RANKING_POLICY.season, cadence: "monthly" as const },
    };
    const scheduled = await schedulePolicy(monthly, "admin", new Date("2026-08-18T04:00:00.000Z"));
    expect(scheduled.ok).toBe(true);

    const result = await refreshRanking(new Date(WEEK_END.getTime() + 1));
    expect(result).toMatchObject({ createdSeason: true, closedSeasons: 1 });

    const seasons = await db.select().from(rankingSeasons).orderBy(asc(rankingSeasons.startsAt));
    expect(seasons).toHaveLength(2);
    expect(seasons[0]).toMatchObject({ key: "2026-W34", state: "closed" });
    expect(seasons[0].closedAt).toEqual(WEEK_END);
    expect(seasons[1]).toMatchObject({
      key: "2026-08-transition-20260824",
      cadence: "monthly",
      state: "active",
      isTransition: true,
    });
    expect(seasons[1].startsAt).toEqual(WEEK_END);
    expect(seasons[1].endsAt.toISOString()).toBe("2026-08-31T15:00:00.000Z");

    const finalized = await db
      .select()
      .from(rankingEntries)
      .where(eq(rankingEntries.seasonId, seasons[0].id));
    expect(finalized).toHaveLength(1);
    expect(finalized[0].finalizedAt).toEqual(WEEK_END);

    const revisions = await db
      .select()
      .from(rankingPolicyRevisions)
      .orderBy(asc(rankingPolicyRevisions.id));
    expect(revisions.map((revision) => revision.state)).toEqual(["applied", "applied"]);
    expect(revisions[1].appliedAt).toEqual(WEEK_END);
  });

  it("does not apply a policy created after a missed boundary retroactively", async () => {
    await insertProduct("verified-a");
    await refreshRanking(NOW);
    const monthly = {
      ...DEFAULT_RANKING_POLICY,
      season: { ...DEFAULT_RANKING_POLICY.season, cadence: "monthly" as const },
    };
    const createdAfterBoundary = new Date("2026-08-24T00:00:00.000Z");
    const scheduled = await schedulePolicy(monthly, "admin", createdAfterBoundary);
    expect(scheduled.ok).toBe(true);

    await refreshRanking(new Date(WEEK_END.getTime() + 1));

    let active = await db.query.rankingSeasons.findFirst({
      where: eq(rankingSeasons.state, "active"),
    });
    expect(active).toMatchObject({ key: "2026-W35", cadence: "weekly" });
    expect(await db.$count(
      rankingPolicyRevisions,
      eq(rankingPolicyRevisions.state, "scheduled"),
    )).toBe(1);

    await refreshRanking(new Date("2026-08-30T15:00:00.001Z"));
    active = await db.query.rankingSeasons.findFirst({
      where: eq(rankingSeasons.state, "active"),
    });
    expect(active).toMatchObject({ cadence: "monthly", isTransition: true });
    expect(await db.$count(
      rankingPolicyRevisions,
      eq(rankingPolicyRevisions.state, "scheduled"),
    )).toBe(0);
  });

  it("applies the 3500 Top 3 cooldown factor in the next season", async () => {
    await insertProduct("winner");
    await db.insert(clickEvents).values({
      slug: "winner",
      occurredAt: new Date("2026-08-18T02:00:00.000Z"),
    });
    await refreshRanking(NOW);

    await refreshRanking(new Date(WEEK_END.getTime() + 1));

    const active = await db.query.rankingSeasons.findFirst({
      where: eq(rankingSeasons.state, "active"),
    });
    expect(active).toBeDefined();
    const [entry] = await db
      .select()
      .from(rankingEntries)
      .where(eq(rankingEntries.seasonId, active!.id));
    expect(entry.cooldownFactorBasisPoints).toBe(3500);
  });

  it("cancels corrupt scheduled JSON and inherits the known-good active policy", async () => {
    await insertProduct("verified-a");
    await refreshRanking(NOW);
    const monthly = {
      ...DEFAULT_RANKING_POLICY,
      season: { ...DEFAULT_RANKING_POLICY.season, cadence: "monthly" as const },
    };
    const scheduled = await schedulePolicy(monthly, "admin", new Date("2026-08-18T04:00:00.000Z"));
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) throw new Error("expected scheduled policy");
    await db
      .update(rankingPolicyRevisions)
      .set({ values: { invalid: true } as never })
      .where(eq(rankingPolicyRevisions.id, scheduled.revision.id));

    await refreshRanking(new Date(WEEK_END.getTime() + 1));

    const active = await db.query.rankingSeasons.findFirst({
      where: eq(rankingSeasons.state, "active"),
    });
    expect(active).toMatchObject({ cadence: "weekly", policySnapshot: DEFAULT_RANKING_POLICY });
    const corrupt = await db.query.rankingPolicyRevisions.findFirst({
      where: eq(rankingPolicyRevisions.id, scheduled.revision.id),
    });
    expect(corrupt?.state).toBe("cancelled");
  });

  it("rolls back a failed snapshot and lets the job runner record the error", async () => {
    await insertProduct("verified-a");
    await db.insert(clickEvents).values({
      slug: "verified-a",
      occurredAt: new Date("2026-08-18T02:00:00.000Z"),
    });
    await refreshRanking(NOW);

    const beforeSeason = await db.query.rankingSeasons.findFirst();
    const beforeEntries = await db.select().from(rankingEntries);
    await db.execute(sql`ALTER TABLE click_events RENAME COLUMN occurred_at TO unavailable_at`);

    try {
      const result = await runJob("ranking-refresh", refreshRankings);
      expect(result.status).toBe("failed");
    } finally {
      await db.execute(sql`ALTER TABLE click_events RENAME COLUMN unavailable_at TO occurred_at`);
    }

    const afterSeason = await db.query.rankingSeasons.findFirst();
    const afterEntries = await db.select().from(rankingEntries);
    expect(afterSeason?.refreshedAt).toEqual(beforeSeason?.refreshedAt);
    expect(afterEntries).toEqual(beforeEntries);
    const job = await db.query.jobs.findFirst({ where: eq(jobs.name, "ranking-refresh") });
    expect(job?.lastError).toContain("click_events");
  });

  it("materializes eligible sets above PostgreSQL's bind-parameter limit", async () => {
    const count = 5_958;
    const rows = Array.from({ length: count }, (_, index) => ({
      slug: `large-${String(index).padStart(4, "0")}`,
      url: `https://large-${index}.test`,
      name: `large-${index}`,
      tagline: "소개",
      description: "설명",
      category: "Other",
      stack: [] as string[],
      status: "verified" as const,
      source: "skill" as const,
      verifyToken: `nmv_verify_large_${index}`,
      verifiedAt: new Date("2026-08-01T00:00:00.000Z"),
      editTokenHash: "x".repeat(64),
    }));
    for (let index = 0; index < rows.length; index += 500) {
      await db.insert(products).values(rows.slice(index, index + 500));
    }

    const result = await refreshRanking(NOW);

    expect(result.entries).toBe(count);
    expect(await db.$count(rankingEntries)).toBe(count);
  }, 30_000);
});
