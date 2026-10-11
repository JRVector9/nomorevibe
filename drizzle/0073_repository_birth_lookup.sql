CREATE INDEX "crawl_documents_repository_birth_lookup_idx" ON "crawl_documents" USING btree (lower("repo"), "fetched_at" DESC, "id" DESC);
