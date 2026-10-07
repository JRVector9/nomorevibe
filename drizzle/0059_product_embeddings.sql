-- 의미 검색 — 공개 제품의 글을 bge-m3 로 임베딩해 둔다(2026-10-07 실험: 낱말 검색과 섞고 재정렬하면 정답 60 질의 nDCG@10 0.725 → 0.832).
-- vector 는 trusted 확장이 아니라 슈퍼유저만 만든다. 프로드는 운영자가 먼저 만들었다(0.8.6) — 이미 있으면 권한 확인 없이 넘어간다.
-- 테스트·로컬 DB 는 pgvector 이미지(pgvector/pgvector:0.8.6-pg17)의 슈퍼유저라 여기서 만든다
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
-- 색인은 두지 않는다 — 3만5천 행을 다 재는 것이 정확하고(실험과 같은 결과), 카테고리 같은 거르기를 그대로 건다.
-- halfvec 은 행당 2KB(float 의 절반)이고 순위는 실험의 float 결과와 같다
CREATE TABLE IF NOT EXISTS "product_embeddings" (
	"product_id" integer PRIMARY KEY NOT NULL,
	"model" varchar(80) NOT NULL,
	"text_hash" varchar(32) NOT NULL,
	"embedding" halfvec(1024) NOT NULL,
	"embedded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_embeddings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action
);
