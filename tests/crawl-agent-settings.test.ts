import { expect, it } from "vitest";
import { DEFAULT_CRAWL_SETTINGS, crawlSettingsSchema } from "@/lib/crawl/settings-schema";

it("has separate collection, presentation and eligibility switches", () => {
  expect(crawlSettingsSchema.parse(DEFAULT_CRAWL_SETTINGS)).toHaveProperty("agentEvidence", {
    enabled: false, enforceEligibility: false, displayObservedFacts: false,
    detectorVersion: "2026-09-06.1", policyVersion: "2026-09-06.1",
  });
});
