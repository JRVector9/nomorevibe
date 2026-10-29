import { expect, it } from "vitest";
import { sourceBufferAdmission } from "@/lib/crawl/source-buffer";
import { DEFAULT_CRAWL_SETTINGS, crawlSettingsSchema } from "@/lib/crawl/settings-schema";
import type { ReviewBacklogSnapshot } from "@/lib/crawl/review-backlog";

const wall = "2026-10-16T03:04:05.123Z";
const snapshot = (downstreamRepositories = 0, queuedRepositories = downstreamRepositories): ReviewBacklogSnapshot =>
  ({ recentNew: 0, queuedRepositories, downstreamRepositories });

it.each([false, true])("uses the configured cap and clears previous pressure below it (prior=%s)", prior => {
  for (const waiting of [500, 1000, 999999]) {
    expect(sourceBufferAdmission(snapshot(waiting), prior, wall)).toMatchObject({ blocked: false, reason: "ready" });
  }
  expect(sourceBufferAdmission(snapshot(1000000), prior, wall)).toMatchObject({ blocked: true, reason: "count_pressure" });
  expect(sourceBufferAdmission(snapshot(500), prior, wall, 500)).toMatchObject({ blocked: true });
});
it("keeps draining unfetched discovery items even when the overall queue is full", () => {
  expect(sourceBufferAdmission(snapshot(0, 1000000), false, wall).blocked).toBe(false);
});
it("blocks unknown depth without inventing available capacity", () => {
  expect(sourceBufferAdmission({ ...snapshot(), timedOut: true }, false, wall)).toMatchObject({ blocked: true, reason: "measurement_unknown", R: null });
});
it("does not mutate the original snapshot", () => {
  const original = snapshot(500), before = structuredClone(original);
  sourceBufferAdmission(original, true, wall);
  expect(original).toEqual(before);
});
it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])("rejects invalid queue count %s", waiting => {
  expect(() => sourceBufferAdmission(snapshot(waiting), false, wall)).toThrow("invalid_source_buffer_snapshot");
});
it.each(["invalid", "2026-10-16T03:04:05+00:00"])("rejects noncanonical wall %s", time => {
  expect(() => sourceBufferAdmission(snapshot(), false, time)).toThrow("invalid_source_buffer_wall");
});
it("keeps the additive gate disabled for existing settings", () => {
  expect(crawlSettingsSchema.parse(DEFAULT_CRAWL_SETTINGS).discover).toHaveProperty("sourceBuffer.enabled", false);
});
