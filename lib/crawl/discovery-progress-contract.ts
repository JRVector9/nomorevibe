/** Versioned observations shared by the discovery writers and replica-only operator projection. */
export const DISCOVERY_PROGRESS_PREFIX = "discovery-progress:";
export const DISCOVERY_PROGRESS_COUNTERS = ["searchRequests", "pagesVisited", "returned", "examined", "existing", "discovered",
  "pageDuplicates", "cacheHits", "incomplete", "koreanYes", "koreanNo", "koreanUnknown"] as const;
export type DiscoveryProgressCounter = typeof DISCOVERY_PROGRESS_COUNTERS[number];
