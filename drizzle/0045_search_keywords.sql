-- 검색 키워드(모델이 적은 한·영 검색어)와 카테고리 이름을 색인에 넣는다 — 둘 다 무게 C.
-- product_search_profiles 가 키워드의 원본이고 products.search_keywords 는 색인용 사본이다.
-- 생성 컬럼은 지우지 않고 식만 바꾼다(PG17 SET EXPRESSION). products 를 한 번 다시 쓰는 동안 수 초 잠긴다.
CREATE TABLE "product_search_profiles" (
	"product_id" integer PRIMARY KEY NOT NULL,
	"keywords_en" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"keywords_ko" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model" varchar(160) DEFAULT '' NOT NULL,
	"source_hash" varchar(64) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(60),
	"retry_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_search_profiles" ADD CONSTRAINT "product_search_profiles_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "search_keywords" text;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "search_category" text;--> statement-breakpoint
ALTER TABLE "products" ALTER COLUMN "search_vector" SET EXPRESSION AS (
    setweight(to_tsvector('english', name), 'A') ||
    setweight(to_tsvector('english', coalesce(search_topics, '')), 'A') ||
    setweight(to_tsvector('english', tagline), 'B') ||
    setweight(to_tsvector('english', case when description = tagline then '' else description end), 'B') ||
    setweight(to_tsvector('english', slug || ' ' ||
      coalesce(regexp_replace(repo_url, '^https?://[^/]+/', ''), '') || ' ' ||
      coalesce(replace(regexp_replace(repo_url, '^https?://[^/]+/', ''), '/', ' '), '') || ' ' ||
      case when source <> 'crawler' or claimed_at is not null then coalesce(builder, '') else '' end), 'C') ||
    setweight(to_tsvector('english', left(coalesce(search_page_text, ''), 2000)), 'D') ||
    setweight(to_tsvector('english', left(coalesce(search_readme, ''), 2000)), 'D') ||
    setweight(to_tsvector('english', coalesce(search_keywords, '')), 'C') ||
    setweight(to_tsvector('english', coalesce(search_category, '')), 'C'));
