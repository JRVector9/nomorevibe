-- Admission first removes byte-identical document/candidate pairs, then probes
-- this index for the remaining case variants. Preserve non-unique identities.
CREATE INDEX "crawl_candidates_identity_idx" ON "crawl_candidates" (lower("repo"));
--> statement-breakpoint
-- Rate admission reads a five-minute discovery window, regardless of queue state.
CREATE INDEX "crawl_frontier_admission_recent_idx" ON "crawl_frontier" ("discovered_at")
WHERE "alias_of" IS NULL
  AND "signal" NOT IN ('review-source-refresh', 'star-auto-source-refresh', 'admin-evidence-refresh');
