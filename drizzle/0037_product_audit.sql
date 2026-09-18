-- 발행분 감사. 공개 10,751건 중 10,120건(94%)이 AI 심사를 한 번도 거치지 않았다(2026-09-18 프로드).
-- 새 표 셋만 만든다 — 기존 표는 건드리지 않고, 감사를 시작하지도 않는다. 첫 감사는 배포 뒤
-- scripts/start-product-audit.ts 나 /admin/audit 의 버튼으로 사람이 연다.
-- 감사는 찾아낸 것만 적는다. crawl_candidates.state 와 products.status 는 쓰지 않는다.
CREATE TABLE "product_audit_attempts" (
	"id" serial PRIMARY KEY NOT NULL,
	"item_id" integer NOT NULL,
	"started_at" timestamp NOT NULL,
	"completed_at" timestamp DEFAULT now() NOT NULL,
	"provider" varchar(80) NOT NULL,
	"model" varchar(160) NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"source" jsonb NOT NULL,
	"outcome" jsonb,
	"error_code" varchar(120)
);
--> statement-breakpoint
CREATE TABLE "product_audit_campaigns" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"started_by" varchar(120) NOT NULL,
	"reason" varchar(500) NOT NULL,
	"prompt_version" varchar(40) NOT NULL,
	"rules_version" varchar(40) NOT NULL,
	"provider" varchar(80) NOT NULL,
	"model" varchar(160) NOT NULL,
	"reaudit_kept" boolean DEFAULT false NOT NULL,
	"status" varchar(20) DEFAULT 'running' NOT NULL,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "product_audit_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"campaign_id" integer NOT NULL,
	"product_id" integer NOT NULL,
	"slug" varchar(80) NOT NULL,
	"source_hash" varchar(64),
	"ai_decision" varchar(20),
	"ai_reason" text,
	"ai_confidence" double precision,
	"ai_category" varchar(40),
	"reviewed_at" timestamp,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error_code" varchar(120),
	"retry_at" timestamp,
	"human_decision" varchar(20),
	"human_by" varchar(120),
	"human_at" timestamp,
	"human_note" varchar(500),
	"keep_until" timestamp
);
--> statement-breakpoint
ALTER TABLE "product_audit_attempts" ADD CONSTRAINT "product_audit_attempts_item_id_product_audit_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."product_audit_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_audit_items" ADD CONSTRAINT "product_audit_items_campaign_id_product_audit_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."product_audit_campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_audit_attempts_item_idx" ON "product_audit_attempts" USING btree ("item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_audit_one_running_idx" ON "product_audit_campaigns" USING btree ("status") WHERE "product_audit_campaigns"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "product_audit_items_campaign_product_idx" ON "product_audit_items" USING btree ("campaign_id","product_id");--> statement-breakpoint
CREATE INDEX "product_audit_items_pending_idx" ON "product_audit_items" USING btree ("campaign_id","id") WHERE "product_audit_items"."ai_decision" is null;--> statement-breakpoint
CREATE INDEX "product_audit_items_open_idx" ON "product_audit_items" USING btree ("campaign_id","ai_decision") WHERE "product_audit_items"."human_decision" is null;--> statement-breakpoint
CREATE INDEX "product_audit_items_kept_idx" ON "product_audit_items" USING btree ("product_id","keep_until") WHERE "product_audit_items"."human_decision" = 'kept';