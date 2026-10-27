import { expect, it } from "vitest";
import { discoveryAdmission, type DiscoveryAdmissionSnapshot } from "@/lib/crawl/discovery-admission";
import { crawlSettingsSchema, DEFAULT_CRAWL_SETTINGS } from "@/lib/crawl/settings-schema";

const quiet = (recentNew = 0, extra: Partial<DiscoveryAdmissionSnapshot> = {}): DiscoveryAdmissionSnapshot => ({
  recentNew, stages: [], secondWindowLimited: false, ...extra,
});

it("accepts existing saved settings and bounds the new rate setting", () => {
  const storedDiscover = { ...DEFAULT_CRAWL_SETTINGS.discover } as Record<string, unknown>;
  delete storedDiscover.maxNewPerHour;
  expect(crawlSettingsSchema.parse({ ...DEFAULT_CRAWL_SETTINGS, discover: storedDiscover }).discover.maxNewPerHour).toBe(3_000);
  for (const maxNewPerHour of [59, 3601]) {
    expect(crawlSettingsSchema.safeParse({ ...DEFAULT_CRAWL_SETTINGS,
      discover: { ...DEFAULT_CRAWL_SETTINGS.discover, maxNewPerHour } }).success).toBe(false);
  }
});

it("stops new discovery at the rolling window limit while preserving two-argument callers", () => {
  expect(discoveryAdmission(quiet(), false)).toEqual({ throttled: false, remainingNew: Infinity });
  expect(discoveryAdmission(quiet(), false, 3_000)).toEqual({ throttled: false, remainingNew: 250 });
  expect(discoveryAdmission(quiet(240), false, 3_000)).toEqual({ throttled: false, remainingNew: 10 });
  expect(discoveryAdmission(quiet(250), false, 3_000)).toEqual({ throttled: false, remainingNew: 0 });
  expect(discoveryAdmission(quiet(260), false, 3_000)).toEqual({ throttled: false, remainingNew: 0 });
});

it("uses the smaller pressure or rate allowance and stays closed when measurement is unknown", () => {
  const pressured = quiet(0, { stages: [{ key: "fetch", waiting: 500, oldestMinutes: 5 }] });
  expect(discoveryAdmission(pressured, false, 3_000)).toEqual({ throttled: true, remainingNew: 100 });
  expect(discoveryAdmission(pressured, false, 60)).toEqual({ throttled: true, remainingNew: 5 });
  expect(discoveryAdmission(quiet(0, { timedOut: true }), false, 3_000)).toEqual({ throttled: true, remainingNew: 1 });
  expect(discoveryAdmission(quiet(250, { timedOut: true }), false, 3_000)).toEqual({ throttled: true, remainingNew: 0 });
  expect(discoveryAdmission(quiet(0, { secondVoteWindowLimited: true }), false, 3_000)).toEqual({ throttled: true, remainingNew: 1 });
  expect(discoveryAdmission(quiet(0, { stages: [{ key: "publish", waiting: 1_000, oldestMinutes: 0 }] }), false, 3_000).throttled).toBe(true);
});
