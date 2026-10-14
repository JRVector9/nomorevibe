import { expect, it } from "vitest";
import { DEFAULT_CRAWL_SETTINGS, crawlSettingsSchema } from "@/lib/crawl/settings-schema";

it("has separate collection, presentation and eligibility switches", () => {
  expect(crawlSettingsSchema.parse(DEFAULT_CRAWL_SETTINGS)).toHaveProperty("agentEvidence", {
    enabled: false, enforceEligibility: false, displayObservedFacts: false, backgroundRefreshDays: 1,
    detectorVersion: "2026-09-14.1", policyVersion: "2026-09-06.1",
  });
});

it('preserves daily refresh for legacy settings and accepts bounded background intervals', () => {
  const legacy = { ...DEFAULT_CRAWL_SETTINGS, agentEvidence: {
    enabled: true, enforceEligibility: false, displayObservedFacts: false,
    detectorVersion: '2026-09-14.1', policyVersion: '2026-09-06.1',
  } };
  expect(crawlSettingsSchema.parse(legacy).agentEvidence.backgroundRefreshDays).toBe(1);
  for (const days of [1, 90, 365]) expect(crawlSettingsSchema.parse({ ...legacy,
    agentEvidence: { ...legacy.agentEvidence, backgroundRefreshDays: days } }).agentEvidence.backgroundRefreshDays).toBe(days);
  for (const days of [0, 366, 1.5]) expect(crawlSettingsSchema.safeParse({ ...legacy,
    agentEvidence: { ...legacy.agentEvidence, backgroundRefreshDays: days } }).success).toBe(false);
});
