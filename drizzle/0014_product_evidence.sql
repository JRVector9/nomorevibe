CREATE TABLE "evidence_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"values" jsonb NOT NULL,
	"updated_by" varchar(120),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media_assets" (
	"hash" varchar(64) PRIMARY KEY NOT NULL,
	"web_data" "bytea" NOT NULL,
	"thumbnail_data" "bytea" NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"thumbnail_width" integer NOT NULL,
	"thumbnail_height" integer NOT NULL,
	"mime_type" varchar(40) NOT NULL,
	"web_size" integer NOT NULL,
	"thumbnail_size" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_agents" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"provider" varchar(120) NOT NULL,
	"client" varchar(120),
	"model" varchar(160),
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"commit_from" varchar(64),
	"commit_to" varchar(64),
	"date_from" date,
	"date_to" date,
	"source_url" varchar(1000),
	"evidence_level" varchar(32) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_evidence_audit" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(80),
	"actor" varchar(120) NOT NULL,
	"action" varchar(80) NOT NULL,
	"reason" varchar(500),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_evidence_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"provider" varchar(60) NOT NULL,
	"source_key" varchar(500) NOT NULL,
	"source_url" varchar(1000),
	"state" varchar(20) DEFAULT 'unobserved' NOT NULL,
	"normalized_facts" jsonb,
	"etag" varchar(500),
	"last_modified" varchar(200),
	"observed_at" timestamp,
	"last_success_at" timestamp,
	"last_failure_at" timestamp,
	"next_attempt_at" timestamp DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(80),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_health_daily" (
	"slug" varchar(80) NOT NULL,
	"day" date NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"successes" integer DEFAULT 0 NOT NULL,
	"latency_total_ms" bigint DEFAULT 0 NOT NULL,
	"latency_samples" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "product_health_daily_slug_day_pk" PRIMARY KEY("slug","day")
);
--> statement-breakpoint
CREATE TABLE "product_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"kind" varchar(24) NOT NULL,
	"declaration_source" varchar(20) NOT NULL,
	"url" varchar(1000) NOT NULL,
	"normalized_key" varchar(500) NOT NULL,
	"verification_state" varchar(20) DEFAULT 'unobserved' NOT NULL,
	"relationship_state" varchar(24),
	"visible" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_media" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"source_url" varchar(1000) NOT NULL,
	"asset_hash" varchar(64) NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"alt_text" varchar(500),
	"current" boolean DEFAULT true NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"first_observed_at" timestamp DEFAULT now() NOT NULL,
	"last_observed_at" timestamp DEFAULT now() NOT NULL,
	"last_success_at" timestamp DEFAULT now() NOT NULL,
	"missing_at" timestamp,
	"superseded_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "product_profiles" (
	"slug" varchar(80) PRIMARY KEY NOT NULL,
	"problem" varchar(2000),
	"target_users" varchar(2000),
	"key_features" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"use_cases" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pricing_model" varchar(20) NOT NULL,
	"pricing_url" varchar(1000),
	"lifecycle" varchar(20) NOT NULL,
	"platforms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"privacy_summary" varchar(2000),
	"long_description_markdown" text NOT NULL,
	"team" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"maker_license" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_skills" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"namespace" varchar(120) NOT NULL,
	"name" varchar(160) NOT NULL,
	"version" varchar(80),
	"source" varchar(1000),
	"hash" varchar(64),
	"commit" varchar(64),
	"evidence_level" varchar(32) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_updates" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" varchar(80) NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"dedupe_key" varchar(500) NOT NULL,
	"canonical_url" varchar(1000),
	"title" varchar(500) NOT NULL,
	"summary" text,
	"before_after" jsonb,
	"published_at" timestamp,
	"observed_at" timestamp NOT NULL,
	"visible" boolean DEFAULT true NOT NULL,
	"maker_edited_at" timestamp,
	"maker_edited_by" varchar(120),
	"maker_deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "product_health" ADD COLUMN "latency_ms" integer;--> statement-breakpoint
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_asset_hash_media_assets_hash_fk" FOREIGN KEY ("asset_hash") REFERENCES "public"."media_assets"("hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "product_evidence_audit_slug_time_idx" ON "product_evidence_audit" USING btree ("slug","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "product_evidence_sources_slug_kind_key_idx" ON "product_evidence_sources" USING btree ("slug","kind","source_key");--> statement-breakpoint
CREATE INDEX "product_evidence_sources_due_idx" ON "product_evidence_sources" USING btree ("state","next_attempt_at","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "product_links_slug_kind_key_idx" ON "product_links" USING btree ("slug","kind","normalized_key");--> statement-breakpoint
CREATE UNIQUE INDEX "product_media_slug_source_asset_idx" ON "product_media" USING btree ("slug","source_url","asset_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "product_media_one_current_source_idx" ON "product_media" USING btree ("slug","source_url") WHERE "product_media"."current" = true;--> statement-breakpoint
CREATE INDEX "product_media_asset_idx" ON "product_media" USING btree ("asset_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "product_skills_identity_idx" ON "product_skills" USING btree ("slug","namespace","name",coalesce("version", ''),coalesce("commit", ''));--> statement-breakpoint
CREATE UNIQUE INDEX "product_updates_slug_dedupe_idx" ON "product_updates" USING btree ("slug","dedupe_key");--> statement-breakpoint
CREATE INDEX "product_updates_visible_order_idx" ON "product_updates" USING btree ("slug","visible",coalesce("published_at", "observed_at") desc);
