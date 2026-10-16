import { expect, it } from "vitest";
import { sourceBufferAdmission } from "@/lib/crawl/source-buffer";
import { DEFAULT_CRAWL_SETTINGS, crawlSettingsSchema } from "@/lib/crawl/settings-schema";
import type { AdmissionStage, DiscoveryAdmissionSnapshot } from "@/lib/crawl/discovery-admission";

const wall = "2026-10-16T03:04:05.123Z";
function snapshot(key: AdmissionStage["key"] = "first", waiting = 0, age: number | null = null): DiscoveryAdmissionSnapshot {
  return { recentNew: 0, secondWindowLimited: false,
    stages: (["fetch", "judge", "first", "second", "publish"] as const)
      .map(stage => ({ key: stage, waiting: stage === key ? waiting : 0, oldestMinutes: stage === key ? age : null })) };
}
it.each([
  [499, 99, false, false], [500, 5, false, true], [999, 0, false, false], [1000, 0, false, true],
  [300, 3, true, true], [250, 2, true, false], [499, 0, true, false], [500, 0, true, true],
])("retains count/age hysteresis %s/%s after blocked=%s", (waiting, age, prior, blocked) => {
  expect(sourceBufferAdmission(snapshot("first", waiting, age), prior, wall)).toMatchObject({ blocked,
    reason: blocked ? "count_pressure" : "ready", R: null, targetHours: null, capHours: null, measuredAt: wall });
});
it("does not stop fetch because the unfetched frontier itself is large", () => {
  expect(sourceBufferAdmission(snapshot("fetch", 10000, 120), false, wall).blocked).toBe(false);
});
it.each(["timedOut", "secondWindowLimited", "secondVoteWindowLimited", "secondObservationLimited"] as const)("blocks unknown %s without inventing a rate", flag => {
  expect(sourceBufferAdmission({ ...snapshot(), [flag]: true }, false, wall)).toMatchObject({ blocked: true, reason: "measurement_unknown", R: null });
});
it("blocks a missing downstream stage", () => {
  expect(sourceBufferAdmission({ ...snapshot(), stages: [] }, false, wall)).toMatchObject({ blocked: true, reason: "measurement_unknown" });
});
it("does not mutate the original snapshot", () => {
  const original = snapshot("first", 500, 5), before = structuredClone(original);
  sourceBufferAdmission(original, true, wall);
  expect(original).toEqual(before);
});
it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])("rejects an invalid queue count %s", waiting => {
  expect(() => sourceBufferAdmission(snapshot("first", waiting, 0), false, wall)).toThrow("invalid_source_buffer_snapshot");
});
it.each(["invalid", "2026-10-16T03:04:05+00:00"])("rejects noncanonical wall %s", time => {
  expect(() => sourceBufferAdmission(snapshot(), false, time)).toThrow("invalid_source_buffer_wall");
});
it("keeps the additive gate disabled for existing settings", () => {
  expect(crawlSettingsSchema.parse(DEFAULT_CRAWL_SETTINGS).discover).toHaveProperty("sourceBuffer.enabled", false);
});
