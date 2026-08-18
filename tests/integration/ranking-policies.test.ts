import { asc, count } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { rankingPolicyRevisions } from "@/lib/db/schema";
import {
  cancelScheduledPolicy,
  ensureDefaultPolicy,
  getScheduledPolicy,
  listPolicyRevisions,
  schedulePolicy,
} from "@/lib/domain/ranking/policies";
import { DEFAULT_RANKING_POLICY } from "@/lib/domain/ranking/policy";
import { logger } from "@/lib/observability/logger";
import { ensureSchema, resetTables } from "./setup";

beforeAll(() => ensureSchema());
beforeEach(() => resetTables());

describe("ranking policy revisions", () => {
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
