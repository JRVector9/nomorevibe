-- 소개 수정 요청(2026-10-08 UX 감사 UX-18) — 주인 없는 제품의 운영자가 상세의 요청 폼에서 한 줄 소개를 고쳐 달라고 한다.
-- 내려달라는 요청(takedown_requests)과 따로 둔다 — 그 표는 제품마다 한 행이라 덮이고, 처리 전 행이 있으면 상세가 곧바로
-- noindex 가 되고 CDN 지우기가 적힌다(indexing.ts 2번, takedown.ts). 소개 수정 요청은 노출에 아무 영향이 없어야 한다.
-- 요청마다 한 행이 쌓인다. 보낸이는 내려달라는 요청과 같은 해시만 남긴다(접속 주소 원문은 남기지 않는다). 연락처는 받지 않는다(D5).
-- 표만 만든다 — 아무것도 채우지 않는다. 옛 웹·워커는 이 표를 모르고 그대로 돈다
CREATE TABLE IF NOT EXISTS "intro_correction_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"product_id" integer NOT NULL,
	"slug" varchar(80) NOT NULL,
	"message" varchar(500) NOT NULL,
	"requester_hash" varchar(64),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"handled_at" timestamp,
	"handled_by" varchar(120),
	"outcome" varchar(20),
	"note" text,
	CONSTRAINT "intro_correction_requests_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
-- 처리 전 요청 — 관리자 목록과 제품마다 쌓인 수(장난 막기)만 찾는다
CREATE INDEX IF NOT EXISTS "intro_correction_requests_pending_idx" ON "intro_correction_requests" USING btree ("product_id") WHERE "intro_correction_requests"."handled_at" is null;
