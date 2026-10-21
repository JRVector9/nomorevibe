-- 감사 보류(2026-10-21 운영자 결정) — AI 감사가 높은 확신으로 "제품 아님"이라 한(사유 갈래가 허용 목록에 들거나 두 번째 모델도 거절한)
-- 주인 없는 공개 제품을 사람이 정할 때까지
-- 공개 목록·검색·순위·피드·sitemap 에서 뺀다. 상태(status)는 그대로라 상세 주소는 열리고 색인만 막는다(lib/crawl/product-audit-hold.ts).
-- 0109 와 같이 CONCURRENTLY 는 쓸 수 없다 — 마이그레이터가 밀린 마이그레이션을 한 트랜잭션으로 돌린다.
--
-- 잠금: 기본값 없는 nullable 열 더하기는 표를 다시 쓰지 않는다(카탈로그만 바꾼다). 대신 ACCESS EXCLUSIVE 를 commit 까지 쥔다 —
-- 이 파일(과 함께 도는 0109)이 끝날 때까지 products 읽기·쓰기가 기다린다. 색인 만들기는 products 를 한 번 훑는다(5만 행, 1초 안).
-- 앞선 긴 트랜잭션이 products 를 쥐고 있으면 scripts/migrate.mjs 의 lock_timeout(10s)이 끊고 마이그레이션이 실패한다 — 다시 돌리면 된다.

-- 보류를 건 시각과 그 까닭이 된 감사 항목. 목록 조건은 audit_hold_at is null 한 줄이라 조인 없이 행에서 바로 거른다
ALTER TABLE "products" ADD COLUMN "audit_hold_at" timestamp;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "audit_hold_item_id" integer;
--> statement-breakpoint
-- 사람이 보류를 풀었다(차단 해제·모두 풀기) — 같은 항목으로 다시 보류하지 않는다. 다음 감사의 새 항목은 다시 보류될 수 있다
ALTER TABLE "product_audit_items" ADD COLUMN "hold_released_at" timestamp;
--> statement-breakpoint
-- 관리자 '보류 중' 목록(오래된 것부터)과 수 — 보류된 행만 담아 작다
CREATE INDEX "products_audit_hold_idx" ON "products" ("audit_hold_at", "id") WHERE "audit_hold_at" IS NOT NULL;
--> statement-breakpoint
-- 감사 답에 대한 다른 모델의 두 번째 의견 — 밖에서 돌린 일괄 결과를 scripts/ops/import-audit-second-opinions.ts 가 옮겨 적는다.
-- 두 번째 모델도 거절했으면 사유 갈래와 상관없이 보류의 까닭이 된다. 새 표라 잠금은 product_audit_items 에 거는 외래 키의
-- SHARE ROW EXCLUSIVE 뿐이다(감사 항목 쓰기만 잠깐 기다린다)
CREATE TABLE "product_audit_second_opinions" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"model" varchar(160) NOT NULL,
	"decision" varchar(20) NOT NULL,
	"confidence" real,
	"reason" text,
	"input_hash" varchar(128),
	"source" varchar(40) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "product_audit_second_opinions_decision_check" CHECK ("decision" in ('approve', 'reject', 'needs_review')),
	CONSTRAINT "product_audit_second_opinions_reason_check" CHECK (char_length("reason") <= 2000)
);
--> statement-breakpoint
ALTER TABLE "product_audit_second_opinions" ADD CONSTRAINT "product_audit_second_opinions_item_id_product_audit_items_id_fk"
  FOREIGN KEY ("item_id") REFERENCES "public"."product_audit_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- 같은 (항목, 모델)은 한 줄 — 다시 옮겨 적으면 덮어쓴다
CREATE UNIQUE INDEX "product_audit_second_opinions_item_model_idx" ON "product_audit_second_opinions" ("item_id", "model");
--> statement-breakpoint
CREATE INDEX "product_audit_second_opinions_product_idx" ON "product_audit_second_opinions" ("product_id");
