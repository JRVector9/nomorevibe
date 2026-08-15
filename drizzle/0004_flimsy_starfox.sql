DROP INDEX "products_status_verified_at_idx";--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "source" varchar(20) DEFAULT 'skill' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "claimed_at" timestamp;--> statement-breakpoint
CREATE INDEX "products_status_listed_at_idx" ON "products" USING btree ("status",coalesce("verified_at", "created_at") desc);