import { asc, count, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import {
  rankingPolicyRevisions,
  visitCollectionState,
} from "@/lib/db/schema";
import {
  cancelScheduledPolicy,
  ensureDefaultPolicy,
  getAppliedPolicy,
  getUniqueCollectionReadiness,
  getScheduledPolicy,
  listPolicyRevisions,
  schedulePolicy,
  transitionPreviewPolicies,
} from "@/lib/domain/ranking/policies";
import {
  DEFAULT_RANKING_POLICY,
  UNIQUE_FIRST_RANKING_POLICY,
  type RankingPolicy,
} from "@/lib/domain/ranking/policy";
import { logger } from "@/lib/observability/logger";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

describe("ranking policy revisions", () => {
  it("reports collection as not ready and rejects unique policy before collection starts", async () => {
    const now = new Date("2026-08-18T03:00:00.000Z");

    expect(await getUniqueCollectionReadiness(now)).toEqual({
      startedAt: null,
      readyAt: null,
      ready: false,
    });
    const result = await schedulePolicy(UNIQUE_FIRST_RANKING_POLICY, "jr", now);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.join(" ")).toContain("집계");
    expect(await listPolicyRevisions()).toHaveLength(0);
  });

  it("rejects unique policy before seven full days but still schedules legacy policy", async () => {
    const startedAt = new Date("2026-08-11T03:00:01.000Z");
    const now = new Date("2026-08-18T03:00:00.000Z");
    await db
      .update(visitCollectionState)
      .set({ uniqueVisitorStartedAt: startedAt })
      .where(eq(visitCollectionState.id, 1));

    expect(await getUniqueCollectionReadiness(now)).toEqual({
      startedAt,
      readyAt: new Date("2026-08-18T03:00:01.000Z"),
      ready: false,
    });
    expect((await schedulePolicy(UNIQUE_FIRST_RANKING_POLICY, "jr", now)).ok).toBe(false);

    const legacy = await schedulePolicy(DEFAULT_RANKING_POLICY, "jr", now);
    expect(legacy.ok).toBe(true);
    expect((await getScheduledPolicy())?.values.scoring.mode).toBe("valid_visits");
  });

  it("allows unique policy at exactly seven days and leaves it future-season scheduled", async () => {
    const startedAt = new Date("2026-08-11T03:00:00.000Z");
    const now = new Date("2026-08-18T03:00:00.000Z");
    await db
      .update(visitCollectionState)
      .set({ uniqueVisitorStartedAt: startedAt })
      .where(eq(visitCollectionState.id, 1));
    await ensureDefaultPolicy("system", new Date("2026-08-01T00:00:00.000Z"));

    expect(await getUniqueCollectionReadiness(now)).toEqual({
      startedAt,
      readyAt: now,
      ready: true,
    });
    const result = await schedulePolicy(UNIQUE_FIRST_RANKING_POLICY, "jr", now);

    expect(result.ok).toBe(true);
    expect((await getAppliedPolicy())?.values.scoring.mode).toBe("valid_visits");
    expect((await getScheduledPolicy())?.values.scoring.mode).toBe("unique_visitors");
    expect((await getScheduledPolicy())?.createdAt).toEqual(now);
  });

  it("builds both comparison modes from the same scheduled form policy", async () => {
    const now = new Date("2026-08-18T03:00:00.000Z");
    const scheduledLegacy = {
      ...DEFAULT_RANKING_POLICY,
      season: { ...DEFAULT_RANKING_POLICY.season, cadence: "monthly" as const },
      eligibility: { ...DEFAULT_RANKING_POLICY.eligibility, launchWindowDays: 35 },
      cooldown: { ...DEFAULT_RANKING_POLICY.cooldown, enabled: false },
    };
    expect((await schedulePolicy(scheduledLegacy, "jr", now)).ok).toBe(true);
    const legacyBase = (await getScheduledPolicy())!.values;
    const legacyComparison = transitionPreviewPolicies(legacyBase);

    expect(legacyComparison.form).toEqual(legacyBase);
    expect(legacyComparison.valid.scoring.mode).toBe("valid_visits");
    expect(legacyComparison.unique.scoring).toEqual(UNIQUE_FIRST_RANKING_POLICY.scoring);
    for (const candidate of [legacyComparison.valid, legacyComparison.unique]) {
      expect(candidate.season).toEqual(legacyBase.season);
      expect(candidate.eligibility).toEqual(legacyBase.eligibility);
      expect(candidate.cooldown).toEqual(legacyBase.cooldown);
    }

    await db
      .update(visitCollectionState)
      .set({ uniqueVisitorStartedAt: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) })
      .where(eq(visitCollectionState.id, 1));
    const scheduledUnique = {
      ...scheduledLegacy,
      scoring: {
        ...UNIQUE_FIRST_RANKING_POLICY.scoring,
        repeatVisitWeightBasisPoints: 4_000,
        maxExtraVisitsPerUnique: 2,
        minimumUniqueVisitors: 3,
      },
      trend: {
        ...scheduledLegacy.trend,
        minimumPreviousUniqueVisitors: 9,
      },
    };
    expect((await schedulePolicy(scheduledUnique, "jr", now)).ok).toBe(true);
    const uniqueBase = (await getScheduledPolicy())!.values;
    const uniqueComparison = transitionPreviewPolicies(uniqueBase);

    expect(uniqueComparison.form).toEqual(uniqueBase);
    expect(uniqueComparison.unique.scoring).toEqual(scheduledUnique.scoring);
    expect(uniqueComparison.unique.trend.minimumPreviousUniqueVisitors).toBe(9);
    expect(uniqueComparison.valid.scoring.mode).toBe("valid_visits");
    for (const candidate of [uniqueComparison.valid, uniqueComparison.unique]) {
      expect(candidate.season).toEqual(uniqueBase.season);
      expect(candidate.eligibility).toEqual(uniqueBase.eligibility);
      expect(candidate.cooldown).toEqual(uniqueBase.cooldown);
    }
  });

  it("normalizes legacy policy JSON on every revision read", async () => {
    const withoutScoring = Object.fromEntries(
      Object.entries(DEFAULT_RANKING_POLICY).filter(([key]) => key !== "scoring"),
    );
    const legacyTrend = Object.fromEntries(
      Object.entries(DEFAULT_RANKING_POLICY.trend)
        .filter(([key]) => key !== "minimumPreviousUniqueVisitors"),
    );
    await db.insert(rankingPolicyRevisions).values({
      values: { ...withoutScoring, trend: legacyTrend } as RankingPolicy,
      state: "applied",
      createdBy: "legacy",
      appliedAt: new Date("2026-08-01T00:00:00.000Z"),
    });

    expect((await getAppliedPolicy())?.values.scoring.mode).toBe("valid_visits");
    expect((await listPolicyRevisions())[0].values.trend.minimumPreviousUniqueVisitors).toBe(5);
  });

  it("creates one applied default policy and reuses it", async () => {
    const now = new Date("2026-08-18T03:00:00.000Z");

    const initial = await ensureDefaultPolicy("system", now);
    const existing = await ensureDefaultPolicy("another-system", new Date(now.getTime() + 1000));

    expect(initial.state).toBe("applied");
    expect(initial.values).toEqual(DEFAULT_RANKING_POLICY);
    expect(initial.createdBy).toBe("system");
    expect(initial.appliedAt).toEqual(now);
    expect(existing.id).toBe(initial.id);
    expect(await listPolicyRevisions()).toHaveLength(1);
  });

  it("selects the revision applied most recently even when it was created earlier", async () => {
    const scheduledAt = new Date("2026-08-18T03:00:00.000Z");
    const scheduled = await schedulePolicy(DEFAULT_RANKING_POLICY, "jr", scheduledAt);
    expect(scheduled.ok).toBe(true);
    if (!scheduled.ok) throw new Error("expected policy scheduling to succeed");

    await ensureDefaultPolicy("system", new Date(scheduledAt.getTime() + 1000));
    const promotedAt = new Date(scheduledAt.getTime() + 2000);
    await db
      .update(rankingPolicyRevisions)
      .set({ state: "applied", appliedAt: promotedAt })
      .where(eq(rankingPolicyRevisions.id, scheduled.revision.id));

    expect((await getAppliedPolicy())?.id).toBe(scheduled.revision.id);
    expect((await ensureDefaultPolicy("system", new Date(scheduledAt.getTime() + 3000))).id)
      .toBe(scheduled.revision.id);
  });

  it("replaces an existing scheduled policy without mutating applied history", async () => {
    const now = new Date("2026-08-18T03:00:00.000Z");
    await ensureDefaultPolicy("system", now);

    const first = await schedulePolicy({
      ...DEFAULT_RANKING_POLICY,
      eligibility: { ...DEFAULT_RANKING_POLICY.eligibility, launchWindowDays: 21 },
    }, "jr", now);
    expect(first.ok).toBe(true);

    const second = await schedulePolicy({
      ...DEFAULT_RANKING_POLICY,
      trend: { ...DEFAULT_RANKING_POLICY.trend, minimumPreviousClicks: 8 },
    }, "jr", new Date(now.getTime() + 1000));

    expect(second.ok).toBe(true);
    expect((await listPolicyRevisions()).map((row) => row.state)).toEqual([
      "applied",
      "cancelled",
      "scheduled",
    ]);
    expect((await getScheduledPolicy())?.values.trend.minimumPreviousClicks).toBe(8);
  });

  it("cancels only the scheduled policy and records the actor in the log", async () => {
    const now = new Date("2026-08-18T03:00:00.000Z");
    await ensureDefaultPolicy("system", now);
    await schedulePolicy(DEFAULT_RANKING_POLICY, "jr", new Date(now.getTime() + 1000));
    const log = vi.spyOn(logger, "info").mockImplementation(() => undefined);

    await cancelScheduledPolicy("admin", new Date(now.getTime() + 2000));

    expect(await getScheduledPolicy()).toBeUndefined();
    const revisions = await db
      .select()
      .from(rankingPolicyRevisions)
      .orderBy(asc(rankingPolicyRevisions.createdAt), asc(rankingPolicyRevisions.id));
    expect(revisions.map((row) => row.state)).toEqual(["applied", "cancelled"]);
    expect(revisions[1].cancelledAt).toEqual(new Date(now.getTime() + 2000));
    expect(log).toHaveBeenCalledWith("ranking.policy_cancelled", { cancelledBy: "admin" });
    log.mockRestore();
  });

  it("returns string issues and inserts nothing for invalid input", async () => {
    const result = await schedulePolicy({
      ...DEFAULT_RANKING_POLICY,
      eligibility: { ...DEFAULT_RANKING_POLICY.eligibility, launchWindowDays: 0 },
    }, "jr");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.every((issue) => typeof issue === "string")).toBe(true);
    }
    const [row] = await db.select({ value: count() }).from(rankingPolicyRevisions);
    expect(row.value).toBe(0);
  });
});
