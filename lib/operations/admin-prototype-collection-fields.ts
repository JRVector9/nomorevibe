import type { CrawlSettings } from "@/lib/crawl/settings-schema";
export type PrototypeCollectionSettings = {
  discover: Pick<CrawlSettings["discover"],"queries"|"windowDays"|"sort"|"pagesPerTick"|"maxNewPerHour"|"maxReviewBacklog"|"showHn"|"showGn">;
  judge: Pick<CrawlSettings["judge"],"autoApproveMinStars"|"minStars"|"maxPushAgeDays"|"excludeForks"|"excludeOrganizations"|"blockedHomepageDomains"|"thirdPartyHosts"|"stubPageTitles"|"excludedRepoPatterns"|"heldRepoPatterns"|"holdAmbiguous"|"stubTextRules">;
  secondReview: Pick<CrawlSettings["secondReview"],"enabled"|"includeAiHeld"|"sampleRate"|"agreeAt">;
  reviewConcurrency:CrawlSettings["reviewConcurrency"];agentEvidence:Pick<CrawlSettings["agentEvidence"],"enabled"|"enforceEligibility">;rising:Pick<CrawlSettings["rising"],"freshDays">;
};
/** Client form receives only its existing action's public settings contract, not unrelated runtime/model data. */
export function prototypeCollectionSettings(settings:CrawlSettings):PrototypeCollectionSettings {
  const {discover,judge,secondReview,reviewConcurrency,agentEvidence,rising}=settings;
  return {
    discover:{queries:discover.queries,windowDays:discover.windowDays,sort:discover.sort,pagesPerTick:discover.pagesPerTick,maxNewPerHour:discover.maxNewPerHour,maxReviewBacklog:discover.maxReviewBacklog,showHn:discover.showHn,showGn:discover.showGn},
    judge:{autoApproveMinStars:judge.autoApproveMinStars,minStars:judge.minStars,maxPushAgeDays:judge.maxPushAgeDays,excludeForks:judge.excludeForks,excludeOrganizations:judge.excludeOrganizations,blockedHomepageDomains:judge.blockedHomepageDomains,thirdPartyHosts:judge.thirdPartyHosts,stubPageTitles:judge.stubPageTitles,excludedRepoPatterns:judge.excludedRepoPatterns,heldRepoPatterns:judge.heldRepoPatterns,holdAmbiguous:judge.holdAmbiguous,stubTextRules:judge.stubTextRules},
    secondReview:{enabled:secondReview.enabled,includeAiHeld:secondReview.includeAiHeld,sampleRate:secondReview.sampleRate,agreeAt:secondReview.agreeAt},reviewConcurrency,agentEvidence:{enabled:agentEvidence.enabled,enforceEligibility:agentEvidence.enforceEligibility},rising:{freshDays:rising.freshDays},
  };
}

/** Serialize the existing full-form contract so editing the small prototype form preserves every untouched setting. */
export function prototypeCollectionFields(settings: PrototypeCollectionSettings): Record<string, string> {
  const { discover, judge, secondReview } = settings;
  const fields: Record<string, string> = {
    queryCount: String(discover.queries.length), windowDays: String(discover.windowDays), sort: discover.sort,
    pagesPerTick: String(discover.pagesPerTick), maxNewPerHour: String(discover.maxNewPerHour), maxReviewBacklog: String(discover.maxReviewBacklog),
    autoApproveMinStars: String(judge.autoApproveMinStars), minStars: String(judge.minStars), maxPushAgeDays: String(judge.maxPushAgeDays),
    stubTextRules: judge.stubTextRules, blockedHomepageDomains: judge.blockedHomepageDomains.join("\n"), thirdPartyHosts: judge.thirdPartyHosts.join("\n"),
    stubPageTitles: judge.stubPageTitles.join("\n"), excludedRepoPatterns: judge.excludedRepoPatterns.join("\n"), heldRepoPatterns: judge.heldRepoPatterns.join("\n"),
    reviewConcurrency: String(settings.reviewConcurrency), secondReviewSamplePercent: String(secondReview.sampleRate * 100), secondReviewAgreeAt: String(secondReview.agreeAt),
    "showGn.priority": String(discover.showGn.priority),
    "showHn.priority": String(discover.showHn.priority), risingFreshDays: String(settings.rising.freshDays),
  };
  const booleans = { excludeForks: judge.excludeForks, excludeOrganizations: judge.excludeOrganizations, holdAmbiguous: judge.holdAmbiguous,
    secondReviewEnabled: secondReview.enabled, secondReviewIncludeAiHeld: secondReview.includeAiHeld,
    agentEvidenceEnabled: settings.agentEvidence.enabled, agentEvidenceEnforce: settings.agentEvidence.enforceEligibility,
    "showGn.enabled": discover.showGn.enabled, "showGn.requireEvidence": discover.showGn.requireEvidence,
    "showHn.enabled": discover.showHn.enabled, "showHn.requireEvidence": discover.showHn.requireEvidence };
  for (const [key, enabled] of Object.entries(booleans)) if (enabled) fields[key] = "on";
  discover.queries.forEach((query, index) => {
    const prefix = `query.${index}.`;
    Object.assign(fields, { [prefix + "label"]: query.label, [prefix + "kind"]: query.kind, [prefix + "query"]: query.query,
      [prefix + "priority"]: String(query.priority), [prefix + "builder"]: query.builder ?? "" });
    if (query.enabled) fields[prefix + "enabled"] = "on";
    if (query.requireEvidence) fields[prefix + "requireEvidence"] = "on";
  });
  return fields;
}
