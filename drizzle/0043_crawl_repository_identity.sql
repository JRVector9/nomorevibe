-- Historical case aliases remain as audit records. Application identity locks serialize new discovery.
CREATE INDEX "crawl_frontier_identity_idx" ON "crawl_frontier" (lower("repo"));
--> statement-breakpoint
CREATE INDEX "products_repository_identity_idx" ON "products"
  (regexp_replace(regexp_replace(lower(rtrim("repo_url", '/')), '^https?://(www[.])?', 'https://'), '[.]git$', ''));
