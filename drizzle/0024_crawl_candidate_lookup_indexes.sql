-- 운영 표 3개(category_decisions 등)는 0023 이 이미 만든다. 0023 에 스냅숏이 없어 generate 가 다시 만들려 한 문장을 뺐다.
-- IF NOT EXISTS: 운영 DB 에 같은 이름으로 먼저 만들어 둔 인덱스가 있으면 건너뛴다.
-- CONCURRENTLY 는 쓸 수 없다 — 마이그레이터가 밀린 마이그레이션 전체를 한 트랜잭션으로 돌린다. 쓰기 잠금이 부담이면
-- 배포 전에 같은 이름으로 CREATE INDEX CONCURRENTLY 를 먼저 돌리고 pg_index.indisvalid 를 확인한다.
CREATE INDEX IF NOT EXISTS "crawl_candidates_published_slug_idx" ON "crawl_candidates" USING btree ("published_slug","repo") WHERE "crawl_candidates"."published_slug" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crawl_candidates_state_id_idx" ON "crawl_candidates" USING btree ("state","id");
