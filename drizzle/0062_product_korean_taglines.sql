-- 공개 제품의 한국어 한 줄 소개(UX-13, 2026-10-09 운영자 결정 D3) — product-tagline-ko 잡이 지금 소개(products.tagline)를
-- 한국어 한 줄로 옮기고, 코드 검사를 통과한 것만 tagline_ko 에 남긴다. 검사에서 버린 글은 남기지 않고 사유만 error_code 에 적는다.
-- source_tagline 은 옮긴(또는 옮기려 한) 소개다 — 제품 소개가 이것과 다르면 화면이 쓰지 않고 잡이 다시 옮긴다.
-- 새 표만 만든다. 채우는 일은 잡이 한다(이 마이그레이션은 아무것도 채우지 않는다). 옛 웹·워커는 이 표를 모르고 그대로 돈다
CREATE TABLE IF NOT EXISTS "product_korean_taglines" (
	"product_id" integer PRIMARY KEY NOT NULL,
	"source_tagline" varchar(200) NOT NULL,
	"tagline_ko" varchar(120),
	"model" varchar(160) DEFAULT '' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(60),
	"retry_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_korean_taglines_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action
);
