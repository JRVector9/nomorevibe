-- 검색 문서 + GIN 색인. products 에는 전문 색인이 하나도 없었다 — 검색어가 붙으면 10,751행을 매번 훑었다.
-- 생성 컬럼을 더하면 표를 통째로 다시 쓴다(ACCESS EXCLUSIVE). 공개 10,751행이면 몇 초짜리지만,
-- CONCURRENTLY 는 여기서 쓸 수 없다 — 마이그레이터가 밀린 마이그레이션 전체를 한 트랜잭션으로 돌린다(0024 주석과 같다).
-- 적용 직후 search_topics·search_page_text 는 전부 null 이라 이름·소개·식별자만으로 찾힌다.
-- 토픽과 본문은 product-search-refresh 잡이 1분마다 1,000행씩 채운다(약 11분).
ALTER TABLE "products" ADD COLUMN "search_topics" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "search_page_text" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (
    setweight(to_tsvector('english', name), 'A') ||
    setweight(to_tsvector('english', coalesce(search_topics, '')), 'A') ||
    setweight(to_tsvector('english', tagline), 'B') ||
    setweight(to_tsvector('english', case when description = tagline then '' else description end), 'B') ||
    setweight(to_tsvector('english', slug || ' ' ||
      coalesce(regexp_replace(repo_url, '^https?://[^/]+/', ''), '') || ' ' ||
      coalesce(replace(regexp_replace(repo_url, '^https?://[^/]+/', ''), '/', ' '), '') || ' ' ||
      case when source <> 'crawler' or claimed_at is not null then coalesce(builder, '') else '' end), 'C') ||
    setweight(to_tsvector('english', left(coalesce(search_page_text, ''), 2000)), 'D')) STORED;--> statement-breakpoint
CREATE INDEX "products_search_idx" ON "products" USING gin ("search_vector");