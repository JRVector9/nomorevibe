-- 감사 보류(2026-10-21 운영자 결정) — AI 감사가 높은 확신으로 "제품 아님"이라 한(사유 갈래가 허용 목록에 들고 두 번째 모델이 승인하지
-- 않았거나, 두 번째 모델도 거절한) 주인 없는 공개 제품을 사람이 정할 때까지 공개 목록·검색·순위·피드·sitemap 에서 뺀다.
-- 상태(status)는 그대로라 상세 주소는 열리고 색인만 막는다(lib/crawl/product-audit-hold.ts).
-- 0109 와 같이 CONCURRENTLY 는 쓸 수 없다 — 마이그레이터가 밀린 마이그레이션을 한 트랜잭션으로 돌린다.
--
-- 잠금: 두 표를 처음에 한 번에 ACCESS EXCLUSIVE 로 잡는다 — 감사 읽기(pendingAuditItems·listAuditFindings 등)가 잡는 차례인
-- product_audit_items → products 순서다. 표마다 ALTER 가 따로 잡으면, products 를 쥔 채 product_audit_items 를 기다리는 동안
-- 그 표를 먼저 읽고 products 를 기다리는 감사 쿼리와 엇갈려 교착이 날 수 있다(잠금 올리기 순환).
-- 기본값 없는 nullable 열 더하기는 표를 다시 쓰지 않는다(카탈로그만 바꾼다). 잠금은 commit 까지 — 이 파일(과 함께 도는 0109)이
-- 끝날 때까지 두 표의 읽기·쓰기가 기다린다. 색인 둘은 products 5만 행·product_audit_items 수만 행을 한 번씩 훑는다(합쳐 1초 안팎).
-- 앞선 긴 트랜잭션이 두 표 중 하나를 쥐고 있으면 scripts/migrate.mjs 의 lock_timeout(10s)이 끊고 마이그레이션이 실패한다 —
-- 그동안 두 표를 읽는 요청이 뒤에 줄을 선다. 런북대로 소비자를 멈춘 뒤 돌리고, 실패하면 다시 돌린다.
LOCK TABLE "product_audit_items", "products" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
-- 보류를 건 시각과 그 까닭이 된 감사 항목. 목록 조건은 audit_hold_at is null 한 줄이라 조인 없이 행에서 바로 거른다
ALTER TABLE "products" ADD COLUMN "audit_hold_at" timestamp;
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "audit_hold_item_id" integer;
--> statement-breakpoint
-- 사람이(또는 두 번째 모델의 승인이) 보류를 풀었다 — 그 항목으로 다시 보류하지 않는다. 다음 감사의 새 항목은 다시 보류될 수 있다
ALTER TABLE "product_audit_items" ADD COLUMN "hold_released_at" timestamp;
--> statement-breakpoint
-- 관리자 '보류 중' 목록(오래된 것부터)과 수 — 보류된 행만 담아 작다
CREATE INDEX "products_audit_hold_idx" ON "products" ("audit_hold_at", "id") WHERE "audit_hold_at" IS NOT NULL;
--> statement-breakpoint
-- 보류 조건의 "그 제품의 더 새 항목" 찾기와, 보류를 풀 때 그 제품의 열린 항목에 '풀었음'을 적는 쓰기
CREATE INDEX "product_audit_items_product_id_idx" ON "product_audit_items" ("product_id", "id");
--> statement-breakpoint
-- 감사 답에 대한 다른 모델의 두 번째 의견 — 밖에서 돌린 일괄 결과를 scripts/ops/import-audit-second-opinions.ts 가 옮겨 적는다.
-- 두 번째 모델도 거절했으면 사유 갈래와 상관없이 보류의 까닭이 되고, 승인했으면 갈래로는 걸지 않는다.
-- 외래 키는 product_audit_items 를 가리킨다(위에서 이미 ACCESS EXCLUSIVE 로 쥐고 있다). 새 표라 비어 있다
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
-- 같은 (항목, 모델)은 한 줄 — 다시 옮겨 적으면 덮어쓴다. 항목마다 의견을 찾는 조건(보류·화면)도 이 색인의 앞 열을 쓴다
CREATE UNIQUE INDEX "product_audit_second_opinions_item_model_idx" ON "product_audit_second_opinions" ("item_id", "model");
