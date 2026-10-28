import { beforeEach, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { crawlSettingsSchema, DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { transaction: mocks.transaction } }));
const { readReviewBacklog, readReviewBacklogInTransaction, reviewBacklogAdmission } = await import("@/lib/crawl/review-backlog");
const snapshot = (queuedRepositories = 0, recentNew = 0) => ({ queuedRepositories, recentNew, downstreamRepositories: 0 });
beforeEach(() => {
  mocks.transaction.mockReset().mockImplementation((load, options) => {
    expect(options).toMatchObject({ accessMode: "read only", isolationLevel: "repeatable read" });
    return load({ execute: mocks.execute });
  });
  mocks.execute.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([snapshot(2600)]);
});
it("defaults old saved settings to a million and validates the admin range", () => {
  const discover = { ...DEFAULT_CRAWL_SETTINGS.discover } as Record<string, unknown>;
  delete discover.maxReviewBacklog;
  expect(crawlSettingsSchema.parse({ ...DEFAULT_CRAWL_SETTINGS, discover }).discover.maxReviewBacklog).toBe(1000000);
  for (const maxReviewBacklog of [0, -1, 0.5, 10000001, Infinity]) {
    expect(crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS, discover: { ...discover, maxReviewBacklog } }).success).toBe(false);
  }
});
it("maintains discovery below the queue cap regardless of old count and age thresholds", () => {
  for (const depth of [500, 1000, 2600, 999000]) {
    expect(reviewBacklogAdmission(snapshot(depth), 3000, 1000000)).toEqual({ throttled: false, remainingNew: 250 });
  }
});
it("limits new insertions to remaining places and resumes after draining or raising the cap", () => {
  expect(reviewBacklogAdmission(snapshot(999999), 3000, 1000000)).toEqual({ throttled: false, remainingNew: 1 });
  expect(reviewBacklogAdmission(snapshot(1000000), 3000, 1000000)).toEqual({ throttled: true, remainingNew: 0 });
  expect(reviewBacklogAdmission(snapshot(1000001), 3000, 1000000).remainingNew).toBe(0);
  expect(reviewBacklogAdmission(snapshot(1000000), 3000, 2000000).remainingNew).toBe(250);
  expect(reviewBacklogAdmission(snapshot(250), 3000, 200).remainingNew).toBe(0);
});
it("preserves hourly rate control and stops discovery when depth is unknown", () => {
  expect(reviewBacklogAdmission(snapshot(2600, 249), 3000, 1000000).remainingNew).toBe(1);
  expect(reviewBacklogAdmission(snapshot(2600, 250), 3000, 1000000).remainingNew).toBe(0);
  expect(reviewBacklogAdmission({ ...snapshot(), timedOut: true }, 3000, 1000000).remainingNew).toBe(0);
});
it("reads unique stored work without semantic vote windows, job pause or retry-time filters", async () => {
  expect(await readReviewBacklog()).toEqual(snapshot(2600));
  const query = new PgDialect().sqlToQuery(mocks.execute.mock.calls[1][0]);
  expect(query.sql).toContain("union");
  expect(query.sql).toContain("'pending', 'fetching'");
  expect(query.sql).toContain("'new', 'approved', 'needs_review'");
  expect(query.sql).not.toMatch(/retry_after|next_attempt_at|second_reviews|not_before|limit 1000/);
});
it.each(["57014", "55P03", "DB_POOL_WAIT_TIMEOUT"])("fails closed on read timeout %s", async code => {
  mocks.transaction.mockRejectedValue(new Error("query failed", { cause: { code } }));
  expect(await readReviewBacklog()).toMatchObject({ timedOut: true });
});
it("does not hide unrelated database errors", async () => {
  mocks.transaction.mockRejectedValue(new Error("missing table"));
  await expect(readReviewBacklog()).rejects.toThrow("missing table");
});
it("checks the shared deadline before starting another read", async () => {
  await expect(readReviewBacklogInTransaction({ execute: mocks.execute } as never, new Date(), Date.now() - 1)).rejects.toThrow("review_backlog_deadline");
  expect(mocks.execute).not.toHaveBeenCalled();
});
