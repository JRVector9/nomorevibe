ALTER TABLE "crawl_frontier" ADD COLUMN "alias_of" varchar(200);--> statement-breakpoint
CREATE INDEX "crawl_documents_github_id_idx" ON "crawl_documents" (("repo_meta"->>'id'));
