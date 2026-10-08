-- 공개 제품의 GitHub 저장소를 하루 한 번 모두 본다(product-stars-refresh 가 GraphQL 로 100개씩 묻는다).
-- repo_status 에 'empty'(커밋 없는 빈 저장소)가 더해진다 — 열은 varchar(16) 그대로다.
-- 보관·마지막 push·바뀐 이름은 기록만 한다(공개 화면에 영향 없음). 값이 없는 열만 더하므로 표를 다시 쓰지 않고,
-- 옛 워커·웹은 이 열과 표를 모르고 그대로 돈다
ALTER TABLE "products" ADD COLUMN "repo_archived" boolean;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "repo_pushed_at" timestamp;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "repo_renamed_to" varchar(160);--> statement-breakpoint
-- 저장소 답(상태·보관·바뀐 이름)이 앞선 확인과 달라진 마지막 시각 — 운영센터의 '오늘 새로'. 첫 기록은 바뀐 것으로 치지 않는다
ALTER TABLE "products" ADD COLUMN "repo_changed_at" timestamp;--> statement-breakpoint
-- 가장 오래 확인하지 않은 것부터 집는 순서 — 공개·저장소 있는 행만(3만7천 행, 1초 안쪽)
CREATE INDEX "products_repo_check_idx" ON "products" USING btree ("repo_checked_at" NULLS FIRST,"id") WHERE "products"."status" in ('seeded', 'verified') and "products"."repo_url" is not null;--> statement-breakpoint
-- 저장소가 사라졌거나 빈 웹사이트 제품의 2단계 확인(product-repo-review). 아무것도 자동으로 가리지 않는다 —
-- keep 만 저절로 끝나고 나머지는 운영자가 유지·내리기를 고른다
CREATE TABLE IF NOT EXISTS "product_repo_reviews" (
	"product_id" integer PRIMARY KEY NOT NULL,
	"decision" varchar(20) NOT NULL,
	"reason" varchar(40) NOT NULL,
	"answers" jsonb,
	"model" varchar(80),
	"page_http_status" integer,
	"final_url" text,
	"page_title" varchar(300),
	"page_excerpt" varchar(600),
	"reviewed_at" timestamp DEFAULT now() NOT NULL,
	"next_review_at" timestamp,
	"operator_decision" varchar(10),
	"operator_by" varchar(120),
	"operator_at" timestamp,
	CONSTRAINT "product_repo_reviews_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action
);
