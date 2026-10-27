import { expect, it } from "vitest";
import type { SecondReview } from "@/lib/db/schema";
import { capacityBlocksStaleReconcile, staleFallbackRootIds, staleReviewCursorAfterPage } from "@/lib/crawl/second-review-stale";

const now = new Date("2026-10-27T05:00:00Z");
it.each(["dispatched", "indeterminate", "unknown"])("protects %s capacity regardless of elapsed time", state => {
  expect(capacityBlocksStaleReconcile({ state, reservedUntil: new Date(0) }, now)).toBe(true);
});
it.each([null, "malformed", new Date(NaN)])("protects a reservation with an unreadable time (%s)", reservedUntil => {
  expect(capacityBlocksStaleReconcile({ state: "reserved", reservedUntil }, now)).toBe(true);
});
it("distinguishes expired reservations from live reservations and unsent waits", () => {
  expect(capacityBlocksStaleReconcile({ state: "reserved", reservedUntil: new Date(+now - 1) }, now)).toBe(false);
  expect(capacityBlocksStaleReconcile({ state: "reserved", reservedUntil: new Date(+now + 1) }, now)).toBe(true);
  expect(capacityBlocksStaleReconcile({ state: "waiting", reservedUntil: null }, now)).toBe(false);
});
it("advances beyond a valid bounded prefix and wraps only after the final page is fully consumed", () => {
  expect(staleReviewCursorAfterPage([79, 80], 2, 2)).toBe(80);
  expect(staleReviewCursorAfterPage([81, 82], 1, 25)).toBe(81);
  expect(staleReviewCursorAfterPage([81, 82], 2, 25)).toBe(0);
  expect(staleReviewCursorAfterPage([], 0, 25)).toBe(0);
});
it("carries an unfinished fallback chain while preserving completed and foreign bindings", () => {
  const root = { id: 1, candidateId: 11, publishedSlug: "app", fallbackForId: null, generationKey: "old", inputHash: "old",
    status: "resolved", resolution: "fallback" } as SecondReview;
  const child = { ...root, id: 2, fallbackForId: 1, status: "pending", resolution: null } as SecondReview;
  const history = { ...child, id: 3, status: "resolved", resolution: "fallback" } as SecondReview;
  expect(staleFallbackRootIds([root, child, history], [child])).toEqual([1]);
  expect(staleFallbackRootIds([root, child, { ...history, status: "needs_human" }], [child])).toEqual([]);
  expect(staleFallbackRootIds([root, { ...child, candidateId: 12 }], [{ ...child, candidateId: 12 }])).toEqual([]);
});
