ALTER TABLE "product_search_profiles" ADD COLUMN "verified_at" timestamp;--> statement-breakpoint
ALTER TABLE "product_search_profiles" ADD COLUMN "removed_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "product_search_profiles" ADD COLUMN "verify_model" varchar(160);--> statement-breakpoint
ALTER TABLE "product_search_profiles" ADD COLUMN "verify_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_search_profiles" ADD COLUMN "verify_error" varchar(60);--> statement-breakpoint
ALTER TABLE "product_search_profiles" ADD COLUMN "verify_retry_at" timestamp;